import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const AIRTABLE_API_BASE_URL = "https://api.airtable.com/v0";

const LIST_TABLES_TOOL_NAME = "airtable_list_tables";
const GET_RECORDS_TOOL_NAME = "airtable_get_records";
const CREATE_RECORD_TOOL_NAME = "airtable_create_record";
const UPDATE_RECORD_TOOL_NAME = "airtable_update_record";
const DELETE_RECORD_TOOL_NAME = "airtable_delete_record";

export const metadata = {
  id: "airtable",
  title: "Airtable MCP Server",
  description: "Table listing, record CRUD, and filtering for Airtable bases.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-airtable",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["AIRTABLE_API_KEY", "AIRTABLE_BASE_ID"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    LIST_TABLES_TOOL_NAME,
    GET_RECORDS_TOOL_NAME,
    CREATE_RECORD_TOOL_NAME,
    UPDATE_RECORD_TOOL_NAME,
    DELETE_RECORD_TOOL_NAME,
  ] as const,
  resourceNames: [] as const,
  promptNames: [] as const,
} satisfies ToolkitServerMetadata;

export const serverCard = createServerCard(metadata);

function extractErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

// --- Zod schemas ---

const tableSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  primaryFieldId: z.string().optional(),
  fields: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().default(""),
        type: z.string().default(""),
      }),
    )
    .optional(),
});

const recordSchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), z.unknown()).default({}),
  createdTime: z.string().optional(),
});

const listTablesResponseSchema = z.object({
  tables: z.array(tableSchema),
});

const listRecordsResponseSchema = z.object({
  records: z.array(recordSchema),
  offset: z.string().optional(),
});

const singleRecordResponseSchema = recordSchema;

const deleteRecordResponseSchema = z.object({
  id: z.string().min(1),
  deleted: z.boolean(),
});

// --- Tool input/output shapes ---

const listTablesInputShape = {
  includeFieldDetails: z.boolean().default(false).describe("Include field type details for each table."),
};

const tableSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  fieldCount: z.number().int().nonnegative(),
});

