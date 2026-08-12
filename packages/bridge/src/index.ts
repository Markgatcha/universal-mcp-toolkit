/**
 * @universal-mcp-toolkit/bridge — Connect any MCP server to any LLM provider.
 *
 * This package bridges the gap between MCP (Model Context Protocol) servers
 * and LLM function-calling APIs (OpenAI, Anthropic, Ollama). It provides:
 *
 * - **`MCPFunctionCallingBridge`** — Connect to any MCP server (stdio/SSE/HTTP),
 *   list tools, and call them via a unified interface.
 * - **`serializeAll()` / `toOpenAI()` / `toAnthropic()` / `toOllama()`** —
 *   Convert MCP tool definitions to any provider's function-calling format.
 * - **`BridgeConversation`** — Run an agent conversation loop that automatically
 *   bridges LLM function calls to MCP tool execution.
 * - **CLI** — `list-tools`, `call-tool`, and `chat` commands for testing.
 *
 * @example Quick Start (programmatic)
 * ```ts
 * import { MCPFunctionCallingBridge, toProvider } from "@universal-mcp-toolkit/bridge";
 *
 * // Connect to the GitHub MCP server
 * const bridge = new MCPFunctionCallingBridge({
 *   transport: "stdio",
 *   commandOrUrl: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-github"],
 * });
 * await bridge.connect();
 *
 * // Get tools in OpenAI format
 * const listing = await bridge.listTools();
 * const tools = toProvider(listing.tools, "gpt-4o"); // auto-detects format
 *
 * // Use with OpenAI SDK
 * const response = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   messages,
 *   tools,
 * });
 *
 * // Execute any tool calls the LLM made
 * if (response.choices[0].message.tool_calls) {
 *   for (const tc of response.choices[0].message.tool_calls) {
 *     const result = await bridge.callTool(tc.function.name, JSON.parse(tc.function.arguments));
 *     console.log(result.output);
 *   }
 * }
 * ```
 *
 * @example Full Conversation Loop
 * ```ts
 * import { MCPFunctionCallingBridge, BridgeConversation } from "@universal-mcp-toolkit/bridge";
 * import { myOpenAIProvider } from "./providers/openai";
 *
 * const bridge = new MCPFunctionCallingBridge({
 *   transport: "stdio",
 *   commandOrUrl: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-github"],
 * });
 * await bridge.connect();
 *
 * const convo = new BridgeConversation(bridge, {
 *   systemPrompt: "You are a GitHub assistant. Help me manage issues.",
 *   maxRounds: 5,
 * });
 *
 * const response = await convo.run("List open issues in my/repo", myOpenAIProvider, "gpt-4o");
 * console.log(response.content);
 * ```
 *
 * @example CLI Usage
 * ```bash
 * # List tools from a stdio MCP server
 * npx umt-bridge list-tools --transport stdio \
 *   --command npx --args -y --args @modelcontextprotocol/server-github
 *
 * # Call a specific tool
 * npx umt-bridge call-tool --tool github_list_issues \
 *   --input '{"owner":"user","repo":"my-repo"}'
 *
 * # Start an interactive chat with OpenAI
 * npx umt-bridge chat --model gpt-4o --apiKey sk-... --provider openai
 * ```
 *
 * @module @universal-mcp-toolkit/bridge
 */

// Core bridge class — connects to MCP servers and executes tools.
export { MCPFunctionCallingBridge } from "./bridge.js";

// Conversation runner — full agent loop with LLM providers.
export {
  BridgeConversation,
  type LLMProvider,
  type BridgeMessage,
  type BridgeToolCall,
  type ConversationConfig,
} from "./conversation.js";

// Serializers — convert tools to OpenAI / Anthropic / Ollama formats.
export {
  toOpenAI,
  toAnthropic,
  toOllama,
  serializeAll,
  detectProvider,
  toProvider,
  type OpenAITool,
  type AnthropicTool,
  type OllamaTool,
  type SerializedToolsets,
  type ProviderFormat,
} from "./serializers.js";

// Type definitions — shared interfaces used across the bridge.
export type {
  AuditLogEntry,
  BridgeTool,
  BridgeToolResult,
  BridgeTransport,
  BridgeServerConfig,
  BridgeOptions,
  ToolAuditLogger,
  ToolListing,
  FunctionCall,
  ToolChain,
  ToolChainStep,
  PolicyRule,
  PolicyContext,
  PolicyDecision,
  Policy,
  PolicyResolver,
  PolicyRegistry,
} from "./types.js";

// Policy engine — RBAC/policy-based access control.
export { PolicyEngine } from "./types.js";

// Session — multi-server orchestration with parallel tool calls.
export { Session } from "./session.js";
export type { SessionConfig, SessionToolResult } from "./session.js";

// Health monitoring — circuit breaker, auto-reconnect, and health events.
export { HealthMonitor } from "./health-monitor.js";
export type { HealthEvent, HealthEventListener, HealthMonitorOptions, CircuitState } from "./health-monitor.js";

// OpenTelemetry observability — GenAI semantic convention traces.
export { BridgeObservability, estimateTokenCost, estimateTokenCount } from "./observability.js";
export type { ObservabilityOptions } from "./observability.js";

// A2A Protocol server adapter — expose MCP tools via Google's Agent2Agent protocol.
export {
  A2AServerAdapter,
  A2A_ERROR_CODES,
  artifactToText,
  serializeResponse,
  parseRequest,
} from "./a2a.js";
export type {
  A2AAgentCard,
  A2ACapabilities,
  A2APushNotificationConfig,
  A2ASkill,
  A2ATask,
  A2ATaskState,
  A2ATaskStatus,
  A2AArtifact,
  A2APart,
  A2AMessage,
  A2AJsonRpcRequest,
  A2AJsonRpcResponse,
  A2AJsonRpcError,
  AuthConfig,
  A2AServerConfig,
} from "./a2a.js";
