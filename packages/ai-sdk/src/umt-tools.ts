/**
 * Core implementation: turn UMT MCP servers into Vercel AI SDK tools.
 *
 * @module @universal-mcp-toolkit/ai-sdk/umt-tools
 */

import { MCPFunctionCallingBridge } from "@universal-mcp-toolkit/bridge";
import type { BridgeTool, BridgeToolResult } from "@universal-mcp-toolkit/bridge";

// ─── Types ──────────────────────────────────────────────────────────────────

/**
 * Options for `umtTools()`.
 */
export interface UmtToolConfig {
  /**
   * Which UMT server packages to connect to. Each entry is a server id from
   * the UMT registry (e.g. "github", "slack", "notion", "postgresql").
   *
   * @example
   * ```ts
   * umtTools({ servers: ["github", "slack"] })
   * ```
   */
  servers: string[];

  /**
   * Environment variables to pass to the spawned MCP server processes.
   * Only used for `stdio` transport (the default).
   *
   * @example
   * ```ts
   * umtTools({
   *   servers: ["github"],
   *   env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
   * })
   * ```
   */
  env?: Record<string, string>;

  /**
   * Optional tool name filter. If provided, only tools matching these names
   * (across all servers) are returned. Useful for reducing the tool surface.
   */
  toolFilter?: string[];

  /**
   * Maximum time to wait for MCP server connection before failing (ms).
   * Default: 15000 (15 seconds).
   */
  connectionTimeoutMs?: number;

  /**
   * Whether to enable health monitoring and auto-reconnect on the bridge.
   * Default: true.
   */
  health?: boolean;

  /**
   * Whether to enable TTL+LRU result caching on the bridge.
   * Default: { ttlMs: 300_000, maxSize: 500 }.
   */
  cache?: { ttlMs?: number; maxSize?: number } | boolean;

  /**
   * Optional allowlist of tool names. Only these tools will be available.
   */
  allowedTools?: string[];
}

/**
 * A single UMT tool wrapped for the AI SDK.
 *
 * This matches the shape the AI SDK's `tool()` function produces:
 * `{ description, parameters, execute }`.
 */
export interface UmtTool {
  description: string;
  /**
   * Zod schema for the tool's parameters. Built from the MCP tool's
   * JSON Schema inputSchema. May be a plain object if zod is not installed.
   */
  parameters: unknown;
  /**
   * Execute the tool with the given arguments.
   * Returns the tool's text output.
   */
  execute: (args: Record<string, unknown>) => Promise<string>;
}

/**
 * The return type — a map of tool name -> UmtTool.
 * Pass this directly to the AI SDK's `tools` parameter.
 */
export type UmtTools = Record<string, UmtTool>;

// ─── Server resolution ────────────────────────────────────────────────────────

/**
 * Resolve a server id to an npx command + args.
 * UMT servers are published as `@universal-mcp-toolkit/server-<id>`.
 */
function resolveServerLaunch(serverId: string): { command: string; args: string[] } {
  const packageName = `@universal-mcp-toolkit/server-${serverId}`;
  return {
    command: "npx",
    args: ["-y", packageName],
  };
}

// ─── JSON Schema to Zod conversion ─────────────────────────────────────────────

/**
 * Build a Zod schema from an MCP tool's JSON Schema inputSchema.
 *
 * The AI SDK's `tool()` uses Zod schemas for type-safe parameter definitions.
 * We convert the JSON Schema from the MCP tool definition to a Zod object
 * so the AI SDK can validate and infer types.
 *
 * If `zod` is not installed (it's optional via peer dep), we fall back to
 * an empty object — the tool still works at runtime, just without strict
 * type checking.
 */
async function buildZodSchema(
  inputSchema: BridgeTool["parameters"],
): Promise<unknown> {
  try {
    const { z } = await import("zod");

    const properties = inputSchema?.properties ?? {};
    const required = new Set(inputSchema?.required ?? []);

    const shape: Record<string, unknown> = {};

    for (const [key, schema] of Object.entries(properties)) {
      const propSchema = schema as Record<string, unknown> | undefined;
      const type = propSchema?.type;
      let zodType: unknown;

      if (typeof type === "string") {
        switch (type) {
          case "string":
            zodType = z.string();
            break;
          case "number":
            zodType = z.number();
            break;
          case "integer":
            zodType = z.number().int();
            break;
          case "boolean":
            zodType = z.boolean();
            break;
          case "array":
            zodType = z.array(z.unknown());
            break;
          case "object":
            zodType = z.record(z.string(), z.unknown());
            break;
          default:
            zodType = z.unknown();
        }
      } else {
        zodType = z.unknown();
      }

      if (!required.has(key)) {
        // Make optional fields .optional()
        const optFn = (zodType as { optional?: () => unknown }).optional;
        if (optFn) zodType = optFn.call(zodType);
      }

      shape[key] = zodType;
    }

    return z.object(shape);
  } catch {
    // zod not available — return empty object as passthrough.
    return {};
  }
}

// ─── Connection management ────────────────────────────────────────────────────

/**
 * Internal state: track all bridge connections so we can clean them up.
 */
interface ServerConnection {
  serverId: string;
  bridge: MCPFunctionCallingBridge;
  tools: BridgeTool[];
}

/**
 * Connect to a list of UMT servers and return the bridge connections.
 * Throws if any server fails to connect.
 */
