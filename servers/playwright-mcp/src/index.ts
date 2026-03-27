import { pathToFileURL } from "node:url";
import { ExternalServiceError, createServerCard, defineTool, loadEnv, normalizeError, parseRuntimeOptions, runToolkitServer, ToolkitServer, type ToolkitServerMetadata } from "@universal-mcp-toolkit/core";
import { chromium } from "playwright";
import { z } from "zod";

const toolNames = ["playwright_navigate", "playwright_screenshot", "playwright_click", "playwright_fill", "playwright_evaluate", "playwright_get_text", "playwright_get_links", "playwright_wait_for", "playwright_close"] as const;

const envShape = { PLAYWRIGHT_BROWSER: z.enum(["chromium", "firefox", "webkit"]).default("chromium") };

export const metadata: ToolkitServerMetadata = {
  id: "playwright-mcp", title: "Playwright MCP Server", description: "Browser automation and web scraping.", version: "1.2.0",
  packageName: "@contextcore/mcp-playwright", homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit", documentationUrl: "https://playwright.dev",
  envVarNames: [], transports: ["stdio", "sse"], toolNames, resourceNames: [], promptNames: [],
};

export const serverCard = createServerCard(metadata);
export class PlaywrightMcpServer extends ToolkitServer {
  private browser: null = null;
  constructor() { super(metadata); }
}
export function createServer(): PlaywrightMcpServer { return new PlaywrightMcpServer(); }
export async function main(argv: string[]): Promise<void> { await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv)); }
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { main(process.argv).catch((e) => { console.error(normalizeError(e).toClientMessage()); process.exit(1); }); }
