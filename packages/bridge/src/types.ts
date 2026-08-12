/**
 * Type definitions for the MCP-to-Function-Calling bridge.
 *
 * This module provides a unified schema that can be serialized to any
 * LLM provider's function-calling format (OpenAI, Anthropic, Ollama).
 * The same tool definition drives all three serializers, ensuring
 * consistency across providers.
 *
 * @module @universal-mcp-toolkit/bridge/types
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { HealthMonitorOptions } from "./health-monitor.js";
import type { ObservabilityOptions } from "./observability.js";

/**
 * A normalized function-calling tool that can be serialized
 * for any LLM provider.
 */
export interface BridgeTool {
  /**
   * The function/tool name as it appears to the LLM.
   * Must match the MCP tool name.
   */
  name: string;

  /**
   * Human-readable description of what the tool does.
   * Shown to the LLM to help it decide when to call the tool.
   */
  description: string;

  /**
   * JSON Schema object describing the parameters the function accepts.
   * Uses the standard JSON Schema format that all major LLM providers
   * understand (OpenAI, Anthropic, Ollama all accept JSON Schema).
   */
  parameters: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };

  /**
   * Optional title for the tool (used for display in some UIs).
   */
  title?: string;

  /**
   * The original MCP Tool object, for round-trip compatibility.
   */
  mcpTool: Tool;
}

/**
 * Result of executing a tool via the bridge.
 * May contain text or structured content (images, embedded resources).
 */
export interface BridgeToolResult {
  /**
   * The tool's output as text. If the MCP tool returned
   * structured content, this is the concatenated text representation.
   */
  output: string;

  /**
   * True if the tool execution failed. The `output` field
   * will contain the error message.
   */
  error?: boolean;

  /**
   * Structured content returned by the tool (e.g., images,
   * embedded resources). Present only for tools that return
   * non-text content.
   */
  data?: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    image?: { url: string; mimeType: string };
    resource?: { uri: string; text?: string; mimeType?: string };
  }>;
}

/**
 * Connection targets for MCP servers.
 * - `stdio`: spawn a local process and communicate via stdio
 * - `sse`: connect to an SSE-based MCP server over HTTP
 * - `http`: connect to a Streamable HTTP MCP server
 */
export type BridgeTransport = "stdio" | "sse" | "http";

/**
 * The LLM provider format for tool serialization.
 * - `openai`: OpenAI-compatible function calling format
 * - `anthropic`: Anthropic Bedrock / Claude tool format
 * - `ollama`: Ollama tool format (same as OpenAI but returned flat)
 */
export type ProviderFormat = "openai" | "anthropic" | "ollama";

export interface BridgeServerConfig {
  /**
   * How to connect to the MCP server.
   */
  transport: BridgeTransport;

  /**
   * For `stdio` transport: the command to spawn.
   * For `sse`/`http` transport: the URL to connect to.
   */
  commandOrUrl: string;

  /**
   * For `stdio` transport: arguments to pass to the command.
   * Ignored for `sse`/`http` transports.
   */
  args?: string[];

  /**
   * Environment variables for the spawned process (stdio transport only).
   */
  env?: Record<string, string>;

  /**
   * Working directory for the spawned process (stdio transport only).
   */
  cwd?: string;

  /**
   * Optional timeout for the MCP client connection (ms).
   * Defaults to 10000ms.
   */
  connectionTimeoutMs?: number;

  /**
   * Optional OAuth 2.1 bearer token for authenticating with remote
   * MCP servers (SSE and HTTP transports only). The token is sent
   * in the `Authorization: Bearer <token>` header on every request.
   *
   * For stdio transports, use `env` to inject credentials.
   *
   * @example
   * ```ts
   * new MCPFunctionCallingBridge({
   *   transport: "sse",
   *   commandOrUrl: "https://mcp.example.com/sse",
   *   auth: {
   *     bearerToken: "oauth2-access-token-here",
   *   },
   * });
   * ```
   */
  auth?: {
    /** OAuth 2.1 bearer token for the `Authorization` header. */
    bearerToken?: string;
    /** Optional API key for header-based auth (header name defaults to `X-API-Key`). */
    apiKey?: string;
    /** Header name for the API key. Default: `X-API-Key`. */
    apiKeyHeader?: string;
  };
}

