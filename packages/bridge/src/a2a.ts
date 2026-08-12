/**
 * A2A (Agent2Agent) Protocol server adapter for the MCP bridge.
 *
 * Exposes UMT's MCP function-calling bridge as a JSON-RPC 2.0 server
 * compliant with Google's A2A Protocol Specification (v1.0), allowing
 * any A2A-compliant client agent to discover and invoke UMT-backed tools.
 *
 * The adapter wraps `MCPFunctionCallingBridge` and translates A2A JSON-RPC
 * requests (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`,
 * `tasks/resubscribe`, push notification methods) into MCP tool calls,
 * and MCP tool results into A2A response artifacts.
 *
 * @module @universal-mcp-toolkit/bridge/a2a
 */

import type { BridgeTool, BridgeToolResult } from "./types.js";

/* ---------------------------------------------------------------------------
 * A2A Protocol Data Types
 * (following https://github.com/a2aproject/A2A/blob/main/docs/specification.md)
 * ------------------------------------------------------------------------- */

/**
 * A2A task lifecycle states, following the A2A protocol spec.
 * These map directly to the `TaskState` enum in the A2A specification.
 */
export type A2ATaskState =
  | "auth-required"
  | "input-required"
  | "working"
  | "completed"
  | "canceled"
  | "failed"
  | "rejected"
  | "pending";

/**
 * A message exchanged between an A2A client and the agent.
 * Messages contain typed parts (text, data, file).
 */
export interface A2AMessage {
  /** Message role: "user" or "agent". */
  role: "user" | "agent";
  /** The message parts. */
  parts: A2APart[];
  /** Optional context ID for multi-turn conversations. */
  contextId?: string;
}

/**
 * A part of an A2A message or artifact.
 * Can be text, structured data, or a file reference.
 */
export type A2APart =
  | { type: "text"; text: string }
  | { type: "data"; data: unknown; mimeType?: string }
  | {
    type: "file";
    name: string;
    bytes?: string;
    uri?: string;
    mimeType?: string;
  };

/**
 * An artifact produced by an A2A agent — contains the result
 * of tool execution, intermediate analysis, or final output.
 */
export interface A2AArtifact {
  /** Artifact name/description. */
  name: string;
  /** MIME type of the artifact content. */
  mimeType?: string;
  /** Parts (content) of the artifact. */
  parts: A2APart[];
  /** Whether this is an append (partial) or final artifact. */
  append?: boolean;
  /** The last chunk — when append=false, this should be true. */
  lastChunk?: boolean;
  /** Index of this artifact in the task's artifact list. */
  index?: number;
}

/**
 * Status of an A2A task at a point in time.
 */
export interface A2ATaskStatus {
  /** The task state at this point in history. */
  state: A2ATaskState;
  /** Optional message about what's happening. */
  message?: A2AMessage;
  /** When this status was recorded (ms since epoch). */
  timestamp: number;
}

/**
 * A task managed by the A2A adapter — tracks the full lifecycle
 * from submission to completion, including streaming updates.
 */
export interface A2ATask {
  /** Unique task identifier. */
  id: string;
  /** The A2A state of this task. */
  state: A2ATaskState;
  /** The incoming A2A message that initiated the task. */
  inputMessage: A2AMessage;
  /** Artifacts produced by the task (tool results, etc.). */
  artifacts?: A2AArtifact[];
  /** Timestamp when the task was created (ms since epoch). */
  createdAt: number;
  /** Timestamp of the last state update (ms since epoch). */
  updatedAt: number;
  /** Optional error message if the task failed. */
  error?: string;
  /** Push notification config for async updates (if registered). */
  pushNotificationConfig?: A2APushNotificationConfig;
  /** History of state transitions for debugging. */
  history: A2ATaskStatus[];
}

/**
 * A2A agent skill — describes a capability that the A2A server exposes.
 * A skill maps roughly to an MCP tool, but can also represent
 * higher-level workflows (e.g. "research a topic").
 */
export interface A2ASkill {
  /** Stable identifier for the skill. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Longer description of what the skill does. */
  description?: string;
  /** Tags for discoverability. */
  tags: string[];
  /** Example prompts that would trigger this skill. */
  examples?: string[];
  /** What input formats the skill accepts. */
  inputModes: string[];
  /** What output formats the skill produces. */
  outputModes: string[];
}

/**
 * Protocol-level capabilities advertised in the Agent Card.
 */
