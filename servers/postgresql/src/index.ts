import { createRequire } from "node:module";
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
import { z } from "zod";

const require = createRequire(import.meta.url);

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

const postgresqlEnvShape = {
  POSTGRESQL_URL: z.string().min(1),
  POSTGRESQL_SCHEMA: z.string().min(1).default("public"),
  POSTGRESQL_ALLOW_WRITES: booleanFlag,
  POSTGRESQL_SSL: booleanFlag,
  POSTGRESQL_MAX_RESULT_ROWS: z.coerce.number().int().positive().max(1000).default(200),
  POSTGRESQL_RESOURCE_TABLE_LIMIT: z.coerce.number().int().positive().max(200).default(50),
} satisfies z.ZodRawShape;

export type PostgreSqlEnv = z.infer<z.ZodObject<typeof postgresqlEnvShape>>;

type SqlParameter = boolean | number | string | null;

export interface PostgreSqlTableSummary {
  schema: string;
  name: string;
  type: string;
}

export interface PostgreSqlColumnSummary {
  name: string;
  ordinalPosition: number;
  dataType: string;
  isNullable: boolean;
  defaultValue: string | null;
  maxLength: number | null;
  numericPrecision: number | null;
  numericScale: number | null;
  comment: string | null;
}

export interface PostgreSqlConstraintSummary {
  name: string;
  type: string;
  columns: string[];
}

export interface PostgreSqlFieldSummary {
  name: string;
  dataType: string | null;
}

export interface PostgreSqlQueryExecution {
  rowCount: number | null;
  fields: PostgreSqlFieldSummary[];
  rows: JsonObject[];
}

export interface PostgreSqlClient {
  listTables(input: {
    schema: string | null;
    includeSystemSchemas: boolean;
    limit: number;
  }): Promise<{
    database: string;
    tables: PostgreSqlTableSummary[];
  }>;
  describeTable(input: {
    schema: string;
    table: string;
  }): Promise<{
    database: string;
    schema: string;
    table: string;
    columns: PostgreSqlColumnSummary[];
    constraints: PostgreSqlConstraintSummary[];
  }>;
  runQuery(input: {
    sql: string;
    params: readonly SqlParameter[];
  }): Promise<PostgreSqlQueryExecution>;
  close?(): Promise<void>;
}

interface RawPgField {
  name: string;
}

interface RawPgRow {
  [key: string]: unknown;
}

interface RawPgQueryResult {
  rowCount: number | null;
  rows: RawPgRow[];
  fields: RawPgField[];
}

interface RawPgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(text: string, values?: readonly SqlParameter[]): Promise<RawPgQueryResult>;
}

interface PgModule {
  Client: new (config: {
    connectionString: string;
    ssl?: {
      rejectUnauthorized: boolean;
    };
  }) => RawPgClient;
}

const TOOL_NAMES = ["describe-table", "list-tables", "run-query"] as const;
const RESOURCE_NAMES = ["schema-overview"] as const;
const PROMPT_NAMES = ["query-review"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "postgresql",
  title: "PostgreSQL MCP Server",
  description: "Schema inspection and safe query tools for PostgreSQL.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-postgresql",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["POSTGRESQL_URL"],
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

  return "Unknown PostgreSQL error.";
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function readNumberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function readBooleanFlag(value: unknown): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.toLowerCase();
    return normalized === "true" || normalized === "yes";
  }

  return false;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((entry) => String(entry));
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

function normalizeSql(sql: string): string {
  return sql.replace(/^(\s|--[^\r\n]*[\r\n]+|\/\*[\s\S]*?\*\/)*/u, "").trim().replace(/\s+/gu, " ");
}

function inferStatementType(sql: string): string {
  const match = normalizeSql(sql).match(/^([a-z]+)/iu);
  const statement = match?.[1];
  return statement ? statement.toUpperCase() : "UNKNOWN";
}

function isPotentiallyMutatingSql(sql: string): boolean {
  const normalized = normalizeSql(sql);
  if (normalized.length === 0) {
    return false;
  }

  const readOnlyStart = /^(select|with|show|explain|values)\b/iu;
  const writePattern =
    /\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|vacuum|call|copy|do|set|reset|refresh|reindex|cluster|comment|lock)\b/iu;

  if (!readOnlyStart.test(normalized)) {
    return true;
  }

  if (writePattern.test(normalized)) {
    return true;
  }

  return /^select\b[\s\S]*\binto\b/iu.test(normalized);
}

