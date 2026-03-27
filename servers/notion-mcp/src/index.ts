import { pathToFileURL } from "node:url";
import { ExternalServiceError, createServerCard, defineTool, loadEnv, normalizeError, parseRuntimeOptions, runToolkitServer, ToolkitServer, type ToolkitServerMetadata } from "@universal-mcp-toolkit/core";
import { Client } from "@notionhq/client";
import { z } from "zod";

const toolNames = ["notion_search", "notion_get_page", "notion_create_page", "notion_update_page", "notion_append_blocks", "notion_get_database", "notion_query_database", "notion_create_database_entry"] as const;

const envShape = { NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required") };

export const metadata: ToolkitServerMetadata = {
  id: "notion-mcp", title: "Notion MCP Server", description: "Full Notion workspace integration.", version: "1.2.0",
  packageName: "@contextcore/mcp-notion", homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit", documentationUrl: "https://developers.notion.com/reference",
  envVarNames: ["NOTION_API_KEY"], transports: ["stdio", "sse"], toolNames, resourceNames: [], promptNames: [],
};

export const serverCard = createServerCard(metadata);
export class NotionMcpServer extends ToolkitServer {
  private client: Client;
  constructor(apiKey: string) { super(metadata); this.client = new Client({ auth: apiKey }); }
}
export function createServer(): NotionMcpServer { const env = loadEnv(envShape); return new NotionMcpServer(env.NOTION_API_KEY); }
export async function main(argv: string[]): Promise<void> { await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv)); }
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { main(process.argv).catch((e) => { console.error(normalizeError(e).toClientMessage()); process.exit(1); }); }
