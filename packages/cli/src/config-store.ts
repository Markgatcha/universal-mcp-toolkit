import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

import {
  getTargetDefaultPath,
  getTargetSpec,
  SHAPE_SPECS,
  type ConfigTarget,
  type EntryStyle,
  type InvocationMode,
  type ServerRegistryEntry,
} from "./registry.js";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface InstallProfile {
  target: ConfigTarget;
  mode: InvocationMode;
  outputPath: string;
  serverIds: string[];
  createdAt: string;
  profileName?: string;
}

export interface CliState {
  installs: InstallProfile[];
}

export interface GeneratedConfig {
  mcpServers: Record<
    string,
    {
      command: string;
      args: string[];
      env?: Record<string, string>;
    }
  >;
}

export interface SavedProfile {
  name: string;
  target: ConfigTarget;
  mode: InvocationMode;
  outputPath: string;
  serverIds: string[];
  createdAt: string;
}

export interface ExportedProfile {
  exportedAt: string;
  version: string;
  profiles: Array<{
    name: string;
    target: ConfigTarget;
    mode: InvocationMode;
    serverIds: string[];
    envVarKeys: string[];
  }>;
}

export function getStateDirectory(): string {
  return process.env.APPDATA
    ? path.join(process.env.APPDATA, "universal-mcp-toolkit")
    : path.join(os.homedir(), ".universal-mcp-toolkit");
}

export function getStateFilePath(): string {
  return path.join(getStateDirectory(), "state.json");
}

/**
 * The harness's real default config path for a target, falling back to a
 * scratch file under the UMT state dir when the target only dumps a snippet
 * (`json`) and so has no harness file.
 */
export function getGeneratedConfigPath(target: ConfigTarget): string {
  return getTargetDefaultPath(target) ?? path.join(getStateDirectory(), `${target}.json`);
}

export async function readState(): Promise<CliState> {
  try {
    const contents = await readFile(getStateFilePath(), "utf8");
    return JSON.parse(contents) as CliState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { installs: [] };
    }

    throw error;
  }
}

export async function writeState(state: CliState): Promise<void> {
  await mkdir(getStateDirectory(), { recursive: true });
  await writeFile(getStateFilePath(), JSON.stringify(state, null, 2), "utf8");
}

export async function saveInstallProfile(profile: InstallProfile): Promise<void> {
  const state = await readState();
  state.installs.unshift(profile);
  await writeState({
    installs: state.installs.slice(0, 10),
  });
}

export function isLocalWorkspaceServer(entry: ServerRegistryEntry): boolean {
  return existsSync(path.join(repoRoot, "servers", entry.id, "package.json"));
}

export function resolveWorkspaceEntryFile(entry: ServerRegistryEntry): string {
  const repoPath = path.join(repoRoot, "servers", entry.id, "dist", "index.mjs");
  try {
    return existsSync(repoPath) ? repoPath : path.join(path.dirname(require.resolve(`${entry.packageName}/package.json`)), "dist", "index.mjs");
  } catch {
    return repoPath;
  }
}

export function createPlaceholderEnv(entry: ServerRegistryEntry): Record<string, string> | undefined {
  if (entry.envVarNames.length === 0) {
    return undefined;
  }

  const env = Object.fromEntries(entry.envVarNames.map((name) => [name, `\${${name}}`]));
  return env;
}

/**
 * First-party servers ship in the catalog's `plugin/mcp.json` pinned to exact
 * npm versions. The CLI's generated configs must resolve the same immutable
 * version (never a floating `latest`), so the per-server pin lives here.
 * Packages not listed fall back to the unpinned package name.
 */
const SERVER_NPM_VERSIONS: Readonly<Record<string, string>> = {
  "umt-hackernews": "0.2.0",
  "umt-arxiv": "0.1.1",
  "umt-npm-registry": "0.2.0",
  hackernews: "0.2.0",
  arxiv: "0.1.1",
  "npm-registry": "0.2.0",
};

function defaultNpxArgs(entry: ServerRegistryEntry): string[] {
  const version = SERVER_NPM_VERSIONS[entry.id];
  const pkg = version ? `${entry.packageName}@${version}` : entry.packageName;
  return ["-y", pkg, "--transport", "stdio"];
}


export function createGeneratedConfig(
  entries: readonly ServerRegistryEntry[],
  mode: InvocationMode,
): GeneratedConfig {
  const mcpServers = Object.fromEntries(
    entries.map((entry) => {
      const invocation =
        mode === "npx"
          ? {
              command: "npx",
              args: [...(entry.npxArgs ?? defaultNpxArgs(entry))],
            }
          : {
              command: process.execPath,
              args: [resolveWorkspaceEntryFile(entry), "--transport", "stdio"],
            };

      const configEntry: {
        command: string;
        args: string[];
        env?: Record<string, string>;
      } = {
        ...invocation,
      };

      const placeholderEnv = createPlaceholderEnv(entry);
      if (placeholderEnv) {
        configEntry.env = placeholderEnv;
      }

      return [entry.id, configEntry];
    }),
  );

  return { mcpServers };
}

