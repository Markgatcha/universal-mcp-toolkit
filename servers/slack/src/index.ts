import { resolve } from "node:path";
import process from "node:process";
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

const DEFAULT_SLACK_API_BASE_URL = "https://slack.com/api";
const LIST_CHANNELS_TOOL_NAME = "list_channels";
const FETCH_CHANNEL_HISTORY_TOOL_NAME = "fetch_channel_history";
const POST_MESSAGE_TOOL_NAME = "post_message";
const WORKSPACE_RESOURCE_NAME = "workspace";
const WORKSPACE_RESOURCE_URI = "slack://workspace";
const COMPOSE_UPDATE_PROMPT_NAME = "compose-update";
const DEFAULT_LIST_CHANNEL_TYPES = ["public_channel", "private_channel"] as const;

export type SlackConversationType = "public_channel" | "private_channel" | "mpim" | "im";

export const metadata = {
  id: "slack",
  title: "Slack MCP Server",
  description: "Slack workspace tools for channel discovery, history lookup, posting updates, and drafting messages.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-slack",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  envVarNames: ["SLACK_BOT_TOKEN"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [LIST_CHANNELS_TOOL_NAME, FETCH_CHANNEL_HISTORY_TOOL_NAME, POST_MESSAGE_TOOL_NAME] as const,
  resourceNames: [WORKSPACE_RESOURCE_NAME] as const,
  promptNames: [COMPOSE_UPDATE_PROMPT_NAME] as const,
} satisfies ToolkitServerMetadata;

export const serverCard = createServerCard(metadata);

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function truncateText(value: string, maxLength = 280): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}…`;
}

function formatChannelName(channelName: string): string {
  return channelName.startsWith("#") ? channelName : `#${channelName}`;
}

function formatBulletList(items: readonly string[], fallback: string): string {
  if (items.length === 0) {
    return `- ${fallback}`;
  }

  return items.map((item) => `- ${item}`).join("\n");
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

type SlackParameterValue = boolean | number | readonly string[] | string | undefined;

function isStringArray(value: SlackParameterValue): value is readonly string[] {
  return Array.isArray(value);
}

function buildFormBody(parameters: Record<string, SlackParameterValue>): URLSearchParams {
  const body = new URLSearchParams();

  for (const [key, value] of Object.entries(parameters)) {
    if (value === undefined) {
      continue;
    }

    if (isStringArray(value)) {
      if (value.length > 0) {
        body.set(key, value.join(","));
      }
      continue;
    }

    body.set(key, String(value));
  }

  return body;
}

function createResponseValidationError(endpoint: string, issues: readonly z.ZodIssue[]): ExternalServiceError {
  return new ExternalServiceError(`Slack endpoint '${endpoint}' returned an unexpected payload.`, {
    statusCode: 502,
    details: {
      endpoint,
      issues,
    },
    exposeToClient: false,
  });
}

const slackBaseResponseSchema = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
  warning: z.string().optional(),
  needed: z.string().optional(),
  provided: z.string().optional(),
  response_metadata: z
    .object({
      next_cursor: z.string().optional(),
      messages: z.array(z.string()).optional(),
    })
    .optional(),
});

type SlackBaseResponse = z.infer<typeof slackBaseResponseSchema>;

