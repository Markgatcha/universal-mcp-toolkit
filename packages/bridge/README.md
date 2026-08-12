# @universal-mcp-toolkit/bridge

**Connect any MCP server to any LLM provider — zero SDK lock-in.**

This package bridges Model Context Protocol (MCP) servers to OpenAI, Anthropic, and Ollama function-calling APIs. Use any of the 41+ MCP servers in the universal-mcp-toolkit with your preferred LLM provider, without writing provider-specific code.

## Why Use This?

| Without the Bridge | With the Bridge |
|---|---|
| You must pick an MCP-compatible LLM provider | Use **any** LLM provider (OpenAI, Anthropic, Ollama, etc.) |
| Your code is tightly coupled to MCP's tool format | Same tool definitions work across all providers |
| Each provider needs custom tool serialization | One-line serialization: `toOpenAI(tools)`, `toAnthropic(tools)`, `toOllama(tools)` |
| No conversation loop — manual tool-calling code | Full agent loop: `conversation.run()` handles the entire loop |

## Installation

```bash
npm install @universal-mcp-toolkit/bridge
```

## Quick Start

### Programmatic Usage

```typescript
import {
  MCPFunctionCallingBridge,
  BridgeConversation,
  toOpenAI,
  toAnthropic,
  toOllama,
  serializeAll,
  detectProvider,
} from "@universal-mcp-toolkit/bridge";
import OpenAI from "openai";

// 1. Connect to an MCP server
const bridge = new MCPFunctionCallingBridge({
  transport: "stdio",
  commandOrUrl: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
});

await bridge.connect();

// 2. Get tools in your provider's format
const listing = await bridge.listTools();
const tools = toOpenAI(listing.tools);

// 3. Use with OpenAI
const openai = new OpenAI({ apiKey: "sk-..." });
const response = await openai.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "List open issues in my/repo" }],
  tools,
});

// 4. Execute tool calls through the bridge
if (response.choices[0].message.tool_calls) {
  for (const tc of response.choices[0].message.tool_calls) {
    const result = await bridge.callTool(
      tc.function.name,
      JSON.parse(tc.function.arguments),
    );
    console.log(result.output);
  }
}

await bridge.disconnect();
```

### Full Conversation Loop

```typescript
import { MCPFunctionCallingBridge, BridgeConversation } from "@universal-mcp-toolkit/bridge";
import { toProvider } from "@universal-mcp-toolkit/bridge";
import OpenAI from "openai";

const bridge = new MCPFunctionCallingBridge({
  transport: "stdio",
  commandOrUrl: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
});
await bridge.connect();

const openai = new OpenAI({ apiKey: "sk-..." });

// Wrap your OpenAI client in the LLMProvider interface
const provider = {
  async chat(messages, tools, providerFormat) {
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: messages.map(m => ({
        role: m.role === "tool" ? "tool" : m.role,
        content: m.content,
        ...(m.toolCallId ? { tool_call_id: m.toolCallId } : {}),
        ...(m.name ? { name: m.name } : {}),
      })),
      tools,
      temperature: 0.7,
    });

    const msg = response.choices[0].message;
    return {
      content: msg.content || "",
      toolCalls: (msg.tool_calls || []).map(tc => ({
        id: tc.id,
        name: tc.function.name,
        arguments: JSON.parse(tc.function.arguments),
      })),
    };
  },
};

const conversation = new BridgeConversation(bridge, {
  systemPrompt: "You are a helpful GitHub assistant.",
  maxRounds: 5,
});

const result = await conversation.run(
  "Create an issue about improving the README",
  provider,
  "gpt-4o",
);
console.log(result.content);

await bridge.disconnect();
```

### CLI Usage

```bash
# List all tools from an MCP server
npx umt-bridge list-tools \
  --transport stdio \
  --command npx \
  --args -y \
  --args @modelcontextprotocol/server-github

# Call a specific tool
npx umt-bridge call-tool \
  --tool github_list_issues \
  --input '{"owner":"user","repo":"my-repo"}' \
  --transport stdio \
  --command npx \
  --args -y \
  --args @modelcontextprotocol/server-github

# Interactive chat (requires --apiKey and --provider)
npx umt-bridge chat --model gpt-4o --apiKey sk-... --provider openai
```