/**
 * Options for the MCPFunctionCallingBridge.
 */
export interface BridgeOptions {
  /**
   * List of tools to expose. If omitted, all tools from the
   * connected MCP server are loaded.
   *
   * Can also be used to filter: only tools matching these
   * names will be available.
   */
  allowedTools?: string[];

  /**
   * If true, tool errors are returned as error results
   * rather than thrown. Defaults to true.
   */
  suppressErrors?: boolean;

  /**
   * Optional tool-result cache configuration. When provided,
   * the bridge caches successful tool results by (server + tool + args)
   * with a TTL, so repeated identical calls return instantly and
   * avoid redundant MCP server round-trips.
   *
   * @example
   * ```ts
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   cache: { ttlMs: 60_000, maxSize: 200 },
   * });
   * ```
   */
  cache?: {
    /** Time-to-live for cached results, in milliseconds. Default 300_000 (5 min). */
    ttlMs?: number;
    /** Maximum number of entries to keep (LRU eviction). Default 500. */
    maxSize?: number;
  };

  /**
   * Optional health monitoring configuration. When provided, the bridge
   * creates a HealthMonitor that emits connection events (connect, disconnect,
   * reconnect, circuit open/close). Auto-reconnect is enabled by default.
   *
   * Pass `false` to explicitly disable health monitoring.
   *
   * @example
   * ```ts
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   health: { maxRetries: 3, onEvent: (e) => console.log(e.type) },
   * });
   * ```
   */
  health?: HealthMonitorOptions | false;

  /**
   * Optional OpenTelemetry observability configuration. When provided,
   * the bridge creates a `BridgeObservability` instance that emits
   * distributed traces following the OpenTelemetry GenAI semantic
   * conventions (gen_ai.*) for every tool call. This enables integration
   * with LangFuse, LangSmith, Datadog, Arize Phoenix, and other OTEL-compatible
   * backends.
   *
   * Requires `@opentelemetry/api` to be installed. If not installed,
   * tracing is silently disabled (no-op).
   *
   * @example
   * ```ts
   * import { traces } from "@opentelemetry/api";
   *
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   observability: {
   *     tracing: true,
   *     includeArgs: true,
   *     includeOutput: true,
   *     estimateTokens: true,
   *     estimateCost: true,
   *   },
   * });
   * ```
   */
  observability?: ObservabilityOptions;

  /**
   * Optional audit logger for recording tool invocations.
   *
   * When provided, every `callTool()` invocation — successful or failed —
   * generates an `AuditLogEntry` with the tool name, args (redacted),
   * duration, result size, and success/error status. This provides the
   * structured audit trail required for enterprise governance,
   * compliance, and observability.
   *
   * Implementations should avoid blocking I/O since `log()` is called
   * synchronously. For file/database logging, buffer entries and flush
   * asynchronously.
   *
   * @example
   * ```ts
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   auditLog: {
   *     log: (entry) => console.log(JSON.stringify(entry)),
   *   },
   * });
   * ```
   */
  auditLog?: ToolAuditLogger | false;

  /**
   * Optional policy-based access control (RBAC) configuration.
   *
   * When provided, every `callTool()` invocation is evaluated against
   * the policy engine before the tool is executed. If a policy denies
   * access, the tool call is rejected with an authorization error.
   *
   * This implements the OAuth 2.1 + RBAC pattern recommended by the
   * MCP specification: OAuth scopes define broad capability domains,
   * and fine-grained tool-level decisions are enforced server-side
   * via these policies.
   *
   * @example
   * ```ts
   * const bridge = new MCPFunctionCallingBridge(config, {
   *   policies: {
   *     policies: [
   *       {
   *         name: "restricted",
   *         defaultAction: "deny",
   *         rules: [
   *           { tool: "list_issues", action: "allow" },
   *           { tool: "create_webhook", action: "deny" },
   *           {
   *             tool: "*",
   *             action: "allow",
   *             condition: (ctx) => ctx.roles.includes("admin"),
   *           },
   *         ],
   *       },
   *     ],
   *   },
   *   // The principal (caller identity) is resolved from the bridge's
   *   // auth config or can be set manually via setPrincipal().
   * });
   * ```
   */
  policies?: PolicyRegistry;
}