const listTablesOutputShape = {
  tables: z.array(tableSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const getRecordsInputShape = {
  tableName: z.string().trim().min(1).describe("The name or ID of the table to fetch records from."),
  filterByFormula: z.string().trim().min(1).optional().describe("An Airtable formula to filter records."),
  maxRecords: z.coerce.number().int().min(1).max(100).default(100).describe("Maximum number of records to return (max 100)."),
};

const recordSummarySchema = z.object({
  id: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
  createdTime: z.string().nullable(),
});

const getRecordsOutputShape = {
  tableName: z.string().min(1),
  records: z.array(recordSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const createRecordInputShape = {
  tableName: z.string().trim().min(1).describe("The name or ID of the table to create the record in."),
  fields: z.record(z.string(), z.unknown()).describe("An object of field names to values for the new record."),
};

const createRecordOutputShape = {
  id: z.string().min(1),
  tableName: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
  createdTime: z.string().nullable(),
};

const updateRecordInputShape = {
  tableName: z.string().trim().min(1).describe("The name or ID of the table."),
  recordId: z.string().trim().min(1).describe("The ID of the record to update."),
  fields: z.record(z.string(), z.unknown()).describe("An object of field names to updated values."),
};

const updateRecordOutputShape = {
  id: z.string().min(1),
  tableName: z.string().min(1),
  fields: z.record(z.string(), z.unknown()),
};

const deleteRecordInputShape = {
  tableName: z.string().trim().min(1).describe("The name or ID of the table."),
  recordId: z.string().trim().min(1).describe("The ID of the record to delete."),
};

const deleteRecordOutputShape = {
  id: z.string().min(1),
  tableName: z.string().min(1),
  deleted: z.boolean(),
};

// --- Client interface ---

export interface AirtableTableSummary {
  id: string;
  name: string;
  fieldCount: number;
}

export interface AirtableRecordSummary {
  id: string;
  fields: Record<string, unknown>;
  createdTime: string | null;
}

export interface AirtableClient {
  listTables(): Promise<AirtableTableSummary[]>;
  getRecords(tableName: string, filterByFormula: string | undefined, maxRecords: number): Promise<AirtableRecordSummary[]>;
  createRecord(tableName: string, fields: Record<string, unknown>): Promise<AirtableRecordSummary>;
  updateRecord(tableName: string, recordId: string, fields: Record<string, unknown>): Promise<{ id: string; fields: Record<string, unknown> }>;
  deleteRecord(tableName: string, recordId: string): Promise<{ id: string; deleted: boolean }>;
}

// --- Concrete client ---

class RestAirtableClient implements AirtableClient {
  private readonly baseId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  public constructor(token: string, baseId: string, baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.baseId = baseId;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  public async listTables(): Promise<AirtableTableSummary[]> {
    const payload = await this.request("GET", `/bases/${this.baseId}/tables`, undefined, true);
    const parsed = listTablesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Airtable returned an unexpected table list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.tables.map((t) => ({
      id: t.id,
      name: t.name,
      fieldCount: t.fields?.length ?? 0,
    }));
  }

  public async getRecords(tableName: string, filterByFormula: string | undefined, maxRecords: number): Promise<AirtableRecordSummary[]> {
    const query: Record<string, string> = { pageSize: String(maxRecords) };
    if (filterByFormula) {
      query.filterByFormula = filterByFormula;
    }
    const payload = await this.request("GET", `/${this.baseId}/${encodeURIComponent(tableName)}`, undefined, false, query);
    const parsed = listRecordsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Airtable returned an unexpected record list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.records.map((r) => ({
      id: r.id,
      fields: r.fields,
      createdTime: r.createdTime ?? null,
    }));
  }

  public async createRecord(tableName: string, fields: Record<string, unknown>): Promise<AirtableRecordSummary> {
    const payload = await this.request("POST", `/${this.baseId}/${encodeURIComponent(tableName)}`, { fields }, false);
    const parsed = singleRecordResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Airtable returned an unexpected create response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      id: parsed.data.id,
      fields: parsed.data.fields,
      createdTime: parsed.data.createdTime ?? null,
    };
  }

  public async updateRecord(tableName: string, recordId: string, fields: Record<string, unknown>): Promise<{ id: string; fields: Record<string, unknown> }> {
    const payload = await this.request("PATCH", `/${this.baseId}/${encodeURIComponent(tableName)}/${recordId}`, { fields }, false);
    const parsed = singleRecordResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Airtable returned an unexpected update response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      id: parsed.data.id,
      fields: parsed.data.fields,
    };
  }

  public async deleteRecord(tableName: string, recordId: string): Promise<{ id: string; deleted: boolean }> {
    const payload = await this.request("DELETE", `/${this.baseId}/${encodeURIComponent(tableName)}/${recordId}`, undefined, false);
    const parsed = deleteRecordResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Airtable returned an unexpected delete response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return { id: parsed.data.id, deleted: parsed.data.deleted };
  }

  private async request(
    method: "DELETE" | "GET" | "PATCH" | "POST",
    path: string,
    body?: object,
    isMetaApi = false,
    query?: Record<string, string>,
  ): Promise<unknown> {
    const baseApiUrl = isMetaApi ? "https://api.airtable.com/v0/meta" : this.baseUrl;
    const url = new URL(`${baseApiUrl}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        url.searchParams.set(key, value);
      }
    }

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/json",
    };

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Airtable API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`Airtable API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Airtable authentication failed. Verify AIRTABLE_API_KEY.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Airtable denied access to '${path}'. The token may lack required permissions.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Airtable resource at '${path}' was not found. Verify AIRTABLE_BASE_ID and table name.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 422) {
        throw new ExternalServiceError(`Airtable rejected the request to '${path}' due to invalid data.`, {
          statusCode: 422,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Airtable rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Airtable API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Render helpers ---

function renderTables(tables: AirtableTableSummary[]): string {
  if (tables.length === 0) {
    return "No tables found in the Airtable base.";
  }
  const lines = tables.map((t) => `- ${t.name} (${t.id}, ${t.fieldCount} fields)`);
  return [`Found ${tables.length} table(s).`, ...lines].join("\n");
}

function renderRecords(records: AirtableRecordSummary[]): string {
  if (records.length === 0) {
    return "No records matched the query.";
  }
  const lines = records.slice(0, 10).map((r) => {
    const fieldKeys = Object.keys(r.fields).slice(0, 5).join(", ");
    return `- ${r.id}: {${fieldKeys}}`;
  });
  if (records.length > 10) {
    lines.push(`- ${records.length - 10} additional record(s) omitted.`);
  }
  return [`Returned ${records.length} record(s).`, ...lines].join("\n");
}

function renderCreatedRecord(id: string, tableName: string): string {
  return `Created record ${id} in table ${tableName}.`;
}

function renderUpdatedRecord(id: string, tableName: string): string {
  return `Updated record ${id} in table ${tableName}.`;
}

function renderDeletedRecord(id: string, tableName: string): string {
  return `Deleted record ${id} from table ${tableName}.`;
}

// --- Server ---

export interface AirtableServerOptions {
  baseId: string;
  client: AirtableClient;
}

export class AirtableServer extends ToolkitServer {
  private readonly baseId: string;
  private readonly client: AirtableClient;

  public constructor(options: AirtableServerOptions) {
    super(metadata);
    this.baseId = options.baseId;
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: LIST_TABLES_TOOL_NAME,
        title: "List Airtable tables",
        description: "List all tables in the configured Airtable base.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listTablesInputShape,
        outputSchema: listTablesOutputShape,
        handler: async (_input, context) => {
          await context.log("info", "Listing Airtable tables.");
          try {
            const tables = await this.client.listTables();
            return { tables, returnedCount: tables.length };
          } catch (error) {
            throw this.mapOperationError(LIST_TABLES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderTables(output.tables),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_RECORDS_TOOL_NAME,
        title: "Get Airtable records",
        description: "Fetch records from a table with optional formula filtering.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getRecordsInputShape,
        outputSchema: getRecordsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching records from table ${input.tableName}.`);
          try {
            const records = await this.client.getRecords(input.tableName, input.filterByFormula, input.maxRecords);
            return { tableName: input.tableName, records, returnedCount: records.length };
          } catch (error) {
            throw this.mapOperationError(GET_RECORDS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderRecords(output.records),
      }),
    );

    this.registerTool(
      defineTool({
        name: CREATE_RECORD_TOOL_NAME,
        title: "Create Airtable record",
        description: "Create a new record in an Airtable table with the given fields.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: createRecordInputShape,
        outputSchema: createRecordOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Creating record in table ${input.tableName}.`);
          try {
            const record = await this.client.createRecord(input.tableName, input.fields);
            return {
              id: record.id,
              tableName: input.tableName,
              fields: record.fields,
              createdTime: record.createdTime,
            };
          } catch (error) {
            throw this.mapOperationError(CREATE_RECORD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderCreatedRecord(output.id, output.tableName),
      }),
    );

    this.registerTool(
      defineTool({
        name: UPDATE_RECORD_TOOL_NAME,
        title: "Update Airtable record",
        description: "Update an existing record in an Airtable table by record ID.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: updateRecordInputShape,
        outputSchema: updateRecordOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Updating record ${input.recordId} in table ${input.tableName}.`);
          try {
            const result = await this.client.updateRecord(input.tableName, input.recordId, input.fields);
            return { id: result.id, tableName: input.tableName, fields: result.fields };
          } catch (error) {
            throw this.mapOperationError(UPDATE_RECORD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderUpdatedRecord(output.id, output.tableName),
      }),
    );

    this.registerTool(
      defineTool({
        name: DELETE_RECORD_TOOL_NAME,
        title: "Delete Airtable record",
        description: "Delete a record by ID from an Airtable table.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: deleteRecordInputShape,
        outputSchema: deleteRecordOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Deleting record ${input.recordId} from table ${input.tableName}.`);
          try {
            const result = await this.client.deleteRecord(input.tableName, input.recordId);
            return { id: result.id, tableName: input.tableName, deleted: result.deleted };
          } catch (error) {
            throw this.mapOperationError(DELETE_RECORD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderDeletedRecord(output.id, output.tableName),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError | ValidationError {
    if (error instanceof ExternalServiceError || error instanceof ValidationError) {
      return error;
    }
    return new ExternalServiceError(`Airtable operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateAirtableServerOptions {
  client?: AirtableClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  AIRTABLE_API_KEY: z.string().trim().min(1, "AIRTABLE_API_KEY is required."),
  AIRTABLE_BASE_ID: z.string().trim().min(1, "AIRTABLE_BASE_ID is required."),
  AIRTABLE_API_BASE_URL: z.string().trim().url().default(AIRTABLE_API_BASE_URL),
};

export function createServer(options: CreateAirtableServerOptions = {}): AirtableServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ?? new RestAirtableClient(env.AIRTABLE_API_KEY, env.AIRTABLE_BASE_ID, env.AIRTABLE_API_BASE_URL, options.fetchImpl);
  return new AirtableServer({ baseId: env.AIRTABLE_BASE_ID, client });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await runToolkitServer(
    {
      createServer,
      serverCard,
    },
    parseRuntimeOptions(argv),
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error) => {
    const normalized = normalizeError(error);
    process.stderr.write(`${normalized.toClientMessage()}\n`);
    process.exitCode = 1;
  });
}
