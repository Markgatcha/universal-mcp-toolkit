/**
 * Slim tool manifests — a names-only (+ one-line description) catalog of MCP
 * tools with on-demand full-schema expansion.
 *
 * Tool *definitions* are the biggest token tax in multi-server MCP setups:
 * every `tools/list` ships full JSON Schemas for every tool on every turn.
 * The slim manifest pattern fixes this:
 *
 * 1. Give the model the slim manifest (names + one-line descriptions) as
 *    cheap context — typically 5-10x fewer tokens than full definitions.
 * 2. Expand the full input schema on demand with {@link describeTool} right
 *    before invoking a tool.
 *
 * The full-schema path is unchanged — these helpers are purely additive.
 *
 * @module @universal-mcp-toolkit/bridge/slim-manifest
 */

import { estimateTokenCount } from "./observability.js";
import type { BridgeTool } from "./types.js";

/**
 * Maximum characters kept from a tool description in the slim manifest.
 * Descriptions are also cut to their first line — one line per tool.
 */
const MAX_SLIM_DESCRIPTION_CHARS = 160;

/**
 * One entry in the slim manifest: everything an agent needs to decide
 * *whether* a tool is relevant, without paying for its full schema.
 */
export interface SlimToolEntry {
  /** Server this tool belongs to (the label passed to {@link toSlimManifest}). */
  server: string;
  /** Tool name, exactly as it appears in `tools/list`. */
  name: string;
  /** First line of the tool description, truncated to {@link MAX_SLIM_DESCRIPTION_CHARS}. */
  description: string;
}

/**
 * A slim catalog of tools across one or more servers.
 */
export interface SlimManifest {
  entries: SlimToolEntry[];
  totalTools: number;
  servers: string[];
}

/**
 * Full input-schema detail for a single tool — the on-demand expansion
 * of a {@link SlimToolEntry}.
 */
export interface ToolSchemaDetail {
  server: string;
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Reduce a tool description to a single line for the slim manifest.
 */
export function oneLineDescription(description: string | undefined | null): string {
  if (!description) return "";
  const firstLine = description.split("\n")[0]!.trim().replace(/\s+/g, " ");
  if (firstLine.length <= MAX_SLIM_DESCRIPTION_CHARS) return firstLine;
  return `${firstLine.slice(0, MAX_SLIM_DESCRIPTION_CHARS - 3).trimEnd()}...`;
}

/**
 * Build slim manifest entries for one server's tools, sorted by name.
 *
 * @param tools - Full tool definitions (e.g. from `bridge.listTools()`).
 * @param server - Label identifying the server these tools belong to.
 */
export function toSlimManifest(tools: BridgeTool[], server = "default"): SlimToolEntry[] {
  return tools
    .map((tool) => ({
      server,
      name: tool.name,
      description: oneLineDescription(tool.description),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Merge per-server slim entries into one cross-server manifest,
 * grouped by server then sorted by tool name.
 */
export function buildSlimManifest(
  servers: Array<{ server: string; tools: BridgeTool[] }>,
): SlimManifest {
  const entries = servers.flatMap(({ server, tools }) => toSlimManifest(tools, server));
  entries.sort(
    (a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name),
  );
  return {
    entries,
    totalTools: entries.length,
    servers: [...new Set(entries.map((e) => e.server))].sort(),
  };
}

/**
 * Render a slim manifest as compact plain text, grouped by server —
 * ready to paste into a prompt as cheap tool context.
 *
 * @example
 * ```text
 * ## github (3 tools)
 * - list_issues — List open issues for a GitHub repository.
 * - get_pull_request — Fetch a pull request by number.
 * ```
 */
export function formatSlimManifest(manifest: SlimManifest): string {
  const lines: string[] = [];
  for (const server of manifest.servers) {
    const tools = manifest.entries.filter((e) => e.server === server);
    lines.push(`## ${server} (${tools.length} tool${tools.length === 1 ? "" : "s"})`);
    for (const tool of tools) {
      lines.push(tool.description ? `- ${tool.name} — ${tool.description}` : `- ${tool.name}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/**
 * On-demand full-schema expansion for a single tool.
 *
 * This is the "expand" half of the slim-manifest pattern: the agent reads
 * the cheap manifest, then calls this for exactly the tool it wants to
 * invoke, instead of paying for every tool's schema up front.
 *
 * @param tools - Full tool definitions (e.g. from `bridge.listTools()`).
 * @param name - Exact tool name to expand.
 * @param server - Server label to attach to the result.
 * @throws If no tool with `name` exists.
 */
export function describeTool(
  tools: BridgeTool[],
  name: string,
  server = "default",
): ToolSchemaDetail {
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    const known = tools
      .map((t) => t.name)
      .sort()
      .slice(0, 10)
      .join(", ");
    throw new Error(
      `Unknown tool "${name}"${server !== "default" ? ` on server "${server}"` : ""}. ` +
        (known ? `Known tools include: ${known}.` : "No tools available."),
    );
  }
  const inputSchema = (tool.mcpTool?.inputSchema ?? {}) as Record<string, unknown>;
  return {
    server,
    name: tool.name,
    title: tool.title,
    description: tool.description ?? "",
    inputSchema:
      Object.keys(inputSchema).length > 0
        ? inputSchema
        : { type: "object", properties: {} },
  };
}

/**
 * Measure how many tokens the slim manifest saves versus shipping full
 * `tools/list` definitions. Useful for sanity checks and reporting.
 *
 * @param tools - Full tool definitions for one server.
 * @param server - Server label for the manifest.
 */
export function compareManifestSize(
  tools: BridgeTool[],
  server = "default",
): { fullTokens: number; slimTokens: number; reductionPct: number } {
  const fullJson = JSON.stringify(tools.map((t) => t.mcpTool ?? t));
  const manifest = buildSlimManifest([{ server, tools }]);
  const slimText = formatSlimManifest(manifest);
  const fullTokens = estimateTokenCount(fullJson);
  const slimTokens = estimateTokenCount(slimText);
  const reductionPct =
    fullTokens === 0 ? 0 : Math.round(((fullTokens - slimTokens) / fullTokens) * 100);
  return { fullTokens, slimTokens, reductionPct };
}
