import { pathToFileURL } from "node:url";

import {
  HttpServiceClient,
  ToolkitServer,
  ValidationError,
  createLogger,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
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

const supabaseFilterValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])),
]);

const supabaseEnvShape = {
  SUPABASE_URL: z.string().url(),
  SUPABASE_KEY: z.string().min(1),
  SUPABASE_SCHEMA: z.string().min(1).default("public"),
  SUPABASE_MAX_ROWS: z.coerce.number().int().positive().max(200).default(50),
  SUPABASE_BUCKET_LIMIT: z.coerce.number().int().positive().max(100).default(25),
} satisfies z.ZodRawShape;

export type SupabaseEnv = z.infer<z.ZodObject<typeof supabaseEnvShape>>;
export type SupabaseFilterValue = z.infer<typeof supabaseFilterValueSchema>;

export interface SupabaseFilter {
  column: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "like" | "ilike" | "in" | "is";
  value: SupabaseFilterValue;
}

export interface SupabaseTableSummary {
  schema: string;
  name: string;
  type: string;
}

export interface SupabaseBucketSummary {
  id: string;
  name: string;
  public: boolean;
  fileSizeLimit: number | null;
  allowedMimeTypes: string[] | null;
  createdAt: string | null;
}

export interface SupabaseClient {
  listTables(input: {
    schema: string;
    limit: number;
  }): Promise<{
    schema: string;
    tables: SupabaseTableSummary[];
  }>;
  queryTable(input: {
    schema: string;
    table: string;
    select: string;
    filters: readonly SupabaseFilter[];
    limit: number;
    orderBy?: string;
    ascending: boolean;
  }): Promise<{
    schema: string;
    table: string;
    rows: JsonObject[];
  }>;
  listStorageBuckets(input: {
    limit: number;
  }): Promise<SupabaseBucketSummary[]>;
}

const TOOL_NAMES = ["list-storage-buckets", "list-tables", "query-table"] as const;
const RESOURCE_NAMES = ["project-overview"] as const;
const PROMPT_NAMES = ["incident-response"] as const;

const tableRowSchema = z
  .object({
    table_schema: z.string(),
    table_name: z.string(),
    table_type: z.string(),
  })
  .passthrough();

const listTablesResponseSchema = z.array(tableRowSchema);
const queryRowsResponseSchema = z.array(jsonObjectSchema);
const bucketRowSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    public: z.boolean().nullable().optional(),
    file_size_limit: z.number().int().nonnegative().nullable().optional(),
    allowed_mime_types: z.array(z.string()).nullable().optional(),
    created_at: z.string().nullable().optional(),
  })
  .passthrough();
const listBucketsResponseSchema = z.array(bucketRowSchema);

