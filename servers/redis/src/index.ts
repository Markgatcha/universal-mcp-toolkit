import { pathToFileURL } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { createClient } from "redis";
import { z } from "zod";

type JsonPrimitive = boolean | number | string | null;
export interface JsonObject {
  [key: string]: JsonValue;
}
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValueSchema), z.record(z.string(), jsonValueSchema)]),
);
const jsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), jsonValueSchema);

const booleanFlag = z.enum(["true", "false"]).default("false").transform((value: "true" | "false") => value === "true");

const redisEnvShape = {
  REDIS_URL: z.string().min(1),
  REDIS_ALLOW_WRITES: booleanFlag,
  REDIS_DEFAULT_TTL_SECONDS: z.coerce.number().int().nonnegative().max(604800).default(0),
  REDIS_VALUE_SAMPLE_LIMIT: z.coerce.number().int().positive().max(100).default(10),
  REDIS_RESOURCE_SCAN_PATTERN: z.string().min(1).default("*"),
  REDIS_RESOURCE_KEY_LIMIT: z.coerce.number().int().positive().max(100).default(20),
} satisfies z.ZodRawShape;

export type RedisEnv = z.infer<z.ZodObject<typeof redisEnvShape>>;

export interface RedisInfoProperty {
  name: string;
  value: string;
}

export interface RedisKeyInspection {
  key: string;
  exists: boolean;
  keyType: string | null;
  ttlSeconds: number | null;
  value: JsonValue | null;
  preview: string;
  size: number | null;
}

export interface RedisClient {
  getKey(input: {
    key: string;
    sampleSize: number;
  }): Promise<RedisKeyInspection>;
  setKey(input: {
    key: string;
    serializedValue: string;
    ttlSeconds: number | null;
    onlyIfAbsent: boolean;
  }): Promise<{
    key: string;
    stored: boolean;
    ttlSeconds: number | null;
  }>;
  inspectServerInfo(input: {
    section?: string;
  }): Promise<{
    section: string;
    properties: RedisInfoProperty[];
    raw: string;
  }>;
  listKeys(input: {
    pattern: string;
    limit: number;
  }): Promise<string[]>;
  close?(): Promise<void>;
}

interface RawRedisClient {
  isOpen: boolean;
  connect(): Promise<void>;
  quit(): Promise<string>;
  sendCommand<T>(args: readonly string[]): Promise<T>;
}

const TOOL_NAMES = ["get-key", "inspect-server-info", "set-key"] as const;
const RESOURCE_NAMES = ["cache-overview"] as const;
const PROMPT_NAMES = ["cache-debug"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "redis",
  title: "Redis MCP Server",
  description: "Key inspection and cache diagnostics tools for Redis.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-redis",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["REDIS_URL"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

function extractErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown Redis error.";
}

function sanitizeJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? value : String(value);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (typeof value === "object") {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeJsonValue(entry);
    }
    return result;
  }

  return String(value);
}

function maskRedisUrl(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    if (url.username || url.password) {
      url.username = "***";
      url.password = "***";
    }
    return url.toString();
  } catch {
    return urlValue.replace(/\/\/[^@/]+@/u, "//***:***@");
  }
}

