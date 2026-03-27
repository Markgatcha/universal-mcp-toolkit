import { pathToFileURL } from "node:url";
import { ExternalServiceError, createServerCard, defineTool, loadEnv, normalizeError, parseRuntimeOptions, runToolkitServer, ToolkitServer, type ToolkitServerMetadata } from "@universal-mcp-toolkit/core";
import { WebClient } from "@slack/web-api";
import { z } from "zod";

const toolNames = ["slack_list_channels", "slack_get_channel", "slack_post_message", "slack_get_messages", "slack_search_messages", "slack_get_user", "slack_list_users", "slack_upload_file", "slack_add_reaction", "slack_get_thread"] as const;

const envShape = { SLACK_BOT_TOKEN: z.string().min(1, "SLACK_BOT_TOKEN is required") };

export const metadata: ToolkitServerMetadata = {
  id: "slack-mcp", title: "Slack MCP Server", description: "Full Slack workspace integration.", version: "1.2.0",
  packageName: "@contextcore/mcp-slack", homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit", documentationUrl: "https://api.slack.com/",
  envVarNames: ["SLACK_BOT_TOKEN"], transports: ["stdio", "sse"], toolNames, resourceNames: [], promptNames: [],
};

export const serverCard = createServerCard(metadata);
export class SlackMcpServer extends ToolkitServer {
  private client: WebClient;
  constructor(token: string) { super(metadata); this.client = new WebClient(token); }
}
export function createServer(): SlackMcpServer { const env = loadEnv(envShape); return new SlackMcpServer(env.SLACK_BOT_TOKEN); }
export async function main(argv: string[]): Promise<void> { await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv)); }
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { main(process.argv).catch((e) => { console.error(normalizeError(e).toClientMessage()); process.exit(1); }); }
