# @universal-mcp-toolkit/ai-sdk

## 1.1.0

### Minor Changes

- [`7bb3c95`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/7bb3c9536705d2067604b48099f3c00d5127a974) Thanks [@Markgatcha](https://github.com/Markgatcha)! - ## Bridge: MCP-to-Function-Calling Bridge (v1.1.0)
  
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

### Patch Changes

- [`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2) - ## Dependency Updates
  
  Routine dependency updates across all workspace packages:
  
  - **turbo** 2.10.6 → 2.10.10 (latest)
  - **tsx** 4.23.1 → 4.23.12 (latest)
  - **@types/node** 26.1.1 → 26.2.0 (latest)
  - **@changesets/cli** 2.31.1 → 3.0.0 (major)
  - **@changesets/changelog-github** 0.7.0 → 1.0.0 (major)
  - **postcss** 8.5.23 → 8.5.26 (pinned override updated in `pnpm-workspace.yaml`)
  
  The `postcss` override in `pnpm-workspace.yaml` was bumped from `8.5.23` to `8.5.26` (a patch release with no known vulnerabilities, superseding the security pin). All workspace package devDependencies referencing `@types/node` and `tsx` were updated to match the latest versions.
- Updated dependencies [[`7bb3c95`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/7bb3c9536705d2067604b48099f3c00d5127a974), [`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2), [`162dea9`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/162dea9780b4a9b21922595647b9a336f5ba8059), [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24), [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3), [`6566cb7`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/6566cb7dab454788a70672e070300b3ef93a456e)]:
  - @universal-mcp-toolkit/bridge@1.2.0
  - @universal-mcp-toolkit/core@0.3.0