function getConnectionSummary(connectionString: string): { database: string; host: string } {
  try {
    const url = new URL(connectionString);
    const database = url.pathname.replace(/^\/+/u, "") || "postgres";
    return {
      database,
      host: url.host || "localhost",
    };
  } catch {
    return {
      database: "unknown",
      host: "unknown",
    };
  }
}

class NodePostgreSqlClient implements PostgreSqlClient {
  private readonly database: string;
  private readonly client: RawPgClient;
  private connected = false;

  public constructor(private readonly env: PostgreSqlEnv) {
    const clientConfig: {
      connectionString: string;
      ssl?: {
        rejectUnauthorized: boolean;
      };
    } = {
      connectionString: env.POSTGRESQL_URL,
    };

    if (env.POSTGRESQL_SSL) {
      clientConfig.ssl = {
        rejectUnauthorized: false,
      };
    }

    const { Client } = require("pg") as PgModule;
    this.client = new Client(clientConfig);
    this.database = getConnectionSummary(env.POSTGRESQL_URL).database;
  }

  public async close(): Promise<void> {
    if (!this.connected) {
      return;
    }

    await this.client.end();
    this.connected = false;
  }

  public async listTables(input: {
    schema: string | null;
    includeSystemSchemas: boolean;
    limit: number;
  }): Promise<{
    database: string;
    tables: PostgreSqlTableSummary[];
  }> {
    const result = await this.execute(
      `
        select
          table_schema,
          table_name,
          table_type
        from information_schema.tables
        where ($1::text is null or table_schema = $1)
          and ($2::boolean or table_schema not in ('information_schema', 'pg_catalog'))
        order by table_schema asc, table_name asc
        limit $3
      `,
      [input.schema, input.includeSystemSchemas, input.limit],
    );

    return {
      database: this.database,
      tables: result.rows.map((row) => ({
        schema: readString(row.table_schema),
        name: readString(row.table_name),
        type: readString(row.table_type),
      })),
    };
  }

  public async describeTable(input: {
    schema: string;
    table: string;
  }): Promise<{
    database: string;
    schema: string;
    table: string;
    columns: PostgreSqlColumnSummary[];
    constraints: PostgreSqlConstraintSummary[];
  }> {
    const columnsResult = await this.execute(
      `
        select
          cols.column_name,
          cols.ordinal_position,
          cols.data_type,
          cols.is_nullable,
          cols.column_default,
          cols.character_maximum_length,
          cols.numeric_precision,
          cols.numeric_scale,
          pgd.description as comment
        from information_schema.columns cols
        left join pg_catalog.pg_statio_all_tables st
          on st.schemaname = cols.table_schema
         and st.relname = cols.table_name
        left join pg_catalog.pg_description pgd
          on pgd.objoid = st.relid
         and pgd.objsubid = cols.ordinal_position
        where cols.table_schema = $1
          and cols.table_name = $2
        order by cols.ordinal_position asc
      `,
      [input.schema, input.table],
    );

    if (columnsResult.rows.length === 0) {
      throw new ValidationError(`Table '${input.schema}.${input.table}' was not found.`);
    }

    const constraintsResult = await this.execute(
      `
        select
          tc.constraint_name,
          tc.constraint_type,
          array_remove(array_agg(kcu.column_name order by kcu.ordinal_position), null) as columns
        from information_schema.table_constraints tc
        left join information_schema.key_column_usage kcu
          on tc.constraint_name = kcu.constraint_name
         and tc.table_schema = kcu.table_schema
         and tc.table_name = kcu.table_name
        where tc.table_schema = $1
          and tc.table_name = $2
        group by tc.constraint_name, tc.constraint_type
        order by tc.constraint_name asc
      `,
      [input.schema, input.table],
    );

    return {
      database: this.database,
      schema: input.schema,
      table: input.table,
      columns: columnsResult.rows.map((row) => ({
        name: readString(row.column_name),
        ordinalPosition: readNumberOrNull(row.ordinal_position) ?? 0,
        dataType: readString(row.data_type),
        isNullable: readBooleanFlag(row.is_nullable),
        defaultValue: row.column_default === null ? null : readString(row.column_default),
        maxLength: readNumberOrNull(row.character_maximum_length),
        numericPrecision: readNumberOrNull(row.numeric_precision),
        numericScale: readNumberOrNull(row.numeric_scale),
        comment: row.comment === null ? null : readString(row.comment),
      })),
      constraints: constraintsResult.rows.map((row) => ({
        name: readString(row.constraint_name),
        type: readString(row.constraint_type),
        columns: readStringArray(row.columns),
      })),
    };
  }