export interface A2ACapabilities {
  /** Whether the agent supports streaming responses via SSE. */
  streaming?: boolean;
  /** Whether the agent supports push notifications for async updates. */
  pushNotifications?: boolean;
  /** Whether the agent supports task state transition history. */
  stateTransitionHistory?: boolean;
  /** Whether the agent supports an extended (non-public) agent card. */
  extendedAgentCard?: boolean;
}

/**
 * Push notification configuration for a task — allows the A2A server
 * to push updates to a client webhook instead of requiring polling.
 */
export interface A2APushNotificationConfig {
  /** Webhook URL to receive push notifications. */
  url: string;
  /** Optional bearer token for authentication. */
  token?: string;
  /** Optional authentication headers. */
  authentication?: AuthConfig;
}

/**
 * Authentication configuration for the A2A server.
 * Supports OAuth 2.1 bearer tokens and optional API key.
 */
export interface AuthConfig {
  /** Bearer token scopes required for access. */
  scopes?: string[];
  /** Optional API key names for header-based authentication. */
  apiKeyNames?: string[];
}

/**
 * Agent Card — the public metadata document that an A2A server exposes
 * at `/.well-known/agent.json`. This is fetched by A2A clients for
 * capability discovery before sending any tasks.
 *
 * @see https://github.com/a2aproject/A2A/blob/main/docs/specification.md
 */
export interface A2AAgentCard {
  /** Protocol version this agent card conforms to. */
  protocolVersion: "1.0";
  /** Human-readable agent name. */
  name: string;
  /** Short description of the agent's purpose. */
  description: string;
  /** URL where the A2A endpoint is reachable. */
  url: string;
  /** Provider name (optional). */
  provider?: {
    name: string;
    url?: string;
  };
  /** Protocol-level capabilities the agent supports. */
  capabilities: A2ACapabilities;
  /** Skills (capabilities) this agent can perform. */
  skills: A2ASkill[];
  /** Supported authentication methods. */
  authentication?: AuthConfig;
  /** Default timeout for long-running tasks (seconds). Default: 30. */
  defaultTimeout?: number;
  /** Version of the agent. */
  version: string;
}

/**
 * A2A JSON-RPC request envelope.
 */
export interface A2AJsonRpcRequest {
  /** JSON-RPC version — always "2.0". */
  jsonrpc: "2.0";
  /** The method being called. */
  method: string;
  /** Request parameters (method-specific). */
  params: unknown;
  /** Request ID for correlation. */
  id: string | number;
}

/**
 * A2A JSON-RPC response envelope.
 */
export interface A2AJsonRpcResponse {
  /** JSON-RPC version — always "2.0". */
  jsonrpc: "2.0";
  /** The result (method-specific). */
  result?: unknown;
  /** Error, if the request failed. */
  error?: A2AJsonRpcError;
  /** Request ID — echoes the request's id. */
  id: string | number;
}

/**
 * A2A JSON-RPC error object.
 */
export interface A2AJsonRpcError {
  /** Error code. */
  code: number;
  /** Human-readable error message. */
  message: string;
  /** Optional structured data. */
  data?: unknown;
}

/**
 * A2A JSON-RPC error codes (following the spec).
 */
export const A2A_ERROR_CODES = {
  parseError: -32700,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32000,
  invalidRequest: -32600,
} as const;

/* ---------------------------------------------------------------------------
 * Bridge Configuration
 * ------------------------------------------------------------------------- */

/**
 * Configuration for the A2A server adapter.
 */
export interface A2AServerConfig {
  /** The bridge instance to wrap. */
  bridge: unknown;
  /** The agent card to serve at /.well-known/agent.json. */
  agentCard: A2AAgentCard;
  /** Optional authentication / auth validation callback. */
  auth?: {
    /** Validate bearer token. Returns true if authorized. */
    validateToken?: (token: string) => boolean | Promise<boolean>;
    /** Validate API key. Returns true if authorized. */
    validateApiKey?: (key: string) => boolean | Promise<boolean>;
  };
  /** Optional push notification sender. */
  pushSender?: {
    /** Send a push notification to a registered webhook. */
    send: (config: A2APushNotificationConfig, payload: unknown) => Promise<void>;
  };
}

/* ---------------------------------------------------------------------------
 * Helper Functions
 * ------------------------------------------------------------------------- */

/**
 * Convert a BridgeTool to an A2A skill.
 */