/**
 * An audit log entry recording a single tool invocation.
 *
 * Each entry captures who/what called the tool, the arguments,
 * the duration, the result size, and whether it succeeded.
 * Sensitive values (e.g. tokens in args) should be redacted
 * by the audit logger implementation, not by the caller.
 */
export interface AuditLogEntry {
  /** ISO timestamp of when the tool call was initiated. */
  timestamp: string;
  /** Name of the MCP tool that was invoked. */
  toolName: string;
  /** Serialized arguments passed to the tool (may be redacted). */
  args: Record<string, unknown>;
  /** Duration of the tool call in milliseconds. */
  durationMs: number;
  /** Whether the tool call succeeded. */
  success: boolean;
  /** Error message if the call failed. */
  error?: string;
  /** Size of the result output in characters (for volume monitoring). */
  resultSizeChars?: number;
  /** Client/identity making the call, if available. */
  clientId?: string;
  /** Principal (caller identity) if RBAC is configured. */
  principal?: string;
  /** Roles assigned to the caller, if RBAC is configured. */
  roles?: string[];
  /** Policy evaluation result, if RBAC is configured. */
  policyDecision?: {
    allowed: boolean;
    policyName?: string;
    reason?: string;
  };
}

/**
 * Interface for an audit logger that records tool invocations.
 *
 * Implementations can write to files, databases, or streaming
 * endpoints. The bridge calls `log()` synchronously before
 * returning from `callTool()`, so implementations should avoid
 * blocking I/O.
 */
export interface ToolAuditLogger {
  /** Record a tool invocation entry. */
  log(entry: AuditLogEntry): void;
}
export interface ToolListing {
  /**
   * All available tools, normalized to the bridge format.
   */
  tools: BridgeTool[];

  /**
   * The raw MCP tool list (for debugging or direct MCP usage).
   */
  rawTools: Tool[];
}

/**
 * A function-call request from an LLM, in a normalized format.
 */
export interface FunctionCall {
  /**
   * The function/tool name to call.
   */
  name: string;

  /**
   * The arguments as a parsed object. If the provider sends
   * a JSON string, the bridge parses it into an object here.
   */
  arguments: Record<string, unknown>;
}

/**
 * A step in a tool chain: calls a tool with given arguments.
 * The output of the previous step (if any) is available as `prevOutput`.
 */
export interface ToolChainStep {
  /** The name of the tool to call. */
  name: string;
  /** Arguments for the tool call. Can be a static object or a function
   * that receives the previous step's BridgeToolResult.output. */
  args: Record<string, unknown> | ((prevOutput: string) => Record<string, unknown>);
}

/**
 * A chain of tool calls where each step's output can feed into the next.
 * This enables type-safe pipelining of MCP tool results.
 *
 * @example
 * ```ts
 * const chain: ToolChain = {
 *   steps: [
 *     { name: "search_repositories", args: { query: "mcp" } },
 *     { name: "list_issues", args: (prev) => {
 *       const repos = JSON.parse(prev);
 *       return { owner: repos[0].owner.login, repo: repos[0].name };
 *     }},
 *   ],
 * };
 * const results = await bridge.callToolChain(chain);
 * ```
 */
export interface ToolChain {
  steps: ToolChainStep[];
}

/* ---------------------------------------------------------------------------
 * Policy-Based Access Control (RBAC)
 * ------------------------------------------------------------------------- */

/**
 * A policy rule that controls access to a specific tool.
 *
 * Policies are evaluated in order: the first matching rule wins.
 * If no rule matches, the default action (allow or deny) applies.
 */
export interface PolicyRule {
  /** The tool name this rule applies to. Use "*" as a wildcard for all tools. */
  tool: string | "*";
  /**
   * Whether to allow or deny access.
   */
  action: "allow" | "deny";
  /**
   * Optional condition function. If provided, the rule only applies
   * when this returns true. The context contains the caller's identity
   * and any attributes available on the bridge.
   */
  condition?: (context: PolicyContext) => boolean | Promise<boolean>;
}

/**
 * The context passed to policy rule conditions.
 * Contains information about the caller and the request.
 */