  public async runQuery(input: {
    sql: string;
    params: readonly SqlParameter[];
  }): Promise<PostgreSqlQueryExecution> {
    const result = await this.execute(input.sql, input.params);
    return {
      rowCount: result.rowCount,
      fields: result.fields.map((field) => ({
        name: field.name,
        dataType: null,
      })),
      rows: result.rows.map((row) => sanitizeJsonValue(row) as JsonObject),
    };
  }

  private async ensureConnected(): Promise<void> {
    if (this.connected) {
      return;
    }

    try {
      await this.client.connect();
      this.connected = true;
    } catch (error) {
      throw new ExternalServiceError("Failed to connect to PostgreSQL.", {
        details: extractErrorMessage(error),
      });
    }
  }

  private async execute(text: string, values: readonly SqlParameter[] = []): Promise<RawPgQueryResult> {
    await this.ensureConnected();

    try {
      return await this.client.query(text, values);
    } catch (error) {
      throw new ExternalServiceError("PostgreSQL query failed.", {
        details: extractErrorMessage(error),
      });
    }
  }
}

export class PostgreSqlServer extends ToolkitServer {
  public constructor(
    private readonly env: PostgreSqlEnv,
    private readonly client: PostgreSqlClient,
  ) {
    super(metadata);

    this.registerTool(
      defineTool({
        name: "list-tables",
        title: "List PostgreSQL tables",
        description: "List tables and views visible to the configured PostgreSQL connection.",
        inputSchema: {
          schema: z.string().min(1).optional(),
          includeSystemSchemas: z.boolean().default(false),
          limit: z.number().int().positive().max(200).default(50),
        },
        outputSchema: {
          database: z.string(),
          schemaFilter: z.string().nullable(),
          tableCount: z.number().int().nonnegative(),
          tables: z.array(
            z.object({
              schema: z.string(),
              name: z.string(),
              type: z.string(),
            }),
          ),
        },
        handler: async ({ includeSystemSchemas, limit, schema }, context) => {
          await context.log("info", "Listing PostgreSQL tables.");
          const result = await this.client.listTables({
            schema: schema ?? null,
            includeSystemSchemas,
            limit,
          });

          return {
            database: result.database,
            schemaFilter: schema ?? null,
            tableCount: result.tables.length,
            tables: result.tables,
          };
        },
        renderText: (output) => `${output.tableCount} tables found in ${output.database}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "describe-table",
        title: "Describe PostgreSQL table",
        description: "Inspect columns and constraints for a PostgreSQL table.",
        inputSchema: {
          schema: z.string().min(1).default(this.env.POSTGRESQL_SCHEMA),
          table: z.string().min(1),
        },
        outputSchema: {
          database: z.string(),
          schema: z.string(),
          table: z.string(),
          columnCount: z.number().int().nonnegative(),
          columns: z.array(
            z.object({
              name: z.string(),
              ordinalPosition: z.number().int().nonnegative(),
              dataType: z.string(),
              isNullable: z.boolean(),
              defaultValue: z.string().nullable(),
              maxLength: z.number().int().nonnegative().nullable(),
              numericPrecision: z.number().int().nonnegative().nullable(),
              numericScale: z.number().int().nonnegative().nullable(),
              comment: z.string().nullable(),
            }),
          ),
          constraints: z.array(
            z.object({
              name: z.string(),
              type: z.string(),
              columns: z.array(z.string()),
            }),
          ),
        },
        handler: async ({ schema, table }, context) => {
          await context.log("info", `Describing ${schema}.${table}.`);
          const result = await this.client.describeTable({ schema, table });
          return {
            database: result.database,
            schema: result.schema,
            table: result.table,
            columnCount: result.columns.length,
            columns: result.columns,
            constraints: result.constraints,
          };
        },
        renderText: (output) => `${output.schema}.${output.table} has ${output.columnCount} columns.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "run-query",
        title: "Run PostgreSQL query",
        description: "Run a PostgreSQL query with a read-only-by-default safety guard.",
        inputSchema: {
          sql: z.string().min(1),
          params: z.array(z.union([z.string(), z.number().finite(), z.boolean(), z.null()])).default([]),
          allowWrite: z.boolean().default(false),
        },
        outputSchema: {
          statementType: z.string(),
          rowCount: z.number().int().nonnegative().nullable(),
          fieldCount: z.number().int().nonnegative(),
          fields: z.array(
            z.object({
              name: z.string(),
              dataType: z.string().nullable(),
            }),
          ),
          returnedRows: z.number().int().nonnegative(),
          truncated: z.boolean(),
          rows: z.array(jsonObjectSchema),
        },
        handler: async ({ allowWrite, params, sql }, context) => {
          const statementType = inferStatementType(sql);
          const mutating = isPotentiallyMutatingSql(sql);
          if (mutating && (!this.env.POSTGRESQL_ALLOW_WRITES || !allowWrite)) {
            throw new ValidationError(
              "Mutating SQL is blocked by default. Set POSTGRESQL_ALLOW_WRITES=true and pass allowWrite=true to run write statements.",
            );
          }

          if (mutating) {
            await context.log("warning", "Executing an opt-in write query against PostgreSQL.");
          } else {
            await context.log("info", `Executing read-only ${statementType} query.`);
          }

          const execution = await this.client.runQuery({ sql, params });
          const rows = execution.rows.slice(0, this.env.POSTGRESQL_MAX_RESULT_ROWS);
          return {
            statementType,
            rowCount: execution.rowCount,
            fieldCount: execution.fields.length,
            fields: execution.fields,
            returnedRows: rows.length,
            truncated: execution.rows.length > rows.length,
            rows,
          };
        },
        renderText: (output) => `${output.statementType} returned ${output.returnedRows} row(s).`,
      }),
    );

    this.registerStaticResource(
      "schema-overview",
      "postgresql://schema-overview",
      {
        title: "PostgreSQL schema overview",
        description: "Connection summary and a snapshot of tables from the default schema.",
        mimeType: "application/json",
      },
      async () => {
        const connection = getConnectionSummary(this.env.POSTGRESQL_URL);
        const tables = await this.client.listTables({
          schema: this.env.POSTGRESQL_SCHEMA,
          includeSystemSchemas: false,
          limit: this.env.POSTGRESQL_RESOURCE_TABLE_LIMIT,
        });

        return this.createJsonResource("postgresql://schema-overview", {
          connection,
          defaultSchema: this.env.POSTGRESQL_SCHEMA,
          writeQueriesEnabled: this.env.POSTGRESQL_ALLOW_WRITES,
          tables: tables.tables,
        });
      },
    );

    this.registerPrompt(
      "query-review",
      {
        title: "PostgreSQL query review",
        description: "Generate a review checklist for a PostgreSQL query before execution.",
        argsSchema: {
          objective: z.string().min(1),
          sql: z.string().min(1),
          allowWrite: z.boolean().default(false),
        },
      },
      async ({ allowWrite, objective, sql }) =>
        this.createTextPrompt(
          [
            "Review this PostgreSQL query before it is executed.",
            `Objective: ${objective}`,
            `Default schema: ${this.env.POSTGRESQL_SCHEMA}`,
            `Write access enabled: ${this.env.POSTGRESQL_ALLOW_WRITES}`,
            `Caller requested write execution: ${allowWrite}`,
            "Check for:",
            "- unexpected table scans or missing predicates",
            "- whether LIMIT, ORDER BY, or EXPLAIN would improve safety",
            "- lock or mutation risks",
            "- whether the SQL matches the stated objective",
            "",
            "SQL:",
            sql,
          ].join("\n"),
        ),
    );
  }

  public override async close(): Promise<void> {
    await this.client.close?.();
    await super.close();
  }
}

export interface CreatePostgreSqlServerOptions {
  env?: PostgreSqlEnv;
  client?: PostgreSqlClient;
}

export function createServer(options: CreatePostgreSqlServerOptions = {}): PostgreSqlServer {
  const env = options.env ?? loadEnv(postgresqlEnvShape);
  const client = options.client ?? new NodePostgreSqlClient(env);
  return new PostgreSqlServer(env, client);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const env = loadEnv(postgresqlEnvShape);
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
    console.error(`Failed to start PostgreSQL MCP server: ${message}`);
    process.exitCode = 1;
  });
}
