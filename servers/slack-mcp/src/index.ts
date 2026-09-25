import { pathToFileURL } from "node:url";
import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { WebClient } from "@slack/web-api";
import { z } from "zod";

const toolNames = [
  "slack_list_channels",
  "slack_get_channel",
  "slack_post_message",
  "slack_get_messages",
  "slack_search_messages",
  "slack_get_user",
  "slack_list_users",
  "slack_upload_file",
  "slack_add_reaction",
  "slack_get_thread",
] as const;

const envShape = { SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required") };

export const metadata: ToolkitServerMetadata = {
  id: "slack-mcp",
  title: "Slack MCP Server",
  description: "Full Slack workspace integration.",
  version: "1.2.0",
  packageName: "@contextcore/mcp-slack",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://api.slack.com/",
  envVarNames: ["SLACK_BOT_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames: [],
  promptNames: [],
};

export const serverCard = createServerCard(metadata);

const channelSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  isPrivate: z.boolean(),
  isArchived: z.boolean(),
  memberCount: z.number().int().nonnegative(),
  topic: z.string(),
  purpose: z.string(),
});

const messageSummarySchema = z.object({
  ts: z.string(),
  user: z.string(),
  text: z.string(),
  threadTs: z.string().nullable(),
});

const userSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  realName: z.string(),
  isBot: z.boolean(),
  isAdmin: z.boolean(),
});

function wrapSlackError(action: string, error: unknown): never {
  if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
    throw error;
  }
  const normalized = normalizeError(error);
  throw new ExternalServiceError(`Failed to ${action}. ${normalized.toClientMessage()}`, {
    details: normalized.details,
  });
}

function assertOk(result: { ok?: boolean; error?: string }, action: string): void {
  if (!result.ok) {
    throw new ExternalServiceError(`Slack API rejected the request to ${action}: ${result.error ?? "unknown error"}.`);
  }
}

export class SlackMcpServer extends ToolkitServer {
  private client: WebClient;

