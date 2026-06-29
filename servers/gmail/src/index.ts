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

const GMAIL_API_BASE_URL = "https://gmail.googleapis.com/gmail/v1";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

const LIST_MESSAGES_TOOL_NAME = "gmail_list_messages";
const GET_MESSAGE_TOOL_NAME = "gmail_get_message";
const SEND_EMAIL_TOOL_NAME = "gmail_send_email";
const SEARCH_MESSAGES_TOOL_NAME = "gmail_search_messages";
const MARK_READ_TOOL_NAME = "gmail_mark_read";

export const metadata = {
  id: "gmail",
  title: "Gmail MCP Server",
  description: "Read, search, send, and manage Gmail messages via the Gmail REST API.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-gmail",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["GMAIL_CLIENT_ID", "GMAIL_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    LIST_MESSAGES_TOOL_NAME,
    GET_MESSAGE_TOOL_NAME,
    SEND_EMAIL_TOOL_NAME,
    SEARCH_MESSAGES_TOOL_NAME,
    MARK_READ_TOOL_NAME,
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

// --- Zod schemas (raw Gmail API responses) ---

const messageRefSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
});

const messageListSchema = z.object({
  messages: z.array(messageRefSchema).optional(),
  nextPageToken: z.string().optional(),
  resultSizeEstimate: z.number().int().optional(),
});

const messagePartHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

const messagePartBodySchema = z.object({
  data: z.string().nullable().optional(),
  size: z.number().int().optional(),
  attachmentId: z.string().nullable().optional(),
});

const messagePartSchema: z.ZodType<RawMessagePart> = z.lazy(() =>
  z.object({
    partId: z.string().nullable().optional(),
    mimeType: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    headers: z.array(messagePartHeaderSchema).optional(),
    body: messagePartBodySchema.optional(),
    parts: z.array(messagePartSchema).optional(),
  }),
);

const messageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().nullable().optional(),
  internalDate: z.string().nullable().optional(),
  payload: messagePartSchema.optional(),
  sizeEstimate: z.number().int().optional(),
});

interface RawMessagePart {
  partId?: string | null | undefined;
  mimeType?: string | null | undefined;
  filename?: string | null | undefined;
  headers?: Array<{ name: string; value: string }> | undefined;
  body?:
    | {
        data?: string | null | undefined;
        size?: number | undefined;
        attachmentId?: string | null | undefined;
      }
    | undefined;
  parts?: RawMessagePart[] | undefined;
}

const sendMessageSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().optional(),
  labelIds: z.array(z.string()).optional(),
});

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

// --- Tool shapes ---

const messageSummarySchema = z.object({
  id: z.string().min(1).describe("Immutable Gmail message identifier."),
  threadId: z.string().nullable().describe("Conversation thread this message belongs to."),
  snippet: z.string().describe("Short preview snippet of the message body."),
  from: z.string().nullable().describe("Sender name and email address."),
  subject: z.string().nullable().describe("Message subject line."),
  date: z.string().nullable().describe("RFC 2822 date the message was sent."),
  isUnread: z.boolean().describe("Whether the message is marked unread."),
});

const listMessagesInputShape = {
  maxResults: z.coerce.number().int().min(1).max(50).default(10).describe("Maximum messages to return (1-50)."),
  query: z.string().trim().optional().describe("Optional Gmail search query, e.g. 'is:unread from:boss@company.com'."),
};

const listMessagesOutputShape = {
  messages: z.array(messageSummarySchema).max(50).describe("Matching message summaries, newest first."),
  returnedCount: z.number().int().nonnegative().describe("Number of messages returned."),
};

const getMessageInputShape = {
  messageId: z.string().trim().min(1).describe("The Gmail message ID to retrieve."),
};