export async function writeGeneratedConfig(targetPath: string, generatedConfig: GeneratedConfig): Promise<void> {
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(targetPath, JSON.stringify(generatedConfig, null, 2), "utf8");
}

// ---------------------------------------------------------------------------
// Shape-aware emit + safe merge/backup write
// ---------------------------------------------------------------------------

type McpServerEntry = GeneratedConfig["mcpServers"][string];

function escapeTomlString(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function escapeTomlKey(key: string): string {
  // Bare keys are safe for [A-Za-z0-9_-]; quote anything else.
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : `"${escapeTomlString(key)}"`;
}

/** Serialize one server's config as a Codex `[mcp_servers.<name>]` TOML table. */
export function renderCodexServerToml(name: string, server: McpServerEntry): string {
  const lines: string[] = [`[mcp_servers.${escapeTomlKey(name)}]`];
  lines.push(`command = "${escapeTomlString(server.command)}"`);
  lines.push(`args = [${server.args.map((a) => `"${escapeTomlString(a)}"`).join(", ")}]`);
  if (server.env && Object.keys(server.env).length > 0) {
    lines.push("", `[mcp_servers.${escapeTomlKey(name)}.env]`);
    for (const [key, value] of Object.entries(server.env)) {
      lines.push(`${escapeTomlKey(key)} = "${escapeTomlString(value)}"`);
    }
  }
  return lines.join("\n");
}

/**
 * Render the generated config for a target into the text form the harness
 * expects: a full JSON document for mcpServers/openclaw targets, or a block of
 * TOML tables for Codex. Codex blocks are merged textually on write (TOML has
 * no safe lossless merge without a parser dependency).
 */
export function emitConfig(config: GeneratedConfig, target: ConfigTarget): string {
  const shape = getTargetSpec(target).shape;
  if (shape === "codex-toml") {
    return Object.entries(config.mcpServers)
      .map(([name, server]) => renderCodexServerToml(name, server))
      .join("\n\n") + "\n";
  }
  const shapeSpec = SHAPE_SPECS[shape];
  const servers = Object.fromEntries(
    Object.entries(config.mcpServers).map(([name, server]) => [name, entryForStyle(shapeSpec.entryStyle, server)]),
  );
  // Every JSON-shaped target nests its server map per its own docs
  // (`mcpServers`, `servers`, `context_servers`, `mcp`, `mcp.servers`).
  return JSON.stringify(nest(shapeSpec.serverKey, servers), null, 2) + "\n";
}

/** Serialize one server entry the way a target's document shape documents it. */
function entryForStyle(style: EntryStyle, server: McpServerEntry): Record<string, unknown> {
  const env = server.env && Object.keys(server.env).length > 0 ? server.env : undefined;
  switch (style) {
    case "vscode":
      // VS Code: { type: "stdio", command, args, env }
      return { type: "stdio", command: server.command, args: server.args, ...(env ? { env } : {}) };
    case "opencode":
      // OpenCode and Kilo Code: local servers take one command array plus
      // `environment` and `enabled` (their documented field names).
      return {
        type: "local",
        command: [server.command, ...server.args],
        enabled: true,
        ...(env ? { environment: env } : {}),
      };
    case "plain":
    default:
      return { command: server.command, args: server.args, ...(env ? { env } : {}) };
  }
}

/** Wrap a value under a key path, e.g. `["mcp","servers"]`. */
function nest(keyPath: readonly string[], value: unknown): Record<string, unknown> {
  return keyPath.reduceRight<Record<string, unknown>>((inner, key) => ({ [key]: inner }), value as Record<string, unknown>);
}

/** Read the server map out of a parsed document at its documented key path. */
function getNestedPath(root: Record<string, unknown>, keyPath: readonly string[]): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const key of keyPath) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  if (current === null || typeof current !== "object" || Array.isArray(current)) return undefined;
  return current as Record<string, unknown>;
}

/** Write a value into a nested key path, creating intermediate objects. */
function setNestedPath(root: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
  let current = root;
  for (const key of keyPath.slice(0, -1)) {
    const next = current[key];
    if (next === null || typeof next !== "object" || Array.isArray(next)) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keyPath[keyPath.length - 1]!] = value;
}

/**
 * Parse an existing JSON harness config, or throw.
 *
 * Deliberately strict: the file being written holds the user's other MCP
 * servers and unrelated harness settings, so silently falling back to an
 * empty document would destroy more than UMT's own entries. A `.umt-bak`
 * backup has already been written by the caller, and the message names it.
 */