  constructor(token: string, client?: WebClient) {
    super(metadata);
    this.client = client ?? new WebClient(token);

    this.registerTool(
      defineTool({
        name: "slack_list_channels",
        title: "List Slack channels",
        description: "List channels in the Slack workspace.",
        inputSchema: {
          includePrivate: z.boolean().default(false),
          excludeArchived: z.boolean().default(true),
          limit: z.number().int().min(1).max(1000).default(100),
        },
        outputSchema: {
          channels: z.array(channelSummarySchema),
          channelCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", "Listing Slack channels");
          try {
            const types = input.includePrivate ? "public_channel,private_channel" : "public_channel";
            const response = await this.client.conversations.list({
              types,
              exclude_archived: input.excludeArchived,
              limit: input.limit,
            });
            assertOk(response, "list channels");
            const channels = (response.channels ?? []).map((channel) => ({
              id: channel.id ?? "",
              name: channel.name ?? "",
              isPrivate: channel.is_private ?? false,
              isArchived: channel.is_archived ?? false,
              memberCount: channel.num_members ?? 0,
              topic: channel.topic?.value ?? "",
              purpose: channel.purpose?.value ?? "",
            }));
            return { channels, channelCount: channels.length };
          } catch (error) {
            wrapSlackError("list channels", error);
          }
        },
        renderText: ({ channelCount, channels }) =>
          channelCount === 0
            ? "No channels found."
            : channels.map((channel) => `#${channel.name} (${channel.id})`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_get_channel",
        title: "Get a Slack channel",
        description: "Get details about a single Slack channel.",
        inputSchema: {
          channelId: z.string().trim().min(1),
        },
        outputSchema: {
          channel: channelSummarySchema,
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Getting Slack channel ${input.channelId}`);
          try {
            const response = await this.client.conversations.info({ channel: input.channelId });
            assertOk(response, "get channel info");
            const channel = response.channel;
            if (!channel) {
              throw new ValidationError(`Slack did not return channel info for '${input.channelId}'.`);
            }
            return {
              channel: {
                id: channel.id ?? "",
                name: channel.name ?? "",
                isPrivate: channel.is_private ?? false,
                isArchived: channel.is_archived ?? false,
                memberCount: channel.num_members ?? 0,
                topic: channel.topic?.value ?? "",
                purpose: channel.purpose?.value ?? "",
              },
            };
          } catch (error) {
            wrapSlackError("get channel info", error);
          }
        },
        renderText: ({ channel }) => `#${channel.name} (${channel.id})`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_post_message",
        title: "Post a Slack message",
        description: "Post a message to a Slack channel.",
        inputSchema: {
          channelId: z.string().trim().min(1),
          text: z.string().trim().min(1),
          threadTs: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          channel: z.string(),
          ts: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", `Posting message to ${input.channelId}`);
          try {
            const response = await this.client.chat.postMessage({
              channel: input.channelId,
              text: input.text,
              ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
            });
            assertOk(response, "post message");
            return { channel: response.channel ?? input.channelId, ts: response.ts ?? "" };
          } catch (error) {
            wrapSlackError("post the message", error);
          }
        },
        renderText: ({ channel, ts }) => `Posted message to ${channel} (ts: ${ts}).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_get_messages",
        title: "Get channel messages",
        description: "Fetch recent messages from a Slack channel.",
        inputSchema: {
          channelId: z.string().trim().min(1),
          limit: z.number().int().min(1).max(200).default(20),
          oldest: z.string().trim().min(1).optional(),
          latest: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          messages: z.array(messageSummarySchema),
          messageCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Fetching messages from ${input.channelId}`);
          try {
            const response = await this.client.conversations.history({
              channel: input.channelId,
              limit: input.limit,
              ...(input.oldest ? { oldest: input.oldest } : {}),
              ...(input.latest ? { latest: input.latest } : {}),
            });
            assertOk(response, "fetch channel history");
            const messages = (response.messages ?? []).map((message) => ({
              ts: message.ts ?? "",
              user: message.user ?? "",
              text: message.text ?? "",
              threadTs: message.thread_ts ?? null,
            }));
            return { messages, messageCount: messages.length };
          } catch (error) {
            wrapSlackError("fetch channel history", error);
          }
        },
        renderText: ({ messageCount }) => `Fetched ${messageCount} message(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_search_messages",
        title: "Search Slack messages",
        description: "Search messages across the Slack workspace.",
        inputSchema: {
          query: z.string().trim().min(1),
          count: z.number().int().min(1).max(100).default(20),
        },
        outputSchema: {
          messages: z.array(messageSummarySchema),
          messageCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Searching Slack for "${input.query}"`);
          try {
            const response = await this.client.search.messages({
              query: input.query,
              count: input.count,
            });
            assertOk(response, "search messages");
            const matches = response.messages?.matches ?? [];
            const messages = matches.map((match) => {
              const loose = match as { ts?: string; user?: string; text?: string; thread_ts?: string };
              return {
                ts: loose.ts ?? "",
                user: loose.user ?? "",
                text: loose.text ?? "",
                threadTs: loose.thread_ts ?? null,
              };
            });
            return { messages, messageCount: messages.length };
          } catch (error) {
            wrapSlackError("search messages", error);
          }
        },
        renderText: ({ messageCount }) => `Found ${messageCount} matching message(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_get_user",
        title: "Get a Slack user",
        description: "Get profile details for a Slack user.",
        inputSchema: {
          userId: z.string().trim().min(1),
        },
        outputSchema: {
          user: userSummarySchema,
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Getting Slack user ${input.userId}`);
          try {
            const response = await this.client.users.info({ user: input.userId });
            assertOk(response, "get user info");
            const user = response.user;
            if (!user) {
              throw new ValidationError(`Slack did not return user info for '${input.userId}'.`);
            }
            return {
              user: {
                id: user.id ?? "",
                name: user.name ?? "",
                realName: user.real_name ?? "",
                isBot: user.is_bot ?? false,
                isAdmin: user.is_admin ?? false,
              },
            };
          } catch (error) {
            wrapSlackError("get user info", error);
          }
        },
        renderText: ({ user }) => `${user.realName || user.name} (${user.id})`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_list_users",
        title: "List Slack users",
        description: "List members of the Slack workspace.",
        inputSchema: {
          limit: z.number().int().min(1).max(1000).default(100),
        },
        outputSchema: {
          users: z.array(userSummarySchema),
          userCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", "Listing Slack users");
          try {
            const response = await this.client.users.list({ limit: input.limit });
            assertOk(response, "list users");
            const users = (response.members ?? []).map((member) => ({
              id: member.id ?? "",
              name: member.name ?? "",
              realName: member.real_name ?? "",
              isBot: member.is_bot ?? false,
              isAdmin: member.is_admin ?? false,
            }));
            return { users, userCount: users.length };
          } catch (error) {
            wrapSlackError("list users", error);
          }
        },
        renderText: ({ userCount }) => `Found ${userCount} user(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_upload_file",
        title: "Upload a file to Slack",
        description: "Upload text content as a file to a Slack channel.",
        inputSchema: {
          channelId: z.string().trim().min(1),
          content: z.string().min(1),
          filename: z.string().trim().min(1).default("upload.txt"),
          title: z.string().trim().min(1).optional(),
          initialComment: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          fileIds: z.array(z.string()),
        },
        handler: async (input, context) => {
          await context.log("info", `Uploading file to ${input.channelId}`);
          try {
            const response = await this.client.filesUploadV2({
              channel_id: input.channelId,
              content: input.content,
              filename: input.filename,
              ...(input.title ? { title: input.title } : {}),
              ...(input.initialComment ? { initial_comment: input.initialComment } : {}),
            });
            assertOk(response, "upload file");
            const files = (response as { files?: Array<{ id?: string }> }).files ?? [];
            return { fileIds: files.map((file) => file.id ?? "").filter((id) => id.length > 0) };
          } catch (error) {
            wrapSlackError("upload the file", error);
          }
        },
        renderText: ({ fileIds }) => `Uploaded ${fileIds.length} file(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_add_reaction",
        title: "Add a reaction",
        description: "Add an emoji reaction to a Slack message.",
        inputSchema: {
          channelId: z.string().trim().min(1),
          timestamp: z.string().trim().min(1),
          name: z.string().trim().min(1),
        },
        outputSchema: {
          added: z.boolean(),
        },
        handler: async (input, context) => {
          await context.log("info", `Adding reaction :${input.name}:`);
          try {
            const response = await this.client.reactions.add({
              channel: input.channelId,
              timestamp: input.timestamp,
              name: input.name,
            });
            assertOk(response, "add reaction");
            return { added: true };
          } catch (error) {
            wrapSlackError("add the reaction", error);
          }
        },
        renderText: () => "Reaction added.",
      }),
    );

    this.registerTool(
      defineTool({
        name: "slack_get_thread",
        title: "Get a message thread",
        description: "Fetch all replies in a Slack message thread.",
        inputSchema: {
          channelId: z.string().trim().min(1),
          threadTs: z.string().trim().min(1),
          limit: z.number().int().min(1).max(200).default(50),
        },
        outputSchema: {
          messages: z.array(messageSummarySchema),
          messageCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Fetching thread ${input.threadTs}`);
          try {
            const response = await this.client.conversations.replies({
              channel: input.channelId,
              ts: input.threadTs,
              limit: input.limit,
            });
            assertOk(response, "fetch thread replies");
            const messages = (response.messages ?? []).map((message) => ({
              ts: message.ts ?? "",
              user: message.user ?? "",
              text: message.text ?? "",
              threadTs: message.thread_ts ?? null,
            }));
            return { messages, messageCount: messages.length };
          } catch (error) {
            wrapSlackError("fetch the thread", error);
          }
        },
        renderText: ({ messageCount }) => `Fetched ${messageCount} thread message(s).`,
      }),
    );

    this.assertMetadataMatchesRegistrations();
  }

  private assertMetadataMatchesRegistrations(): void {
    const sortNames = (names: readonly string[]) => [...names].sort();
    if (JSON.stringify(sortNames(this.getToolNames())) !== JSON.stringify(sortNames(metadata.toolNames))) {
      throw new ConfigurationError("metadata.toolNames must match the registered tool names.", {
        expected: metadata.toolNames,
        actual: this.getToolNames(),
      });
    }
  }
}

export function createServer(): SlackMcpServer {
  const env = loadEnv(envShape);
  return new SlackMcpServer(env.SLACK_BOT_TOKEN);
}

export async function main(argv: string[]): Promise<void> {
  await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(normalizeError(e).toClientMessage());
    process.exit(1);
  });
}
