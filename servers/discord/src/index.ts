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

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";

const LIST_GUILDS_TOOL_NAME = "discord_list_guilds";
const LIST_CHANNELS_TOOL_NAME = "discord_list_channels";
const GET_MESSAGES_TOOL_NAME = "discord_get_messages";
const SEND_MESSAGE_TOOL_NAME = "discord_send_message";
const GET_GUILD_MEMBERS_TOOL_NAME = "discord_get_guild_members";

export const metadata = {
  id: "discord",
  title: "Discord MCP Server",
  description: "Guild discovery, channel lookup, message history, and messaging for Discord servers.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-discord",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["DISCORD_BOT_TOKEN"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    LIST_GUILDS_TOOL_NAME,
    LIST_CHANNELS_TOOL_NAME,
    GET_MESSAGES_TOOL_NAME,
    SEND_MESSAGE_TOOL_NAME,
    GET_GUILD_MEMBERS_TOOL_NAME,
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

function snowflakeToDate(snowflake: string): string | null {
  const discordEpoch = 1420070400000n;
  const id = BigInt(snowflake);
  const timestamp = Number((id >> 22n) + BigInt(discordEpoch));
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// --- Zod schemas ---

const guildSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  icon: z.string().nullable().optional(),
  owner: z.boolean().optional(),
  permissions: z.string().optional(),
  member_count: z.number().int().optional(),
});

const channelSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  type: z.number().int(),
  topic: z.string().nullable().optional(),
  guild_id: z.string().optional(),
  parent_id: z.string().nullable().optional(),
  position: z.number().int().optional(),
  nsfw: z.boolean().optional(),
});

const messageSchema = z.object({
  id: z.string().min(1),
  content: z.string().default(""),
  author: z.object({
    id: z.string().min(1),
    username: z.string().default(""),
    discriminator: z.string().default("0"),
    bot: z.boolean().optional(),
  }),
  channel_id: z.string().min(1),
  timestamp: z.string().default(""),
  edited_timestamp: z.string().nullable().optional(),
  tts: z.boolean().optional(),
  mention_everyone: z.boolean().optional(),
  type: z.number().int().optional(),
});

const memberSchema = z.object({
  user: z
    .object({
      id: z.string().min(1),
      username: z.string().default(""),
      discriminator: z.string().default("0"),
      bot: z.boolean().optional(),
    })
    .optional(),
  nick: z.string().nullable().optional(),
  roles: z.array(z.string()).optional(),
  joined_at: z.string().nullable().optional(),
});

const CHANNEL_TYPE_NAMES: Record<number, string> = {
  0: "text",
  1: "dm",
  2: "voice",
  3: "group_dm",
  4: "category",
  5: "announcement",
  10: "announcement_thread",
  11: "public_thread",
  12: "private_thread",
  13: "stage_voice",
  14: "directory",
  15: "forum",
  16: "media",
};

function channelTypeName(type: number): string {
  return CHANNEL_TYPE_NAMES[type] ?? `unknown(${type})`;
}

// --- Tool shapes ---

const listGuildsInputShape = {
  limit: z.coerce.number().int().min(1).max(200).default(100),
};

const guildSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  isOwner: z.boolean(),
  permissions: z.string().nullable(),
});

const listGuildsOutputShape = {
  guilds: z.array(guildSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const listChannelsInputShape = {
  guildId: z.string().trim().min(1).describe("The guild (server) ID to list channels for."),
};

const channelSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  type: z.string(),
  topic: z.string().nullable(),
  position: z.number().int().nullable(),
  isNsfw: z.boolean(),
  parentId: z.string().nullable(),
});

