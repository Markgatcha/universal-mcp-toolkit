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

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SERVER_REGISTRY, type ServerRegistryEntry } from "./registry.js";
import { generateServerSkill, parseSkillFrontmatter } from "./skills.js";
import { getStateDirectory } from "./config-store.js";

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
export type PluginPackFileKind = "manifest" | "mcp-config" | "skill" | "skill-manifest" | "client-shim";

/**
 * Extension identifier for the MCP Skills extension (`io.modelcontextprotocol/skills`).
 * SEP-2640 reached Status: Final (PR #2640 merged 2026-09-13); the normative
 * extension spec is `specification/stable/skills.mdx` in
 * modelcontextprotocol/ext-skills, written against base protocol 2026-07-28.
 */
export const MCP_SKILLS_EXTENSION_ID = "io.modelcontextprotocol/skills";

/**
 * SEP-2640 §Skill Entries: one file of a skill — the digest and byte size of
 * its raw content. `digest` is `sha256:{64 lowercase hex}`.
 */
export interface Sep2640SkillResource {
  uri: string;
  digest: string;
  size: number;
}

/**
 * SEP-2640 §Skill Entries: the entry for a single skill. Identical shape in
 * `skills/list` and `skills/get`; `frontmatter` is the SKILL.md frontmatter
 * verbatim as a JSON object (`name` and `description` always present).
 */
export interface Sep2640SkillEntry {
  uri: string;
  frontmatter: Record<string, unknown>;
  resources: Sep2640SkillResource[] | "dynamic";
}

/**
 * SEP-2640 §Listing Skills: the `skills/list` result shape (JSON-RPC envelope
 * omitted — this is the file a host reads from disk). `ttlMs: 0` marks a
 * static package manifest as immediately stale: hosts re-check the package
 * itself rather than trusting a cached listing.
 */
export interface Sep2640SkillsList {
  extension: typeof MCP_SKILLS_EXTENSION_ID;
  resultType: "complete";
  skills: Sep2640SkillEntry[];
  ttlMs: 0;
  cacheScope: "public";
}

/** SHA-256 digest of raw bytes, formatted `sha256:{64 lowercase hex}` per SEP-2640. */
export function sha256Digest(content: string | Uint8Array): string {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

/**
 * The `skill://` URI for a packed skill. SEP-2640 requires the final
 * `<skill-path>` segment to equal the frontmatter `name`, which for
 * pack-generated skills is `umt-<id>` (see `generateServerSkill`).
 */
export function skillUriForPackEntry(entry: ServerRegistryEntry): string {
  return `skill://umt-${entry.id}/SKILL.md`;
}

/**
 * Build the SEP-2640 `Skill` entry for one packed skill from its planned
 * file content. Digests are computed over the exact bytes `writePluginPack`
 * writes (UTF-8), so the manifest and the package can never disagree.
 */
export function buildSkillEntry(entry: ServerRegistryEntry, content: string): Sep2640SkillEntry {
  const frontmatter = parseSkillFrontmatter(content);
  if (!frontmatter || typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") {
    throw new Error(
      `Cannot build SEP-2640 skill entry for '${entry.id}': generated SKILL.md lacks name/description frontmatter.`,
    );
  }
  const uri = skillUriForPackEntry(entry);
  return {
    uri,
    frontmatter: frontmatter as Record<string, unknown>,
    resources: [{ uri, digest: sha256Digest(content), size: Buffer.byteLength(content, "utf8") }],
  };
}

/**
 * Build the SEP-2640 `skills/list` result for a set of planned skill files.
 * Each entry is complete (its `resources` set is never split), so the same
 * object also answers `skills/get` entry-by-entry via {@link getSkillEntry}.
 */
export function buildSkillsList(
  skills: Array<{ entry: ServerRegistryEntry; content: string }>,
): Sep2640SkillsList {
  return {
    extension: MCP_SKILLS_EXTENSION_ID,
    resultType: "complete",
    skills: skills.map(({ entry, content }) => buildSkillEntry(entry, content)),
    ttlMs: 0,
    cacheScope: "public",
  };
}

/**
 * The `skills/get` view over a manifest: return the entry for one skill URI.
 * Mirrors the spec's error contract — an unknown URI is `-32602 Invalid
 * params` on the wire, a loud throw here.
 */
export function getSkillEntry(manifest: Sep2640SkillsList, uri: string): Sep2640SkillEntry {
  const found = manifest.skills.find((s) => s.uri === uri);
  if (!found) {
    throw new Error(`Unknown skill URI '${uri}'. (On the wire this is skills/get error -32602 Invalid params.)`);
  }
  return found;
}

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

  // SEP-2640 skills/list manifest: every packed skill as a `Skill` entry with
  // SHA-256 digests over the exact bytes written above. Hosts can verify a
  // distributed package the same way they verify a live server's listing.
  files.push({
    relativePath: "skills.json",
    kind: "skill-manifest",
    content: `${JSON.stringify(buildSkillsList(skillFilesForEntries(entries, files)), null, 2)}\n`,
  });

  files.push(...buildClientShims(options.name, version, description, mcpConfig));

  return { name: options.name, version, description, entries, outDir, files };
}