## API Reference

### `MCPFunctionCallingBridge`

The core bridge class that connects to MCP servers and executes tools.

```typescript
new MCPFunctionCallingBridge(config: BridgeServerConfig, options?: BridgeOptions)
```

**Methods:**
- `connect()` — Connect to the MCP server
- `listTools()` — List all available tools
- `callTool(name, args, timeoutMs?)` — Execute an authorized tool with timeout cleanup and structured errors
- `callToolStreaming(name, args, timeoutMs?)` — Buffer a completed result and expose it as an async chunk iterator
- `callToolChain(chain)` — Execute a sequence of tools with piped outputs
- `getCacheStats()` — Get cache statistics (null if caching is disabled)
- `disconnect()` — Close the connection

**Options:**
- `allowedTools: string[]` — Enforce a tool allowlist during listing and direct execution
- `policies` — Apply per-tool RBAC before reconnect, cache lookup, or execution
- `auditLog` — Record redacted success, failure, and authorization decisions
- `observability` — Emit optional OpenTelemetry spans
- `cache: { ttlMs?, maxSize? }` — Enable TTL+LRU result caching for tool calls

`callToolStreaming()` is a convenience iterator over a completed result. It does not provide incremental MCP protocol streaming.

### Caching

Enable an in-memory TTL + LRU cache to avoid redundant MCP server calls:

```typescript
const bridge = new MCPFunctionCallingBridge(
  config,
  { cache: { ttlMs: 60_000, maxSize: 200 } },
);

await bridge.connect();
const result1 = await bridge.callTool("list_issues", { owner: "user", repo: "repo" });
const result2 = await bridge.callTool("list_issues", { owner: "user", repo: "repo" });
// result2 is returned from cache — no new MCP server call!

// Check cache stats
console.log(bridge.getCacheStats()); // { size: 1, maxSize: 200, ttlMs: 60000 }
```

### Type-Safe Tool Chaining

Chain multiple tool calls where each step's output feeds into the next:

```typescript
import { MCPFunctionCallingBridge } from "@universal-mcp-toolkit/bridge";

const results = await bridge.callToolChain({
  steps: [
    { name: "search_repositories", args: { query: "model-context-protocol" } },
    { name: "get_repository", args: (prev) => {
      const repos = JSON.parse(prev);
      return { owner: repos[0].owner.login, repo: repos[0].name };
    }},
  ],
});

console.log(results[1].output); // Info about the first matching repo
```

### Serializers

Convert MCP tool definitions to any LLM provider's format:

```typescript
import { toOpenAI, toAnthropic, toOllama, serializeAll, detectProvider } from "@universal-mcp-toolkit/bridge";

const { tools } = await bridge.listTools();

// Serialize for a specific provider
const openAITools = toOpenAI(tools);
const anthropicTools = toAnthropic(tools);
const ollamaTools = toOllama(tools);

// Serialize for all providers at once
const allFormats = serializeAll(tools);

// Auto-detect format from model name
const format = detectProvider("claude-3-5-sonnet-20241022"); // → "anthropic"
const tools = toProvider(tools, "gpt-4o"); // auto-serializes to OpenAI format
```

### `BridgeConversation`

Full agent conversation loop with automatic tool calling.

```typescript
new BridgeConversation(bridge: MCPFunctionCallingBridge, config?: ConversationConfig)
```

**Config options:**
- `maxRounds` (default: 10) — Maximum tool-calling rounds
- `systemPrompt` (default: "You are a helpful assistant...") — System prompt
- `temperature` (default: 0.7) — LLM temperature
- `maxTokens` — Max tokens for responses
- `onStep` — Callback after each tool round

## Supported Transports

| Transport | Description |
|-----------|-------------|
| `stdio` | Spawn a local process and communicate via stdin/stdout |
| `sse` | Connect to an SSE-based MCP server over HTTP |
| `http` | Connect to a Streamable HTTP MCP server |

## Supported Providers

| Provider | Model Prefix | Serializer |
|----------|-------------|------------|
| OpenAI | `gpt-`, `o1`, `o3` | `toOpenAI()` |
| Anthropic | `claude-` | `toAnthropic()` |
| Ollama | `llama`, `mistral`, `mixtral` | `toOllama()` |

## License

MIT
