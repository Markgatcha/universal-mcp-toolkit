/**
 * @universal-mcp-toolkit/ai-sdk — Connect UMT's MCP servers to the Vercel AI SDK.
 *
 * This package provides a single `umtTools()` function that returns
 * AI SDK-compatible tool objects, so you can use any of UMT's 28 MCP servers
 * with `streamText()`, `generateText()`, and the AI SDK agent APIs —
 * zero boilerplate, zero provider lock-in.
 *
 * @example Quick Start
 * ```ts
 * import { streamText } from "ai";
 * import { umtTools } from "@universal-mcp-toolkit/ai-sdk";
 *
 * const tools = await umtTools({
 *   servers: ["github", "slack"],
 *   env: {
 *     GITHUB_TOKEN: process.env.GITHUB_TOKEN,
 *     SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
 *   },
 * });
 *
 * const result = await streamText({
 *   model: openrouter("google/gemini-2.0-flash"),
 *   prompt: "List open issues in owner/repo",
 *   tools,
 * });
 * ```
 *
 * @example With generateText
 * ```ts
 * import { generateText } from "ai";
 * import { umtTools } from "@universal-mcp-toolkit/ai-sdk";
 *
 * const tools = await umtTools({
 *   servers: ["notion"],
 *   env: { NOTION_TOKEN: process.env.NOTION_TOKEN },
 * });
 *
 * const { text, toolResults } = await generateText({
 *   model: openrouter("anthropic/claude-3-5-sonnet"),
 *   prompt: "Summarize my Notion page titled 'Project Plan'",
 *   tools,
 * });
 * ```
 *
 * @module @universal-mcp-toolkit/ai-sdk
 */

// Core function — turn MCP servers into AI SDK tools.
export { umtTools, umtToolsFor, type UmtTool, type UmtToolConfig, type UmtTools } from "./umt-tools.js";

// Bridge utilities — re-export the bridge's core types for convenience.
export { MCPFunctionCallingBridge } from "@universal-mcp-toolkit/bridge";

// Re-export the BridgeConversation for advanced usage.
export { BridgeConversation } from "@universal-mcp-toolkit/bridge";
