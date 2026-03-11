import { pathToFileURL } from "node:url";

import {
  ConfigurationError,
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
import { MongoClient, type Document } from "mongodb";
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

const mongodbEnvShape = {
  MONGODB_URI: z.string().min(1),
  MONGODB_DATABASE: z.string().min(1).optional(),
  MONGODB_ALLOW_WRITE_PIPELINES: booleanFlag,
  MONGODB_MAX_DOCUMENTS: z.coerce.number().int().positive().max(200).default(50),
  MONGODB_RESOURCE_COLLECTION_LIMIT: z.coerce.number().int().positive().max(100).default(25),
} satisfies z.ZodRawShape;

export type MongoDbEnv = z.infer<z.ZodObject<typeof mongodbEnvShape>>;

export interface MongoDbCollectionSummary {
  name: string;
  type: string;
  options: JsonObject;
}

export interface MongoDbDocumentBatch {
  database: string;
  collection: string;
  documents: JsonObject[];
}

export interface MongoDbClient {
  listCollections(input: {
    database: string;
    namePrefix?: string;
    limit: number;
  }): Promise<{
    database: string;
    collections: MongoDbCollectionSummary[];
  }>;
  findDocuments(input: {
    database: string;
    collection: string;
    filter: JsonObject;
    projection: JsonObject;
    sort: JsonObject;
    limit: number;
    skip: number;
  }): Promise<MongoDbDocumentBatch>;
  aggregateDocuments(input: {
    database: string;
    collection: string;
    pipeline: readonly JsonObject[];
    limit: number;
  }): Promise<MongoDbDocumentBatch>;
  close?(): Promise<void>;
}

const TOOL_NAMES = ["aggregate-documents", "find-documents", "list-collections"] as const;
const RESOURCE_NAMES = ["cluster-overview"] as const;
const PROMPT_NAMES = ["data-summary"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "mongodb",
  title: "MongoDB MCP Server",
  description: "Database, collection, and document tools for MongoDB.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-mongodb",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["MONGODB_URI"],
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

  return "Unknown MongoDB error.";
}

function getDefaultDatabaseFromUri(uri: string): string | undefined {
  const match = uri.match(/^[a-z0-9+.-]+:\/\/(?:[^@/]+@)?[^/]+\/([^?]+)/iu);
  const database = match?.[1];
  if (!database || database === "") {
    return undefined;
  }

  return decodeURIComponent(database);
}

function maskMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]+@/u, "//***:***@");
}

function hasToHexString(value: object): value is { toHexString: () => string } {
  return "toHexString" in value && typeof value.toHexString === "function";
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return "toJSON" in value && typeof value.toJSON === "function";
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

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString("base64");
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeJsonValue(entry));
  }

  if (typeof value === "object") {
    if (hasToHexString(value)) {
      return value.toHexString();
    }

    if (hasToJson(value)) {
      const jsonValue = value.toJSON();
      if (jsonValue !== value) {
        return sanitizeJsonValue(jsonValue);
      }
    }

    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value)) {
      result[key] = sanitizeJsonValue(entry);
    }
    return result;
  }

  return String(value);
}

function sanitizeJsonObject(value: unknown): JsonObject {
  const sanitized = sanitizeJsonValue(value);
  if (sanitized !== null && typeof sanitized === "object" && !Array.isArray(sanitized)) {
    return sanitized;
  }

  return {
    value: sanitized,
  };
}

function pipelineContainsWriteStage(pipeline: readonly JsonObject[]): boolean {
  return pipeline.some((stage) => Object.keys(stage).some((key) => key === "$merge" || key === "$out"));
}

class NodeMongoDbClient implements MongoDbClient {
  private readonly client: MongoClient;
  private connected = false;

  public constructor(private readonly env: MongoDbEnv) {
    this.client = new MongoClient(env.MONGODB_URI);
  }

  public async close(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await this.client.close();
    this.connected = false;
  }

  public async listCollections(input: {
    database: string;
    namePrefix?: string;
    limit: number;
  }): Promise<{
    database: string;
    collections: MongoDbCollectionSummary[];
  }> {
    const db = await this.getDatabase(input.database);
    try {
      const collections = await db.listCollections({}, { nameOnly: false }).toArray();
      const filtered = collections
        .filter((collection) => (input.namePrefix ? collection.name.startsWith(input.namePrefix) : true))
        .slice(0, input.limit)
        .map((collection) => ({
          name: collection.name,
          type: collection.type ?? "collection",
          options: sanitizeJsonObject(collection.options),
        }));

      return {
        database: input.database,
        collections: filtered,
      };
    } catch (error) {
      throw new ExternalServiceError(`Failed to list collections for database '${input.database}'.`, {
        details: extractErrorMessage(error),
      });
    }
  }

