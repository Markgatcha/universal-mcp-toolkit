/**
 * Core MCP-to-Function-Calling bridge implementation.
 *
 * The `MCPFunctionCallingBridge` class connects to any MCP server
 * (stdio, SSE, or Streamable HTTP) and exposes a unified `callTool`
 * interface. Combined with the serializers in `serializers.ts`,
 * this lets you use any MCP server with OpenAI, Anthropic, or Ollama
 * SDKs without writing provider-specific code.
 *
 * @module @universal-mcp-toolkit/bridge/bridge
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { createHash } from "node:crypto";

import type {
  AuditLogEntry,
  BridgeServerConfig,
  BridgeTool,
  BridgeToolResult,
  BridgeTransport,
  FunctionCall,
  ToolAuditLogger,
  ToolListing,
  BridgeOptions,
  ToolChain,
} from "./types.js";
import { HealthMonitor } from "./health-monitor.js";
import { BridgeObservability } from "./observability.js";
import { PolicyEngine } from "./types.js";

/**
 * Default connection timeout for MCP clients (ms).
 */
const DEFAULT_CONNECTION_TIMEOUT_MS = 10_000;

/**
 * Default request timeout for tool calls (ms).
 */
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

const TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "ERR_NETWORK",
  "ERR_STREAM_PREMATURE_CLOSE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

const TRANSPORT_ERROR_MESSAGES = [
  /\bfetch failed\b/i,
  /\bnetwork(?: request)? (?:error|failed)\b/i,
  /\bsocket (?:closed|disconnected|hang up)\b/i,
  /\bconnection (?:aborted|closed|lost|refused|reset)\b/i,
  /\btransport (?:closed|disconnected|error|failed)\b/i,
  /\bbroken pipe\b/i,
];

/** Return true only for errors that strongly indicate a failed transport. */
function isLikelyTransportError(error: unknown): boolean {
  if (error === null || error === undefined) return false;

  const candidate = error as { code?: unknown; cause?: unknown; message?: unknown };
  const code = typeof candidate.code === "string" ? candidate.code.toUpperCase() : undefined;
  if (code && TRANSPORT_ERROR_CODES.has(code)) return true;

  const message = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : typeof candidate.message === "string"
        ? candidate.message
        : "";
  if (TRANSPORT_ERROR_MESSAGES.some((pattern) => pattern.test(message))) return true;

  return candidate.cause !== undefined && candidate.cause !== error
    ? isLikelyTransportError(candidate.cause)
    : false;
}

/** Race a promise against a timeout and always release the timer afterward. */
async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(createError()), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

/**
 * Keys in tool arguments that are considered sensitive and should be
 * redacted in audit logs. Matching is case-insensitive on substrings.
 */
const SENSITIVE_ARG_KEYS = ["token", "password", "secret", "key", "apikey", "api_key", "auth", "credential"];

/**
 * Recursively redact sensitive-looking keys from an object's arguments
 * so that audit log entries don't leak credentials.
 *
 * - String values for matching keys are replaced with "[REDACTED]".
 * - Nested objects and arrays are traversed recursively.
 * - Matching is case-insensitive on substring presence.
 */
