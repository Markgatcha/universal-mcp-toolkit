import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const SHEETS_API_BASE_URL = "https://sheets.googleapis.com/v4";
const DRIVE_API_BASE_URL = "https://www.googleapis.com/drive/v3";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const LIST_SPREADSHEETS_TOOL_NAME = "sheets_list_spreadsheets";
const GET_VALUES_TOOL_NAME = "sheets_get_values";
const UPDATE_VALUES_TOOL_NAME = "sheets_update_values";
const APPEND_VALUES_TOOL_NAME = "sheets_append_values";
const GET_METADATA_TOOL_NAME = "sheets_get_metadata";

export const metadata = {
  id: "google-sheets",
  title: "Google Sheets MCP Server",
  description: "List, read, and write Google Sheets data via the Sheets API v4 and Drive API v3.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-google-sheets",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["SHEETS_CLIENT_ID", "SHEETS_CLIENT_SECRET", "SHEETS_REFRESH_TOKEN"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    LIST_SPREADSHEETS_TOOL_NAME,
    GET_VALUES_TOOL_NAME,
    UPDATE_VALUES_TOOL_NAME,
    APPEND_VALUES_TOOL_NAME,
    GET_METADATA_TOOL_NAME,
  ] as const,
  resourceNames: [] as const,
  promptNames: [] as const,
} satisfies ToolkitServerMetadata;

export const serverCard = createServerCard(metadata);

function toNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

// --- Zod schemas (raw Google API responses) ---

const driveFileSchema = z.object({
  id: z.string().min(1),
  name: z.string().nullable().optional(),
  modifiedTime: z.string().nullable().optional(),
});

const driveFileListSchema = z.object({
  files: z.array(driveFileSchema).optional(),
  nextPageToken: z.string().nullable().optional(),
});

const sheetsValuesResponseSchema = z.object({
  range: z.string().nullable().optional(),
  majorDimension: z.string().nullable().optional(),
  values: z.array(z.array(z.string())).nullable().optional(),
});

const sheetsUpdateResponseSchema = z.object({
  spreadsheetId: z.string().nullable().optional(),
  updatedRange: z.string().nullable().optional(),
  updatedRows: z.number().int().nullable().optional(),
  updatedColumns: z.number().int().nullable().optional(),
  updatedCells: z.number().int().nullable().optional(),
});

const sheetsAppendResponseSchema = z.object({
  spreadsheetId: z.string().nullable().optional(),
  tableRange: z.string().nullable().optional(),
  updates: z
    .object({
      updatedRange: z.string().nullable().optional(),
      updatedRows: z.number().int().nullable().optional(),
      updatedColumns: z.number().int().nullable().optional(),
      updatedCells: z.number().int().nullable().optional(),
    })
    .nullable()
    .optional(),
});

const sheetPropertiesSchema = z
  .object({
    sheetId: z.number().int().nullable().optional(),
    title: z.string().nullable().optional(),
    index: z.number().int().nullable().optional(),
  })
  .passthrough();

const gridPropertiesSchema = z
  .object({
    rowCount: z.number().int().nullable().optional(),
    columnCount: z.number().int().nullable().optional(),
  })
  .passthrough();

const sheetEntrySchema = z.object({
  properties: sheetPropertiesSchema.optional(),
});