  public async findDocuments(input: {
    database: string;
    collection: string;
    filter: JsonObject;
    projection: JsonObject;
    sort: JsonObject;
    limit: number;
    skip: number;
  }): Promise<MongoDbDocumentBatch> {
    const db = await this.getDatabase(input.database);

    try {
      const options: {
        projection?: Document;
      } = {};
      if (Object.keys(input.projection).length > 0) {
        options.projection = input.projection as Document;
      }

      const cursor = db.collection(input.collection).find(input.filter as Document, options);
      if (Object.keys(input.sort).length > 0) {
        cursor.sort(input.sort as Document);
      }

      if (input.skip > 0) {
        cursor.skip(input.skip);
      }

      const documents = await cursor.limit(input.limit).toArray();

      return {
        database: input.database,
        collection: input.collection,
        documents: documents.map((document) => sanitizeJsonObject(document)),
      };
    } catch (error) {
      throw new ExternalServiceError(`Failed to query collection '${input.collection}'.`, {
        details: extractErrorMessage(error),
      });
    }
  }

  public async aggregateDocuments(input: {
    database: string;
    collection: string;
    pipeline: readonly JsonObject[];
    limit: number;
  }): Promise<MongoDbDocumentBatch> {
    const db = await this.getDatabase(input.database);

    try {
      const documents = await db
        .collection(input.collection)
        .aggregate(input.pipeline as Document[])
        .limit(input.limit)
        .toArray();

      return {
        database: input.database,
        collection: input.collection,
        documents: documents.map((document) => sanitizeJsonObject(document)),
      };
    } catch (error) {
      throw new ExternalServiceError(`Failed to aggregate collection '${input.collection}'.`, {
        details: extractErrorMessage(error),
      });
    }
  }

  private async getDatabase(name: string) {
    await this.ensureConnected();
    return this.client.db(name);
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.client.connect();
      this.connected = true;
    } catch (error) {
      throw new ExternalServiceError("Failed to connect to MongoDB.", {
        details: extractErrorMessage(error),
      });
    }
  }
}