function mapSlackFailure(
  endpoint: string,
  statusCode: number,
  retryAfter: string | null,
  envelope: SlackBaseResponse | undefined,
  payload: unknown,
): ExternalServiceError {
  const errorCode = envelope?.error;
  const details = {
    endpoint,
    statusCode,
    retryAfter: retryAfter ?? undefined,
    slackError: errorCode ?? undefined,
    needed: envelope?.needed,
    provided: envelope?.provided,
    warning: envelope?.warning,
    payload,
  };

  if (statusCode === 429 || errorCode === "ratelimited") {
    const retryMessage = retryAfter ? ` Retry after ${retryAfter} second(s).` : "";
    return new ExternalServiceError(`Slack rate limited '${endpoint}'.${retryMessage}`, {
      statusCode: 429,
      details,
    });
  }

  switch (errorCode) {
    case "invalid_auth":
    case "not_authed":
    case "account_inactive":
    case "token_revoked":
      return new ExternalServiceError("Slack authentication failed. Verify SLACK_BOT_TOKEN.", {
        statusCode: 401,
        details,
      });
    case "missing_scope":
      return new ExternalServiceError(`Slack rejected '${endpoint}' because the bot token is missing a required scope.`, {
        statusCode: 403,
        details,
      });
    case "channel_not_found":
      return new ExternalServiceError("The requested Slack channel could not be found.", {
        statusCode: 404,
        details,
      });
    case "not_in_channel":
      return new ExternalServiceError("The Slack bot is not a member of the requested channel.", {
        statusCode: 403,
        details,
      });
    case "is_archived":
      return new ExternalServiceError("Slack cannot post to an archived channel.", {
        statusCode: 409,
        details,
      });
    case "msg_too_long":
      return new ExternalServiceError("Slack rejected the message because it is too long.", {
        statusCode: 400,
        details,
      });
    default:
      break;
  }

  switch (statusCode) {
    case 400:
      return new ExternalServiceError(`Slack rejected the '${endpoint}' request.`, {
        statusCode,
        details,
      });
    case 401:
      return new ExternalServiceError("Slack authentication failed. Verify SLACK_BOT_TOKEN.", {
        statusCode,
        details,
      });
    case 403:
      return new ExternalServiceError(`Slack denied access to '${endpoint}'.`, {
        statusCode,
        details,
      });
    case 404:
      return new ExternalServiceError(`Slack endpoint '${endpoint}' was not found.`, {
        statusCode,
        details,
      });
    default:
      return new ExternalServiceError(
        errorCode ? `Slack endpoint '${endpoint}' failed with error '${errorCode}'.` : `Slack request to '${endpoint}' failed.`,
        {
          statusCode: statusCode >= 400 ? statusCode : 502,
          details,
        },
      );
  }
}

interface ParsedSlackResponseBody {
  payload: unknown;
  parsedAsJson: boolean;
  rawText: string;
}

async function parseSlackResponseBody(response: Response): Promise<ParsedSlackResponseBody> {
  const rawText = await response.text();
  if (rawText.trim().length === 0) {
    return {
      payload: {},
      parsedAsJson: true,
      rawText,
    };
  }

  try {
    return {
      payload: JSON.parse(rawText) as unknown,
      parsedAsJson: true,
      rawText,
    };
  } catch {
    return {
      payload: {
        rawText: truncateText(rawText, 1_000),
      },
      parsedAsJson: false,
      rawText,
    };
  }
}

const slackConversationTypeSchema = z.enum(["public_channel", "private_channel", "mpim", "im"]);

const envShape = {
  SLACK_BOT_TOKEN: z.string().trim().min(1, "SLACK_BOT_TOKEN is required."),
  SLACK_DEFAULT_CHANNEL_ID: z.string().trim().min(1).optional(),
  SLACK_TEAM_ID: z.string().trim().min(1).optional(),
  SLACK_WORKSPACE_NAME: z.string().trim().min(1).optional(),
  SLACK_API_BASE_URL: z.string().trim().url().default(DEFAULT_SLACK_API_BASE_URL).transform(normalizeBaseUrl),
};

const slackTopicSchema = z.object({
  value: z.string().optional(),
});

const slackChannelResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  user: z.string().optional(),
  is_private: z.boolean().optional(),
  is_archived: z.boolean().optional(),
  is_member: z.boolean().optional(),
  num_members: z.number().int().nonnegative().optional(),
  topic: slackTopicSchema.optional(),
  purpose: slackTopicSchema.optional(),
});

type SlackChannelResponse = z.infer<typeof slackChannelResponseSchema>;

const slackListChannelsResponseSchema = slackBaseResponseSchema.extend({
  ok: z.literal(true),
  channels: z.array(slackChannelResponseSchema).default([]),
});

const slackReactionResponseSchema = z.object({
  name: z.string().min(1),
});

const slackHistoryMessageResponseSchema = z.object({
  ts: z.string().min(1),
  text: z.string().default(""),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  type: z.string().optional(),
  subtype: z.string().optional(),
  thread_ts: z.string().optional(),
  reply_count: z.number().int().nonnegative().optional(),
  reactions: z.array(slackReactionResponseSchema).optional(),
});

type SlackHistoryMessageResponse = z.infer<typeof slackHistoryMessageResponseSchema>;

const slackChannelHistoryResponseSchema = slackBaseResponseSchema.extend({
  ok: z.literal(true),
  messages: z.array(slackHistoryMessageResponseSchema).default([]),
  has_more: z.boolean().default(false),
});