/**
 * Re-derive the planned skill file contents for a set of entries (the same
 * strings `writePluginPack` will write). Shared by the plan builder and the
 * CLI so digests can never disagree with the package on disk.
 */
function skillFilesForEntries(
  entries: readonly ServerRegistryEntry[],
  files: readonly PluginPackFile[],
): Array<{ entry: ServerRegistryEntry; content: string }> {
  return entries.map((entry) => {
    const file = files.find((f) => f.relativePath === `skills/umt-${entry.id}/SKILL.md`);
    if (!file) throw new Error(`Plan is missing the skill file for server '${entry.id}'.`);
    return { entry, content: file.content };
  });
}

/**
 * Build the SEP-2640 `skills/list` manifest for an already-planned package.
 * Pure — the CLI uses it to record digest pins after writing.
 */
export function manifestForPlan(plan: PluginPackPlan): Sep2640SkillsList {
  return buildSkillsList(skillFilesForEntries(plan.entries, plan.files));
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

/**
 * One skill's integrity pin — the disk-side record of what `umt plugin pack`
 * emitted, dovetailing with `umt vet`'s drift-pin persistence in
 * `vet-pins.json`. A later `umt plugin audit` (or vet) compares the pinned
 * digests against the package on disk and reports drift instead of silently
 * trusting changed skill files.
 */
export interface SkillPinRecord {
  /** Plugin name this skill was packed into. */
  plugin: string;
  /** SEP-2640 skill URI (`skill://umt-<id>/SKILL.md`). */
  uri: string;
  /** SHA-256 digest of the packed SKILL.md, `sha256:{hex}`. */
  digest: string;
  /** Byte size of the packed SKILL.md. */
  size: number;
  /** Full SEP-2640 resources set (the unit of content a pin binds to). */
  resources: Sep2640SkillResource[] | "dynamic";
  /** ISO timestamp of when the pin was recorded. */
  pinnedAt: string;
}

function getSkillPinPath(): string {
  return path.join(getStateDirectory(), "skill-pins.json");
}

async function readSkillPins(): Promise<Record<string, SkillPinRecord>> {
  try {
    const contents = await readFile(getSkillPinPath(), "utf8");
    return JSON.parse(contents) as Record<string, SkillPinRecord>;
  } catch {
    return {};
  }
}

/**
 * Persist the manifest's skill digests to `~/.universal-mcp-toolkit/skill-pins.json`,
 * keyed by skill URI. Returns `true` when the pins were stored; `false` when
 * the state directory is unwritable (callers should warn, not fail).
 */
export async function recordSkillPins(
  plan: Pick<PluginPackPlan, "name">,
  manifest: Sep2640SkillsList,
): Promise<boolean> {
  const pins = await readSkillPins();
  const pinnedAt = new Date().toISOString();
  for (const skill of manifest.skills) {
    const skillResource = Array.isArray(skill.resources)
      ? skill.resources.find((r) => r.uri === skill.uri)
      : undefined;
    pins[skill.uri] = {
      plugin: plan.name,
      uri: skill.uri,
      digest: skillResource?.digest ?? "sha256:unavailable",
      size: skillResource?.size ?? 0,
      resources: skill.resources,
      pinnedAt,
    };
  }
  try {
    await mkdir(getStateDirectory(), { recursive: true });
    await writeFile(getSkillPinPath(), JSON.stringify(pins, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Read back the recorded skill pins (used by tests and by future drift
 * checks). Returns an empty record when nothing was pinned yet.
 */
export async function readRecordedSkillPins(): Promise<Record<string, SkillPinRecord>> {
  return readSkillPins();
}