const spreadsheetMetadataSchema = z.object({
  spreadsheetId: z.string().min(1),
  properties: z
    .object({ title: z.string().nullable().optional() })
    .passthrough()
    .optional(),
  sheets: z.array(sheetEntrySchema).optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

// --- Tool shapes ---

const spreadsheetSummarySchema = z.object({
  spreadsheetId: z.string().min(1).describe("Google Drive file ID of the spreadsheet."),
  name: z.string().describe("Spreadsheet display name."),
  modifiedTime: z.string().nullable().describe("RFC 3339 last-modified timestamp."),
});

const listSpreadsheetsInputShape = {
  maxResults: z.coerce.number().int().min(1).max(30).default(10).describe("Maximum spreadsheets to return (1-30)."),
};

const listSpreadsheetsOutputShape = {
  spreadsheets: z.array(spreadsheetSummarySchema).max(50).describe("Accessible spreadsheet summaries."),
  returnedCount: z.number().int().nonnegative().describe("Number of spreadsheets returned."),
};

const getValuesInputShape = {
  spreadsheetId: z.string().trim().min(1).describe("The spreadsheet ID to read from."),
  range: z.string().trim().min(1).describe("A1 notation range, e.g. 'Sheet1!A1:D10'."),
};

const getValuesOutputShape = {
  spreadsheetId: z.string().min(1).describe("The spreadsheet that was read."),
  range: z.string().describe("The range that was returned."),
  values: z.array(z.array(z.string())).max(50).describe("Row-major cell values."),
};

const updateValuesInputShape = {
  spreadsheetId: z.string().trim().min(1).describe("The spreadsheet ID to write to."),
  range: z.string().trim().min(1).describe("A1 notation range to overwrite."),
  values: z.array(z.array(z.string())).min(1).max(50).describe("Row-major values to write."),
};

const updateValuesOutputShape = {
  spreadsheetId: z.string().min(1).describe("The spreadsheet that was updated."),
  updatedRange: z.string().nullable().describe("The range that was written."),
  updatedRows: z.number().int().nullable().describe("Number of rows written."),
  updatedColumns: z.number().int().nullable().describe("Number of columns written."),
  updatedCells: z.number().int().nullable().describe("Total cells written."),
};

const appendValuesInputShape = {
  spreadsheetId: z.string().trim().min(1).describe("The spreadsheet ID to append to."),
  range: z.string().trim().min(1).describe("A1 notation range indicating where to append (e.g. 'Sheet1!A1')."),
  values: z.array(z.array(z.string())).min(1).max(50).describe("Row-major values to append."),
};

const appendValuesOutputShape = {
  spreadsheetId: z.string().min(1).describe("The spreadsheet that was appended to."),
  tableRange: z.string().nullable().describe("The range of existing data before the append."),
  updatedRange: z.string().nullable().describe("The range that was appended."),
  updatedRows: z.number().int().nullable().describe("Number of rows appended."),
};

const sheetMetadataSchema = z.object({
  title: z.string().describe("Sheet/tab display name."),
  sheetId: z.number().int().nullable().describe("Numeric sheet ID."),
  rowCount: z.number().int().nullable().describe("Number of rows in the sheet."),
  columnCount: z.number().int().nullable().describe("Number of columns in the sheet."),
});

const getMetadataInputShape = {
  spreadsheetId: z.string().trim().min(1).describe("The spreadsheet ID to inspect."),
};

const getMetadataOutputShape = {
  spreadsheetId: z.string().min(1).describe("The spreadsheet ID."),
  title: z.string().describe("Spreadsheet title."),
  sheets: z.array(sheetMetadataSchema).max(50).describe("Per-tab metadata."),
};

// --- Client interface ---

export interface SheetsSpreadsheetSummary {
  spreadsheetId: string;
  name: string;
  modifiedTime: string | null;
}

export interface SheetsMetadata {
  spreadsheetId: string;
  title: string;
  sheets: Array<{ title: string; sheetId: number | null; rowCount: number | null; columnCount: number | null }>;
}

export interface SheetsClient {
  listSpreadsheets(maxResults: number): Promise<SheetsSpreadsheetSummary[]>;
  getValues(spreadsheetId: string, range: string): Promise<{ spreadsheetId: string; range: string; values: string[][] }>;
  updateValues(spreadsheetId: string, range: string, values: string[][]): Promise<{ spreadsheetId: string; updatedRange: string | null; updatedRows: number | null; updatedColumns: number | null; updatedCells: number | null }>;
  appendValues(spreadsheetId: string, range: string, values: string[][]): Promise<{ spreadsheetId: string; tableRange: string | null; updatedRange: string | null; updatedRows: number | null }>;
  getMetadata(spreadsheetId: string): Promise<SheetsMetadata>;
}

// --- Concrete client ---

class RestSheetsClient implements SheetsClient {
  private readonly sheetsBaseUrl: string;
  private readonly driveBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private initialized = false;

  public constructor(input: { clientId: string; clientSecret: string; refreshToken: string; sheetsBaseUrl: string; driveBaseUrl: string; fetchImpl?: typeof fetch }) {
    this.clientId = input.clientId;
    this.clientSecret = input.clientSecret;
    this.refreshToken = input.refreshToken;
    this.sheetsBaseUrl = input.sheetsBaseUrl.replace(/\/+$/, "");
    this.driveBaseUrl = input.driveBaseUrl.replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // Prefetch an access token once so the first real request is not delayed.
    await this.refreshAccessToken();
    this.initialized = true;
  }

  public async listSpreadsheets(maxResults: number): Promise<SheetsSpreadsheetSummary[]> {
    await this.ensureInitialized();
    const params = new URLSearchParams({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      pageSize: String(maxResults),
      fields: "files(id,name,modifiedTime),nextPageToken",
      orderBy: "modifiedByMeTime desc",
    });
    const payload = await this.request(this.driveBaseUrl, "GET", `/files?${params.toString()}`);
    const parsed = driveFileListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Google Drive returned an unexpected spreadsheet list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return (parsed.data.files ?? []).map((file) => ({
      spreadsheetId: file.id,
      name: file.name ?? file.id,
      modifiedTime: toNullableString(file.modifiedTime),
    }));
  }

  public async getValues(spreadsheetId: string, range: string): Promise<{ spreadsheetId: string; range: string; values: string[][] }> {
    await this.ensureInitialized();
    const payload = await this.request(this.sheetsBaseUrl, "GET", `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}`);
    const parsed = sheetsValuesResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Sheets API returned an unexpected values response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      spreadsheetId,
      range: parsed.data.range ?? range,
      values: parsed.data.values ?? [],
    };
  }

  public async updateValues(spreadsheetId: string, range: string, values: string[][]): Promise<{ spreadsheetId: string; updatedRange: string | null; updatedRows: number | null; updatedColumns: number | null; updatedCells: number | null }> {
    await this.ensureInitialized();
    const params = new URLSearchParams({ valueInputOption: "USER_ENTERED" });
    const path = `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?${params.toString()}`;
    const payload = await this.request(this.sheetsBaseUrl, "PUT", path, { values });
    const parsed = sheetsUpdateResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Sheets API returned an unexpected update response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      spreadsheetId,
      updatedRange: toNullableString(parsed.data.updatedRange),
      updatedRows: parsed.data.updatedRows ?? null,
      updatedColumns: parsed.data.updatedColumns ?? null,
      updatedCells: parsed.data.updatedCells ?? null,
    };
  }

  public async appendValues(spreadsheetId: string, range: string, values: string[][]): Promise<{ spreadsheetId: string; tableRange: string | null; updatedRange: string | null; updatedRows: number | null }> {
    await this.ensureInitialized();
    const params = new URLSearchParams({ valueInputOption: "USER_ENTERED", insertDataOption: "INSERT_ROWS" });
    const path = `/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`;
    const payload = await this.request(this.sheetsBaseUrl, "POST", path, { values });
    const parsed = sheetsAppendResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Sheets API returned an unexpected append response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      spreadsheetId,
      tableRange: toNullableString(parsed.data.tableRange),
      updatedRange: toNullableString(parsed.data.updates?.updatedRange),
      updatedRows: parsed.data.updates?.updatedRows ?? null,
    };
  }

  public async getMetadata(spreadsheetId: string): Promise<SheetsMetadata> {
    await this.ensureInitialized();
    const params = new URLSearchParams({ fields: "spreadsheetId,properties.title,sheets(properties)" });
    const payload = await this.request(this.sheetsBaseUrl, "GET", `/${encodeURIComponent(spreadsheetId)}?${params.toString()}`);
    const parsed = spreadsheetMetadataSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Sheets API returned an unexpected metadata response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return mapMetadata(parsed.data);
  }

  private async refreshAccessToken(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: this.refreshToken,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          "Connection": "keep-alive",
          "Keep-Alive": "timeout=30, max=100",
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new ExternalServiceError("Unable to reach Google OAuth token endpoint.", {
        statusCode: 502,
        details: { cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let tokenPayload: unknown;
    try {
      tokenPayload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError("Google OAuth token endpoint returned malformed JSON.", {
        statusCode: 502,
        details: { rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      throw new ExternalServiceError("Failed to refresh Sheets access token. Verify SHEETS_CLIENT_ID, SHEETS_CLIENT_SECRET, and SHEETS_REFRESH_TOKEN.", {
        statusCode: 401,
        details: { statusCode: response.status, body: tokenPayload },
      });
    }

    const parsed = tokenResponseSchema.safeParse(tokenPayload);
    if (!parsed.success) {
      throw new ExternalServiceError("Google OAuth token endpoint returned an unexpected token shape.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }

    this.accessToken = parsed.data.access_token;
    const expiresIn = parsed.data.expires_in ?? 3600;
    // Refresh slightly before the real expiry to avoid edge-case failures.
    this.accessTokenExpiresAt = Date.now() + Math.max(60, expiresIn - 60) * 1000;
    return parsed.data.access_token;
  }

  private async getValidAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessTokenExpiresAt) {
      return this.accessToken;
    }
    return this.refreshAccessToken();
  }

  private async request(baseUrl: string, method: "GET" | "POST" | "PUT", path: string, body?: object): Promise<unknown> {
    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=30, max=100",
    };

    const requestInit: RequestInit = { method, headers };

    if (body) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(body);
    }

    headers["Authorization"] = `Bearer ${await this.getValidAccessToken()}`;

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Google API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    // On 401, force a single token refresh and retry once.
    if (response.status === 401) {
      await this.refreshAccessToken();
      headers["Authorization"] = `Bearer ${this.accessToken ?? ""}`;
      try {
        response = await this.fetchImpl(url, { ...requestInit, headers });
      } catch (error) {
        throw new ExternalServiceError(`Unable to reach Google API at '${path}'.`, {
          statusCode: 502,
          details: { path, cause: extractErrorDetails(error) },
        });
      }
    }

    return this.parseResponse(response, path);
  }

  private async parseResponse(response: Response, path: string): Promise<unknown> {
    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`Google API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Google authentication failed. Verify the OAuth refresh token credentials.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Google denied access to '${path}'. The OAuth scope may be missing.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Google resource at '${path}' was not found.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Google rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Google API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Mapping helpers ---

function mapMetadata(raw: z.infer<typeof spreadsheetMetadataSchema>): SheetsMetadata {
  return {
    spreadsheetId: raw.spreadsheetId,
    title: raw.properties?.title ?? raw.spreadsheetId,
    sheets: (raw.sheets ?? []).map((entry, index) => {
      const props = entry.properties;
      const grid = props as z.infer<typeof sheetPropertiesSchema> & {
        gridProperties?: z.infer<typeof gridPropertiesSchema>;
      };
      return {
        title: props?.title ?? `Sheet${index + 1}`,
        sheetId: props?.sheetId ?? null,
        rowCount: grid.gridProperties?.rowCount ?? null,
        columnCount: grid.gridProperties?.columnCount ?? null,
      };
    }),
  };
}

// --- Render helpers ---

function renderSpreadsheets(spreadsheets: SheetsSpreadsheetSummary[]): string {
  if (spreadsheets.length === 0) {
    return "No spreadsheets found.";
  }
  const shown = spreadsheets.slice(0, 5);
  const lines = shown.map((s) => {
    const parts: string[] = [s.name];
    if (s.modifiedTime) {
      parts.push(s.modifiedTime.slice(0, 10));
    }
    return `- ${parts.join(" | ")}`;
  });
  const omitted = spreadsheets.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use maxResults to adjust)`);
  }
  return [`✓ ${spreadsheets.length} spreadsheets`, ...lines].join("\n");
}

function renderValues(range: string, values: string[][]): string {
  if (values.length === 0) {
    return `Range '${range}' is empty.`;
  }
  const shown = values.slice(0, 5);
  const lines = shown.map((row) => `- ${row.join(" | ")}`);
  const omitted = values.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more rows, narrow the range to adjust)`);
  }
  return [`✓ ${values.length} rows in ${range}`, ...lines].join("\n");
}

function renderUpdate(output: { spreadsheetId: string; updatedRange: string | null; updatedRows: number | null; updatedCells: number | null }): string {
  const where = output.updatedRange ? ` to ${output.updatedRange}` : "";
  const rows = output.updatedRows !== null ? ` (${output.updatedRows} rows, ${output.updatedCells ?? 0} cells)` : "";
  return `✓ Updated spreadsheet ${output.spreadsheetId}${where}${rows}.`;
}

function renderAppend(output: { spreadsheetId: string; updatedRange: string | null; updatedRows: number | null }): string {
  const where = output.updatedRange ? ` at ${output.updatedRange}` : "";
  const rows = output.updatedRows !== null ? ` (${output.updatedRows} rows)` : "";
  return `✓ Appended to spreadsheet ${output.spreadsheetId}${where}${rows}.`;
}

function renderMetadata(metadata: SheetsMetadata): string {
  const lines: string[] = [`✓ ${metadata.title}`];
  for (const sheet of metadata.sheets.slice(0, 5)) {
    const dims: string[] = [];
    if (sheet.rowCount !== null) {
      dims.push(`${sheet.rowCount} rows`);
    }
    if (sheet.columnCount !== null) {
      dims.push(`${sheet.columnCount} cols`);
    }
    const dimText = dims.length > 0 ? ` | ${dims.join(" × ")}` : "";
    lines.push(`- ${sheet.title}${dimText}`);
  }
  return lines.join("\n");
}

// --- Server ---

export interface GoogleSheetsServerOptions {
  client: SheetsClient;
}

export class GoogleSheetsServer extends ToolkitServer {
  private readonly client: SheetsClient;

  public constructor(options: GoogleSheetsServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: LIST_SPREADSHEETS_TOOL_NAME,
        title: "List Google Sheets spreadsheets",
        description: "List accessible Google Sheets spreadsheets via the Google Drive API.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listSpreadsheetsInputShape,
        outputSchema: listSpreadsheetsOutputShape,
        handler: async (input, context) => {
          await context.log("info", "Listing Google Sheets spreadsheets.");
          try {
            const spreadsheets = await this.client.listSpreadsheets(input.maxResults);
            return { spreadsheets, returnedCount: spreadsheets.length };
          } catch (error) {
            throw this.mapOperationError(LIST_SPREADSHEETS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderSpreadsheets(output.spreadsheets),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_VALUES_TOOL_NAME,
        title: "Get Google Sheets values",
        description: "Read a cell range from a Google Sheets spreadsheet using A1 notation.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getValuesInputShape,
        outputSchema: getValuesOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Reading range '${input.range}' from spreadsheet ${input.spreadsheetId}.`);
          try {
            return await this.client.getValues(input.spreadsheetId, input.range);
          } catch (error) {
            throw this.mapOperationError(GET_VALUES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderValues(output.range, output.values),
      }),
    );

    this.registerTool(
      defineTool({
        name: UPDATE_VALUES_TOOL_NAME,
        title: "Update Google Sheets values",
        description: "Overwrite a cell range in a Google Sheets spreadsheet using A1 notation.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: updateValuesInputShape,
        outputSchema: updateValuesOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Updating range '${input.range}' in spreadsheet ${input.spreadsheetId}.`);
          try {
            return await this.client.updateValues(input.spreadsheetId, input.range, input.values);
          } catch (error) {
            throw this.mapOperationError(UPDATE_VALUES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderUpdate(output),
      }),
    );

    this.registerTool(
      defineTool({
        name: APPEND_VALUES_TOOL_NAME,
        title: "Append Google Sheets rows",
        description: "Append rows to a Google Sheets spreadsheet after the existing data.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: appendValuesInputShape,
        outputSchema: appendValuesOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Appending ${input.values.length} row(s) to spreadsheet ${input.spreadsheetId}.`);
          try {
            return await this.client.appendValues(input.spreadsheetId, input.range, input.values);
          } catch (error) {
            throw this.mapOperationError(APPEND_VALUES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderAppend(output),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_METADATA_TOOL_NAME,
        title: "Get Google Sheets metadata",
        description: "Fetch a spreadsheet's title and per-sheet dimensions (rows, columns).",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getMetadataInputShape,
        outputSchema: getMetadataOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching metadata for spreadsheet ${input.spreadsheetId}.`);
          try {
            const metadata = await this.client.getMetadata(input.spreadsheetId);
            return metadata;
          } catch (error) {
            throw this.mapOperationError(GET_METADATA_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMetadata(output),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      return error;
    }
    return new ExternalServiceError(`Google Sheets operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateGoogleSheetsServerOptions {
  client?: SheetsClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  SHEETS_CLIENT_ID: z.string().trim().min(1, "SHEETS_CLIENT_ID is required."),
  SHEETS_CLIENT_SECRET: z.string().trim().min(1, "SHEETS_CLIENT_SECRET is required."),
  SHEETS_REFRESH_TOKEN: z.string().trim().min(1, "SHEETS_REFRESH_TOKEN is required."),
  SHEETS_API_BASE_URL: z.string().trim().url().default(SHEETS_API_BASE_URL),
  DRIVE_API_BASE_URL: z.string().trim().url().default(DRIVE_API_BASE_URL),
};

export function createServer(options: CreateGoogleSheetsServerOptions = {}): GoogleSheetsServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ??
    new RestSheetsClient({
      clientId: env.SHEETS_CLIENT_ID,
      clientSecret: env.SHEETS_CLIENT_SECRET,
      refreshToken: env.SHEETS_REFRESH_TOKEN,
      sheetsBaseUrl: env.SHEETS_API_BASE_URL,
      driveBaseUrl: env.DRIVE_API_BASE_URL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  return new GoogleSheetsServer({ client });
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
