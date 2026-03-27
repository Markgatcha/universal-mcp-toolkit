import { pathToFileURL } from "node:url";
import { ExternalServiceError, createServerCard, defineTool, loadEnv, normalizeError, parseRuntimeOptions, runToolkitServer, ToolkitServer, type ToolkitServerMetadata } from "@universal-mcp-toolkit/core";
import OpenAI from "openai";
import { z } from "zod";

const toolNames = ["openai_chat", "openai_complete", "openai_embed", "openai_list_models", "openai_image_generate", "openai_moderate", "openai_transcribe", "openai_function_call"] as const;

const envShape = { OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"), OPENAI_BASE_URL: z.string().url().optional(), OPENAI_DEFAULT_MODEL: z.string().default("gpt-4o") };

export const metadata: ToolkitServerMetadata = {
  id: "openai-mcp", title: "OpenAI MCP Server", description: "OpenAI/Codex API integration.", version: "1.2.0",
  packageName: "@contextcore/mcp-openai", homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit", documentationUrl: "https://platform.openai.com/docs",
  envVarNames: ["OPENAI_API_KEY"], transports: ["stdio", "sse"], toolNames, resourceNames: [], promptNames: [],
};

export const serverCard = createServerCard(metadata);
export class OpenAiMcpServer extends ToolkitServer {
  private client: OpenAI;
  constructor(apiKey: string) { super(metadata); this.client = new OpenAI({ apiKey }); }
}
export function createServer(): OpenAiMcpServer { const env = loadEnv(envShape); return new OpenAiMcpServer(env.OPENAI_API_KEY); }
export async function main(argv: string[]): Promise<void> { await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv)); }
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { main(process.argv).catch((e) => { console.error(normalizeError(e).toClientMessage()); process.exit(1); }); }