function parseJsonDocument(text: string, targetPath: string, backupPath: string | undefined): Record<string, unknown> {
  if (text.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Refusing to merge into ${targetPath}: the existing file is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}). ` +
        (backupPath ? `A backup was written to ${backupPath}. ` : "") +
        "Fix or move the file aside, then re-run.",
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, unknown>;
}

function codexTableHeaderRe(name: string): RegExp {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const quoted = `"${escapeTomlString(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`;
  // Match `[mcp_servers.<name>]` or `[mcp_servers."<name>"]` (same table).
  return new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${esc}|${quoted})\\s*\\]\\s*$`, "m");
}

function stripCodexServerBlocks(toml: string, names: readonly string[]): string {
  if (names.length === 0) return toml;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    if (/^\s*\[.*\]\s*$/.test(line)) {
      skipping = names.some((n) => codexTableHeaderRe(n).test(line));
    }
    if (!skipping) out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimStart();
}

export interface TargetWriteResult {
  /** True when servers were merged into an existing file. */
  merged: boolean;
  /** Backup written before modifying an existing file, if one existed. */
  backupPath: string | undefined;
}

/**
 * Write the generated config for a target to `targetPath`, merging the new
 * servers into any existing file instead of clobbering it.
 *
 * - JSON shapes: parse the existing document, merge the incoming servers into
 *   the shape's documented server map (new servers replace only their own
 *   name; every other server and unrelated setting is preserved), and back the
 *   original up to `<file>.umt-bak` first.
 * - Codex (`codex-toml`): drop existing `[mcp_servers.<name>]` tables for the
 *   servers being written, then append fresh tables; all other TOML content is
 *   preserved verbatim. Backup taken first.
 * - A file that exists but is not valid JSON is left untouched: the write is
 *   refused (after the backup) rather than replacing settings UMT cannot read.
 */
export async function writeTargetConfig(
  target: ConfigTarget,
  targetPath: string,
  generatedConfig: GeneratedConfig,
): Promise<TargetWriteResult> {
  const shapeSpec = SHAPE_SPECS[getTargetSpec(target).shape];
  await mkdir(path.dirname(targetPath), { recursive: true });

  const existed = existsSync(targetPath);
  const existingText = existed ? await readFile(targetPath, "utf8") : "";
  let backupPath: string | undefined;
  if (existed) {
    backupPath = `${targetPath}.umt-bak`;
    await copyFile(targetPath, backupPath);
  }

  if (shapeSpec.merge === "toml-block") {
    const names = Object.keys(generatedConfig.mcpServers);
    const stripped = stripCodexServerBlocks(existingText, names).trimEnd();
    const block = emitConfig(generatedConfig, target).trimEnd();
    await writeFile(targetPath, (stripped ? stripped + "\n\n" : "") + block + "\n", "utf8");
    return { merged: existed, backupPath };
  }

  const root = { ...parseJsonDocument(existingText, targetPath, backupPath) };
  const incoming = Object.fromEntries(
    Object.entries(generatedConfig.mcpServers).map(([name, server]) => [name, entryForStyle(shapeSpec.entryStyle, server)]),
  );
  const current = getNestedPath(root, shapeSpec.serverKey) ?? {};
  setNestedPath(root, shapeSpec.serverKey, { ...current, ...incoming });

  await writeFile(targetPath, JSON.stringify(root, null, 2) + "\n", "utf8");
  return { merged: existed, backupPath };
}

/** True if a Codex TOML document already defines the given server. */
export function codexHasServer(toml: string, name: string): boolean {
  return codexTableHeaderRe(name).test(toml);
}

export function getProfilesDirectory(): string {
  return path.join(getStateDirectory(), "profiles");
}

function getProfilePath(name: string): string {
  return path.join(getProfilesDirectory(), `${name}.json`);
}

export async function saveNamedProfile(profile: SavedProfile): Promise<void> {
  const dir = getProfilesDirectory();
  await mkdir(dir, { recursive: true });
  await writeFile(getProfilePath(profile.name), JSON.stringify(profile, null, 2), "utf8");
}

export async function listProfiles(): Promise<SavedProfile[]> {
  const dir = getProfilesDirectory();
  try {
    const entries = await readdir(dir);
    const profiles: SavedProfile[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      try {
        const contents = await readFile(path.join(dir, entry), "utf8");
        const parsed = JSON.parse(contents) as SavedProfile;
        profiles.push(parsed);
      } catch {
        // skip corrupted profile files
      }
    }
    return profiles.sort((a, b) => a.name.localeCompare(b.name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function loadProfile(name: string): Promise<SavedProfile> {
  try {
    const contents = await readFile(getProfilePath(name), "utf8");
    return JSON.parse(contents) as SavedProfile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Profile '${name}' not found.`);
    }
    throw error;
  }
}

export async function deleteProfile(name: string): Promise<void> {
  const profilePath = getProfilePath(name);
  try {
    await rm(profilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Profile '${name}' not found.`);
    }
    throw error;
  }
}

export function getActiveProfilePath(): string {
  return path.join(getStateDirectory(), "active-profile");
}

export async function loadActiveProfile(): Promise<SavedProfile | null> {
  try {
    const activePath = getActiveProfilePath();
    const contents = await readFile(activePath, "utf8");
    const data = JSON.parse(contents);
    if(data.profileName) {
      return await loadProfile(data.profileName);
    }
    return null;
  } catch {
    return null;
  }
}

export async function setActiveProfile(name: string): Promise<void> {
  await mkdir(getStateDirectory(), { recursive: true });
  const activePath = getActiveProfilePath();
  await writeFile(activePath, JSON.stringify({ profileName: name }), "utf8");
}