function truncateText(value: string, maxLength = 120): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength - 3)}...`;
}

function parseInteger(reply: unknown): number | null {
  if (typeof reply === "number" && Number.isFinite(reply)) {
    return reply;
  }

  if (typeof reply === "string" && reply.length > 0) {
    const parsed = Number(reply);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function parseStringArray(reply: unknown): string[] {
  if (!Array.isArray(reply)) {
    return [];
  }

  return reply.map((entry) => String(entry));
}

function parseHashReply(reply: unknown): JsonObject {
  if (reply !== null && typeof reply === "object" && !Array.isArray(reply)) {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(reply)) {
      result[key] = sanitizeJsonValue(value);
    }
    return result;
  }

  if (!Array.isArray(reply)) {
    return {};
  }

  const result: JsonObject = {};
  for (let index = 0; index < reply.length; index += 2) {
    const key = reply[index];
    const value = reply[index + 1];
    if (key !== undefined) {
      result[String(key)] = sanitizeJsonValue(value ?? null);
    }
  }

  return result;
}

function parseZsetReply(reply: unknown): JsonValue[] {
  if (!Array.isArray(reply)) {
    return [];
  }

  if (reply.every((entry) => Array.isArray(entry) && entry.length >= 2)) {
    return reply.map((entry) => {
      const pair = entry as unknown[];
      return {
        member: String(pair[0]),
        score: parseInteger(pair[1]) ?? String(pair[1] ?? ""),
      };
    });
  }

  const result: JsonValue[] = [];
  for (let index = 0; index < reply.length; index += 2) {
    const member = reply[index];
    const score = reply[index + 1];
    if (member !== undefined) {
      result.push({
        member: String(member),
        score: parseInteger(score) ?? String(score ?? ""),
      });
    }
  }

  return result;
}

function parseStreamReply(reply: unknown): JsonValue[] {
  if (!Array.isArray(reply)) {
    return [];
  }

  return reply.map((entry) => {
    if (!Array.isArray(entry) || entry.length < 2) {
      return {
        raw: sanitizeJsonValue(entry),
      };
    }

    const id = String(entry[0]);
    const fields = parseHashReply(entry[1]);
    return {
      id,
      fields,
    };
  });
}

function parseInfoSection(raw: string): RedisInfoProperty[] {
  return raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#") && line.includes(":"))
    .map((line) => {
      const separatorIndex = line.indexOf(":");
      return {
        name: line.slice(0, separatorIndex),
        value: line.slice(separatorIndex + 1),
      };
    });
}

function parseScanReply(reply: unknown): { cursor: string; keys: string[] } {
  if (!Array.isArray(reply) || reply.length < 2) {
    return {
      cursor: "0",
      keys: [],
    };
  }

  const cursor = String(reply[0]);
  const keys = parseStringArray(reply[1]);
  return {
    cursor,
    keys,
  };
}

class NodeRedisClient implements RedisClient {
  private readonly client: RawRedisClient;

  public constructor(url: string) {
    this.client = createClient({ url }) as unknown as RawRedisClient;
  }

  public async close(): Promise<void> {
    if (!this.client.isOpen) {
      return;
    }

    await this.client.quit();
  }

  public async getKey(input: {
    key: string;
    sampleSize: number;
  }): Promise<RedisKeyInspection> {
    const keyType = await this.execute<string>(["TYPE", input.key]);
    if (keyType === "none") {
      return {
        key: input.key,
        exists: false,
        keyType: null,
        ttlSeconds: null,
        value: null,
        preview: "Key not found.",
        size: null,
      };
    }

    const ttlReply = await this.execute<number | string>(["TTL", input.key]);
    const ttl = parseInteger(ttlReply);
    const ttlSeconds = ttl === null || ttl < 0 ? null : ttl;

    switch (keyType) {
      case "string": {
        const value = await this.execute<string | null>(["GET", input.key]);
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value,
          preview: typeof value === "string" ? truncateText(value) : "null",
          size: typeof value === "string" ? value.length : 0,
        };
      }
      case "hash": {
        const value = parseHashReply(await this.execute<unknown>(["HGETALL", input.key]));
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value,
          preview: `${Object.keys(value).length} hash field(s)`,
          size: Object.keys(value).length,
        };
      }
      case "list": {
        const value = parseStringArray(await this.execute<unknown>(["LRANGE", input.key, "0", String(input.sampleSize - 1)]));
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value,
          preview: `${value.length} sampled list item(s)`,
          size: value.length,
        };
      }
      case "set": {
        const members = parseStringArray(await this.execute<unknown>(["SMEMBERS", input.key])).slice(0, input.sampleSize);
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value: members,
          preview: `${members.length} sampled set member(s)`,
          size: members.length,
        };
      }
      case "zset": {
        const value = parseZsetReply(
          await this.execute<unknown>(["ZRANGE", input.key, "0", String(input.sampleSize - 1), "WITHSCORES"]),
        );
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value,
          preview: `${value.length} sampled sorted-set member(s)`,
          size: value.length,
        };
      }
      case "stream": {
        const value = parseStreamReply(
          await this.execute<unknown>(["XRANGE", input.key, "-", "+", "COUNT", String(input.sampleSize)]),
        );
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value,
          preview: `${value.length} sampled stream entr${value.length === 1 ? "y" : "ies"}`,
          size: value.length,
        };
      }
      default:
        return {
          key: input.key,
          exists: true,
          keyType,
          ttlSeconds,
          value: null,
          preview: `Key type '${keyType}' is not directly decoded by this server.`,
          size: null,
        };
    }
  }

  public async setKey(input: {
    key: string;
    serializedValue: string;
    ttlSeconds: number | null;
    onlyIfAbsent: boolean;
  }): Promise<{
    key: string;
    stored: boolean;
    ttlSeconds: number | null;
  }> {
    const args = ["SET", input.key, input.serializedValue];
    if (input.ttlSeconds !== null) {
      args.push("EX", String(input.ttlSeconds));
    }

    if (input.onlyIfAbsent) {
      args.push("NX");
    }

    const response = await this.execute<string | null>(args);

    return {
      key: input.key,
      stored: response === "OK",
      ttlSeconds: input.ttlSeconds,
    };
  }

  public async inspectServerInfo(input: {
    section?: string;
  }): Promise<{
    section: string;
    properties: RedisInfoProperty[];
    raw: string;
  }> {
    const raw = await this.execute<string>(input.section ? ["INFO", input.section] : ["INFO"]);
    return {
      section: input.section ?? "default",
      properties: parseInfoSection(raw),
      raw,
    };
  }

  public async listKeys(input: {
    pattern: string;
    limit: number;
  }): Promise<string[]> {
    const keys: string[] = [];
    let cursor = "0";

    do {
      const reply = await this.execute<unknown>(["SCAN", cursor, "MATCH", input.pattern, "COUNT", String(input.limit)]);
      const parsed = parseScanReply(reply);
      cursor = parsed.cursor;
      for (const key of parsed.keys) {
        if (keys.length >= input.limit) {
          break;
        }

        keys.push(key);
      }
    } while (cursor !== "0" && keys.length < input.limit);

    return keys;
  }

  private async ensureConnected(): Promise<void> {
    if (this.client.isOpen) {
      return;
    }

    try {
      await this.client.connect();
    } catch (error) {
      throw new ExternalServiceError("Failed to connect to Redis.", {
        details: extractErrorMessage(error),
      });
    }
  }

  private async execute<T>(args: readonly string[]): Promise<T> {
    await this.ensureConnected();

    try {
      return await this.client.sendCommand<T>(args);
    } catch (error) {
      throw new ExternalServiceError(`Redis command failed: ${args[0]}.`, {
        details: extractErrorMessage(error),
      });
    }
  }
}

export class RedisServer extends ToolkitServer {
  public constructor(
    private readonly env: RedisEnv,
    private readonly client: RedisClient,
  ) {
    super(metadata);

    this.registerTool(
      defineTool({
        name: "get-key",
        title: "Inspect Redis key",
        description: "Fetch a Redis key with type-aware decoding and TTL metadata.",
        inputSchema: {
          key: z.string().min(1),
          sampleSize: z.number().int().positive().max(100).default(10),
        },
        outputSchema: {
          key: z.string(),
          exists: z.boolean(),
          keyType: z.string().nullable(),
          ttlSeconds: z.number().int().nonnegative().nullable(),
          value: jsonValueSchema.nullable(),
          preview: z.string(),
          size: z.number().int().nonnegative().nullable(),
        },
        handler: async ({ key, sampleSize }, context) => {
          await context.log("info", `Inspecting Redis key '${key}'.`);
          return this.client.getKey({
            key,
            sampleSize: Math.min(sampleSize, this.env.REDIS_VALUE_SAMPLE_LIMIT),
          });
        },
        renderText: (output) =>
          output.exists
            ? `${output.key} (${output.keyType ?? "unknown"}) ttl=${output.ttlSeconds ?? "none"}`
            : `${output.key} was not found.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "set-key",
        title: "Set Redis key",
        description: "Set a Redis key with an explicit write guard and optional TTL.",
        inputSchema: {
          key: z.string().min(1),
          value: jsonValueSchema,
          ttlSeconds: z.number().int().positive().max(604800).optional(),
          onlyIfAbsent: z.boolean().default(false),
          allowWrite: z.boolean().default(false),
        },
        outputSchema: {
          key: z.string(),
          stored: z.boolean(),
          ttlSeconds: z.number().int().nonnegative().nullable(),
          serialization: z.string(),
        },
        handler: async ({ allowWrite, key, onlyIfAbsent, ttlSeconds, value }, context) => {
          if (!this.env.REDIS_ALLOW_WRITES || !allowWrite) {
            throw new ValidationError(
              "Redis writes are disabled by default. Set REDIS_ALLOW_WRITES=true and pass allowWrite=true to set keys.",
            );
          }

          const resolvedTtlSeconds =
            ttlSeconds ?? (this.env.REDIS_DEFAULT_TTL_SECONDS > 0 ? this.env.REDIS_DEFAULT_TTL_SECONDS : null);
          const serialization = typeof value === "string" ? value : JSON.stringify(value);
          await context.log("warning", `Setting Redis key '${key}' with explicit write opt-in.`);
          const result = await this.client.setKey({
            key,
            serializedValue: serialization,
            ttlSeconds: resolvedTtlSeconds,
            onlyIfAbsent,
          });

          return {
            key: result.key,
            stored: result.stored,
            ttlSeconds: result.ttlSeconds,
            serialization,
          };
        },
        renderText: (output) => `${output.key} ${output.stored ? "stored" : "not written"}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "inspect-server-info",
        title: "Inspect Redis server info",
        description: "Read INFO output from Redis and parse it into name/value pairs.",
        inputSchema: {
          section: z.string().min(1).optional(),
        },
        outputSchema: {
          section: z.string(),
          propertyCount: z.number().int().nonnegative(),
          properties: z.array(
            z.object({
              name: z.string(),
              value: z.string(),
            }),
          ),
          raw: z.string(),
        },
        handler: async ({ section }, context) => {
          await context.log("info", `Inspecting Redis INFO ${section ?? "default"} section.`);
          const request: {
            section?: string;
          } = {};

          if (section) {
            request.section = section;
          }

          const result = await this.client.inspectServerInfo(request);
          return {
            section: result.section,
            propertyCount: result.properties.length,
            properties: result.properties,
            raw: result.raw,
          };
        },
        renderText: (output) => `${output.propertyCount} Redis INFO properties returned for ${output.section}.`,
      }),
    );

    this.registerStaticResource(
      "cache-overview",
      "redis://cache-overview",
      {
        title: "Redis cache overview",
        description: "Redis connection summary, INFO snapshot, and sampled keys.",
        mimeType: "application/json",
      },
      async () => {
        const info = await this.client.inspectServerInfo({ section: "server" });
        const sampleKeys = await this.client.listKeys({
          pattern: this.env.REDIS_RESOURCE_SCAN_PATTERN,
          limit: this.env.REDIS_RESOURCE_KEY_LIMIT,
        });

        return this.createJsonResource("redis://cache-overview", {
          connection: maskRedisUrl(this.env.REDIS_URL),
          writeEnabled: this.env.REDIS_ALLOW_WRITES,
          defaultTtlSeconds: this.env.REDIS_DEFAULT_TTL_SECONDS > 0 ? this.env.REDIS_DEFAULT_TTL_SECONDS : null,
          sampledPattern: this.env.REDIS_RESOURCE_SCAN_PATTERN,
          sampleKeys,
          info: info.properties.reduce<Record<string, string>>((accumulator, property) => {
            accumulator[property.name] = property.value;
            return accumulator;
          }, {}),
        });
      },
    );

    this.registerPrompt(
      "cache-debug",
      {
        title: "Redis cache debug",
        description: "Generate a focused investigation plan for Redis cache issues.",
        argsSchema: {
          symptom: z.string().min(1),
          keyPattern: z.string().min(1).optional(),
          suspectedTtlIssue: z.boolean().default(false),
        },
      },
      async ({ keyPattern, suspectedTtlIssue, symptom }) =>
        this.createTextPrompt(
          [
            "Investigate the Redis caching issue described below.",
            `Symptom: ${symptom}`,
            `Key pattern: ${keyPattern ?? "not provided"}`,
            `Suspected TTL issue: ${suspectedTtlIssue}`,
            `Write operations enabled: ${this.env.REDIS_ALLOW_WRITES}`,
            "Use the Redis tools to:",
            "- inspect representative keys and their TTLs",
            "- compare INFO output for memory, evictions, and persistence clues",
            "- confirm whether serialization or key type mismatches are involved",
            "- document the safest next step before modifying cache entries",
          ].join("\n"),
        ),
    );
  }

  public override async close(): Promise<void> {
    await this.client.close?.();
    await super.close();
  }
}

export interface CreateRedisServerOptions {
  env?: RedisEnv;
  client?: RedisClient;
}

export function createServer(options: CreateRedisServerOptions = {}): RedisServer {
  const env = options.env ?? loadEnv(redisEnvShape);
  const client = options.client ?? new NodeRedisClient(env.REDIS_URL);
  return new RedisServer(env, client);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const env = loadEnv(redisEnvShape);
  const runtimeOptions = parseRuntimeOptions(argv);

  await runToolkitServer(
    {
      createServer: () => createServer({ env }),
      serverCard,
    },
    runtimeOptions,
  );
}

function isMainModule(): boolean {
  const entryPoint = process.argv[1];
  if (!entryPoint) {
    return false;
  }

  return import.meta.url === pathToFileURL(entryPoint).href;
}

if (isMainModule()) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "Unknown startup error.";
    console.error(`Failed to start Redis MCP server: ${message}`);
    process.exitCode = 1;
  });
}
