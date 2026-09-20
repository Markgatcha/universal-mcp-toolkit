/**
 * Agent Plugins 1.0 distribution engine — the `pack` side of `umt plugin`.
 *
 * [Agent Plugins](https://agent-plugins.org) 1.0.0 (GA Aug 2026) is a
 * vendor-neutral package format that makes Agent Skills + an `mcp.json`
 * server map portable across clients (GitHub Copilot, ChatGPT & Codex,
 * VS Code, Hermes Agent, Kiro, Cursor, OpenClaw). The spec defines the
 * package layout but no registry, no CLI, and no trust model — this module
 * is UMT's answer to the first two: it *generates* a complete, installable
 * plugin package from any UMT server selection.
 *
 * A generated package mirrors UMT's own hand-maintained `plugin/` directory
 * at the repo root:
 *
 * ```
 * <out>/
 * ├── plugin.json            # required manifest: $schema + name + metadata
 * ├── mcp.json               # stdio server configs (npx-based, no secrets)
 * ├── skills/
 * │   └── umt-<id>/SKILL.md  # reused per-server SKILL.md generation
 * ├── .mcp.json              # client shim: Codex-historical MCP config shape
 * └── .claude-plugin/
 *     └── plugin.json       # client shim: Claude Code plugin manifest shape
 * ```
 *
 * Secrets policy: the spec forbids credentials in `env`/`headers` and makes
 * auth client-managed. `pack` therefore never emits secret *values* — each
 * server-required env var becomes a self-referencing placeholder
 * (`"GITHUB_TOKEN": "${GITHUB_TOKEN}"`), which the audit side
 * (`plugin-audit.ts`) explicitly allows. Install-time secret injection is the
 * client's job.
 *
 * No LLM is involved anywhere: everything is derived deterministically from
 * the server registry and the existing SKILL.md generator.
 */

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_REGISTRY, type ServerRegistryEntry } from "./registry.js";
import { generateServerSkill } from "./skills.js";

/** Agent Plugins spec version this engine targets. */
export const AGENT_PLUGINS_SPEC_VERSION = "1.0.0";

/** Canonical `$schema` values from the spec (used in pack output, checked in audit). */
export const PLUGIN_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const MCP_SCHEMA_URL = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

/**
 * Spec §5 plugin name rule: 1–64 chars, lowercase alphanumerics with
 * `.`/`-` separators, no leading/trailing separator, no `--` or `..`.
 */
export const PLUGIN_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const PLUGIN_NAME_MAX_LENGTH = 64;

export const PLUGIN_HOMEPAGE = "https://github.com/Markgatcha/universal-mcp-toolkit";
export const PLUGIN_AUTHOR_NAME = "Markgatcha";

/** What kind of package member a planned file is (shown in `--dry-run`). */
export type PluginPackFileKind = "manifest" | "mcp-config" | "skill" | "client-shim";

export interface PluginPackFile {
  /** Path relative to the package root, POSIX-style. */
  relativePath: string;
  kind: PluginPackFileKind;
  /** File contents (UTF-8). */
  content: string;
}

export interface PluginPackOptions {
  /** Spec-validated plugin name (required). */
  name: string;
  /** UMT server IDs to include (required, non-empty). */
  serverIds: readonly string[];
  /** Plugin description; defaults to a generated summary. */
  description?: string | undefined;
  /** Plugin version; defaults to the CLI version when packed via the CLI. */
  version?: string | undefined;
  /** Output directory; defaults to `./<name>` under the cwd. */
  outDir?: string | undefined;
}

export interface PluginPackPlan {
  name: string;
  version: string;
  description: string;
  entries: readonly ServerRegistryEntry[];
  outDir: string;
  files: PluginPackFile[];
}

