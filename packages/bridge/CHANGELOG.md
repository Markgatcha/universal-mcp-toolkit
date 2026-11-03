# @universal-mcp-toolkit/bridge

## [Unreleased]

### Features

- **Health monitoring wired into `MCPFunctionCallingBridge`** — `HealthMonitor` is now enabled by default on every bridge instance (pass `{ health: false }` to disable). The bridge registers `onerror`/`onclose` handlers on the MCP client, calls `onError()` on tool-call failures, and auto-reconnects with exponential backoff when the connection drops (e.g. remote SSE server restarts). The circuit breaker prevents reconnect storms — after `failureThreshold` consecutive failures, the circuit opens and further reconnect attempts are suspended until the timeout expires.
- **Tool audit logging** — new `auditLog` option accepts a `ToolAuditLogger` implementation. Every `callTool()` invocation generates an `AuditLogEntry` with tool name, redacted args, duration, result size, and success/error status. Sensitive argument keys (tokens, passwords, secrets, API keys) are automatically redacted. Exported `AuditLogEntry` and `ToolAuditLogger` types for custom logging implementations.
- **A2A Protocol server adapter** — new `A2AServerAdapter` class that wraps `MCPFunctionCallingBridge` and exposes it as a Google A2A Protocol (v1.0) JSON-RPC 2.0 server. Implements all 6 core A2A methods: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, and push notification config set/get. Includes agent card discovery with auto-populated skills from bridge tools, bearer token auth validation, push notification sending, subscriber-based streaming, and full task lifecycle management. Exported `A2AServerAdapter` plus all A2A types (agent card, task, skill, artifact, message, JSON-RPC envelope, error codes).
- **Policy-based RBAC (`PolicyEngine`)** — new `policies` option on `BridgeOptions` enables per-tool allow/deny rules with optional condition functions, wildcard matching, first-match-wins evaluation, and configurable default actions. `setPrincipal()` sets the caller identity (principal, roles, attributes) for per-request authorization. Denied calls throw with a clear authorization error and are logged to the audit logger. Exported `PolicyEngine`, `PolicyRule`, `PolicyContext`, `PolicyDecision`, `Policy`, `PolicyResolver`, `PolicyRegistry`.
- **Transport-level auth** — new `auth` field on `BridgeServerConfig` adds OAuth 2.1 bearer token (`Authorization: Bearer <token>`) and API key (`X-API-Key`) header injection for SSE and Streamable HTTP transports. Headers are injected into both `requestInit` (POST requests) and `eventSourceInit` (SSE connections). Uses the MCP SDK's native `requestInit` option.
- **A2A Protocol server adapter (`A2AServerAdapter`)** — expose UMT's MCP tools via Google's Agent2Agent Protocol (v1.0). The adapter wraps `MCPFunctionCallingBridge` and implements all 6 core A2A JSON-RPC methods: `message/send`, `message/stream`, `tasks/get`, `tasks/cancel`, `tasks/resubscribe`, and push notification config set/get. Includes agent card discovery, bearer token auth validation, push notification sending, subscriber-based streaming, task lifecycle management, tool-name resolution, and serialization helpers (`artifactToText`, `serializeResponse`, `parseRequest`). Auto-populates A2A skills from the bridge's tool listing. Exported `A2AServerAdapter`, `A2AAgentCard`, `A2ASkill`, `A2ATask`, `A2ATaskState`, `A2AArtifact`, `A2AMessage`, `A2APart`, `A2AJsonRpcRequest`, `A2AJsonRpcResponse`, `A2AJsonRpcError`, `AuthConfig`, `A2AServerConfig`, `A2A_ERROR_CODES`.
- **`onEvent` callback on `HealthMonitorOptions`** — pass `health: { onEvent: (event) => ... }` to receive real-time health events (connect, disconnect, reconnecting, circuit open/close) without manually registering listeners.
- **`reconnect()` method** — protected method on `MCPFunctionCallingBridge` that respects the health monitor's backoff schedule and circuit-breaker state. Called automatically by `callTool()` when the client was torn down by a disconnect.