export const metadata: ToolkitServerMetadata = {
  id: "supabase",
  title: "Supabase MCP Server",
  description: "Database, auth, storage, and function tools for Supabase.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-supabase",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["SUPABASE_URL", "SUPABASE_KEY"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

function getProjectReference(urlValue: string): string {
  try {
    const url = new URL(urlValue);
    return url.hostname.split(".")[0] ?? url.hostname;
  } catch {
    return urlValue;
  }
}

function formatScalarFilterValue(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function formatInMember(value: string | number | boolean | null): string {
  if (value === null) {
    return "null";
  }

  if (typeof value === "string") {
    const escaped = value.replace(/\\/gu, "\\\\").replace(/"/gu, '\\"');
    return `"${escaped}"`;
  }

  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }

  return String(value);
}

function formatFilterExpression(filter: SupabaseFilter): string {
  if (filter.operator === "in") {
    if (!Array.isArray(filter.value)) {
      throw new ValidationError("Supabase 'in' filters require an array value.");
    }

    return `in.(${filter.value.map((value) => formatInMember(value)).join(",")})`;
  }

  if (Array.isArray(filter.value)) {
    throw new ValidationError(`Supabase filter operator '${filter.operator}' does not accept array values.`);
  }

  return `${filter.operator}.${formatScalarFilterValue(filter.value)}`;
}

class SupabaseRestClient extends HttpServiceClient implements SupabaseClient {
  public constructor(private readonly env: SupabaseEnv) {
    super({
      serviceName: "Supabase",
      baseUrl: env.SUPABASE_URL,
      logger: createLogger({ name: metadata.packageName }),
      defaultHeaders: () => ({
        apikey: env.SUPABASE_KEY,
        authorization: `Bearer ${env.SUPABASE_KEY}`,
      }),
    });
  }

  public async listTables(input: {
    schema: string;
    limit: number;
  }): Promise<{
    schema: string;
    tables: SupabaseTableSummary[];
  }> {
    const rows = await this.getJson("/rest/v1/tables", listTablesResponseSchema, {
      headers: {
        "accept-profile": "information_schema",
      },
      query: {
        select: "table_schema,table_name,table_type",
        table_schema: `eq.${input.schema}`,
        order: "table_name.asc",
        limit: input.limit,
      },
    });

    return {
      schema: input.schema,
      tables: rows.map((row) => ({
        schema: row.table_schema,
        name: row.table_name,
        type: row.table_type,
      })),
    };
  }

  public async queryTable(input: {
    schema: string;
    table: string;
    select: string;
    filters: readonly SupabaseFilter[];
    limit: number;
    orderBy?: string;
    ascending: boolean;
  }): Promise<{
    schema: string;
    table: string;
    rows: JsonObject[];
  }> {
    const query: Record<string, string | number> = {
      select: input.select,
      limit: input.limit,
    };

    if (input.orderBy) {
      query.order = `${input.orderBy}.${input.ascending ? "asc" : "desc"}`;
    }

    for (const filter of input.filters) {
      query[filter.column] = formatFilterExpression(filter);
    }

    const rows = await this.getJson(`/rest/v1/${encodeURIComponent(input.table)}`, queryRowsResponseSchema, {
      headers: {
        "accept-profile": input.schema,
      },
      query,
    });

    return {
      schema: input.schema,
      table: input.table,
      rows,
    };
  }

  public async listStorageBuckets(input: {
    limit: number;
  }): Promise<SupabaseBucketSummary[]> {
    const rows = await this.getJson("/storage/v1/bucket", listBucketsResponseSchema);

    return rows.slice(0, input.limit).map((row) => ({
      id: row.id,
      name: row.name,
      public: row.public ?? false,
      fileSizeLimit: row.file_size_limit ?? null,
      allowedMimeTypes: row.allowed_mime_types ?? null,
      createdAt: row.created_at ?? null,
    }));
  }
}

export class SupabaseServer extends ToolkitServer {
  public constructor(
    private readonly env: SupabaseEnv,
    private readonly client: SupabaseClient,
  ) {
    super(metadata);

    this.registerTool(
      defineTool({
        name: "list-tables",
        title: "List Supabase tables",
        description: "List tables exposed through the Supabase REST API for a given schema.",
        inputSchema: {
          schema: z.string().min(1).default(this.env.SUPABASE_SCHEMA),
          limit: z.number().int().positive().max(100).default(25),
        },
        outputSchema: {
          schema: z.string(),
          tableCount: z.number().int().nonnegative(),
          tables: z.array(
            z.object({
              schema: z.string(),
              name: z.string(),
              type: z.string(),
            }),
          ),
        },
        handler: async ({ limit, schema }, context) => {
          const cappedLimit = Math.min(limit, this.env.SUPABASE_MAX_ROWS);
          await context.log("info", `Listing Supabase tables for schema '${schema}'.`);
          const result = await this.client.listTables({
            schema,
            limit: cappedLimit,
          });

          return {
            schema: result.schema,
            tableCount: result.tables.length,
            tables: result.tables,
          };
        },
        renderText: (output) => `${output.tableCount} tables found in Supabase schema ${output.schema}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "query-table",
        title: "Query Supabase table",
        description: "Query a Supabase table with select, filters, ordering, and row limits.",
        inputSchema: {
          schema: z.string().min(1).default(this.env.SUPABASE_SCHEMA),
          table: z.string().min(1),
          select: z.string().min(1).default("*"),
          filters: z
            .array(
              z.object({
                column: z.string().min(1),
                operator: z.enum(["eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "in", "is"]),
                value: supabaseFilterValueSchema,
              }),
            )
            .default([]),
          limit: z.number().int().positive().max(200).default(25),
          orderBy: z.string().min(1).optional(),
          ascending: z.boolean().default(true),
        },
        outputSchema: {
          schema: z.string(),
          table: z.string(),
          rowCount: z.number().int().nonnegative(),
          rows: z.array(jsonObjectSchema),
        },
        handler: async ({ ascending, filters, limit, orderBy, schema, select, table }, context) => {
          const cappedLimit = Math.min(limit, this.env.SUPABASE_MAX_ROWS);
          await context.log("info", `Querying Supabase table ${schema}.${table}.`);
          const request: {
            schema: string;
            table: string;
            select: string;
            filters: readonly SupabaseFilter[];
            limit: number;
            orderBy?: string;
            ascending: boolean;
          } = {
            schema,
            table,
            select,
            filters,
            limit: cappedLimit,
            ascending,
          };

          if (orderBy) {
            request.orderBy = orderBy;
          }

          const result = await this.client.queryTable(request);

          return {
            schema: result.schema,
            table: result.table,
            rowCount: result.rows.length,
            rows: result.rows,
          };
        },
        renderText: (output) => `${output.rowCount} row(s) returned from ${output.schema}.${output.table}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list-storage-buckets",
        title: "List Supabase storage buckets",
        description: "List storage buckets available in the configured Supabase project.",
        inputSchema: {
          limit: z.number().int().positive().max(100).default(25),
        },
        outputSchema: {
          bucketCount: z.number().int().nonnegative(),
          buckets: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              public: z.boolean(),
              fileSizeLimit: z.number().int().nonnegative().nullable(),
              allowedMimeTypes: z.array(z.string()).nullable(),
              createdAt: z.string().nullable(),
            }),
          ),
        },
        handler: async ({ limit }, context) => {
          const cappedLimit = Math.min(limit, this.env.SUPABASE_BUCKET_LIMIT);
          await context.log("info", "Listing Supabase storage buckets.");
          const buckets = await this.client.listStorageBuckets({ limit: cappedLimit });
          return {
            bucketCount: buckets.length,
            buckets,
          };
        },
        renderText: (output) => `${output.bucketCount} storage bucket(s) available in Supabase.`,
      }),
    );

    this.registerStaticResource(
      "project-overview",
      "supabase://project-overview",
      {
        title: "Supabase project overview",
        description: "Project-level context including schema and storage bucket visibility.",
        mimeType: "application/json",
      },
      async () => {
        const tables = await this.client.listTables({
          schema: this.env.SUPABASE_SCHEMA,
          limit: Math.min(this.env.SUPABASE_MAX_ROWS, 20),
        });
        const buckets = await this.client.listStorageBuckets({
          limit: Math.min(this.env.SUPABASE_BUCKET_LIMIT, 20),
        });

        return this.createJsonResource("supabase://project-overview", {
          projectRef: getProjectReference(this.env.SUPABASE_URL),
          url: this.env.SUPABASE_URL,
          schema: this.env.SUPABASE_SCHEMA,
          maxRows: this.env.SUPABASE_MAX_ROWS,
          tables: tables.tables,
          buckets,
        });
      },
    );

    this.registerPrompt(
      "incident-response",
      {
        title: "Supabase incident response",
        description: "Prepare a structured response plan for a Supabase production incident.",
        argsSchema: {
          incident: z.string().min(1),
          impactedArea: z.string().min(1).optional(),
          recentErrors: z.string().min(1).optional(),
        },
      },
      async ({ impactedArea, incident, recentErrors }) =>
        this.createTextPrompt(
          [
            "Prepare a Supabase incident response plan.",
            `Incident: ${incident}`,
            `Impacted area: ${impactedArea ?? "unknown"}`,
            `Recent errors: ${recentErrors ?? "none provided"}`,
            `Primary schema: ${this.env.SUPABASE_SCHEMA}`,
            `Project ref: ${getProjectReference(this.env.SUPABASE_URL)}`,
            "Use the Supabase tools to:",
            "- confirm which tables and buckets are involved",
            "- capture a bounded sample of affected rows",
            "- distinguish schema, data, and storage symptoms",
            "- document the safest immediate mitigation and follow-up checks",
          ].join("\n"),
        ),
    );
  }
}

export interface CreateSupabaseServerOptions {
  env?: SupabaseEnv;
  client?: SupabaseClient;
}

export function createServer(options: CreateSupabaseServerOptions = {}): SupabaseServer {
  const env = options.env ?? loadEnv(supabaseEnvShape);
  const client = options.client ?? new SupabaseRestClient(env);
  return new SupabaseServer(env, client);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const env = loadEnv(supabaseEnvShape);
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
    console.error(`Failed to start Supabase MCP server: ${message}`);
    process.exitCode = 1;
  });
}