/** Throw a loud, actionable error when the plugin name violates the spec. */
export function validatePluginName(name: string): void {
  if (typeof name !== "string" || name.length === 0) {
    throw new Error("Plugin name is required (--name).");
  }
  if (name.length > PLUGIN_NAME_MAX_LENGTH || !PLUGIN_NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid plugin name '${name}'. Agent Plugins 1.0 requires 1–64 lowercase ` +
        `characters: letters, digits, '.' and '-' only, no leading/trailing ` +
        `separator, no '--' or '..'.`,
    );
  }
}

/**
 * Resolve server IDs to registry entries. Throws listing every unknown ID —
 * a typo'd server must never silently shrink the package.
 */
export function resolvePackServers(serverIds: readonly string[]): ServerRegistryEntry[] {
  if (serverIds.length === 0) {
    throw new Error("At least one --servers <id> is required.");
  }
  const byId = new Map(SERVER_REGISTRY.map((e) => [e.id, e]));
  const unknown = serverIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    const valid = [...byId.keys()].sort().join(", ");
    throw new Error(`Unknown server id(s): ${unknown.join(", ")}. Valid ids: ${valid}.`);
  }
  // De-duplicate while preserving the user's order.
  const seen = new Set<string>();
  return serverIds.filter((id) => (seen.has(id) ? false : (seen.add(id), true))).map((id) => byId.get(id)!);
}

/**
 * Build the `plugin.json` manifest object. Only spec-defined top-level
 * fields are emitted (the spec sets `additionalProperties: false`).
 */
export function buildPluginManifest(
  name: string,
  version: string,
  description: string,
): Record<string, unknown> {
  return {
    $schema: PLUGIN_SCHEMA_URL,
    name,
    version,
    description,
    keywords: ["mcp", "agent-skills", "universal-mcp-toolkit"],
    author: { name: PLUGIN_AUTHOR_NAME },
    homepage: PLUGIN_HOMEPAGE,
    repository: PLUGIN_HOMEPAGE,
    license: "MIT",
  };
}

/**
 * Build one stdio server entry for `mcp.json` from a registry entry.
 * Mirrors the launch shape of `umt run` / the bridge: npx-based servers run
 * `npx -y <package> --transport stdio`; entries with explicit `npxArgs`
 * (companion packages) keep their own invocation verbatim.
 *
 * Env vars the server needs become `${NAME}` placeholders — a reference the
 * client resolves at install time, never a value. The spec forbids secrets
 * here and leaves auth client-managed.
 */
export function buildMcpServerEntry(entry: ServerRegistryEntry): Record<string, unknown> {
  const args = entry.npxArgs ? [...entry.npxArgs] : ["-y", entry.packageName, "--transport", "stdio"];
  const server: Record<string, unknown> = {
    type: "stdio",
    command: "npx",
    args,
  };
  if (entry.envVarNames.length > 0) {
    server.env = Object.fromEntries(entry.envVarNames.map((name) => [name, `\${${name}}`]));
  }
  return server;
}

/** Build the `mcp.json` object for the selected entries. */
export function buildMcpConfig(entries: readonly ServerRegistryEntry[]): Record<string, unknown> {
  const mcpServers: Record<string, unknown> = {};
  for (const entry of entries) {
    mcpServers[`umt-${entry.id}`] = buildMcpServerEntry(entry);
  }
  return { $schema: MCP_SCHEMA_URL, mcpServers };
}

/**
 * Build the client-namespace shim files, mirroring UMT's own `plugin/`
 * distribution: a Codex-historical `.mcp.json` (bare `mcpServers`, no
 * `$schema`) and a Claude Code `.claude-plugin/plugin.json` manifest.
 */
export function buildClientShims(
  name: string,
  version: string,
  description: string,
  mcpConfig: Record<string, unknown>,
): PluginPackFile[] {
  const mcpServers = mcpConfig.mcpServers as Record<string, unknown>;
  const shimServers: Record<string, unknown> = {};
  for (const [key, server] of Object.entries(mcpServers)) {
    const rest = { ...(server as Record<string, unknown>) };
    delete rest.type;
    shimServers[key] = rest;
  }
  return [
    {
      relativePath: ".mcp.json",
      kind: "client-shim",
      content: `${JSON.stringify({ mcpServers: shimServers }, null, 2)}\n`,
    },
    {
      relativePath: ".claude-plugin/plugin.json",
      kind: "client-shim",
      content: `${JSON.stringify(
        {
          name,
          displayName: name,
          version,
          description,
          keywords: ["mcp", "agent-skills", "universal-mcp-toolkit"],
          author: { name: PLUGIN_AUTHOR_NAME },
          homepage: PLUGIN_HOMEPAGE,
          license: "MIT",
        },
        null,
        2,
      )}\n`,
    },
  ];
}

/** Default one-line description when the user passes no `--description`. */
export function defaultPackDescription(entries: readonly ServerRegistryEntry[]): string {
  const titles = entries.map((e) => e.title).join(", ");
  return `Universal MCP Toolkit plugin — MCP servers and Agent Skills for: ${titles}.`;
}

/**
 * Plan the full package: validate inputs, resolve servers, and compute every
 * file that would be written. Pure — no filesystem side effects, so
 * `--dry-run` is just printing this plan.
 */
export function planPluginPack(options: PluginPackOptions, cliVersion = "0.0.0"): PluginPackPlan {
  validatePluginName(options.name);
  const entries = resolvePackServers(options.serverIds);
  const version = options.version ?? cliVersion;
  const description = options.description ?? defaultPackDescription(entries);
  const outDir = options.outDir ?? path.join(process.cwd(), options.name);

  const files: PluginPackFile[] = [
    {
      relativePath: "plugin.json",
      kind: "manifest",
      content: `${JSON.stringify(buildPluginManifest(options.name, version, description), null, 2)}\n`,
    },
  ];

  const mcpConfig = buildMcpConfig(entries);
  files.push({
    relativePath: "mcp.json",
    kind: "mcp-config",
    content: `${JSON.stringify(mcpConfig, null, 2)}\n`,
  });

  for (const entry of entries) {
    files.push({
      relativePath: `skills/umt-${entry.id}/SKILL.md`,
      kind: "skill",
      content: generateServerSkill(entry),
    });
  }

  files.push(...buildClientShims(options.name, version, description, mcpConfig));

  return { name: options.name, version, description, entries, outDir, files };
}

/**
 * Write a planned package to disk. Creates directories as needed and refuses
 * to write outside the planned output root. Returns absolute written paths.
 */
export async function writePluginPack(plan: PluginPackPlan): Promise<string[]> {
  const root = path.resolve(plan.outDir);
  const written: string[] = [];
  for (const file of plan.files) {
    const abs = path.resolve(root, file.relativePath);
    if (abs !== root && !abs.startsWith(root + path.sep)) {
      throw new Error(`Refusing to write outside the package root: ${file.relativePath}`);
    }
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, file.content, "utf8");
    written.push(abs);
  }
  return written;
}