const slackPostedMessageResponseSchema = slackBaseResponseSchema.extend({
  ok: z.literal(true),
  channel: z.string().min(1),
  ts: z.string().min(1),
  message: z.object({
    text: z.string().default(""),
    thread_ts: z.string().optional(),
  }),
});

const slackAuthTestResponseSchema = slackBaseResponseSchema.extend({
  ok: z.literal(true),
  url: z.string().optional(),
  team: z.string().optional(),
  user: z.string().optional(),
  team_id: z.string().optional(),
  user_id: z.string().optional(),
  bot_id: z.string().optional(),
});

const channelSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  isMember: z.boolean(),
  memberCount: z.number().int().nonnegative().nullable(),
  topic: z.string().nullable(),
  purpose: z.string().nullable(),
});

export type SlackChannelSummary = z.infer<typeof channelSummarySchema>;

const messageSummarySchema = z.object({
  ts: z.string().min(1),
  threadTs: z.string().nullable(),
  userId: z.string().nullable(),
  text: z.string(),
  messageType: z.string().nullable(),
  replyCount: z.number().int().nonnegative().nullable(),
  reactionNames: z.array(z.string().min(1)),
});

export type SlackMessageSummary = z.infer<typeof messageSummarySchema>;

const workspaceResourceSchema = z.object({
  workspaceName: z.string().nullable(),
  teamId: z.string().nullable(),
  workspaceUrl: z.string().nullable(),
  authenticatedUserId: z.string().nullable(),
  authenticatedUserName: z.string().nullable(),
  botId: z.string().nullable(),
  defaultChannelId: z.string().nullable(),
  apiBaseUrl: z.string().url(),
  availableTools: z.array(z.string().min(1)),
  availableResources: z.array(z.string().min(1)),
  availablePrompts: z.array(z.string().min(1)),
});

export type SlackWorkspaceResource = z.infer<typeof workspaceResourceSchema>;

const listChannelsInputShape = {
  limit: z.coerce.number().int().min(1).max(1_000).default(100),
  cursor: z.string().trim().min(1).optional(),
  includeArchived: z.boolean().default(false),
  types: z.array(slackConversationTypeSchema).min(1).max(4).default([...DEFAULT_LIST_CHANNEL_TYPES]),
};

const listChannelsOutputShape = {
  channels: z.array(channelSummarySchema),
  nextCursor: z.string().nullable(),
  returnedCount: z.number().int().nonnegative(),
};

export type ListChannelsOutput = z.infer<z.ZodObject<typeof listChannelsOutputShape>>;

const fetchChannelHistoryInputShape = {
  channelId: z.string().trim().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(20),
  cursor: z.string().trim().min(1).optional(),
  oldest: z.string().trim().min(1).optional(),
  latest: z.string().trim().min(1).optional(),
  inclusive: z.boolean().default(false),
};

const fetchChannelHistoryOutputShape = {
  channelId: z.string().min(1),
  messages: z.array(messageSummarySchema),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
  returnedCount: z.number().int().nonnegative(),
};

export type FetchChannelHistoryOutput = z.infer<z.ZodObject<typeof fetchChannelHistoryOutputShape>>;

const postMessageInputShape = {
  channelId: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).max(40_000),
  threadTs: z.string().trim().min(1).optional(),
  mrkdwn: z.boolean().default(true),
  unfurlLinks: z.boolean().default(false),
};

const postMessageOutputShape = {
  channelId: z.string().min(1),
  messageTs: z.string().min(1),
  threadTs: z.string().nullable(),
  text: z.string(),
  usedDefaultChannel: z.boolean(),
};

export type PostMessageOutput = z.infer<z.ZodObject<typeof postMessageOutputShape>>;

const composeUpdatePromptArgsShape = {
  channelName: z.string().trim().min(1).optional(),
  audience: z.string().trim().min(1).optional(),
  topic: z.string().trim().min(1),
  progressSummary: z.string().trim().min(1),
  highlights: z.array(z.string().trim().min(1)).default([]),
  risks: z.array(z.string().trim().min(1)).default([]),
  nextStep: z.string().trim().min(1).optional(),
  tone: z.enum(["concise", "friendly", "executive"]).default("concise"),
};

const composeUpdatePromptSchema = z.object(composeUpdatePromptArgsShape);