function toolToSkill(tool: BridgeTool): A2ASkill {
  return {
    id: tool.name,
    name: tool.name,
    description: tool.description,
    tags: (tool.mcpTool as { tags?: string[] } | undefined)?.tags ??
      (tool.title ? [tool.title] : []),
    inputModes: ["application/json", "text/plain"],
    outputModes: ["application/json", "text/plain"],
    examples: [tool.name],
  };
}

/**
 * Convert an A2A message part to tool arguments.
 */
function partToArgs(part: A2APart): Record<string, unknown> {
  if (part.type === "text") {
    return { query: part.text };
  }
  if (part.type === "data") {
    return part.data as Record<string, unknown>;
  }
  // File parts
  return { file: { name: part.name, uri: part.uri, bytes: part.bytes } };
}

/**
 * Convert a BridgeToolResult to an A2A artifact.
 */
function resultToArtifact(result: BridgeToolResult): A2AArtifact {
  return {
    name: "tool-result",
    mimeType: "application/json",
    parts: [
      {
        type: "data",
        data: result.output,
        mimeType: "application/json",
      },
    ],
    lastChunk: true,
    index: 0,
  };
}

/* ---------------------------------------------------------------------------
 * A2A Server Adapter
 * ------------------------------------------------------------------------- */

/**
 * A2A Protocol server that exposes UMT's MCP function-calling bridge
 * as a JSON-RPC 2.0 service compliant with Google's A2A specification.
 *
 * The server handles:
 * - Agent Card discovery at `/.well-known/agent.json`
 * - `message/send` — synchronous task execution
 * - `message/stream` — streaming task execution via SSE
 * - `tasks/get` — retrieve task status
 * - `tasks/cancel` — cancel a running task
 * - `tasks/resubscribe` — reconnect to a streaming task
 * - Push notification config set/get
 * - Authentication via bearer tokens or API keys
 *
 * @example
 * ```ts
 * import { MCPFunctionCallingBridge } from "./bridge.js";
 * import { A2AServerAdapter } from "./a2a.js";
 *
 * const bridge = new MCPFunctionCallingBridge(config);
 * await bridge.connect();
 *
 * const adapter = new A2AServerAdapter({
 *   bridge,
 *   agentCard: {
 *     protocolVersion: "1.0",
 *     name: "UMT A2A Server",
 *     description: "Exposes MCP tools via the A2A protocol",
 *     url: "http://localhost:8080/a2a",
 *     capabilities: { streaming: true, pushNotifications: false },
 *     skills: [],
 *     version: "1.0.0",
 *   },
 * });
 * ```
 */
export class A2AServerAdapter {
  protected readonly bridge: unknown;
  protected readonly config: A2AServerConfig;
  protected readonly tasks = new Map<string, A2ATask>();
  protected readonly subscribers = new Map<string, Set<(task: A2ATask) => void>>();

  /**
   * Create a new A2A server adapter.
   *
   * @param config Configuration including the bridge, agent card, and auth.
   */
  constructor(config: A2AServerConfig) {
    this.bridge = config.bridge;
    this.config = config;
  }

  /**
   * Get the Agent Card for this server.
   *
   * Skills are auto-populated from the bridge's tool listing if
   * the bridge has a `tools` property.
   */
  getAgentCard(): A2AAgentCard {
    const skills: A2ASkill[] = [];

    // Try to auto-populate skills from the bridge's tool listing.
    const bridgeAny = this.bridge as { tools?: BridgeTool[] };
    if (bridgeAny.tools) {
      for (const tool of bridgeAny.tools) {
        skills.push(toolToSkill(tool));
      }
    }

    return {
      ...this.config.agentCard,
      skills: skills.length > 0 ? skills : this.config.agentCard.skills,
    };
  }

  /**
   * Validate authentication for an incoming request.
   * Returns `true` if authorized, or an error object if not.
   */
  async validateAuth(
    authHeader?: string,
    apiKey?: string,
  ): Promise<true | { code: number; message: string }> {
    const auth = this.config.auth;
    if (!auth) return true; // No auth configured.

    // Bearer token validation.
    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.slice("Bearer ".length);
      if (auth.validateToken) {
        const valid = await auth.validateToken(token);
        if (!valid) return { code: -32001, message: "Invalid or expired token" };
      }
      return true;
    }

    // API key validation.
    if (apiKey) {
      if (auth.validateApiKey) {
        const valid = await auth.validateApiKey(apiKey);
        if (!valid) return { code: -32001, message: "Invalid API key" };
      }
      return true;
    }