const listChannelsOutputShape = {
  guildId: z.string().min(1),
  channels: z.array(channelSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const getMessagesInputShape = {
  channelId: z.string().trim().min(1).describe("The channel ID to fetch messages from."),
  limit: z.coerce.number().int().min(1).max(100).default(20).describe("Number of messages to fetch (max 100)."),
};

const messageSummarySchema = z.object({
  id: z.string().min(1),
  content: z.string(),
  authorId: z.string().min(1),
  authorName: z.string(),
  isBot: z.boolean(),
  timestamp: z.string(),
  editedTimestamp: z.string().nullable(),
});

const getMessagesOutputShape = {
  channelId: z.string().min(1),
  messages: z.array(messageSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const sendMessageInputShape = {
  channelId: z.string().trim().min(1).describe("The channel ID to send the message to."),
  content: z.string().trim().min(1).max(2000).describe("The message content (max 2000 characters)."),
};

const sendMessageOutputShape = {
  messageId: z.string().min(1),
  channelId: z.string().min(1),
  content: z.string(),
  timestamp: z.string(),
};

const getGuildMembersInputShape = {
  guildId: z.string().trim().min(1).describe("The guild (server) ID to list members for."),
  limit: z.coerce.number().int().min(1).max(1000).default(100).describe("Number of members to fetch (max 1000)."),
};

const memberSummarySchema = z.object({
  id: z.string().min(1),
  username: z.string(),
  nickname: z.string().nullable(),
  isBot: z.boolean(),
  roles: z.array(z.string()),
  joinedAt: z.string().nullable(),
});

const getGuildMembersOutputShape = {
  guildId: z.string().min(1),
  members: z.array(memberSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

// --- Client interface ---

export interface DiscordGuildSummary {
  id: string;
  name: string;
  isOwner: boolean;
  permissions: string | null;
}

export interface DiscordChannelSummary {
  id: string;
  name: string;
  type: string;
  topic: string | null;
  position: number | null;
  isNsfw: boolean;
  parentId: string | null;
}

export interface DiscordMessageSummary {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  isBot: boolean;
  timestamp: string;
  editedTimestamp: string | null;
}

export interface DiscordMemberSummary {
  id: string;
  username: string;
  nickname: string | null;
  isBot: boolean;
  roles: string[];
  joinedAt: string | null;
}

export interface DiscordClient {
  listGuilds(limit: number): Promise<DiscordGuildSummary[]>;
  listChannels(guildId: string): Promise<DiscordChannelSummary[]>;
  getMessages(channelId: string, limit: number): Promise<DiscordMessageSummary[]>;
  sendMessage(channelId: string, content: string): Promise<{ messageId: string; channelId: string; content: string; timestamp: string }>;
  getGuildMembers(guildId: string, limit: number): Promise<DiscordMemberSummary[]>;
}

// --- Concrete client ---

class RestDiscordClient implements DiscordClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  public constructor(token: string, baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  public async listGuilds(limit: number): Promise<DiscordGuildSummary[]> {
    const payload = await this.request("GET", `/users/@me/guilds?limit=${limit}`);
    const parsed = z.array(guildSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Discord returned an unexpected guild list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((g) => ({
      id: g.id,
      name: g.name,
      isOwner: g.owner ?? false,
      permissions: toNullableString(g.permissions),
    }));
  }

  public async listChannels(guildId: string): Promise<DiscordChannelSummary[]> {
    const payload = await this.request("GET", `/guilds/${guildId}/channels`);
    const parsed = z.array(channelSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Discord returned an unexpected channel list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((c) => ({
      id: c.id,
      name: c.name,
      type: channelTypeName(c.type),
      topic: toNullableString(c.topic),
      position: c.position ?? null,
      isNsfw: c.nsfw ?? false,
      parentId: toNullableString(c.parent_id),
    }));
  }

  public async getMessages(channelId: string, limit: number): Promise<DiscordMessageSummary[]> {
    const payload = await this.request("GET", `/channels/${channelId}/messages?limit=${limit}`);
    const parsed = z.array(messageSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Discord returned an unexpected message list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((m) => ({
      id: m.id,
      content: m.content,
      authorId: m.author.id,
      authorName: m.author.username,
      isBot: m.author.bot ?? false,
      timestamp: m.timestamp,
      editedTimestamp: toNullableString(m.edited_timestamp),
    }));
  }

  public async sendMessage(channelId: string, content: string): Promise<{ messageId: string; channelId: string; content: string; timestamp: string }> {
    const payload = await this.request("POST", `/channels/${channelId}/messages`, { content });
    const parsed = messageSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Discord returned an unexpected message response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      messageId: parsed.data.id,
      channelId: parsed.data.channel_id,
      content: parsed.data.content,
      timestamp: parsed.data.timestamp,
    };
  }

  public async getGuildMembers(guildId: string, limit: number): Promise<DiscordMemberSummary[]> {
    const payload = await this.request("GET", `/guilds/${guildId}/members?limit=${limit}`);
    const parsed = z.array(memberSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Discord returned an unexpected member list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((m) => ({
      id: m.user?.id ?? "",
      username: m.user?.username ?? "",
      nickname: toNullableString(m.nick),
      isBot: m.user?.bot ?? false,
      roles: m.roles ?? [],
      joinedAt: toNullableString(m.joined_at),
    }));
  }

  private async request(method: "GET" | "POST", path: string, body?: object): Promise<unknown> {
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bot ${this.token}`,
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
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Discord API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`Discord API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Discord authentication failed. Verify DISCORD_BOT_TOKEN.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Discord denied access to '${path}'. The bot may lack required permissions.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Discord resource at '${path}' was not found.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Discord rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Discord API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Render helpers ---

function renderGuilds(guilds: DiscordGuildSummary[]): string {
  if (guilds.length === 0) {
    return "The bot is not in any Discord guilds.";
  }
  const lines = guilds.map((g) => `- ${g.name} (${g.id})${g.isOwner ? " [owner]" : ""}`);
  return [`Returned ${guilds.length} guild(s).`, ...lines].join("\n");
}

function renderChannels(channels: DiscordChannelSummary[]): string {
  if (channels.length === 0) {
    return "No channels found in this guild.";
  }
  const lines = channels.map((c) => {
    const topic = c.topic ? ` — ${c.topic}` : "";
    return `- #${c.name} (${c.id}, ${c.type})${topic}`;
  });
  return [`Returned ${channels.length} channel(s).`, ...lines].join("\n");
}

function renderMessages(messages: DiscordMessageSummary[]): string {
  if (messages.length === 0) {
    return "No messages in this channel.";
  }
  const lines = messages.slice(0, 10).map((m) => {
    const bot = m.isBot ? " [bot]" : "";
    return `- ${m.authorName}${bot} at ${m.timestamp}: ${m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}`;
  });
  if (messages.length > 10) {
    lines.push(`- ${messages.length - 10} additional message(s) omitted.`);
  }
  return [`Returned ${messages.length} message(s).`, ...lines].join("\n");
}

function renderSentMessage(messageId: string, channelId: string): string {
  return `Sent message ${messageId} to channel ${channelId}.`;
}

function renderMembers(members: DiscordMemberSummary[]): string {
  if (members.length === 0) {
    return "No members found in this guild.";
  }
  const lines = members.slice(0, 20).map((m) => {
    const nick = m.nickname ? ` (${m.nickname})` : "";
    const bot = m.isBot ? " [bot]" : "";
    return `- ${m.username}${nick}${bot}`;
  });
  if (members.length > 20) {
    lines.push(`- ${members.length - 20} additional member(s) omitted.`);
  }
  return [`Returned ${members.length} member(s).`, ...lines].join("\n");
}

// --- Server ---

export interface DiscordServerOptions {
  client: DiscordClient;
}

export class DiscordServer extends ToolkitServer {
  private readonly client: DiscordClient;

  public constructor(options: DiscordServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: LIST_GUILDS_TOOL_NAME,
        title: "List Discord guilds",
        description: "List all guilds (servers) the bot is currently in.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listGuildsInputShape,
        outputSchema: listGuildsOutputShape,
        handler: async (input, context) => {
          await context.log("info", "Listing Discord guilds.");
          try {
            const guilds = await this.client.listGuilds(input.limit);
            return { guilds, returnedCount: guilds.length };
          } catch (error) {
            throw this.mapOperationError(LIST_GUILDS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderGuilds(output.guilds),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_CHANNELS_TOOL_NAME,
        title: "List Discord channels",
        description: "List all channels in a specific Discord guild by guild ID.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listChannelsInputShape,
        outputSchema: listChannelsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Listing channels for guild ${input.guildId}.`);
          try {
            const channels = await this.client.listChannels(input.guildId);
            return { guildId: input.guildId, channels, returnedCount: channels.length };
          } catch (error) {
            throw this.mapOperationError(LIST_CHANNELS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderChannels(output.channels),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_MESSAGES_TOOL_NAME,
        title: "Get Discord messages",
        description: "Fetch recent messages from a Discord channel.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getMessagesInputShape,
        outputSchema: getMessagesOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching messages from channel ${input.channelId}.`);
          try {
            const messages = await this.client.getMessages(input.channelId, input.limit);
            return { channelId: input.channelId, messages, returnedCount: messages.length };
          } catch (error) {
            throw this.mapOperationError(GET_MESSAGES_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMessages(output.messages),
      }),
    );

    this.registerTool(
      defineTool({
        name: SEND_MESSAGE_TOOL_NAME,
        title: "Send Discord message",
        description: "Send a message to a Discord channel by channel ID.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: sendMessageInputShape,
        outputSchema: sendMessageOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Sending message to channel ${input.channelId}.`);
          try {
            const result = await this.client.sendMessage(input.channelId, input.content);
            return result;
          } catch (error) {
            throw this.mapOperationError(SEND_MESSAGE_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderSentMessage(output.messageId, output.channelId),
      }),
    );

    this.registerTool(
      defineTool({
        name: GET_GUILD_MEMBERS_TOOL_NAME,
        title: "Get Discord guild members",
        description: "List members of a specific Discord guild.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: getGuildMembersInputShape,
        outputSchema: getGuildMembersOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Fetching members for guild ${input.guildId}.`);
          try {
            const members = await this.client.getGuildMembers(input.guildId, input.limit);
            return { guildId: input.guildId, members, returnedCount: members.length };
          } catch (error) {
            throw this.mapOperationError(GET_GUILD_MEMBERS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderMembers(output.members),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError {
    if (error instanceof ExternalServiceError) {
      return error;
    }
    return new ExternalServiceError(`Discord operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateDiscordServerOptions {
  client?: DiscordClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  DISCORD_BOT_TOKEN: z.string().trim().min(1, "DISCORD_BOT_TOKEN is required."),
  DISCORD_API_BASE_URL: z.string().trim().url().default(DISCORD_API_BASE_URL),
};

export function createServer(options: CreateDiscordServerOptions = {}): DiscordServer {
  const env = loadEnv(envShape, options.env);
  const client = options.client ?? new RestDiscordClient(env.DISCORD_BOT_TOKEN, env.DISCORD_API_BASE_URL, options.fetchImpl);
  return new DiscordServer({ client });
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
