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

const TWILIO_API_BASE_URL = "https://api.twilio.com/2010-04-01";

const SEND_SMS_TOOL_NAME = "twilio_send_sms";
const LIST_MESSAGES_TOOL_NAME = "twilio_list_messages";
const GET_MESSAGE_TOOL_NAME = "twilio_get_message";
const MAKE_CALL_TOOL_NAME = "twilio_make_call";
const LIST_CALLS_TOOL_NAME = "twilio_list_calls";

export const metadata = {
  id: "twilio",
  title: "Twilio MCP Server",
  description: "Send SMS, list messages, place voice calls, and review call history via the Twilio REST API.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-twilio",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    SEND_SMS_TOOL_NAME,
    LIST_MESSAGES_TOOL_NAME,
    GET_MESSAGE_TOOL_NAME,
    MAKE_CALL_TOOL_NAME,
    LIST_CALLS_TOOL_NAME,
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

// --- Zod schemas (raw Twilio REST API v2010 responses) ---

const messageResourceSchema = z.object({
  sid: z.string().min(1),
  accountSid: z.string().optional(),
  to: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  body: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  direction: z.string().nullable().optional(),
  dateCreated: z.string().nullable().optional(),
  dateSent: z.string().nullable().optional(),
  errorCode: z.number().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
});

const messageListSchema = z.object({
  messages: z.array(messageResourceSchema).optional(),
  nextPageToken: z.string().nullable().optional(),
});

const callResourceSchema = z.object({
  sid: z.string().min(1),
  accountSid: z.string().optional(),
  to: z.string().nullable().optional(),
  from: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  duration: z.string().nullable().optional(),
  dateCreated: z.string().nullable().optional(),
  direction: z.string().nullable().optional(),
});

const callListSchema = z.object({
  calls: z.array(callResourceSchema).optional(),
  nextPageToken: z.string().nullable().optional(),
});

// --- Tool shapes ---

const sendSmsInputShape = {
  to: z.string().trim().min(1).describe("Destination phone number in E.164 format (e.g. +14155551234)."),
  body: z.string().min(1).max(1600).describe("SMS body (max 1600 characters)."),
};

const sendSmsOutputShape = {
  messageSid: z.string().min(1).describe("SID of the newly created message resource."),
  to: z.string().describe("Destination phone number."),
  from: z.string().describe("Sender phone number."),
  status: z.string().describe("Initial Twilio delivery status."),
  dateCreated: z.string().nullable().describe("Creation timestamp reported by Twilio."),
};

const messageListItemSchema = z.object({
  messageSid: z.string().min(1).describe("Message resource SID."),
  to: z.string().nullable().describe("Destination phone number."),
  from: z.string().nullable().describe("Sender phone number."),
  body: z.string().describe("Message body (truncated for display only)."),
  status: z.string().nullable().describe("Twilio delivery status."),
  direction: z.string().nullable().describe("Message direction (inbound/outbound)."),
  dateCreated: z.string().nullable().describe("Creation timestamp reported by Twilio."),
});

const listMessagesInputShape = {
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Maximum messages to return (1-50)."),
  to: z.string().trim().optional().describe("Filter by destination number (E.164)."),
  from: z.string().trim().optional().describe("Filter by sender number (E.164)."),
};

const listMessagesOutputShape = {
  messages: z.array(messageListItemSchema).max(50).describe("Recent message resources."),
  returnedCount: z.number().int().nonnegative().describe("Number of messages returned."),
};

const getMessageInputShape = {
  messageSid: z.string().trim().min(1).describe("The Twilio message SID to retrieve."),
};

const getMessageOutputShape = {
  message: messageListItemSchema.describe("The requested message resource."),
};

const makeCallInputShape = {
  to: z.string().trim().min(1).describe("Destination phone number in E.164 format."),
  twimlUrl: z.string().trim().url().describe("Publicly accessible URL that returns TwiML call instructions."),
};

const makeCallOutputShape = {
  callSid: z.string().min(1).describe("SID of the newly created call resource."),
  to: z.string().describe("Destination phone number."),
  from: z.string().describe("Sender phone number."),
  status: z.string().describe("Initial Twilio call status."),
  dateCreated: z.string().nullable().describe("Creation timestamp reported by Twilio."),
};

const callListItemSchema = z.object({
  callSid: z.string().min(1).describe("Call resource SID."),
  to: z.string().nullable().describe("Destination phone number."),
  from: z.string().nullable().describe("Sender phone number."),
  status: z.string().nullable().describe("Twilio call status."),
  duration: z.string().nullable().describe("Call duration in seconds."),
  dateCreated: z.string().nullable().describe("Creation timestamp reported by Twilio."),
});

const listCallsInputShape = {
  limit: z.coerce.number().int().min(1).max(50).default(10).describe("Maximum calls to return (1-50)."),
};

const listCallsOutputShape = {
  calls: z.array(callListItemSchema).max(50).describe("Recent call resources."),
  returnedCount: z.number().int().nonnegative().describe("Number of calls returned."),
};

// --- Client interface ---

export interface TwilioMessageItem {
  messageSid: string;
  to: string | null;
  from: string | null;
  body: string;
  status: string | null;
  direction: string | null;
  dateCreated: string | null;
}

export interface TwilioCallItem {
  callSid: string;
  to: string | null;
  from: string | null;
  status: string | null;
  duration: string | null;
  dateCreated: string | null;
}

export interface TwilioClient {
  sendSms(to: string, body: string): Promise<{ messageSid: string; to: string; from: string; status: string; dateCreated: string | null }>;
  listMessages(limit: number, filters: { to?: string; from?: string }): Promise<TwilioMessageItem[]>;
  getMessage(messageSid: string): Promise<TwilioMessageItem>;
  makeCall(to: string, twimlUrl: string): Promise<{ callSid: string; to: string; from: string; status: string; dateCreated: string | null }>;
  listCalls(limit: number): Promise<TwilioCallItem[]>;
}

// --- Concrete client ---

class RestTwilioClient implements TwilioClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly accountSid: string;
  private readonly authToken: string;
  private readonly fromNumber: string;
  private initialized = false;

  public constructor(input: { accountSid: string; authToken: string; fromNumber: string; baseUrl: string; fetchImpl?: typeof fetch }) {
    this.accountSid = input.accountSid;
    this.authToken = input.authToken;
    this.fromNumber = input.fromNumber;
    this.baseUrl = input.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = input.fetchImpl ?? fetch;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }
    // No startup network call needed: credentials are validated lazily on first use.
    this.initialized = true;
  }

  public async sendSms(to: string, body: string): Promise<{ messageSid: string; to: string; from: string; status: string; dateCreated: string | null }> {
    await this.ensureInitialized();
    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", this.fromNumber);
    form.set("Body", body);
    const payload = await this.request("POST", `/Accounts/${this.accountSid}/Messages.json`, form);
    const parsed = messageResourceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Twilio returned an unexpected SMS response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      messageSid: parsed.data.sid,
      to,
      from: this.fromNumber,
      status: parsed.data.status ?? "queued",
      dateCreated: toNullableString(parsed.data.dateCreated),
    };
  }

  public async listMessages(limit: number, filters: { to?: string; from?: string }): Promise<TwilioMessageItem[]> {
    await this.ensureInitialized();
    const form = new URLSearchParams();
    form.set("PageSize", String(limit));
    if (filters.to) {
      form.set("To", filters.to);
    }
    if (filters.from) {
      form.set("From", filters.from);
    }
    const payload = await this.request("GET", `/Accounts/${this.accountSid}/Messages.json?${form.toString()}`);
    const parsed = messageListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Twilio returned an unexpected message list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return (parsed.data.messages ?? []).map(mapMessageResource);
  }

  public async getMessage(messageSid: string): Promise<TwilioMessageItem> {
    await this.ensureInitialized();
    const payload = await this.request("GET", `/Accounts/${this.accountSid}/Messages/${messageSid}.json`);
    const parsed = messageResourceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(`Twilio returned an unexpected message for SID '${messageSid}'.`, {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return mapMessageResource(parsed.data);
  }

  public async makeCall(to: string, twimlUrl: string): Promise<{ callSid: string; to: string; from: string; status: string; dateCreated: string | null }> {
    await this.ensureInitialized();
    const form = new URLSearchParams();
    form.set("To", to);
    form.set("From", this.fromNumber);
    form.set("Url", twimlUrl);
    const payload = await this.request("POST", `/Accounts/${this.accountSid}/Calls.json`, form);
    const parsed = callResourceSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Twilio returned an unexpected call response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      callSid: parsed.data.sid,
      to,
      from: this.fromNumber,
      status: parsed.data.status ?? "queued",
      dateCreated: toNullableString(parsed.data.dateCreated),
    };
  }

  public async listCalls(limit: number): Promise<TwilioCallItem[]> {
    await this.ensureInitialized();
    const params = new URLSearchParams({ PageSize: String(limit) });
    const payload = await this.request("GET", `/Accounts/${this.accountSid}/Calls.json?${params.toString()}`);
    const parsed = callListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Twilio returned an unexpected call list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return (parsed.data.calls ?? []).map(mapCallResource);
  }

  private buildAuthHeader(): string {
    // HTTP Basic Auth: Account SID as username, Auth Token as password.
    const credential = `${this.accountSid}:${this.authToken}`;
    const encoded = typeof btoa === "function" ? btoa(credential) : Buffer.from(credential).toString("base64");
    return `Basic ${encoded}`;
  }

  private async request(method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: this.buildAuthHeader(),
      Accept: "application/json",
      "Connection": "keep-alive",
      "Keep-Alive": "timeout=30, max=100",
    };

    const requestInit: RequestInit = { method, headers };

    if (form) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      requestInit.body = form.toString();
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Twilio API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`Twilio API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Twilio authentication failed. Verify TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Twilio denied access to '${path}'. The account may lack this capability.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Twilio resource at '${path}' was not found.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Twilio rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Twilio API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Mapping helpers ---

function mapMessageResource(message: z.infer<typeof messageResourceSchema>): TwilioMessageItem {
  return {
    messageSid: message.sid,
    to: toNullableString(message.to),
    from: toNullableString(message.from),
    body: message.body ?? "",
    status: toNullableString(message.status),
    direction: toNullableString(message.direction),
    dateCreated: toNullableString(message.dateCreated),
  };
}

function mapCallResource(call: z.infer<typeof callResourceSchema>): TwilioCallItem {
  return {
    callSid: call.sid,
    to: toNullableString(call.to),
    from: toNullableString(call.from),
    status: toNullableString(call.status),
    duration: toNullableString(call.duration),
    dateCreated: toNullableString(call.dateCreated),
  };
}

// --- Render helpers ---

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function renderMessages(messages: TwilioMessageItem[]): string {
  if (messages.length === 0) {
    return "No messages found.";
  }
  const shown = messages.slice(0, 5);
  const lines = shown.map((m) => {
    const parts: string[] = [];
    const direction = m.direction ?? "message";
    parts.push(direction);
    if (m.from) {
      parts.push(m.from);
    }
    parts.push("→");
    if (m.to) {
      parts.push(m.to);
    }
    if (m.status) {
      parts.push(`[${m.status}]`);
    }
    if (m.body) {
      parts.push(truncate(m.body, 120));
    }
    return `- ${parts.join(" | ").replace(" | → | ", " → ")}`;
  });
  const omitted = messages.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use limit param to adjust)`);
  }
  return [`✓ ${messages.length} messages`, ...lines].join("\n");
}