function redactSensitiveArgs(args: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = SENSITIVE_ARG_KEYS.some((s) => lowerKey.includes(s));

    if (isSensitive && typeof value === "string") {
      result[key] = "[REDACTED]";
    } else if (Array.isArray(value)) {
      result[key] = value.map(redactDeep);
    } else if (value !== null && typeof value === "object") {
      result[key] = redactDeep(value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Recursively redact sensitive values within nested structures. */
function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value !== null && typeof value === "object") {
    return redactSensitiveArgs(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Serialize JSON-compatible values with object keys in lexicographic order.
 * JSON.stringify first preserves its existing treatment of values such as Date,
 * undefined object properties, and non-finite numbers.
 */
function canonicalizeJson(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) return "undefined";

  const sortValue = (parsed: unknown): unknown => {
    if (Array.isArray(parsed)) return parsed.map(sortValue);
    if (parsed !== null && typeof parsed === "object") {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
          .map(([key, child]) => [key, sortValue(child)]),
      );
    }
    return parsed;
  };

  return JSON.stringify(sortValue(JSON.parse(json)));
}

/**
 * The core bridge class. Connects to an MCP server and provides
 * methods to list tools, call tools, and serialize tool definitions
 * for any LLM provider.
 *
 * @example
 * ```ts
 * // Connect to the GitHub MCP server via stdio
 * const bridge = new MCPFunctionCallingBridge({
 *   transport: "stdio",
 *   commandOrUrl: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-github"],
 * });
 * await bridge.connect();
 *
 * // Get tools in OpenAI format
 * const listing = await bridge.listTools();
 * const openAITools = toOpenAI(listing.tools);
 *
 * // Call a tool
 * const result = await bridge.callTool("list_issues", { owner: "user", repo: "repo" });
 * console.log(result.output);
 * ```
 */
export class MCPFunctionCallingBridge {
  protected client: Client | undefined;
  protected transport: BridgeTransport;
  protected config: BridgeServerConfig;
  protected options: BridgeOptions;
  protected toolsCache: Map<string, Tool> | null = null;

  // --- Tool-result cache (TTL + LRU) ---------------------------------------
  protected resultCache: Map<string, { result: BridgeToolResult; expiresAt: number }> | null = null;
  protected resultCacheTtlMs: number = 300_000;
  protected resultCacheMaxSize: number = 500;

  // Health monitoring (optional — set via options.health).
  protected healthMonitor?: HealthMonitor;

  // Audit logging (optional — set via options.auditLog).
  protected auditLogger?: ToolAuditLogger;

  // OpenTelemetry observability (optional — set via options.observability).
  protected observability?: BridgeObservability;

  // Policy engine for RBAC (optional — set via options.policies).
  protected policyEngine?: PolicyEngine;

  // Principal (caller identity) for RBAC — set via setPrincipal().
  protected principal?: string;

  // Roles for RBAC — set via setPrincipal().
  protected roles: string[] = [];

  // Additional principal attributes for RBAC — set via setPrincipal().
  protected principalAttributes: Record<string, unknown> = {};

  /**
   * Whether a reconnect attempt is currently in progress.
   * Prevents concurrent reconnect loops on repeated tool-call failures.
   */
  protected reconnecting: boolean = false;

  constructor(config: BridgeServerConfig, options: BridgeOptions = {}) {
    this.config = config;
    this.transport = config.transport;
    this.options = {
      suppressErrors: options.suppressErrors ?? true,
      allowedTools: options.allowedTools,
      cache: options.cache,
      health: options.health,
      auditLog: options.auditLog,
      observability: options.observability,
      policies: options.policies,
    };

    // Initialise the result cache if caching is enabled via options.cache.
    if (this.options.cache) {
      this.resultCache = new Map();
      this.resultCacheTtlMs = this.options.cache.ttlMs ?? 300_000;
      this.resultCacheMaxSize = this.options.cache.maxSize ?? 500;
    }

    // Initialise the health monitor if enabled.
    if (this.options.health !== false) {
      this.healthMonitor = new HealthMonitor({
        autoReconnect: true,
        ...(typeof this.options.health === "object" ? this.options.health : {}),
      });
    }

    // Initialise the audit logger if enabled.
    if (this.options.auditLog !== false && this.options.auditLog) {
      this.auditLogger = this.options.auditLog;
    }

    // Initialise OpenTelemetry observability if enabled.
    if (this.options.observability) {
      this.observability = new BridgeObservability(this.options.observability);
    }

    // Initialise the policy engine if policies are configured.
    if (this.options.policies) {
      this.policyEngine = new PolicyEngine(this.options.policies);
    }
  }

  /**
   * Set the principal (caller identity) for RBAC policy evaluation.
   *
   * When policies are configured on the bridge, every `callTool()`
   * invocation is evaluated against the policy engine using this
   * principal and roles. This enables per-caller access control —
   * e.g. a bridge shared across multiple users can deny certain
   * tools to specific callers.
   *
   * @param principal The caller's identity (e.g. user ID, service account name).
   * @param roles The caller's assigned roles (e.g. ["admin", "viewer"]).
   * @param attributes Additional attributes (from auth token claims, etc.).
   *
   * @example
   * ```ts
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   policies: { policies: [...], defaultPolicyName: "admin" },
   * });
   * await bridge.connect();
   *
   * // Set the caller before invoking tools:
   * bridge.setPrincipal("user-123", ["viewer"]);
   *
   * // Now all tool calls are checked against the "admin" policy
   * // with principal="user-123" and roles=["viewer"].
   * await bridge.callTool("list_issues", { owner: "user", repo: "repo" });
   * ```
   */
  setPrincipal(
    principal?: string,
    roles: string[] = [],
    attributes: Record<string, unknown> = {},
  ): void {
    this.principal = principal;
    this.roles = roles;
    this.principalAttributes = attributes;
  }

  /**
   * Connect to the MCP server. Must be called before listTools() or callTool().
   *
   * When a HealthMonitor is configured, this also wires up error/disconnect
   * handlers on the underlying MCP client so that connection drops are detected
   * and auto-recovery (circuit breaker + exponential backoff reconnect) is
   * activated.
   */
  async connect(): Promise<void> {
    this.reconnecting = true;
    try {
      const transport = await this.createTransport();
      this.client = new Client(
        {
          name: "umt-bridge",
          version: "1.0.0",
        },
        {
          capabilities: {},
        },
      );

      // Wire health-monitor event handlers onto the MCP client.
      // These fire asynchronously when the remote server disconnects
      // or encounters an unrecoverable transport error.
      if (this.healthMonitor) {
        this.client.onerror = (error) => {
          // onError returns true if the circuit has now opened (i.e. too
          // many consecutive failures). In that case we tear down the
          // client so future callTool attempts trigger a reconnect.
          const opened = this.healthMonitor!.onError(error);
          if (opened) {
            this.client = undefined;
            this.toolsCache = null;
          }
        };
        this.client.onclose = () => {
          this.healthMonitor!.onDisconnect();
          // Clear the cached client so the next callTool triggers reconnect.
          this.client = undefined;
          this.toolsCache = null;
        };
      }

      const connectionTimeout =
        this.config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;

      await withTimeout(
        this.client.connect(transport),
        connectionTimeout,
        () => new Error(
          `MCP server connection timed out after ${connectionTimeout}ms. ` +
            `Check that the server is running and the command/URL is correct.`,
        ),
      );

      // Notify the health monitor of successful connection.
      this.healthMonitor?.onConnect();
    } catch (error) {
      // Notify the health monitor of the failure so it can update
      // circuit-breaker state and trigger backoff on retry.
      this.healthMonitor?.onError(error);
      throw error;
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * Create the appropriate MCP client transport based on the config.
   * Supports stdio, SSE, and Streamable HTTP transports.
   */
  protected async createTransport(): Promise<
    StdioClientTransport | SSEClientTransport | StreamableHTTPClientTransport
  > {
    switch (this.transport) {
      case "stdio": {
        return new StdioClientTransport({
          command: this.config.commandOrUrl,
          args: this.config.args,
          env: this.config.env as Record<string, string> | undefined,
          cwd: this.config.cwd,
        });
      }

      case "sse": {
        const headers: Record<string, string> = {};
        this.addAuthHeaders(headers);
        return new SSEClientTransport(
          new URL(this.config.commandOrUrl),
          {
            requestInit: { headers },
          },
        );
      }

      case "http": {
        const headers: Record<string, string> = {};
        this.addAuthHeaders(headers);
        return new StreamableHTTPClientTransport(
          new URL(this.config.commandOrUrl),
          {
            requestInit: { headers },
          },
        );
      }

      default: {
        throw new Error(`Unsupported transport type: ${this.transport}`);
      }
    }
  }

  /**
   * Add authentication headers from the bridge config to the given headers object.
   * Supports OAuth 2.1 bearer tokens and API key authentication for remote
   * (SSE / HTTP) transports. Stdio transports are not affected.
   */
  protected addAuthHeaders(headers: Record<string, string>): void {
    const auth = this.config.auth;
    if (!auth) return;

    if (auth.bearerToken) {
      headers["Authorization"] = `Bearer ${auth.bearerToken}`;
    }

    if (auth.apiKey) {
      const headerName = auth.apiKeyHeader ?? "X-API-Key";
      headers[headerName] = auth.apiKey;
    }
  }

  /**
   * Reconnect to the MCP server using the health monitor's backoff schedule.
   *
   * Called automatically when `callTool()` detects the client was torn down
   * by a disconnect event, or can be invoked manually. Respects the circuit
   * breaker — if the circuit is open, this method returns without retrying.
   */
  protected async reconnect(): Promise<void> {
    if (!this.healthMonitor) return;
    if (this.reconnecting) return;
    if (this.healthMonitor.getCircuitState() === "open") return;

    this.reconnecting = true;
    try {
      const delay = this.healthMonitor.getReconnectDelay();
      if (delay > 0) {
        // Wait for the backoff delay before retrying.
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      this.healthMonitor.onReconnectAttempt();
      await this.connect();
      this.healthMonitor.onReconnected();
    } catch (error) {
      this.healthMonitor?.onError(error);
      // Let the caller decide how to handle the failure.
      // The circuit breaker will prevent further reconnect attempts
      // until the circuit timeout expires.
    } finally {
      this.reconnecting = false;
    }
  }

  /**
   * List all available tools from the connected MCP server.
   * If `allowedTools` is configured, only those tools are returned.
   * Results are cached after the first call for performance.
   */
  async listTools(): Promise<ToolListing> {
    if (!this.client) {
      throw new Error("Bridge not connected. Call connect() first.");
    }

    // Use cached tool listing if available (avoids re-querying the server).
    if (this.toolsCache) {
      const cached = Array.from(this.toolsCache.values());
      return this.toListing(cached);
    }

    const response = await this.client.listTools();
    const allTools = response.tools;

    // Cache all tools for future calls.
    this.toolsCache = new Map(allTools.map((t) => [t.name, t]));

    // Filter if allowedTools is specified.
    if (this.options.allowedTools) {
      const filtered = allTools.filter((t) =>
        this.options.allowedTools!.includes(t.name),
      );
      return this.toListing(filtered);
    }

    return this.toListing(allTools);
  }

  /**
   * Convert raw MCP Tool objects to BridgeTool format.
   */
  protected toListing(tools: Tool[]): ToolListing {
    const bridgeTools: BridgeTool[] = tools.map((t) => {
      const description = t.description || "";
      return {
        name: t.name,
        description,
        parameters: {
          type: "object",
          properties: (t.inputSchema?.properties as Record<string, unknown>) ?? {},
          required: t.inputSchema?.required as string[] ?? [],
          additionalProperties: t.inputSchema?.additionalProperties as boolean | undefined,
        },
        title: t.title,
        mcpTool: t,
      };
    });

    return {
      tools: bridgeTools,
      rawTools: tools,
    };
  }

  /**
   * Call a tool on the connected MCP server.
   *
   * This is the unified entry point for invoking any MCP tool
   * from your LLM application code. The result is normalized
   * to the BridgeToolResult format regardless of which LLM
   * provider you're using.
   *
   * If the connection was lost (e.g. remote SSE server dropped),
   * the bridge will attempt to reconnect automatically using the
   * health monitor's exponential backoff, provided health
   * monitoring is enabled.
   *
   * @example
   * ```ts
   * // After an LLM returns a function call:
   * const call: FunctionCall = {
   *   name: "github_list_issues",
   *   arguments: { owner: "user", repo: "my-repo", state: "open" },
   * };
   * const result = await bridge.callTool(call);
   * console.log(result.output); // "Issue #1: Fix bug..."
   * ```
   */
  async callTool(
    nameOrCall: string | FunctionCall,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<BridgeToolResult> {
    const toolName = typeof nameOrCall === "string" ? nameOrCall : nameOrCall.name;
    const toolArgs = typeof nameOrCall === "string" ? (args ?? {}) : nameOrCall.arguments;

    // Treat allowedTools as an authorization boundary, not just a listing filter.
    // This must run before reconnecting, consulting the result cache, or invoking
    // the remote server so direct calls cannot bypass the configured allowlist.
    if (this.options.allowedTools && !this.options.allowedTools.includes(toolName)) {
      const reason = `Tool '${toolName}' is not included in allowedTools.`;
      const error = new Error(`Access denied: ${reason}`);
      error.name = "AuthorizationError";

      this.auditLogger?.log({
        ...this.buildAuditEntry(toolName, toolArgs, false, error.message, 0, 0),
        principal: this.principal,
        roles: this.roles,
        policyDecision: {
          allowed: false,
          policyName: "allowedTools",
          reason,
        },
      });

      if (this.options.suppressErrors) {
        return this.buildSuppressedErrorResult(toolName, toolArgs, error);
      }
      throw error;
    }

    // Enforce policy-based access control (RBAC) before reconnecting,
    // consulting the cache, or executing the tool.
    // This implements the OAuth 2.1 + RBAC pattern: OAuth scopes define
    // broad capability domains, and fine-grained tool-level access is
    // enforced here via the policy engine.
    if (this.policyEngine) {
      const context = {
        principal: this.principal,
        roles: this.roles,
        attributes: this.principalAttributes,
        tool: toolName,
        args: toolArgs,
      };
      const decision = await this.policyEngine.evaluate(context);

      // Record the policy decision in the audit log.
      this.auditLogger?.log({
        timestamp: new Date().toISOString(),
        toolName: toolName,
        args: {},
        success: decision.allowed,
        durationMs: 0,
        resultSizeChars: 0,
        principal: this.principal,
        roles: this.roles,
        policyDecision: {
          allowed: decision.allowed,
          policyName: decision.policyName,
          reason: decision.reason,
        },
      });

      if (!decision.allowed) {
        const error = new Error(
          `Access denied: tool '${toolName}' is not allowed. ` +
            `Reason: ${decision.reason ?? "policy denied"}`,
        );
        error.name = "AuthorizationError";
        if (this.options.suppressErrors) {
          return this.buildSuppressedErrorResult(toolName, toolArgs, error);
        }
        throw error;
      }
    }

    // If the client was torn down by a health-monitor disconnect event,
    // attempt to reconnect only after the call has passed authorization.
    if (!this.client && this.healthMonitor && this.healthMonitor.getCircuitState() !== "open") {
      await this.reconnect();
    }

    if (!this.client) {
      throw new Error("Bridge not connected. Call connect() first.");
    }

    const toolTimeout = timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;

    // Check the result cache before making the call.
    if (this.resultCache) {
      const cacheKey = this.buildCacheKey(toolName, toolArgs);
      const cached = this.resultCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) {
        // Refresh LRU position.
        this.resultCache.delete(cacheKey);
        this.resultCache.set(cacheKey, cached);
        return cached.result;
      }
      // Evict expired entry.
      if (cached) {
        this.resultCache.delete(cacheKey);
      }
    }

    // Start an observability span for this tool call (if tracing is enabled).
    const spanHandle = this.observability?.startToolSpan(toolName, toolArgs);

    try {
      const startTime = Date.now();
      // Execute the MCP tool call with a timeout.
      const result = (await withTimeout(
        this.client.callTool({
          name: toolName,
          arguments: toolArgs,
        }),
        toolTimeout,
        () => new Error(`Tool "${toolName}" timed out after ${toolTimeout}ms.`),
      )) as CallToolResult;

      const normalized = this.normalizeResult(result, toolName);
      // Cache successful results.
      this.storeInCache(toolName, toolArgs, normalized);

      // Audit-log successful tool call.
      this.auditLogger?.log(
        this.buildAuditEntry(toolName, toolArgs, true, undefined, normalized.output.length, Date.now() - startTime),
      );

      // End the observability span with success.
      this.observability?.endToolSpan(spanHandle, normalized.output, undefined);

      return normalized;
    } catch (error) {
      // Tool/application errors do not imply that the MCP connection is
      // unhealthy. Only report errors with explicit transport indicators.
      if (isLikelyTransportError(error)) {
        this.healthMonitor?.onError(error);
      }

      // Audit-log failed tool call.
      const errMsg = error instanceof Error ? error.message : String(error);
      this.auditLogger?.log(
        this.buildAuditEntry(toolName, toolArgs, false, errMsg, 0),
      );

      // End the observability span with error.
      this.observability?.endToolSpan(spanHandle, undefined, errMsg);

      if (this.options.suppressErrors) {
        return this.buildSuppressedErrorResult(toolName, toolArgs, error);
      }

      // When not suppressing errors, enrich the thrown error with context
      // so the caller gets a clear message including tool name and args.
      const wrapped = new Error(
        `Tool "${toolName}" failed: ${errMsg}\n  args: ${JSON.stringify(toolArgs).slice(0, 500)}`,
      );
      // Preserve the original stack trace for debugging.
      (wrapped as any).originalError = error;
      (wrapped as any).toolName = toolName;
      (wrapped as any).toolArgs = toolArgs;
      throw wrapped;
    }
  }

  /**
   * Call a tool, buffer its complete result, then expose that result as an
   * AsyncIterable<string>. Text output is split into 1 KiB chunks and followed
   * by an end marker; structured data is yielded first as a JSON summary.
   *
   * This method does not implement MCP protocol streaming and does not yield
   * partial output while the tool is still running. It is a chunked iterator
   * over the result returned by the standard `callTool()` request.
   *
   * @example
   * ```ts
   * for await (const chunk of bridge.callToolStreaming("export_data", { table: "users" })) {
   *   console.log(chunk);  // chunks are emitted after the tool call completes
   * }
   * ```
   */
  async *callToolStreaming(
    nameOrCall: string | FunctionCall,
    args?: Record<string, unknown>,
    timeoutMs?: number,
  ): AsyncIterable<string> {
    if (!this.client) {
      throw new Error("Bridge not connected. Call connect() first.");
    }

    const toolName = typeof nameOrCall === "string" ? nameOrCall : nameOrCall.name;
    const toolArgs = typeof nameOrCall === "string" ? (args ?? {}) : nameOrCall.arguments;

    // Buffer the standard tool result before yielding any chunks.
    try {
      const result = await this.callTool(toolName, toolArgs, timeoutMs);

      // If the result has structured data (non-text content), yield a JSON summary.
      if (result.data && result.data.length > 0) {
        yield JSON.stringify(result.data, null, 2);
      }

      // Yield the text output in chunks (simulate streaming for non-streaming servers).
      if (result.output) {
        const chunkSize = 1024;
        for (let i = 0; i < result.output.length; i += chunkSize) {
          yield result.output.slice(i, Math.min(i + chunkSize, result.output.length));
        }
      }

      // Yield a final marker with error status.
      yield `[${result.error ? "ERROR" : "END"} tool:${toolName}]`;
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      yield `[ERROR tool:${toolName}] ${errMsg}`;
    }
  }

  /** Build a structured error result when suppressErrors is enabled. */
  protected buildSuppressedErrorResult(
    toolName: string,
    toolArgs: Record<string, unknown>,
    error: unknown,
  ): BridgeToolResult {
    const errName = error instanceof Error ? error.name : "Error";
    const errMsg = error instanceof Error ? error.message : String(error);
    const argsPreview = JSON.stringify(toolArgs);
    const maxArgsLen = 200;
    const argsTruncated = argsPreview.length > maxArgsLen
      ? argsPreview.slice(0, maxArgsLen) + "…"
      : argsPreview;

    return {
      output: `Error calling tool "${toolName}": ${errMsg}`,
      error: true,
      data: [{
        type: "text",
        text: JSON.stringify({
          error: errName,
          tool: toolName,
          args: argsTruncated,
        }),
      }],
    };
  }

  /**
   * Build a deterministic cache key from the connection config and tool call.
   * The key includes the transport type, command/URL, tool name, and a
   * SHA-256 hash of canonicalized arguments so structurally-identical calls
   * share a key regardless of object insertion order.
   */
  protected buildCacheKey(toolName: string, args: Record<string, unknown>): string {
    const connPart = `${this.config.transport}:${this.config.commandOrUrl ?? ""}`;
    const argsHash = createHash("sha256").update(canonicalizeJson(args ?? {})).digest("hex");
    return `${connPart}:${toolName}:${argsHash}`;
  }

  /**
   * Build an AuditLogEntry from the call context.
   *
   * Redacts sensitive-looking argument keys (tokens, passwords, secrets)
   * before constructing the entry so that audit logs are safe to
   * persist or stream to external observability systems.
   */
  protected buildAuditEntry(
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    error?: string,
    resultSizeChars?: number,
    durationMs?: number,
  ): AuditLogEntry {
    return {
      timestamp: new Date().toISOString(),
      toolName,
      args: redactSensitiveArgs(args),
      durationMs: durationMs ?? 0,
      success,
      error,
      resultSizeChars,
    };
  }

  /**
   * Store a successful tool result in the result cache.
   * Called internally after normalizeResult returns a non-error result.
   */
  protected storeInCache(toolName: string, args: Record<string, unknown>, result: BridgeToolResult): void {
    if (!this.resultCache) return;

    // Only cache successful results (skip errors).
    if (result.error) return;

    // Evict oldest if at capacity (simple LRU: first entry is oldest).
    if (this.resultCache.size >= this.resultCacheMaxSize) {
      const oldestKey = this.resultCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.resultCache.delete(oldestKey);
      }
    }

    const cacheKey = this.buildCacheKey(toolName, args);
    this.resultCache.set(cacheKey, {
      result,
      expiresAt: Date.now() + this.resultCacheTtlMs,
    });
  }

  /**
   * Get cache statistics for monitoring.
   * Returns null if caching is not enabled.
   */
  getCacheStats(): { size: number; maxSize: number; ttlMs: number } | null {
    if (!this.resultCache) return null;
    return {
      size: this.resultCache.size,
      maxSize: this.resultCacheMaxSize,
      ttlMs: this.resultCacheTtlMs,
    };
  }

  /**
   * Normalize an MCP CallToolResult into BridgeToolResult format.
   * Handles text content, images, and embedded resources.
   */
  protected normalizeResult(result: CallToolResult, toolName: string): BridgeToolResult {
    const contentItems = result.content ?? [];
    const data: BridgeToolResult["data"] = [];
    const textParts: string[] = [];

    for (const item of contentItems) {
      const itemType = item.type as string;
      if (itemType === "text") {
        textParts.push((item as { text?: string }).text ?? "");
        data.push({ type: "text", text: (item as { text?: string }).text ?? "" });
      } else if (itemType === "image") {
        const imageData = (item as { data?: string }).data ?? "";
        const mimeType = (item as { mimeType?: string }).mimeType ?? "image/png";
        const dataUri = `data:${mimeType};base64,${imageData}`;
        textParts.push(`[Image: ${mimeType} (${imageData.length} bytes)]`);
        data.push({
          type: "image",
          image: { url: dataUri, mimeType },
        });
      } else if (itemType === "resource") {
        const resource = (item as { resource?: { uri: string; text?: string; mimeType?: string } }).resource;
        if (!resource) continue;
        const resourceText = typeof resource.text === "string"
          ? resource.text
          : `[Resource: ${resource.uri}]`;
        textParts.push(resourceText);
        data.push({
          type: "resource",
          resource: {
            uri: resource.uri,
            text: resource.text,
            mimeType: resource.mimeType,
          },
        });
      }
    }

    const isError = !!result.isError;
    const output = textParts.join("\n").trim();

    return {
      output,
      error: isError || undefined,
      // Only include data if there are non-text items.
      ...(data.some((d) => d.type !== "text") ? { data } : {}),
    };
  }

  /**
   * Execute a chain of tool calls, where each step can receive the
   * output of the previous step as input. This enables pipeline-style
   * workflows where the result of one MCP tool feeds into the next.
   *
   * @example
   * ```ts
   * const results = await bridge.callToolChain({
   *   steps: [
   *     { name: "github_search", args: { query: "mcp" } },
   *     { name: "github_list_issues", args: (prev) => {
   *       const repos = JSON.parse(prev);
   *       return { owner: repos[0].owner, repo: repos[0].name };
   *     }},
   *   ],
   * });
   * ```
   */
  async callToolChain(chain: ToolChain): Promise<BridgeToolResult[]> {
    const results: BridgeToolResult[] = [];
    let prevOutput: string | undefined;

    for (const step of chain.steps) {
      const args = typeof step.args === "function"
        ? step.args(prevOutput ?? "")
        : step.args;

      const result = await this.callTool(step.name, args);
      results.push(result);
      prevOutput = result.output;
    }

    return results;
  }

  /**
   * Close the connection to the MCP server.
   * Call this when you're done using the bridge.
   */
  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = undefined;
      this.toolsCache = null;
      this.healthMonitor?.onDisconnect();
    }
  }

  /**
   * Get the health monitor instance (if enabled).
   * Use this to register custom event listeners.
   */
  getHealthMonitor(): HealthMonitor | undefined {
    return this.healthMonitor;
  }

  /**
   * Get the underlying MCP client (if connected).
   * Useful for advanced use cases like accessing resources or prompts.
   */
  getClient(): Client | undefined {
    return this.client;
  }

  /**
   * Check if the bridge is currently connected to an MCP server.
   */
  isConnected(): boolean {
    return this.client !== undefined;
  }
}