export type ComposeUpdatePromptArgs = z.infer<typeof composeUpdatePromptSchema>;
export type ComposeUpdatePromptArgsInput = z.input<typeof composeUpdatePromptSchema>;

function mapChannel(channel: SlackChannelResponse): SlackChannelSummary {
  return {
    id: channel.id,
    name: channel.name ?? channel.user ?? channel.id,
    isPrivate: channel.is_private ?? false,
    isArchived: channel.is_archived ?? false,
    isMember: channel.is_member ?? false,
    memberCount: channel.num_members ?? null,
    topic: toNullableString(channel.topic?.value),
    purpose: toNullableString(channel.purpose?.value),
  };
}

function mapMessage(message: SlackHistoryMessageResponse): SlackMessageSummary {
  const reactionNames = message.reactions?.map((reaction) => reaction.name) ?? [];
  const messageType = toNullableString(message.subtype ?? message.type);

  return {
    ts: message.ts,
    threadTs: toNullableString(message.thread_ts),
    userId: toNullableString(message.user ?? message.bot_id),
    text: message.text,
    messageType,
    replyCount: message.reply_count ?? null,
    reactionNames,
  };
}

function renderListChannels(output: ListChannelsOutput): string {
  if (output.channels.length === 0) {
    return "No Slack channels matched the request.";
  }

  const lines = output.channels.map((channel) => {
    const visibility = channel.isPrivate ? "private" : "public";
    const archived = channel.isArchived ? ", archived" : "";
    const topic = channel.topic ? ` — ${channel.topic}` : "";
    return `- ${formatChannelName(channel.name)} (${channel.id}, ${visibility}${archived})${topic}`;
  });

  if (output.nextCursor) {
    lines.push(`Next cursor: ${output.nextCursor}`);
  }

  return [`Returned ${output.returnedCount} channel(s).`, ...lines].join("\n");
}

function renderChannelHistory(output: FetchChannelHistoryOutput): string {
  if (output.messages.length === 0) {
    return `No Slack messages were returned for channel ${output.channelId}.`;
  }

  const previewMessages = output.messages.slice(0, 10).map((message) => {
    const author = message.userId ? `@${message.userId}` : "unknown";
    return `- ${author} at ${message.ts}: ${truncateText(message.text, 160)}`;
  });

  if (output.messages.length > previewMessages.length) {
    previewMessages.push(`- ${output.messages.length - previewMessages.length} additional message(s) omitted from preview.`);
  }

  if (output.nextCursor) {
    previewMessages.push(`Next cursor: ${output.nextCursor}`);
  }

  return [`Returned ${output.returnedCount} message(s) for channel ${output.channelId}.`, ...previewMessages].join("\n");
}

function renderPostedMessage(output: PostMessageOutput): string {
  const destination = output.usedDefaultChannel ? `${output.channelId} (default)` : output.channelId;
  const threadLine = output.threadTs ? ` Thread: ${output.threadTs}.` : "";
  return `Posted a Slack message to ${destination} at ${output.messageTs}.${threadLine}`;
}

export interface SlackListChannelsParams {
  cursor?: string;
  includeArchived: boolean;
  limit: number;
  types: readonly SlackConversationType[];
}

export interface SlackListChannelsResult {
  channels: SlackChannelSummary[];
  nextCursor: string | null;
}

export interface SlackFetchChannelHistoryParams {
  channelId: string;
  cursor?: string;
  inclusive: boolean;
  latest?: string;
  limit: number;
  oldest?: string;
}

export interface SlackFetchChannelHistoryResult {
  channelId: string;
  hasMore: boolean;
  messages: SlackMessageSummary[];
  nextCursor: string | null;
}

export interface SlackPostMessageParams {
  channelId: string;
  mrkdwn: boolean;
  text: string;
  threadTs?: string;
  unfurlLinks: boolean;
}

export interface SlackPostMessageResult {
  channelId: string;
  messageTs: string;
  threadTs: string | null;
  text: string;
}

export interface SlackWorkspaceInfo {
  authenticatedUserId: string | null;
  authenticatedUserName: string | null;
  botId: string | null;
  teamId: string | null;
  workspaceName: string | null;
  workspaceUrl: string | null;
}