export interface PolicyContext {
  /** The authenticated caller's identity (if any). */
  principal?: string;
  /** Roles assigned to the caller (if any). */
  roles: string[];
  /** Additional attributes about the caller (from auth token claims, etc.). */
  attributes: Record<string, unknown>;
  /** The tool being called. */
  tool: string;
  /** The tool arguments (may be redacted for sensitive data). */
  args: Record<string, unknown>;
}

/**
 * Result of a policy evaluation.
 */
export interface PolicyDecision {
  /** Whether the action is allowed. */
  allowed: boolean;
  /** The rule that matched (if any). */
  matchedRule?: PolicyRule;
  /** The policy that was evaluated. */
  policyName?: string;
  /** Timestamp of the decision. */
  timestamp: number;
  /** Reason for the decision (for audit logs). */
  reason?: string;
}

/**
 * A named policy — an ordered list of rules with a default action.
 */
export interface Policy {
  /** Unique policy name. */
  name: string;
  /** Ordered rules — first match wins. */
  rules: PolicyRule[];
  /** Default action when no rule matches. Default: "allow". */
  defaultAction: "allow" | "deny";
}

/**
 * A policy resolver that determines which policy applies to a given
 * caller/tool combination. This allows dynamic policy selection
 * (e.g. based on the caller's role or the tool category).
 */
export interface PolicyResolver {
  /**
   * Resolve the applicable policy for a given context.
   * Returns the policy name, or undefined if no policy applies.
   */
  resolve(context: PolicyContext): string | undefined;
}

/**
 * Registry of named policies and an optional default policy.
 */
export interface PolicyRegistry {
  /** The policies available in this registry. */
  policies: Policy[];
  /** The name of the default policy to use when no specific policy matches. */
  defaultPolicyName?: string;
}

/**
 * Policy-based access control engine for the bridge.
 *
 * Evaluates incoming tool calls against a registry of policies
 * and decides whether the call is allowed.
 *
 * @example
 * ```ts
 * import { PolicyEngine } from "@universal-mcp-toolkit/bridge";
 *
 * const engine = new PolicyEngine({
 *   policies: [
 *     {
 *       name: "admin",
 *       defaultAction: "allow",
 *       rules: [
 *         { tool: "*", action: "deny" },
 *       ],
 *     },
 *     {
 *       name: "guest",
 *       defaultAction: "deny",
 *       rules: [
 *         { tool: "list_issues", action: "allow" },
 *       ],
 *     },
 *   ],
 * });
 * ```
 */
export class PolicyEngine {
  protected readonly registry: PolicyRegistry;

  constructor(registry: PolicyRegistry) {
    this.registry = registry;
  }

  /**
   * Evaluate a tool call against the policies.
   *
   * @param context The policy context (principal, roles, tool, args).
   * @returns A decision indicating whether the call is allowed.
   */
  async evaluate(context: PolicyContext): Promise<PolicyDecision> {
    const timestamp = Date.now();

    // Find the applicable policy.
    let policy: Policy | undefined;

    if (this.registry.defaultPolicyName) {
      policy = this.registry.policies.find(
        (p) => p.name === this.registry.defaultPolicyName,
      );
    }

    // If no specific resolver, use the default policy.
    if (!policy && this.registry.policies.length > 0) {
      // If there's only one policy, use it.
      if (this.registry.policies.length === 1) {
        policy = this.registry.policies[0];
      } else {
        // Default to the first policy.
        policy = this.registry.policies[0];
      }
    }

    if (!policy) {
      return {
        allowed: true,
        timestamp,
        reason: "No policy configured — default allow",
      };
    }

    // Evaluate rules in order — first match wins.
    for (const rule of policy.rules) {
      const ruleMatches =
        rule.tool === "*" ||
        rule.tool === context.tool;

      if (!ruleMatches) continue;

      // Check the condition if present.
      if (rule.condition) {
        const conditionResult = await rule.condition(context);
        if (!conditionResult) continue; // Rule doesn't apply.
      }

      return {
        allowed: rule.action === "allow",
        matchedRule: rule,
        policyName: policy.name,
        timestamp,
        reason: `Rule '${rule.tool}' ${rule.action}`,
      };
    }

    // No rule matched — use the default action.
    return {
      allowed: policy.defaultAction === "allow",
      policyName: policy.name,
      timestamp,
      reason: `Default action: ${policy.defaultAction}`,
    };
  }
}