const fullMessageSchema = z.object({
  id: z.string().min(1).describe("Immutable Gmail message identifier."),
  threadId: z.string().nullable().describe("Conversation thread this message belongs to."),
  subject: z.string().nullable().describe("Message subject line."),
  from: z.string().nullable().describe("Sender name and email address."),
  to: z.string().nullable().describe("Recipient email address(es)."),
  date: z.string().nullable().describe("RFC 2822 date the message was sent."),
  bodyText: z.string().nullable().describe("Plain-text body of the message, if available."),
  bodyHtml: z.string().nullable().describe("HTML body of the message, if available."),
});

const getMessageOutputShape = {
  message: fullMessageSchema.describe("The full message with decoded bodies."),
};

const sendEmailInputShape = {
  to: z.string().trim().min(1).describe("Recipient email address(es), comma-separated."),
  subject: z.string().trim().min(1).max(998).describe("Email subject line."),
  body: z.string().min(1).max(1_000_000).describe("Plain-text body of the email."),
  cc: z.string().trim().optional().describe("Optional CC recipient(s), comma-separated."),
};

const sendEmailOutputShape = {
  messageId: z.string().min(1).describe("ID of the newly sent message."),
  threadId: z.string().nullable().describe("Thread the sent message belongs to."),
};

const searchMessagesInputShape = {
  query: z.string().trim().min(1).describe("Gmail search query syntax, e.g. 'subject:invoice newer_than:7d'."),
  maxResults: z.coerce.number().int().min(1).max(20).default(5).describe("Maximum messages to return (1-20)."),
};

const searchMessagesOutputShape = {
  query: z.string().describe("The search query that was executed."),
  messages: z.array(messageSummarySchema).max(50).describe("Matching message summaries."),
  returnedCount: z.number().int().nonnegative().describe("Number of messages returned."),
};

const markReadInputShape = {
  messageId: z.string().trim().min(1).describe("The Gmail message ID to mark as read."),
};

const markReadOutputShape = {
  messageId: z.string().min(1).describe("ID of the message that was updated."),
  success: z.boolean().describe("Whether the UNREAD label was removed successfully."),
};

// --- Client interface ---

export interface GmailMessageSummary {
  id: string;
  threadId: string | null;
  snippet: string;
  from: string | null;
  subject: string | null;
  date: string | null;
  isUnread: boolean;
}

export interface GmailFullMessage {
  id: string;
  threadId: string | null;
  subject: string | null;
  from: string | null;
  to: string | null;
  date: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
}

export interface GmailClient {
  listMessages(maxResults: number, query?: string): Promise<GmailMessageSummary[]>;
  getMessage(messageId: string): Promise<GmailFullMessage>;
  sendEmail(input: { to: string; subject: string; body: string; cc?: string }): Promise<{ messageId: string; threadId: string | null }>;
  searchMessages(query: string, maxResults: number): Promise<GmailMessageSummary[]>;
  markRead(messageId: string): Promise<{ messageId: string; success: true }>;
}

// --- Concrete client ---