function renderSingleMessage(message: TwilioMessageItem): string {
  const parts: string[] = [];
  if (message.from) {
    parts.push(`From: ${message.from}`);
  }
  if (message.to) {
    parts.push(`To: ${message.to}`);
  }
  if (message.status) {
    parts.push(`Status: ${message.status}`);
  }
  if (message.dateCreated) {
    parts.push(message.dateCreated);
  }
  const header = `✓ Message ${message.messageSid}`;
  return [header, ...parts, "", message.body || "(empty body)"].join("\n");
}

function renderSms(output: { messageSid: string; to: string; from: string; status: string }): string {
  return `✓ Sent SMS ${output.messageSid} from ${output.from} to ${output.to} (${output.status}).`;
}

function renderCall(call: TwilioCallItem): string {
  const parts: string[] = [];
  if (call.from) {
    parts.push(`From: ${call.from}`);
  }
  if (call.to) {
    parts.push(`To: ${call.to}`);
  }
  if (call.status) {
    parts.push(`Status: ${call.status}`);
  }
  if (call.duration && call.duration !== "0") {
    parts.push(`Duration: ${call.duration}s`);
  }
  return [`✓ Call ${call.callSid}`, ...parts].join("\n");
}

function renderMadeCall(output: { callSid: string; to: string; from: string; status: string }): string {
  return `✓ Initiated call ${output.callSid} from ${output.from} to ${output.to} (${output.status}).`;
}