## 1.2.0

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

- [`162dea9`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/162dea9780b4a9b21922595647b9a336f5ba8059) Thanks [@Markgatcha](https://github.com/Markgatcha)! - ## Experimental MCP 2026-07-28 feature set: Tasks, MRTR, cache hints, drift defense
  
  Additive support for the experimental MCP `2026-07-28` protocol era, with
  dual-era compatibility for `2025-06-18` / `2025-11-25` servers.
  
  **Bridge (`@universal-mcp-toolkit/bridge`)**
  - Tasks lifecycle: `getTaskSupport()`, `spawnTaskToolCall()`, `getTask()`,
    `listServerTasks()`, `awaitTaskCompletion()` (with `onProgress` polling),
    `cancelTask()`, `linkTaskChild()`, `getSpawnedTaskIds()`
  - Cancellation cascades: cancelling a parent task depth-first cancels its
    linked child tasks (disable with `{ cascade: false }`)
  - MRTR (`input_required`) loops: `callToolWithMrtr()` answers server input
    requests via an `onInputRequest` handler, resubmits with byte-exact
    `requestState`, caps rounds with `MrtrRoundLimitError`, and surfaces
    unanswered rounds via `MrtrInputRequiredError`
  - Server-advertised cache hints: `listTools({ refresh: true })` extracts
    `_meta` TTL/scope hints; result cache honors advertised TTLs and exposes
    them via `getCacheStats()`; `getListCacheHint()` returns the hint
  - `tools/list` definition-drift defense: SHA-256 digest pinning of
    canonicalized tool definitions, `definition-drift` events naming added /
    removed / modified tools, `getToolsDigest()` / `resetToolsDigest()`
  
  **CLI (`umt`)**
  - `umt tools call <tool> --server <id> --args <json>` — direct calls with
    interactive MRTR prompting (`--max-rounds`, `--json`)
  - `umt tools call --task` — spawn a long-running task, stream progress,
    await completion (falls back to a direct call on non-task servers)
  - `umt task spawn|status|await|cancel` — full task lifecycle management
  - Loud red `definition-drift` warnings on every connect (supply-chain
    attack surface), printed to stderr so `--json` output stays clean

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
- Updated dependencies [[`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2), [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24), [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3), [`6566cb7`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/6566cb7dab454788a70672e070300b3ef93a456e)]:
  - @universal-mcp-toolkit/core@0.3.0

## 1.1.0

### Features

- **Multi-server sessions via `Session` class** — bundle multiple MCP bridge connections into a single logical session. Supports parallel `callToolsParallel()`, `listAllTools()`, and health monitoring across all connected servers. Exported as `Session` from the package root.
- **Health monitoring with circuit breaker** — `HealthMonitor` class provides auto-reconnect with exponential backoff, circuit breaking (open/half-open/closed states), and event subscriptions (`connected`, `disconnected`, `reconnecting`, `circuit_open`, `circuit_closed`, `error`). Enable with `{ health: {} }` in bridge options or `getHealthMonitor()` to register listeners.
- **Streaming tool results via `callToolStreaming()`** — async iterator that yields text chunks from tool results, useful for long-running operations like file exports or log streams.

## 1.0.1

### Minor Changes

- **Structured error wrapping in `callTool()`** — errors now include the tool name, original error type, and truncated args in the `data` field, making debugging MCP integrations significantly easier. When `suppressErrors` is false, thrown errors include the tool name and args context.

### Features

- **TTL + LRU result caching** — enable with `{ cache: { ttlMs, maxSize } }` in bridge options. Repeated identical tool calls return instantly from cache, avoiding redundant MCP server round-trips. Cache stats available via `getCacheStats()`.
- **Type-safe tool chaining via `callToolChain()`** — execute a sequence of tools where each step's output feeds into the next step's args. Steps can use static args or a function that receives the previous step's output.
- **`ToolChain` and `ToolChainStep` types** — exported for compile-time-checked tool pipelines.

## 1.0.0

Initial release of the MCP-to-function-calling bridge.