export interface SlackClient {
  fetchChannelHistory(input: SlackFetchChannelHistoryParams): Promise<SlackFetchChannelHistoryResult>;
  getWorkspaceInfo(): Promise<SlackWorkspaceInfo>;
  listChannels(input: SlackListChannelsParams): Promise<SlackListChannelsResult>;
  postMessage(input: SlackPostMessageParams): Promise<SlackPostMessageResult>;
}

class FetchSlackClient implements SlackClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  public constructor(token: string, baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.fetchImpl = fetchImpl;
  }

  public async listChannels(input: SlackListChannelsParams): Promise<SlackListChannelsResult> {
    const payload = await this.request("conversations.list", {
      cursor: input.cursor,
      exclude_archived: !input.includeArchived,
      limit: input.limit,
      types: input.types,
    });

    const parsed = slackListChannelsResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw createResponseValidationError("conversations.list", parsed.error.issues);
    }

    return {
      channels: parsed.data.channels.map((channel) => mapChannel(channel)),
      nextCursor: toNullableString(parsed.data.response_metadata?.next_cursor),
    };
  }

  public async fetchChannelHistory(input: SlackFetchChannelHistoryParams): Promise<SlackFetchChannelHistoryResult> {
    const payload = await this.request("conversations.history", {
      channel: input.channelId,
      cursor: input.cursor,
      inclusive: input.inclusive,
      latest: input.latest,
      limit: input.limit,
      oldest: input.oldest,
    });

    const parsed = slackChannelHistoryResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw createResponseValidationError("conversations.history", parsed.error.issues);
    }

    return {
      channelId: input.channelId,
      hasMore: parsed.data.has_more,
      messages: parsed.data.messages.map((message) => mapMessage(message)),
      nextCursor: toNullableString(parsed.data.response_metadata?.next_cursor),
    };
  }

  public async postMessage(input: SlackPostMessageParams): Promise<SlackPostMessageResult> {
    const payload = await this.request("chat.postMessage", {
      channel: input.channelId,
      mrkdwn: input.mrkdwn,
      text: input.text,
      thread_ts: input.threadTs,
      unfurl_links: input.unfurlLinks,
    });

    const parsed = slackPostedMessageResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw createResponseValidationError("chat.postMessage", parsed.error.issues);
    }

    return {
      channelId: parsed.data.channel,
      messageTs: parsed.data.ts,
      threadTs: toNullableString(parsed.data.message.thread_ts ?? input.threadTs),
      text: parsed.data.message.text,
    };
  }

  public async getWorkspaceInfo(): Promise<SlackWorkspaceInfo> {
    const payload = await this.request("auth.test", {});
    const parsed = slackAuthTestResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw createResponseValidationError("auth.test", parsed.error.issues);
    }

    return {
      authenticatedUserId: toNullableString(parsed.data.user_id),
      authenticatedUserName: toNullableString(parsed.data.user),
      botId: toNullableString(parsed.data.bot_id),
      teamId: toNullableString(parsed.data.team_id),
      workspaceName: toNullableString(parsed.data.team),
      workspaceUrl: toNullableString(parsed.data.url),
    };
  }

  private async request(endpoint: string, parameters: Record<string, SlackParameterValue>): Promise<unknown> {
    const url = new URL(endpoint, `${this.baseUrl}/`);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
        },
        body: buildFormBody(parameters),
      });
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Slack endpoint '${endpoint}'.`, {
        statusCode: 502,
        details: {
          endpoint,
          cause: extractErrorDetails(error),
        },
      });
    }

    const parsedBody = await parseSlackResponseBody(response);

    if (response.ok && !parsedBody.parsedAsJson) {
      throw new ExternalServiceError(`Slack endpoint '${endpoint}' returned malformed JSON.`, {
        statusCode: 502,
        details: {
          endpoint,
          rawText: truncateText(parsedBody.rawText, 1_000),
        },
        exposeToClient: false,
      });
    }

    const envelopeResult = slackBaseResponseSchema.safeParse(parsedBody.payload);

    if (!response.ok) {
      throw mapSlackFailure(
        endpoint,
        response.status,
        response.headers.get("retry-after"),
        envelopeResult.success ? envelopeResult.data : undefined,
        parsedBody.payload,
      );
    }

    if (!envelopeResult.success) {
      throw createResponseValidationError(endpoint, envelopeResult.error.issues);
    }

    if (!envelopeResult.data.ok) {
      throw mapSlackFailure(endpoint, response.status, response.headers.get("retry-after"), envelopeResult.data, parsedBody.payload);
    }

    return parsedBody.payload;
  }
}

export interface SlackServerOptions {
  apiBaseUrl: string;
  client: SlackClient;
  defaultChannelId?: string;
  teamId?: string;
  workspaceName?: string;
}

export class SlackServer extends ToolkitServer {
  private readonly apiBaseUrl: string;
  private readonly client: SlackClient;
  private readonly defaultChannelId: string | undefined;
  private readonly teamId: string | undefined;
  private readonly workspaceName: string | undefined;

  public constructor(options: SlackServerOptions) {
    super(metadata);
    this.client = options.client;
    this.apiBaseUrl = normalizeBaseUrl(options.apiBaseUrl);
    this.defaultChannelId = options.defaultChannelId;
    this.teamId = options.teamId;
    this.workspaceName = options.workspaceName;

    this.registerListChannelsTool();
    this.registerFetchChannelHistoryTool();
    this.registerPostMessageTool();
    this.registerWorkspaceResource();
    this.registerComposeUpdatePrompt();
  }

  public async readWorkspaceResource(): Promise<SlackWorkspaceResource> {
    try {
      const workspace = await this.client.getWorkspaceInfo();
      return workspaceResourceSchema.parse({
        workspaceName: this.workspaceName ?? workspace.workspaceName,
        teamId: this.teamId ?? workspace.teamId,
        workspaceUrl: workspace.workspaceUrl,
        authenticatedUserId: workspace.authenticatedUserId,
        authenticatedUserName: workspace.authenticatedUserName,
        botId: workspace.botId,
        defaultChannelId: this.defaultChannelId ?? null,
        apiBaseUrl: this.apiBaseUrl,
        availableTools: [...metadata.toolNames],
        availableResources: [...metadata.resourceNames],
        availablePrompts: [...metadata.promptNames],
      });
    } catch (error) {
      throw this.mapOperationError("workspace resource", error);
    }
  }

  public buildComposeUpdatePrompt(rawArgs: ComposeUpdatePromptArgsInput) {
    const args = composeUpdatePromptSchema.parse(rawArgs);
    const channelLine = args.channelName ? `Target channel: ${formatChannelName(args.channelName)}` : "Target channel: choose the most relevant Slack destination.";
    const audienceLine = args.audience ? `Audience: ${args.audience}` : undefined;
    const workspaceLine = this.workspaceName ? `Workspace: ${this.workspaceName}` : undefined;
    const nextStepLine = args.nextStep
      ? `Next step / ask: ${args.nextStep}`
      : "Next step / ask: end with the clearest next action for the reader.";

    const lines = [
      `Draft a ${args.tone} Slack update that is ready to paste into Slack.`,
      "Use a short opener, compact bullets, and a clear close.",
      channelLine,
      audienceLine,
      workspaceLine,
      `Topic: ${args.topic}`,
      `Progress summary: ${args.progressSummary}`,
      "Highlights:",
      formatBulletList(args.highlights, "No highlights were supplied."),
      "Risks / blockers:",
      formatBulletList(args.risks, "No blockers were supplied."),
      nextStepLine,
      "Keep technical identifiers exact and avoid adding facts that are not present in the request.",
    ].filter((line): line is string => line !== undefined);

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: lines.join("\n"),
          },
        },
      ],
    };
  }

  private registerListChannelsTool(): void {
    this.registerTool(
      defineTool({
        name: LIST_CHANNELS_TOOL_NAME,
        title: "List Slack channels",
        description: "List Slack channels the bot can discover, with pagination and archive filtering.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listChannelsInputShape,
        outputSchema: listChannelsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Listing Slack channels with limit ${input.limit}.`);

          try {
            const result = await this.client.listChannels({
              includeArchived: input.includeArchived,
              limit: input.limit,
              types: input.types,
              ...(input.cursor ? { cursor: input.cursor } : {}),
            });

            return {
              channels: result.channels,
              nextCursor: result.nextCursor,
              returnedCount: result.channels.length,
            };
          } catch (error) {
            throw this.mapOperationError(LIST_CHANNELS_TOOL_NAME, error);
          }
        },
        renderText: renderListChannels,
      }),
    );
  }

  private registerFetchChannelHistoryTool(): void {
    this.registerTool(
      defineTool({
        name: FETCH_CHANNEL_HISTORY_TOOL_NAME,
        title: "Fetch Slack channel history",
        description: "Fetch recent Slack messages from a channel, including pagination and thread metadata.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: fetchChannelHistoryInputShape,
        outputSchema: fetchChannelHistoryOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching Slack history for channel ${input.channelId}.`);

          try {
            const result = await this.client.fetchChannelHistory({
              channelId: input.channelId,
              inclusive: input.inclusive,
              limit: input.limit,
              ...(input.cursor ? { cursor: input.cursor } : {}),
              ...(input.latest ? { latest: input.latest } : {}),
              ...(input.oldest ? { oldest: input.oldest } : {}),
            });

            return {
              channelId: result.channelId,
              messages: result.messages,
              hasMore: result.hasMore,
              nextCursor: result.nextCursor,
              returnedCount: result.messages.length,
            };
          } catch (error) {
            throw this.mapOperationError(FETCH_CHANNEL_HISTORY_TOOL_NAME, error);
          }
        },
        renderText: renderChannelHistory,
      }),
    );
  }

  private registerPostMessageTool(): void {
    this.registerTool(
      defineTool({
        name: POST_MESSAGE_TOOL_NAME,
        title: "Post a Slack message",
        description: "Post a new Slack message to a channel or thread using the configured bot token.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: postMessageInputShape,
        outputSchema: postMessageOutputShape,
        handler: async (input, context) => {
          const channelId = this.resolveChannelId(input.channelId);
          await context.log("info", `Posting a Slack message to channel ${channelId}.`);

          try {
            const result = await this.client.postMessage({
              channelId,
              mrkdwn: input.mrkdwn,
              text: input.text,
              unfurlLinks: input.unfurlLinks,
              ...(input.threadTs ? { threadTs: input.threadTs } : {}),
            });

            return {
              channelId: result.channelId,
              messageTs: result.messageTs,
              threadTs: result.threadTs,
              text: result.text,
              usedDefaultChannel: input.channelId === undefined,
            };
          } catch (error) {
            throw this.mapOperationError(POST_MESSAGE_TOOL_NAME, error);
          }
        },
        renderText: renderPostedMessage,
      }),
    );
  }

  private registerWorkspaceResource(): void {
    this.registerStaticResource(
      WORKSPACE_RESOURCE_NAME,
      WORKSPACE_RESOURCE_URI,
      {
        title: "Slack workspace snapshot",
        description: "Workspace metadata, authenticated identity, and configured Slack defaults.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.readWorkspaceResource()),
    );
  }

  private registerComposeUpdatePrompt(): void {
    this.registerPrompt(
      COMPOSE_UPDATE_PROMPT_NAME,
      {
        title: "Compose a Slack update",
        description: "Draft a polished Slack update from structured status inputs.",
        argsSchema: composeUpdatePromptArgsShape,
      },
      async (args) => this.buildComposeUpdatePrompt(args),
    );
  }

  private resolveChannelId(channelId: string | undefined): string {
    if (channelId) {
      return channelId;
    }

    if (this.defaultChannelId) {
      return this.defaultChannelId;
    }

    throw new ValidationError(
      "channelId is required for post_message when SLACK_DEFAULT_CHANNEL_ID is not configured.",
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError | ValidationError {
    if (error instanceof ExternalServiceError || error instanceof ValidationError) {
      return error;
    }

    return new ExternalServiceError(`Slack operation '${operation}' failed unexpectedly.`, {
      details: {
        operation,
        cause: extractErrorDetails(error),
      },
      exposeToClient: true,
    });
  }
}

export interface CreateSlackServerOptions {
  client?: SlackClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

export function createServer(options: CreateSlackServerOptions = {}): SlackServer {
  const env = loadEnv(envShape, options.env);
  const client = options.client ?? new FetchSlackClient(env.SLACK_BOT_TOKEN, env.SLACK_API_BASE_URL, options.fetchImpl);

  return new SlackServer({
    apiBaseUrl: env.SLACK_API_BASE_URL,
    client,
    ...(env.SLACK_DEFAULT_CHANNEL_ID ? { defaultChannelId: env.SLACK_DEFAULT_CHANNEL_ID } : {}),
    ...(env.SLACK_TEAM_ID ? { teamId: env.SLACK_TEAM_ID } : {}),
    ...(env.SLACK_WORKSPACE_NAME ? { workspaceName: env.SLACK_WORKSPACE_NAME } : {}),
  });
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