export class MongoDbServer extends ToolkitServer {
  public constructor(
    private readonly env: MongoDbEnv,
    private readonly client: MongoDbClient,
  ) {
    super(metadata);

    this.registerTool(
      defineTool({
        name: "list-collections",
        title: "List MongoDB collections",
        description: "List collections in a MongoDB database with optional prefix filtering.",
        inputSchema: {
          database: z.string().min(1).optional(),
          namePrefix: z.string().min(1).optional(),
          limit: z.number().int().positive().max(100).default(25),
        },
        outputSchema: {
          database: z.string(),
          collectionCount: z.number().int().nonnegative(),
          collections: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              options: jsonObjectSchema,
            }),
          ),
        },
        handler: async ({ database, limit, namePrefix }, context) => {
          const resolvedDatabase = this.resolveDatabaseName(database);
          await context.log("info", `Listing collections for ${resolvedDatabase}.`);
          const request: {
            database: string;
            namePrefix?: string;
            limit: number;
          } = {
            database: resolvedDatabase,
            limit,
          };

          if (namePrefix) {
            request.namePrefix = namePrefix;
          }

          const result = await this.client.listCollections(request);

          return {
            database: result.database,
            collectionCount: result.collections.length,
            collections: result.collections,
          };
        },
        renderText: (output) => `${output.collectionCount} collections found in ${output.database}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "find-documents",
        title: "Find MongoDB documents",
        description: "Find documents in a MongoDB collection using a JSON filter and projection.",
        inputSchema: {
          database: z.string().min(1).optional(),
          collection: z.string().min(1),
          filter: jsonObjectSchema.default({}),
          projection: jsonObjectSchema.default({}),
          sort: jsonObjectSchema.default({}),
          limit: z.number().int().positive().max(200).default(25),
          skip: z.number().int().nonnegative().default(0),
        },
        outputSchema: {
          database: z.string(),
          collection: z.string(),
          returnedDocuments: z.number().int().nonnegative(),
          truncated: z.boolean(),
          documents: z.array(jsonObjectSchema),
        },
        handler: async ({ collection, database, filter, limit, projection, skip, sort }, context) => {
          const resolvedDatabase = this.resolveDatabaseName(database);
          const cappedLimit = Math.min(limit, this.env.MONGODB_MAX_DOCUMENTS);
          await context.log("info", `Finding documents in ${resolvedDatabase}.${collection}.`);
          const result = await this.client.findDocuments({
            database: resolvedDatabase,
            collection,
            filter,
            projection,
            sort,
            limit: cappedLimit,
            skip,
          });

          return {
            database: result.database,
            collection: result.collection,
            returnedDocuments: result.documents.length,
            truncated: limit > cappedLimit,
            documents: result.documents,
          };
        },
        renderText: (output) => `${output.returnedDocuments} documents returned from ${output.collection}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "aggregate-documents",
        title: "Aggregate MongoDB documents",
        description: "Run a MongoDB aggregation pipeline with write stages disabled by default.",
        inputSchema: {
          database: z.string().min(1).optional(),
          collection: z.string().min(1),
          pipeline: z.array(jsonObjectSchema).min(1),
          limit: z.number().int().positive().max(200).default(25),
          allowWriteStage: z.boolean().default(false),
        },
        outputSchema: {
          database: z.string(),
          collection: z.string(),
          stageCount: z.number().int().positive(),
          returnedDocuments: z.number().int().nonnegative(),
          truncated: z.boolean(),
          documents: z.array(jsonObjectSchema),
        },
        handler: async ({ allowWriteStage, collection, database, limit, pipeline }, context) => {
          const resolvedDatabase = this.resolveDatabaseName(database);
          const hasWriteStage = pipelineContainsWriteStage(pipeline);
          if (hasWriteStage && (!this.env.MONGODB_ALLOW_WRITE_PIPELINES || !allowWriteStage)) {
            throw new ValidationError(
              "Aggregation pipelines with $out or $merge are blocked by default. Set MONGODB_ALLOW_WRITE_PIPELINES=true and pass allowWriteStage=true to opt in.",
            );
          }

          if (hasWriteStage) {
            await context.log("warning", "Executing an opt-in MongoDB aggregation pipeline with write stages.");
          } else {
            await context.log("info", `Aggregating documents in ${resolvedDatabase}.${collection}.`);
          }

          const cappedLimit = Math.min(limit, this.env.MONGODB_MAX_DOCUMENTS);
          const result = await this.client.aggregateDocuments({
            database: resolvedDatabase,
            collection,
            pipeline,
            limit: cappedLimit,
          });

          return {
            database: result.database,
            collection: result.collection,
            stageCount: pipeline.length,
            returnedDocuments: result.documents.length,
            truncated: limit > cappedLimit,
            documents: result.documents,
          };
        },
        renderText: (output) => `${output.returnedDocuments} aggregated documents returned from ${output.collection}.`,
      }),
    );

    this.registerStaticResource(
      "cluster-overview",
      "mongodb://cluster-overview",
      {
        title: "MongoDB cluster overview",
        description: "A lightweight summary of the configured MongoDB cluster and default database.",
        mimeType: "application/json",
      },
      async () => {
        const defaultDatabase = this.getDefaultDatabaseName();
        const collections =
          defaultDatabase === null
            ? []
            : (
                await this.client.listCollections({
                  database: defaultDatabase,
                  limit: this.env.MONGODB_RESOURCE_COLLECTION_LIMIT,
                })
              ).collections;

        return this.createJsonResource("mongodb://cluster-overview", {
          connectionString: maskMongoUri(this.env.MONGODB_URI),
          defaultDatabase,
          writePipelinesEnabled: this.env.MONGODB_ALLOW_WRITE_PIPELINES,
          collections,
        });
      },
    );

    this.registerPrompt(
      "data-summary",
      {
        title: "MongoDB data summary",
        description: "Draft a focused investigation prompt for summarizing MongoDB documents.",
        argsSchema: {
          collection: z.string().min(1),
          focus: z.string().min(1),
          sampleSize: z.number().int().positive().max(100).default(20),
        },
      },
      async ({ collection, focus, sampleSize }) =>
        this.createTextPrompt(
          [
            "Use the MongoDB tools to produce a concise data summary.",
            `Collection: ${collection}`,
            `Focus area: ${focus}`,
            `Suggested sample size: ${sampleSize}`,
            `Default database: ${this.getDefaultDatabaseName() ?? "not configured"}`,
            "Look for:",
            "- common document shapes and optional fields",
            "- schema drift or surprising value distributions",
            "- timestamps, status fields, and identifiers worth drilling into",
            "- whether an aggregation pipeline or targeted find query would answer the question fastest",
          ].join("\n"),
        ),
    );
  }

  public override async close(): Promise<void> {
    await this.client.close?.();
    await super.close();
  }

  private getDefaultDatabaseName(): string | null {
    return this.env.MONGODB_DATABASE ?? getDefaultDatabaseFromUri(this.env.MONGODB_URI) ?? null;
  }

  private resolveDatabaseName(database: string | undefined): string {
    const resolved = database ?? this.getDefaultDatabaseName();
    if (!resolved) {
      throw new ConfigurationError(
        "No MongoDB database was provided. Supply a database argument or configure MONGODB_DATABASE.",
      );
    }

    return resolved;
  }
}

export interface CreateMongoDbServerOptions {
  env?: MongoDbEnv;
  client?: MongoDbClient;
}

export function createServer(options: CreateMongoDbServerOptions = {}): MongoDbServer {
  const env = options.env ?? loadEnv(mongodbEnvShape);
  const client = options.client ?? new NodeMongoDbClient(env);
  return new MongoDbServer(env, client);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const env = loadEnv(mongodbEnvShape);
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
    console.error(`Failed to start MongoDB MCP server: ${message}`);
    process.exitCode = 1;
  });
}
