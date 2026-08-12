// Multi-server session context for MCPFunctionCallingBridge.
//
// A Session bundles multiple connected MCP bridges together so that tools
// from different servers can be orchestrated in a single logical workflow.
// This is especially useful when you need to cross-reference data across
// servers (e.g., GitHub issues → Notion pages → Slack notifications).
//
// @module @universal-mcp-toolkit/bridge/session

import { createLogger, ToolkitError, normalizeError } from "@universal-mcp-toolkit/core";
import { MCPFunctionCallingBridge } from "./bridge.js";
import type { BridgeToolResult, BridgeServerConfig, BridgeOptions } from "./types.js";

/** Minimal logger interface compatible with pino's Logger. */
interface Logger {
  info(msgOrObj: unknown, msg?: string): void;
  warn(msgOrObj: unknown, msg?: string): void;
  error(msgOrObj: unknown, msg?: string): void;
  debug(msgOrObj: unknown, msg?: string): void;
}

/**
 * Configuration for a session — a named set of MCP server connections.
 */
export interface SessionConfig {
  /** Human-readable name for this session. */
  name: string;
  /** Bridge configurations for each server in the session. */
  bridges: ReadonlyArray<{
    /** Unique identifier for this bridge within the session. */
    id: string;
    /** Bridge config to connect. */
    config: BridgeServerConfig;
    /** Bridge options (cache, error suppression, etc.). */
    options?: BridgeOptions;
  }>;
}

/**
 * Result of executing a tool within a session.
 */
export interface SessionToolResult {
  /** The bridge ID that produced this result. */
  bridgeId: string;
  /** The tool name that was called. */
  tool: string;
  /** The result data. */
  result: BridgeToolResult;
}

/**
 * A multi-server session that manages multiple MCP bridge connections
 * and provides a unified interface for calling tools across servers.
 *
 * @example
 * ```ts
 * const session = await Session.create({
 *   name: "bug-report-flow",
 *   bridges: [
 *     { id: "github", config: { transport: "stdio", commandOrUrl: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } },
 *     { id: "slack", config: { transport: "stdio", commandOrUrl: "npx", args: ["-y", "@universal-mcp-toolkit/server-slack"] } },
 *   ],
 * });
 *
 * const issue = await session.callTool("github", "get_issue", { owner: "user", repo: "repo", issue_number: 1 });
 * const result = await session.callTool("slack", "post_message", { channel: "alerts", text: issue.result.output });
 * ```
 */
export class Session {
  private readonly logger: Logger;
  private readonly bridges: Map<string, MCPFunctionCallingBridge> = new Map();
  private readonly configs: SessionConfig;

  private constructor(config: SessionConfig, logger?: Logger) {
    this.configs = config;
    this.logger = logger ?? createLogger({ name: `session:${config.name}` });
  }

  /**
   * Create and connect a new session with multiple MCP bridges.
   * All bridges are connected in parallel for faster startup.
   */
  static async create(config: SessionConfig, logger?: Logger): Promise<Session> {
    const session = new Session(config, logger);

    // Connect all bridges in parallel for faster startup.
    const bridgePromises = config.bridges.map(async (bridgeConfig) => {
      const bridge = new MCPFunctionCallingBridge(bridgeConfig.config, bridgeConfig.options);
      await bridge.connect();
      session.bridges.set(bridgeConfig.id, bridge);
      return bridge;
    });

    try {
      await Promise.all(bridgePromises);
    } catch (error) {
      // Clean up any bridges that were successfully connected.
      await session.close();
      throw normalizeError(error);
    }

    session.logger.info(`Session '${config.name}' connected with ${session.bridges.size} bridge(s).`);
    return session;
  }

  /**
   * Call a tool on a specific bridge within this session.
   */
  async callTool(
    bridgeId: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<SessionToolResult> {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) {
      throw new ToolkitError(
        `Bridge '${bridgeId}' not found in session '${this.configs.name}'. Available: ${[...this.bridges.keys()].join(", ")}`,
        { code: "bridge_not_found" },
      );
    }

    const result = await bridge.callTool(toolName, args, timeoutMs);
    return { bridgeId, tool: toolName, result };
  }

  /**
   * Call tools on multiple bridges in parallel.
   * Useful for fan-out operations (e.g., searching across multiple servers).
   */
  async callToolsParallel(calls: Array<{
    bridgeId: string;
    toolName: string;
    args: Record<string, unknown>;
    timeoutMs?: number;
  }>): Promise<SessionToolResult[]> {
    const results = await Promise.all(
      calls.map((call) => this.callTool(call.bridgeId, call.toolName, call.args, call.timeoutMs)),
    );
    return results;
  }

  /**
   * List all available tools across all bridges in this session.
   */
  async listAllTools(): Promise<{ bridgeId: string; toolName: string; description: string }[]> {
    const allTools: { bridgeId: string; toolName: string; description: string }[] = [];

    for (const [bridgeId, bridge] of this.bridges) {
      const listing = await bridge.listTools();
      for (const tool of listing.tools) {
        allTools.push({
          bridgeId,
          toolName: tool.name,
          description: tool.description ?? "",
        });
      }
    }

    return allTools;
  }

  /**
   * Get the bridge for a specific ID.
   */
  getBridge(bridgeId: string): MCPFunctionCallingBridge | undefined {
    return this.bridges.get(bridgeId);
  }

  /**
   * Get all bridge IDs in this session.
   */
  getBridgeIds(): string[] {
    return [...this.bridges.keys()];
  }

  /**
   * Get cache statistics for all bridges in this session.
   */
  getCacheStats(): Record<string, { size: number; maxSize: number; ttlMs: number } | null> {
    const stats: Record<string, { size: number; maxSize: number; ttlMs: number } | null> = {};
    for (const [bridgeId, bridge] of this.bridges) {
      stats[bridgeId] = bridge.getCacheStats?.() ?? null;
    }
    return stats;
  }

  /**
   * Close all bridge connections in this session.
   */
  async close(): Promise<void> {
    const closePromises = Array.from(this.bridges.values()).map((bridge) =>
      bridge.disconnect().catch((err) => {
        this.logger.error({ err }, `Error disconnecting bridge in session '${this.configs.name}'.`);
      }),
    );
    await Promise.all(closePromises);
    this.bridges.clear();
    this.logger.info(`Session '${this.configs.name}' closed.`);
  }

  /**
   * Check if all bridges in this session are connected.
   */
  isConnected(): boolean {
    return Array.from(this.bridges.values()).every((bridge) => bridge.isConnected());
  }
}