    // If auth is configured but no credentials were provided.
    return { code: -32001, message: "Authentication required" };
  }

  /**
   * Handle `message/send` — create a task, execute it, and return the result.
   *
   * This is the core A2A method: it takes a message, finds the appropriate
   * tool(s) to call, executes them via the bridge, and returns the results
   * as A2A artifacts.
   */
  async handleMessageSend(params: {
    message: A2AMessage;
    /** Optional task ID to continue an existing task. */
    taskId?: string;
    /** Optional context ID for multi-turn conversations. */
    contextId?: string;
    /** Optional timeout in seconds. */
    timeout?: number;
  }): Promise<{ task: A2ATask; artifacts: A2AArtifact[] }> {
    const taskId = params.taskId ?? this.generateTaskId();
    const task: A2ATask = {
      id: taskId,
      state: "working",
      inputMessage: params.message,
      artifacts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{ state: "working", timestamp: Date.now() }],
    };

    this.tasks.set(taskId, task);

    // Execute each part of the message as a tool call.
    const artifacts: A2AArtifact[] = [];

    for (const part of params.message.parts) {
      const args = partToArgs(part);

      // Find the best matching tool based on the skill ID / tool name.
      const toolName = this.resolveToolName(args);

      try {
        const callTool = (this.bridge as {
          callTool: (
            name: string,
            args: Record<string, unknown>,
            timeoutMs?: number,
          ) => Promise<BridgeToolResult>;
        }).callTool;

        const result = await callTool(
          toolName,
          args,
          params.timeout ? params.timeout * 1000 : undefined,
        );

        const artifact = resultToArtifact(result);
        artifacts.push(artifact);
        task.artifacts = task.artifacts ?? [];
        task.artifacts.push(artifact);

        // Notify subscribers.
        this.notifySubscribers(task);
      } catch (err) {
        task.state = "failed";
        task.error = err instanceof Error ? err.message : String(err);
        task.updatedAt = Date.now();
        task.history.push({ state: "failed", timestamp: Date.now() });
        this.notifySubscribers(task);

        // Also emit the error as an artifact.
        artifacts.push({
          name: "error",
          mimeType: "application/json",
          parts: [
            {
              type: "data",
              data: { error: task.error, tool: toolName, args },
              mimeType: "application/json",
            },
          ],
          lastChunk: true,
          index: artifacts.length,
        });
      }
    }

    // Only mark as completed if no errors occurred.
    if (task.state !== "failed") {
      task.state = "completed";
    }
    task.updatedAt = Date.now();
    task.history.push({ state: task.state, timestamp: Date.now() });
    this.notifySubscribers(task);

    return { task, artifacts };
  }

  /**
   * Handle `message/stream` — create a task and return a stream of
   * task status updates via callbacks.
   */
  async handleMessageStream(params: {
    message: A2AMessage;
    onTaskUpdate: (task: A2ATask) => void;
  }): Promise<{ task: A2ATask }> {
    const taskId = this.generateTaskId();
    const task: A2ATask = {
      id: taskId,
      state: "working",
      inputMessage: params.message,
      artifacts: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      history: [{ state: "working", timestamp: Date.now() }],
    };

    this.tasks.set(taskId, task);

    // Register subscriber for streaming updates.
    const subscriber = (updatedTask: A2ATask) => {
      if (updatedTask.id === taskId) {
        params.onTaskUpdate(updatedTask);
      }
    };
    this.addSubscriber(taskId, subscriber);

    // Execute the task asynchronously.
    this.executeTask(task).finally(() => {
      this.removeSubscriber(taskId, subscriber);
    });

    return { task };
  }

  /**
   * Handle `tasks/get` — retrieve a task by ID.
   */
  handleTaskGet(params: { taskId: string }): A2ATask | undefined {
    return this.tasks.get(params.taskId);
  }

  /**
   * Handle `tasks/cancel` — cancel a running task.
   */
  handleTaskCancel(params: { taskId: string }): A2ATask | undefined {
    const task = this.tasks.get(params.taskId);
    if (!task) return undefined;

    if (task.state === "working" || task.state === "pending") {
      task.state = "canceled";
      task.updatedAt = Date.now();
      task.history.push({ state: "canceled", timestamp: Date.now() });
      this.notifySubscribers(task);
    }

    return task;
  }

  /**
   * Handle `tasks/resubscribe` — reconnect to a streaming task.
   */
  handleTaskResubscribe(params: {
    taskId: string;
    onTaskUpdate: (task: A2ATask) => void;
  }): A2ATask | undefined {
    const task = this.tasks.get(params.taskId);
    if (!task) return undefined;

    const subscriber = (updatedTask: A2ATask) => {
      if (updatedTask.id === params.taskId) {
        params.onTaskUpdate(updatedTask);
      }
      // If the task is terminal, stop sending updates.
      if (
        updatedTask.state === "completed" ||
        updatedTask.state === "failed" ||
        updatedTask.state === "canceled"
      ) {
        this.removeSubscriber(params.taskId, subscriber);
      }
    };
    this.addSubscriber(params.taskId, subscriber);

    return task;
  }

  /**
   * Handle `push_notification/set` — register a push notification
   * config for a task.
   */
  handlePushNotificationSet(params: {
    taskId: string;
    pushNotificationConfig: A2APushNotificationConfig;
  }): boolean {
    const task = this.tasks.get(params.taskId);
    if (!task) return false;

    task.pushNotificationConfig = params.pushNotificationConfig;
    return true;
  }

  /**
   * Handle `push_notification/get` — retrieve push notification config.
   */
  handlePushNotificationGet(params: {
    taskId: string;
  }): A2APushNotificationConfig | undefined {
    return this.tasks.get(params.taskId)?.pushNotificationConfig;
  }

  /**
   * Dispatch an A2A JSON-RPC request to the appropriate handler.
   * This is the main entry point for the A2A server's HTTP endpoint.
   */
  async dispatch(
    request: A2AJsonRpcRequest,
    authHeader?: string,
    apiKey?: string,
  ): Promise<A2AJsonRpcResponse> {
    // Validate authentication.
    if (this.config.auth) {
      const authResult = await this.validateAuth(authHeader, apiKey);
      if (authResult !== true) {
        return {
          jsonrpc: "2.0",
          error: {
            code: authResult.code,
            message: authResult.message,
          },
          id: request.id,
        };
      }
    }

    const { method, params, id } = request;

    try {
      if (method === "message/send") {
        const result = await this.handleMessageSend(
          params as Parameters<A2AServerAdapter["handleMessageSend"]>[0],
        );
        return { jsonrpc: "2.0", result, id };
      }

      if (method === "tasks/get") {
        const params = request.params as { taskId: string };
        const task = this.handleTaskGet(params);
        if (!task) {
          return {
            jsonrpc: "2.0",
            error: {
              code: A2A_ERROR_CODES.invalidParams,
              message: `Task not found: ${params.taskId}`,
            },
            id,
          };
        }
        return { jsonrpc: "2.0", result: task, id };
      }

      if (method === "tasks/cancel") {
        const params = request.params as { taskId: string };
        const task = this.handleTaskCancel(params);
        if (!task) {
          return {
            jsonrpc: "2.0",
            error: {
              code: A2A_ERROR_CODES.invalidParams,
              message: `Task not found: ${params.taskId}`,
            },
            id,
          };
        }
        return { jsonrpc: "2.0", result: task, id };
      }

      if (method === "tasks/resubscribe") {
        const params = request.params as {
          taskId: string;
          onTaskUpdate: (task: A2ATask) => void;
        };
        const task = this.handleTaskResubscribe(params);
        if (!task) {
          return {
            jsonrpc: "2.0",
            error: {
              code: A2A_ERROR_CODES.invalidParams,
              message: `Task not found: ${params.taskId}`,
            },
            id,
          };
        }
        return { jsonrpc: "2.0", result: task, id };
      }

      if (method === "push_notification/set") {
        const params = request.params as {
          taskId: string;
          pushNotificationConfig: A2APushNotificationConfig;
        };
        const success = this.handlePushNotificationSet(params);
        return { jsonrpc: "2.0", result: { success }, id };
      }

      if (method === "push_notification/get") {
        const params = request.params as { taskId: string };
        const config = this.handlePushNotificationGet(params);
        return { jsonrpc: "2.0", result: config, id };
      }

      // Unknown method.
      return {
        jsonrpc: "2.0",
        error: {
          code: A2A_ERROR_CODES.methodNotFound,
          message: `Method not found: ${method}`,
        },
        id,
      };
    } catch (err) {
      return {
        jsonrpc: "2.0",
        error: {
          code: A2A_ERROR_CODES.internalError,
          message: err instanceof Error ? err.message : String(err),
        },
        id,
      };
    }
  }

  // --- Internal helpers ---

  /**
   * Resolve which MCP tool to call based on the message args.
   *
   * If `tool` is specified in the args, use that. Otherwise,
   * try to find a tool that matches by name. Falls back to
   * the first available tool.
   */
  protected resolveToolName(args: Record<string, unknown>): string {
    if (args.tool && typeof args.tool === "string") {
      return args.tool;
    }

    // Try to find the best matching tool from the bridge's tools.
    const bridgeAny = this.bridge as { tools?: BridgeTool[] };
    const tools = bridgeAny.tools;
    if (tools && tools.length > 0) {
      // Simple heuristic: use the first available tool.
      // In production, this would be replaced with LLM-based routing
      // or keyword matching against tool descriptions.
      return tools[0].name;
    }

    // Fallback: use "query" as a tool name hint.
    if (args.query && typeof args.query === "string") {
      return args.query;
    }

    throw new Error(
      "Could not resolve tool name from message. Include a 'tool' field in the args.",
    );
  }

  /**
   * Execute a task by calling the appropriate bridge tools.
   * Used for streaming (async) execution.
   */
  protected async executeTask(task: A2ATask): Promise<void> {
    try {
      for (const part of task.inputMessage.parts) {
        const args = partToArgs(part);
        const toolName = this.resolveToolName(args);

        const callTool = (this.bridge as {
          callTool: (
            name: string,
            args: Record<string, unknown>,
          ) => Promise<BridgeToolResult>;
        }).callTool;

        const result = await callTool(toolName, args);
        const artifact = resultToArtifact(result);
        task.artifacts = task.artifacts ?? [];
        task.artifacts.push(artifact);
        task.updatedAt = Date.now();
        this.notifySubscribers(task);
      }

      task.state = "completed";
      task.updatedAt = Date.now();
      task.history.push({ state: "completed", timestamp: Date.now() });
      this.notifySubscribers(task);
    } catch (err) {
      task.state = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.updatedAt = Date.now();
      task.history.push({ state: "failed", timestamp: Date.now() });
      this.notifySubscribers(task);
    }
  }

  /**
   * Generate a unique task ID.
   */
  protected generateTaskId(): string {
    return `a2a-task-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Add a subscriber for task updates (for streaming).
   */
  protected addSubscriber(
    taskId: string,
    callback: (task: A2ATask) => void,
  ): void {
    if (!this.subscribers.has(taskId)) {
      this.subscribers.set(taskId, new Set());
    }
    this.subscribers.get(taskId)!.add(callback);
  }

  /**
   * Remove a subscriber.
   */
  protected removeSubscriber(
    taskId: string,
    callback: (task: A2ATask) => void,
  ): void {
    const set = this.subscribers.get(taskId);
    if (set) {
      set.delete(callback);
    }
  }

  /**
   * Notify all subscribers of a task update.
   */
  protected notifySubscribers(task: A2ATask): void {
    const set = this.subscribers.get(task.id);
    if (set) {
      for (const cb of set) {
        cb(task);
      }
    }

    // Send push notification if configured.
    this.sendPushNotification(task).catch(() => {
      /* non-blocking */
    });
  }

  /**
   * Send a push notification to a task's configured webhook.
   */
  protected async sendPushNotification(task: A2ATask): Promise<void> {
    if (!task.pushNotificationConfig || !this.config.pushSender) return;

    const payload = {
      method: "notifications/pushMessage",
      params: { task },
    };

    await this.config.pushSender.send(task.pushNotificationConfig, payload);
  }
}

/* ---------------------------------------------------------------------------
 * Serialization Helpers
 * ------------------------------------------------------------------------- */

/**
 * Convert an A2A artifact back to a text string for display.
 */
export function artifactToText(artifact: A2AArtifact): string {
  const textParts = artifact.parts.filter(
    (p): p is { type: "text"; text: string } => p.type === "text",
  );
  return textParts.map((p) => p.text).join("\n");
}

/**
 * Serialize an A2A JSON-RPC response to a JSON string.
 */
export function serializeResponse(response: A2AJsonRpcResponse): string {
  return JSON.stringify(response);
}

/**
 * Parse an A2A JSON-RPC request from JSON.
 */
export function parseRequest(json: string): A2AJsonRpcRequest {
  return JSON.parse(json) as A2AJsonRpcRequest;
}
