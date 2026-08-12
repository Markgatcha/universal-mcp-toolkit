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