async function connectServers(config: UmtToolConfig): Promise<ServerConnection[]> {
  const {
    servers,
    env,
    toolFilter,
    connectionTimeoutMs = 15_000,
    health = true,
    cache = true,
    allowedTools,
  } = config;

  if (servers.length === 0) {
    throw new Error("umtTools: at least one server must be specified");
  }

  const connections: ServerConnection[] = [];

  for (const serverId of servers) {
    const { command, args } = resolveServerLaunch(serverId);

    try {
      const bridge = new MCPFunctionCallingBridge(
        {
          transport: "stdio",
          commandOrUrl: command,
          args,
          env,
          connectionTimeoutMs,
        },
        {
          health: health ? { autoReconnect: true } : false,
          cache: cache ? { ttlMs: 300_000, maxSize: 500 } : undefined,
          allowedTools,
        },
      );

      await bridge.connect();
      const listing = await bridge.listTools();

      // Apply the tool name filter if provided.
      const filtered = toolFilter
        ? listing.tools.filter((t) => toolFilter.includes(t.name))
        : listing.tools;

      connections.push({ serverId, bridge, tools: filtered });
    } catch (error) {
      // Disconnect any bridges we've already connected so we don't leak.
      for (const { bridge: b } of connections) {
        await b.disconnect().catch(() => {});
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `umtTools: failed to connect to server '${serverId}': ${message}`,
      );
    }
  }

  return connections;
}

// ─── Core function ────────────────────────────────────────────────────────────

/**
 * Connect to UMT MCP servers and return AI SDK-compatible tools.
 *
 * This function:
 * 1. Spawns each server via `npx -y @universal-mcp-toolkit/server-<id>`
 * 2. Connects via stdio transport
 * 3. Lists all available tools from each server
 * 4. Converts each tool to the AI SDK's tool format with Zod schemas
 * 5. Wraps each tool's `execute` with a bridge call to the MCP server
 * 6. Returns a `ToolSet` ready for `streamText()` / `generateText()`
 *
 * @example Basic usage
 * ```ts
 * import { streamText } from "ai";
 * import { umtTools } from "@universal-mcp-toolkit/ai-sdk";
 *
 * const tools = await umtTools({
 *   servers: ["github"],
 *   env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
 * });
 *
 * const result = await streamText({
 *   model: openrouter("google/gemini-2.0-flash"),
 *   prompt: "List open issues in owner/repo",
 *   tools,
 * });
 * ```
 *
 * @example Multiple servers
 * ```ts
 * const tools = await umtTools({
 *   servers: ["github", "slack", "notion"],
 *   env: {
 *     GITHUB_TOKEN: process.env.GITHUB_TOKEN,
 *     SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN,
 *     NOTION_TOKEN: process.env.NOTION_TOKEN,
 *   },
 * });
 * ```
 *
 * @example With tool filtering
 * ```ts
 * const tools = await umtTools({
 *   servers: ["github"],
 *   env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
 *   toolFilter: ["list_issues", "create_issue"],
 * });
 * ```
 *
 * @example With a specific provider model
 * ```ts
 * import { generateText } from "ai";
 * import { umtTools } from "@universal-mcp-toolkit/ai-sdk";
 *
 * const tools = await umtTools({
 *   servers: ["github"],
 *   env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
 * });
 *
 * const result = await generateText({
 *   model: openrouter("anthropic/claude-3-5-sonnet"),
 *   prompt: "List open issues in owner/repo",
 *   tools,
 *   maxSteps: 10, // AI SDK auto-runs tool calls until done
 * });
 *
 * console.log(result.text);        // final response
 * console.log(result.toolResults); // all tool call results
 * ```
 */
export async function umtTools(config: UmtToolConfig): Promise<UmtTools> {
  const connections = await connectServers(config);

  const result: UmtTools = {};
  const usedNames = new Set<string>();

  for (const { serverId, bridge, tools } of connections) {
    for (const tool of tools) {
      // Avoid name collisions — if two servers export a tool with the same
      // name, prefix the second one with the server id.
      let toolName = tool.name;
      if (usedNames.has(toolName)) {
        toolName = `${serverId}_${tool.name}`;
      }
      usedNames.add(toolName);

      // Build the Zod schema for this tool's parameters.
      const parameters = await buildZodSchema(tool.parameters);

      result[toolName] = {
        description: tool.description,
        parameters,
        execute: async (args: Record<string, unknown>): Promise<string> => {
          const res: BridgeToolResult = await bridge.callTool(tool.name, args);
          return res.output;
        },
      };
    }
  }

  // Attach a cleanup method for callers who want to disconnect after use.
  // (Not enumerable so it doesn't show up in tool iteration.)
  Object.defineProperty(result, "_cleanup", {
    value: async () => {
      for (const { bridge } of connections) {
        await bridge.disconnect().catch(() => {});
      }
    },
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return result;
}

// ─── Convenience: single-server shortcut ─────────────────────────────────────

/**
 * Connect to a single UMT MCP server and return AI SDK tools.
 * Shorthand for `umtTools({ servers: [serverId], env })`.
 *
 * @example
 * ```ts
 * const tools = await umtToolsFor("github", { GITHUB_TOKEN });
 * ```
 */
export async function umtToolsFor(
  serverId: string,
  env: Record<string, string>,
  options: Omit<UmtToolConfig, "servers" | "env"> = {},
): Promise<UmtTools> {
  return umtTools({
    servers: [serverId],
    env,
    ...options,
  });
}