class RestGmailClient implements GmailClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly refreshToken: string;

  private accessToken: string | null = null;
  private accessTokenExpiresAt = 0;
  private initialized = false;

  public constructor(input: { clientId: string; clientSecret: string; refreshToken: string; baseUrl: string; fetchImpl?: typeof fetch }) {
    this.clientId = input.clientId;
    this.clientSecret = input.clientSecret;
    this.refreshToken = input.refreshToken;
    this.baseUrl = input.baseUrl.replace(/\/+$/, "");
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

  public async listMessages(maxResults: number, query?: string): Promise<GmailMessageSummary[]> {
    await this.ensureInitialized();
    const params = new URLSearchParams({ maxResults: String(maxResults) });
    if (query) {
      params.set("q", query);
    }
    const list = await this.request("GET", `/users/me/messages?${params.toString()}`);
    const parsedList = messageListSchema.safeParse(list);
    if (!parsedList.success) {
      throw new ExternalServiceError("Gmail returned an unexpected message list.", {
        statusCode: 502,
        details: parsedList.error.flatten(),
      });
    }
    const refs = parsedList.data.messages ?? [];
    return Promise.all(refs.map((ref) => this.fetchMessageSummary(ref.id)));
  }

  public async getMessage(messageId: string): Promise<GmailFullMessage> {
    await this.ensureInitialized();
    return this.fetchFullMessage(messageId);
  }

  public async sendEmail(input: { to: string; subject: string; body: string; cc?: string }): Promise<{ messageId: string; threadId: string | null }> {
    await this.ensureInitialized();
    const raw = buildRfc2822Email(input);
    const payload = await this.request("POST", "/users/me/messages/send", { raw });
    const parsed = sendMessageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Gmail returned an unexpected send response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return { messageId: parsed.data.id, threadId: toNullableString(parsed.data.threadId) };
  }

  public async searchMessages(query: string, maxResults: number): Promise<GmailMessageSummary[]> {
    await this.ensureInitialized();
    return this.listMessages(maxResults, query);
  }

  public async markRead(messageId: string): Promise<{ messageId: string; success: true }> {
    await this.ensureInitialized();
    await this.request("POST", `/users/me/messages/${messageId}/modify`, { removeLabelIds: ["UNREAD"] });
    return { messageId, success: true };
  }

  private async fetchMessageSummary(id: string): Promise<GmailMessageSummary> {
    const fields = "id,threadId,snippet,labelIds,payload/headers,internalDate";
    const payload = await this.request("GET", `/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date&fields=${fields}`);
    const parsed = messageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(`Gmail returned an unexpected message for id '${id}'.`, {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const headers = readHeaders(parsed.data.payload);
    return {
      id: parsed.data.id,
      threadId: toNullableString(parsed.data.threadId),
      snippet: parsed.data.snippet ?? "",
      from: toNullableString(headers.from),
      subject: toNullableString(headers.subject),
      date: toNullableString(headers.date),
      isUnread: (parsed.data.labelIds ?? []).includes("UNREAD"),
    };
  }

  private async fetchFullMessage(messageId: string): Promise<GmailFullMessage> {
    const payload = await this.request("GET", `/users/me/messages/${messageId}?format=full`);
    const parsed = messageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(`Gmail returned an unexpected message for id '${messageId}'.`, {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    const headers = readHeaders(parsed.data.payload);
    const { text, html } = extractBodies(parsed.data.payload);
    return {
      id: parsed.data.id,
      threadId: toNullableString(parsed.data.threadId),
      subject: toNullableString(headers.subject),
      from: toNullableString(headers.from),
      to: toNullableString(headers.to),
      date: toNullableString(headers.date),
      bodyText: text.length > 0 ? text : null,
      bodyHtml: html.length > 0 ? html : null,
    };
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
      throw new ExternalServiceError("Failed to refresh Gmail access token. Verify GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, and GMAIL_REFRESH_TOKEN.", {
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

  private async request(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
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
      throw new ExternalServiceError(`Unable to reach Gmail API at '${path}'.`, {
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
        throw new ExternalServiceError(`Unable to reach Gmail API at '${path}'.`, {
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
      throw new ExternalServiceError(`Gmail API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Gmail authentication failed. Verify the OAuth refresh token credentials.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Gmail denied access to '${path}'. The OAuth scope may be missing.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Gmail resource at '${path}' was not found.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Gmail rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Gmail API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Header & body helpers ---

function readHeaders(payload: RawMessagePart | undefined): {
  from: string | null;
  to: string | null;
  subject: string | null;
  date: string | null;
} {
  const headers = payload?.headers ?? [];
  const find = (name: string): string | null => {
    const match = headers.find((h) => h.name.toLowerCase() === name.toLowerCase());
    return match ? match.value : null;
  };
  return {
    from: find("From"),
    to: find("To"),
    subject: find("Subject"),
    date: find("Date"),
  };
}

function decodeBase64Url(input: string): string {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function extractBodies(payload: RawMessagePart | undefined): { text: string; html: string } {
  let text = "";
  let html = "";

  const walk = (part: RawMessagePart | undefined): void => {
    if (!part) {
      return;
    }
    const mime = (part.mimeType ?? "").toLowerCase();
    const data = part.body?.data;
    if (mime === "text/plain" && data) {
      text += decodeBase64Url(data);
    } else if (mime === "text/html" && data) {
      html += decodeBase64Url(data);
    }
    if (part.parts && part.parts.length > 0) {
      for (const child of part.parts) {
        walk(child);
      }
    }
  };

  walk(payload);
  return { text, html };
}

function encodeBase64Url(input: string): string {
  const bytes = new TextEncoder().encode(input);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function buildRfc2822Email(input: { to: string; subject: string; body: string; cc?: string }): string {
  const lines: string[] = [];
  const date = new Date().toUTCString();
  const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@universal-mcp-toolkit>`;
  lines.push(`To: ${input.to}`);
  lines.push(`Subject: ${ensureEncodedSubject(input.subject)}`);
  lines.push(`Date: ${date}`);
  lines.push(`Message-ID: ${messageId}`);
  lines.push(`MIME-Version: 1.0`);
  lines.push(`Content-Type: text/plain; charset=UTF-8`);
  lines.push(`Content-Transfer-Encoding: 8bit`);
  if (input.cc) {
    lines.push(`Cc: ${input.cc}`);
  }
  lines.push("");
  lines.push(input.body);
  return encodeBase64Url(lines.join("\r\n"));
}

function ensureEncodedSubject(subject: string): string {
  // Avoid header injection: collapse newlines, keep ASCII subjects verbatim.
  const singleLine = subject.replace(/\r?\n/g, " ").trim();
  if (/^[\x20-\x7E]*$/.test(singleLine)) {
    return singleLine;
  }
  // RFC 2047 encoded-word fallback for non-ASCII subjects.
  const bytes = new TextEncoder().encode(singleLine);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const b64 = btoa(binary);
  return `=?UTF-8?B?${b64}?=`;
}

// --- Render helpers ---

function renderMessageSummaries(messages: GmailMessageSummary[], headerLabel: string): string {
  if (messages.length === 0) {
    return `No ${headerLabel} found.`;
  }
  const shown = messages.slice(0, 5);
  const lines = shown.map((m) => {
    const parts: string[] = [];
    const subject = m.subject ?? "(no subject)";
    const from = m.from ?? "unknown sender";
    parts.push(subject);
    parts.push(from);
    if (m.date) {
      parts.push(m.date);
    }
    if (m.isUnread) {
      parts.push("unread");
    }
    return `- ${parts.join(" | ")}`;
  });
  const omitted = messages.length - shown.length;
  if (omitted > 0) {
    lines.push(`(+${omitted} more, use maxResults to adjust)`);
  }
  return [`✓ ${messages.length} ${headerLabel}`, ...lines].join("\n");
}

function renderFullMessage(message: GmailFullMessage): string {
  const lines: string[] = [];
  lines.push(`✓ Message ${message.id}`);
  if (message.subject) {
    lines.push(`Subject: ${message.subject}`);
  }
  if (message.from) {
    lines.push(`From: ${message.from}`);
  }
  if (message.to) {
    lines.push(`To: ${message.to}`);
  }
  if (message.date) {
    lines.push(`Date: ${message.date}`);
  }
  const body = message.bodyText ?? message.bodyHtml ?? "(empty body)";
  const trimmed = body.length > 800 ? `${body.slice(0, 800)}…` : body;
  lines.push("");
  lines.push(trimmed);
  return lines.join("\n");
}

function renderSentEmail(output: { messageId: string; threadId: string | null }): string {
  const thread = output.threadId ? ` (thread ${output.threadId})` : "";
  return `✓ Sent email ${output.messageId}${thread}.`;
}

function renderMarkRead(output: { messageId: string; success: boolean }): string {
  return `✓ Marked message ${output.messageId} as read.`;
}

// --- Server ---

export interface GmailServerOptions {
  client: GmailClient;
}

export class GmailServer extends ToolkitServer {
  private readonly client: GmailClient;

  public constructor(options: GmailServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: LIST_MESSAGES_TOOL_NAME,
        title: "List Gmail messages",
        description: "List recent inbox messages, optionally filtered with Gmail search syntax.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listMessagesInputShape,
        outputSchema: listMessagesOutputShape,
        handler: async (input, context) => {
          await context.log("info", "Listing Gmail messages.");
          try {
            const messages = await this.client.listMessages(input.maxResults, input.query);
            return { messages, returnedCount: messages.length };
          } catch (error) {
            throw this.mapOperationError(LIST_MESSAGES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMessageSummaries(output.messages, "messages"),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_MESSAGE_TOOL_NAME,
        title: "Get Gmail message",
        description: "Fetch a full Gmail message by ID, including decoded text and HTML bodies.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getMessageInputShape,
        outputSchema: getMessageOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching Gmail message ${input.messageId}.`);
          try {
            const message = await this.client.getMessage(input.messageId);
            return { message };
          } catch (error) {
            throw this.mapOperationError(GET_MESSAGE_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderFullMessage(output.message),
      }),
    );

    this.registerTool(
      defineTool({
        name: SEND_EMAIL_TOOL_NAME,
        title: "Send Gmail email",
        description: "Send an email through Gmail, encoded as RFC 2822 and submitted base64url.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: sendEmailInputShape,
        outputSchema: sendEmailOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Sending Gmail email to ${input.to}.`);
          try {
            const request = {
              to: input.to,
              subject: input.subject,
              body: input.body,
              ...(input.cc ? { cc: input.cc } : {}),
            };
            return await this.client.sendEmail(request);
          } catch (error) {
            throw this.mapOperationError(SEND_EMAIL_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderSentEmail(output),
      }),
    );

    this.registerTool(
      defineTool({
        name: SEARCH_MESSAGES_TOOL_NAME,
        title: "Search Gmail messages",
        description: "Search Gmail messages using Gmail query syntax (e.g. 'is:unread', 'from:x@y.com').",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: searchMessagesInputShape,
        outputSchema: searchMessagesOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Searching Gmail messages with query '${input.query}'.`);
          try {
            const messages = await this.client.searchMessages(input.query, input.maxResults);
            return { query: input.query, messages, returnedCount: messages.length };
          } catch (error) {
            throw this.mapOperationError(SEARCH_MESSAGES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMessageSummaries(output.messages, "results"),
      }),
    );

    this.registerTool(
      defineTool({
        name: MARK_READ_TOOL_NAME,
        title: "Mark Gmail message read",
        description: "Mark a Gmail message as read by removing the UNREAD label.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: markReadInputShape,
        outputSchema: markReadOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Marking Gmail message ${input.messageId} as read.`);
          try {
            return await this.client.markRead(input.messageId);
          } catch (error) {
            throw this.mapOperationError(MARK_READ_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMarkRead(output),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      return error;
    }
    return new ExternalServiceError(`Gmail operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateGmailServerOptions {
  client?: GmailClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  GMAIL_CLIENT_ID: z.string().trim().min(1, "GMAIL_CLIENT_ID is required."),
  GMAIL_CLIENT_SECRET: z.string().trim().min(1, "GMAIL_CLIENT_SECRET is required."),
  GMAIL_REFRESH_TOKEN: z.string().trim().min(1, "GMAIL_REFRESH_TOKEN is required."),
  GMAIL_API_BASE_URL: z.string().trim().url().default(GMAIL_API_BASE_URL),
};

export function createServer(options: CreateGmailServerOptions = {}): GmailServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ??
    new RestGmailClient({
      clientId: env.GMAIL_CLIENT_ID,
      clientSecret: env.GMAIL_CLIENT_SECRET,
      refreshToken: env.GMAIL_REFRESH_TOKEN,
      baseUrl: env.GMAIL_API_BASE_URL,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  return new GmailServer({ client });
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
