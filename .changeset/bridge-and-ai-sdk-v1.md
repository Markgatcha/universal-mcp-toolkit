---
"@universal-mcp-toolkit/bridge": minor
"@universal-mcp-toolkit/ai-sdk": minor
"universal-mcp-toolkit": patch
---

## Bridge: MCP-to-Function-Calling Bridge (v1.1.0)

Published the `@universal-mcp-toolkit/bridge` package — connect any MCP server to OpenAI, Anthropic, or Ollama function-calling format. This package makes the 27 UMT servers usable with any LLM provider, not just MCP-compatible ones.

**Features:**
- `MCPFunctionCallingBridge` — connect to any MCP server (stdio/SSE/HTTP), list tools, and call them
- `toOpenAI()`, `toAnthropic()`, `toOllama()` — serialize MCP tools to any provider's function-calling format
- `toProvider(tools, model)` — auto-detect provider from model name
- `serializeAll()` — generate all three formats lazily
- `BridgeConversation` — full agent conversation loop with tool calling
- TTL + LRU result caching
- Health monitoring with circuit breaker and auto-reconnect
- Policy-based RBAC (allow/deny rules with conditions)
- Audit logging with automatic secret redaction
- Transport-level auth (OAuth 2.1 bearer tokens, API keys)
- A2A Protocol server adapter (expose MCP tools via Google's A2A)
- Multi-server sessions with parallel tool calls
- `umt-bridge` CLI for testing

**Usage:**
```typescript
import { MCPFunctionCallingBridge, toOpenAI } from "@universal-mcp-toolkit/bridge";

const bridge = new MCPFunctionCallingBridge({
  transport: "stdio",
  commandOrUrl: "npx",
  args: ["-y", "@modelcontextprotocol/server-github"],
});
await bridge.connect();
const { tools } = await bridge.listTools();
const openAITools = toOpenAI(tools);
```

## AI SDK: Vercel AI SDK Integration

Published `@universal-mcp-toolkit/ai-sdk` — adapter that lets you use UMT's 27 MCP servers directly with the Vercel AI SDK's `streamText()` and `generateText()` functions. Zero boilerplate — turn any MCP server into AI SDK tools in one line.

**Features:**
- `umtTools({ servers })` — returns AI SDK-compatible tool objects
- Streaming tool results via async generators
- Auto-reconnect with circuit breaker from the bridge
- Per-tool TTL caching of results
- Works with any AI SDK provider (OpenRouter, OpenAI, Anthropic, Ollama)

**Usage:**
```typescript
import { streamText } from "ai";
import { umtTools } from "@universal-mcp-toolkit/ai-sdk";

const tools = await umtTools({
  servers: ["github"],
  env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
});

const result = await streamText({
  model: openrouter("google/gemini-2.0-flash"),
  prompt: "List open issues in owner/repo",
  tools,
});
```

## CLI: Bridge CLI + experimental server surfacing

- `umt-bridge` CLI command for testing MCP servers with any LLM provider
- `packages/bridge` integrated into the Turbo build pipeline
- Server discovery now distinguishes 27 production-ready servers from 8 experimental stubs
- Documentation updated for consistent server counts across README, docs, and well-known manifests