function renderCalls(calls: TwilioCallItem[]): string {
  if (calls.length === 0) {
    return "No calls found.";
  }
  const shown = calls.slice(0, 5);
  const lines = shown.map((c) => {
    const parts: string[] = [];
    if (c.from) {
      parts.push(c.from);
    }
    parts.push("→");
    if (c.to) {
      parts.push(c.to);
    }
    if (c.status) {
      parts.push(`[${c.status}]`);
    }
    if (c.duration && c.duration !== "0") {
      parts.push(`${c.duration}s`);
    }
    return `- ${parts.join(" | ").replace(" | → | ", " → ")}`;
  });
  const omitted = calls.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use limit param to adjust)`);
  }
  return [`✓ ${calls.length} calls`, ...lines].join("\n");
}

// --- Server ---

export interface TwilioServerOptions {
  client: TwilioClient;
}

export class TwilioServer extends ToolkitServer {
  private readonly client: TwilioClient;

  public constructor(options: TwilioServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: SEND_SMS_TOOL_NAME,
        title: "Send Twilio SMS",
        description: "Send an SMS message from the configured Twilio number.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: sendSmsInputShape,
        outputSchema: sendSmsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Sending Twilio SMS to ${input.to}.`);
          try {
            return await this.client.sendSms(input.to, input.body);
          } catch (error) {
            throw this.mapOperationError(SEND_SMS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderSms(output),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_MESSAGES_TOOL_NAME,
        title: "List Twilio messages",
        description: "List recent Twilio messages, optionally filtered by sender or recipient.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listMessagesInputShape,
        outputSchema: listMessagesOutputShape,
        handler: async (input, context) => {
          await context.log("info", "Listing Twilio messages.");
          try {
            const filters = {
              ...(input.to ? { to: input.to } : {}),
              ...(input.from ? { from: input.from } : {}),
            };
            const messages = await this.client.listMessages(input.limit, filters);
            return { messages, returnedCount: messages.length };
          } catch (error) {
            throw this.mapOperationError(LIST_MESSAGES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMessages(output.messages),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_MESSAGE_TOOL_NAME,
        title: "Get Twilio message",
        description: "Fetch a single Twilio message resource by SID.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getMessageInputShape,
        outputSchema: getMessageOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching Twilio message ${input.messageSid}.`);
          try {
            const message = await this.client.getMessage(input.messageSid);
            return { message };
          } catch (error) {
            throw this.mapOperationError(GET_MESSAGE_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderSingleMessage(output.message),
      }),
    );

    this.registerTool(
      defineTool({
        name: MAKE_CALL_TOOL_NAME,
        title: "Make Twilio voice call",
        description: "Initiate an outbound voice call using a publicly accessible TwiML URL.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: makeCallInputShape,
        outputSchema: makeCallOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Initiating Twilio call to ${input.to}.`);
          try {
            return await this.client.makeCall(input.to, input.twimlUrl);
          } catch (error) {
            throw this.mapOperationError(MAKE_CALL_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMadeCall(output),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_CALLS_TOOL_NAME,
        title: "List Twilio calls",
        description: "List recent Twilio voice calls.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listCallsInputShape,
        outputSchema: listCallsOutputShape,
        handler: async (input, context) => {
          await context.log("info", "Listing Twilio calls.");
          try {
            const calls = await this.client.listCalls(input.limit);
            return { calls, returnedCount: calls.length };
          } catch (error) {
            throw this.mapOperationError(LIST_CALLS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderCalls(output.calls),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      return error;
    }
    return new ExternalServiceError(`Twilio operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateTwilioServerOptions {
  client?: TwilioClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  TWILIO_ACCOUNT_SID: z.string().trim().min(1, "TWILIO_ACCOUNT_SID is required."),
  TWILIO_AUTH_TOKEN: z.string().trim().min(1, "TWILIO_AUTH_TOKEN is required."),
  TWILIO_FROM_NUMBER: z.string().trim().min(1, "TWILIO_FROM_NUMBER is required."),
  TWILIO_API_BASE_URL: z.string().trim().url().default(TWILIO_API_BASE_URL),
};

export function createServer(options: CreateTwilioServerOptions = {}): TwilioServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ??
    new RestTwilioClient({
      accountSid: env.TWILIO_ACCOUNT_SID,
      authToken: env.TWILIO_AUTH_TOKEN,
      fromNumber: env.TWILIO_FROM_NUMBER,
      baseUrl: env.TWILIO_API_BASE_URL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  return new TwilioServer({ client });
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
