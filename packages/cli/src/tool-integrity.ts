/**
 * MCP tool-definition integrity.
 *
 * `umt pin` snapshots the tools a server exposes, `umt audit` compares the
 * current definitions to that baseline and runs static poisoning checks, and
 * `umt diff` shows exactly what drifted.
 *
 * The hash covers the complete definition: name, title, description,
 * inputSchema, outputSchema, annotations, and `_meta`. That is deliberate —
 * a flipped readOnlyHint or a changed schema is as security-relevant as a
 * changed description.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import chalk from "chalk";
import { resolveWorkspaceEntryFile } from "./config-store.js";
import { SERVER_REGISTRY, getRegistryEntry, type ServerRegistryEntry } from "./registry.js";

const IS_WINDOWS = process.platform === "win32";
const DEFAULT_LOCKFILE = "umt.lock.json";
const DEFAULT_TIMEOUT_MS = 15_000;

export type Severity = "critical" | "high" | "medium" | "low";

export interface ToolDefinition {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
  _meta?: unknown;
}

export interface ToolLockEntry {
  hash: string;
  fieldHashes: Record<string, string>;
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  descriptionPreview?: string;
}

export interface ServerLockEntry {
  package: string;
  version: string;
  transport: "stdio";
  serverInfo?: { name?: string; version?: string };
  instructionsHash: string | null;
  tools: Record<string, ToolLockEntry>;
}

export interface UmtLockfile {
  lockfileVersion: 1;
  generatedAt: string;
  generator: string;
  servers: Record<string, ServerLockEntry>;
}

export interface ServerSnapshot {
  tools: ToolDefinition[];
  instructions: string | null;
  serverInfo: { name?: string; version?: string } | null;
  protocolVersion: string | null;
}

export interface Finding {
  id: string;
  severity: Severity;
  server: string;
  message: string;
  tool?: string;
  evidence?: string;
}

export interface ToolDrift {
  server: string;
  tool: string;
  kind: "added" | "removed" | "changed";
  fields: string[];
  beforeHash?: string;
  afterHash?: string;
  beforeDescription?: string;
  afterDescription?: string;
}

export interface ServerDrift {
  server: string;
  kind: "version" | "server-info" | "instructions";
  before: string;
  after: string;
}

export interface IntegrityOptions {
  server?: string[];
  lockfile?: string;
  npx?: boolean;
  force?: boolean;
  json?: boolean;
  strict?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
    return sorted;
  }
  return value;
}

export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value)) ?? "null";
}

export function canonicalTool(tool: ToolDefinition): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? "",
    inputSchema: tool.inputSchema ?? null,
    outputSchema: tool.outputSchema ?? null,
    annotations: tool.annotations ?? null,
    meta: tool._meta ?? null,
  };
}

function hashValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export function hashTool(tool: ToolDefinition): string {
  return hashValue(canonicalTool(tool));
}

export function hashText(text: string | null): string | null {
  return text === null ? null : hashValue(text);
}

export function lockEntryForTool(tool: ToolDefinition): ToolLockEntry {
  const canonical = canonicalTool(tool);
  const fieldHashes: Record<string, string> = {};
  for (const [key, value] of Object.entries(canonical)) {
    fieldHashes[key] = hashValue(value);
  }

  const entry: ToolLockEntry = {
    hash: hashValue(canonical),
    fieldHashes,
  };

  if (tool.title) entry.title = tool.title;
  const readOnly = tool.annotations?.readOnlyHint;
  if (typeof readOnly === "boolean") entry.readOnlyHint = readOnly;
  const destructive = tool.annotations?.destructiveHint;
  if (typeof destructive === "boolean") entry.destructiveHint = destructive;
  if (tool.description) entry.descriptionPreview = tool.description.slice(0, 200);

  return entry;
}

export function snapshotTools(tools: readonly ToolDefinition[]): Record<string, ToolLockEntry> {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const out: Record<string, ToolLockEntry> = {};
  for (const tool of sorted) out[tool.name] = lockEntryForTool(tool);
  return out;
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readPackageVersion(entry: ServerRegistryEntry): Promise<string> {
  try {
    const distPath = resolveWorkspaceEntryFile(entry);
    const pkgPath = path.resolve(distPath, "../../package.json");
    const raw = await readFile(pkgPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (isRecord(parsed) && typeof parsed.version === "string") return parsed.version;
  } catch {
    // fall through
  }
  return "unknown";
}

/** Minimal JSON-RPC client over a stdio MCP server. */
class StdioRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly timeoutMs: number;
  private buffer = "";
  private stderr = "";
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();

  public constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.child = child;
    this.timeoutMs = timeoutMs;

    this.child.stderr.on("data", (data: Buffer) => {
      this.stderr += data.toString();
    });

    this.child.stdout.on("data", (data: Buffer) => {
      this.buffer += data.toString();
      const lines = this.buffer.split("\n");
      this.buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          if (!isRecord(parsed) || typeof parsed.id !== "number") continue;
          const pending = this.pending.get(parsed.id);
          if (!pending) continue;
          clearTimeout(pending.timer);
          this.pending.delete(parsed.id);
          if (parsed.error !== undefined) {
            pending.reject(new Error(JSON.stringify(parsed.error)));
          } else {
            pending.resolve(parsed.result);
          }
        } catch {
          // Servers may write diagnostics to stdout; ignore non-JSON lines.
        }
      }
    });

    this.child.once("exit", (code) => {
      if (this.pending.size > 0) {
        this.failAll(
          new Error(
            `Server exited before completing the handshake (code ${code ?? 1}). ${this.stderr.slice(0, 300)}`,
          ),
        );
      }
    });

    this.child.once("error", (error) => {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    });
  }

  public request(id: number, method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out after ${this.timeoutMs}ms waiting for ${method}. ${this.stderr.slice(0, 300)}`));
      }, this.timeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      try {
        this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  public close(): void {
    this.failAll(new Error("Client closed."));
    try {
      this.child.kill();
    } catch {
      // already exited
    }
  }

  private failAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function normalizeTool(value: unknown): ToolDefinition {
  if (!isRecord(value) || typeof value.name !== "string" || value.name.length === 0) {
    throw new Error("Server returned a tool without a name.");
  }

  const tool: ToolDefinition = { name: value.name };
  if (typeof value.title === "string") tool.title = value.title;
  if (typeof value.description === "string") tool.description = value.description;
  if (value.inputSchema !== undefined) tool.inputSchema = value.inputSchema;
  if (value.outputSchema !== undefined) tool.outputSchema = value.outputSchema;
  if (isRecord(value.annotations)) tool.annotations = value.annotations;
  if (value._meta !== undefined) tool._meta = value._meta;
  return tool;
}

export interface FetchOptions {
  timeoutMs?: number;
  npx?: boolean;
  cliVersion: string;
}

export async function fetchServerSnapshot(
  entry: ServerRegistryEntry,
  options: FetchOptions,
): Promise<ServerSnapshot> {
  const distPath = resolveWorkspaceEntryFile(entry);
  const hasBuild = await fileExists(distPath);
  const useNpx = options.npx === true;

  if (!hasBuild && !useNpx) {
    throw new Error(
      `Build output not found for ${entry.id}: ${distPath}. Run the workspace build, or pass --npx to use the published package.`,
    );
  }

  const command = useNpx ? (IS_WINDOWS ? "npx.cmd" : "npx") : process.execPath;
  const args = useNpx
    ? ["-y", entry.packageName, "--transport", "stdio"]
    : [distPath, "--transport", "stdio"];

  const child = spawn(command, args, {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    windowsHide: IS_WINDOWS,
    shell: useNpx && IS_WINDOWS,
  }) as ChildProcessWithoutNullStreams;

  const client = new StdioRpcClient(child, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const init = await client.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "umt-integrity", version: options.cliVersion },
    });

    const initRecord = isRecord(init) ? init : {};
    const list = await client.request(2, "tools/list", {});
    const listRecord = isRecord(list) ? list : {};

    if (!Array.isArray(listRecord.tools)) {
      throw new Error("tools/list response did not contain a tools array.");
    }

    const info = isRecord(initRecord.serverInfo) ? initRecord.serverInfo : null;
    const serverInfo =
      info === null
        ? null
        : {
            ...(typeof info.name === "string" ? { name: info.name } : {}),
            ...(typeof info.version === "string" ? { version: info.version } : {}),
          };

    return {
      tools: listRecord.tools.map(normalizeTool),
      instructions: typeof initRecord.instructions === "string" ? initRecord.instructions : null,
      serverInfo,
      protocolVersion:
        typeof initRecord.protocolVersion === "string" ? initRecord.protocolVersion : null,
    };
  } finally {
    client.close();
  }
}

export async function createServerLockEntry(
  entry: ServerRegistryEntry,
  snapshot: ServerSnapshot,
): Promise<ServerLockEntry> {
  const lock: ServerLockEntry = {
    package: entry.packageName,
    version: await readPackageVersion(entry),
    transport: "stdio",
    instructionsHash: hashText(snapshot.instructions),
    tools: snapshotTools(snapshot.tools),
  };
  if (snapshot.serverInfo) lock.serverInfo = snapshot.serverInfo;
  return lock;
}

export function validateLockfile(value: unknown): UmtLockfile {
  if (!isRecord(value) || value.lockfileVersion !== 1 || !isRecord(value.servers)) {
    throw new Error("Invalid umt.lock.json: expected lockfileVersion 1 and a servers object.");
  }
  return value as unknown as UmtLockfile;
}

export async function readLockfile(filePath: string): Promise<UmtLockfile | null> {
  try {
    const raw = await readFile(filePath, "utf8");
    return validateLockfile(JSON.parse(raw) as unknown);
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function writeLockfile(filePath: string, lockfile: UmtLockfile): Promise<void> {
  const directory = path.dirname(filePath);
  if (directory !== "." && directory !== "") await mkdir(directory, { recursive: true });
  await writeFile(filePath, `${JSON.stringify(lockfile, null, 2)}\n`, "utf8");
}

function resolveEntries(serverIds?: readonly string[]): ServerRegistryEntry[] {
  if (!serverIds || serverIds.length === 0) return [...SERVER_REGISTRY];
  return serverIds.map((id) => {
    try {
      return getRegistryEntry(id);
    } catch {
      throw new Error(`Unknown server id: ${id}`);
    }
  });
}

function countTools(servers: Record<string, ServerLockEntry>): number {
  return Object.values(servers).reduce((total, server) => total + Object.keys(server.tools).length, 0);
}

export async function runPin(options: IntegrityOptions, cliVersion: string): Promise<void> {
  const entries = resolveEntries(options.server);
  const lockfilePath = path.resolve(options.lockfile ?? DEFAULT_LOCKFILE);
  const existing = options.force ? null : await readLockfile(lockfilePath);
  const servers: Record<string, ServerLockEntry> = { ...(existing?.servers ?? {}) };
  const failures: Array<{ server: string; error: string }> = [];

  for (const entry of entries) {
    try {
      const snapshot = await fetchServerSnapshot(entry, {
        ...(options.npx === true ? { npx: true } : {}),
        cliVersion,
      });
      servers[entry.id] = await createServerLockEntry(entry, snapshot);
    } catch (error) {
      failures.push({
        server: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const lockfile: UmtLockfile = {
    lockfileVersion: 1,
    generatedAt: new Date().toISOString(),
    generator: `umt@${cliVersion}`,
    servers: sortRecord(servers),
  };

  const pinnedServers = Object.keys(lockfile.servers).length;
  if (pinnedServers > 0) await writeLockfile(lockfilePath, lockfile);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          lockfile: lockfilePath,
          servers: pinnedServers,
          tools: countTools(lockfile.servers),
          failures,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(chalk.bold(`\nPinned ${pinnedServers} server(s), ${countTools(lockfile.servers)} tool(s).`));
    console.log(chalk.gray(`Lockfile: ${lockfilePath}`));
    for (const failure of failures) {
      console.log(`${chalk.red("FAIL")} ${failure.server}  ${failure.error}`);
    }
    if (failures.length === 0) {
      console.log(chalk.gray("\nNext: run `umt audit` before you trust the server list."));
    } else {
      console.log(chalk.yellow(`\n${failures.length} server(s) could not be pinned.`));
    }
  }

  if (failures.length > 0) process.exitCode = 1;
}

const INVISIBLE_UNICODE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;
const INJECTION_PATTERNS: Array<{ id: string; severity: Severity; message: string; pattern: RegExp }> = [
  {
    id: "UMT-002",
    severity: "high",
    message: "Tool text contains a prompt-injection phrase.",
    pattern: /ignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above)\s+(instructions?|prompts?|rules?)/i,
  },
  {
    id: "UMT-002",
    severity: "high",
    message: "Tool text asks the model to disregard prior instructions.",
    pattern: /disregard\s+(all\s+|any\s+|the\s+)?(previous|prior|above|system)/i,
  },
  {
    id: "UMT-002",
    severity: "high",
    message: "Tool text refers to a system prompt.",
    pattern: /\bsystem\s+prompt\b/i,
  },
  {
    id: "UMT-003",
    severity: "high",
    message: "Tool text asks the model to conceal behavior from the user.",
    pattern: /\b(do\s+not|don't|never)\s+(tell|inform|mention|reveal|alert|notify)\s+(the\s+)?(user|human)\b/i,
  },
  {
    id: "UMT-003",
    severity: "high",
    message: "Tool text asks the model to hide behavior from the user.",
    pattern: /\bhide\s+(this|it|the\s+\w+)\s+from\s+(the\s+)?(user|human)\b/i,
  },
];

const CREDENTIAL_PATHS =
  /(~\/\.ssh|id_rsa|\.aws\/credentials|\.config\/gcloud|keychain|credentials\.json|process\.env)/i;
const WRITE_VERB =
  /\b(create|update|delete|remove|send|post|write|run|execute|deploy|merge|archive|close|pay|refund|cancel|invite|upload|publish|modify|set|add|patch|put)\b/i;
const DESTRUCTIVE_VERB =
  /\b(delete|remove|destroy|purge|drop|truncate|revoke|refund|cancel|archive|overwrite)\b/i;

function pushFinding(
  findings: Finding[],
  id: string,
  severity: Severity,
  server: string,
  message: string,
  extra: { tool?: string | undefined; evidence?: string | undefined } = {},
): void {
  const finding: Finding = { id, severity, server, message };
  if (extra.tool) finding.tool = extra.tool;
  if (extra.evidence) finding.evidence = extra.evidence;
  findings.push(finding);
}

function scanText(
  findings: Finding[],
  server: string,
  text: string,
  tool?: string,
): void {
  if (INVISIBLE_UNICODE.test(text)) {
    pushFinding(
      findings,
      "UMT-001",
      "high",
      server,
      "Text contains invisible or bidirectional Unicode characters.",
      { tool, evidence: text.slice(0, 120) },
    );
  }

  for (const rule of INJECTION_PATTERNS) {
    if (rule.pattern.test(text)) {
      pushFinding(findings, rule.id, rule.severity, server, rule.message, {
        tool,
        evidence: text.slice(0, 160),
      });
    }
  }

  if (CREDENTIAL_PATHS.test(text)) {
    pushFinding(
      findings,
      "UMT-004",
      "medium",
      server,
      "Text references credential files or environment variables.",
      { tool, evidence: text.slice(0, 160) },
    );
  }
}

export function scanTool(
  tool: ToolDefinition,
  server: string,
  toolOwners: ReadonlyMap<string, ReadonlySet<string>>,
): Finding[] {
  const findings: Finding[] = [];
  const text = [tool.name, tool.title ?? "", tool.description ?? ""].join("\n");
  scanText(findings, server, text, tool.name);

  if (tool.description) {
    for (const name of toolOwners.keys()) {
      if (name === tool.name || name.length < 5) continue;
      if (!/[-_]/.test(name)) continue;
      const owners = toolOwners.get(name);
      if (!owners || ![...owners].some((owner) => owner !== server)) continue;
      if (tool.description.includes(name)) {
        pushFinding(
          findings,
          "UMT-005",
          "medium",
          server,
          `Tool description references a tool from another server (${name}); check for cross-server shadowing.`,
          { tool: tool.name, evidence: tool.description.slice(0, 160) },
        );
        break;
      }
    }
  }

  const readOnly = tool.annotations?.readOnlyHint;
  const destructive = tool.annotations?.destructiveHint;
  const nameText = tool.name.replace(/[_-]+/g, " ");

  if (readOnly === true && WRITE_VERB.test(nameText)) {
    pushFinding(
      findings,
      "UMT-007",
      "high",
      server,
      "Tool is marked readOnlyHint but its name looks write-capable.",
      { tool: tool.name },
    );
  }

  if (destructive === false && DESTRUCTIVE_VERB.test(nameText)) {
    pushFinding(
      findings,
      "UMT-007",
      "high",
      server,
      "Tool is marked destructiveHint: false but its name looks destructive.",
      { tool: tool.name },
    );
  }

  if (readOnly === undefined && WRITE_VERB.test(nameText)) {
    pushFinding(
      findings,
      "UMT-007",
      "low",
      server,
      "Write-capable tool has no readOnlyHint annotation.",
      { tool: tool.name },
    );
  }

  const schema = isRecord(tool.inputSchema) ? tool.inputSchema : null;
  if (schema && schema.type === "object") {
    if (schema.additionalProperties !== false) {
      pushFinding(
        findings,
        "UMT-008",
        "low",
        server,
        "inputSchema does not set additionalProperties: false.",
        { tool: tool.name },
      );
    }
    const properties = schema.properties;
    if (isRecord(properties) && Object.keys(properties).length > 0) {
      const required = schema.required;
      if (!Array.isArray(required) || required.length === 0) {
        pushFinding(
          findings,
          "UMT-009",
          "low",
          server,
          "inputSchema declares properties but no required fields.",
          { tool: tool.name },
        );
      }
    }
  }

  return findings;
}

export function scanInstructions(instructions: string, server: string): Finding[] {
  const findings: Finding[] = [];
  scanText(findings, server, instructions);
  return findings;
}

export function compareServerTools(
  server: string,
  lockedTools: Record<string, ToolLockEntry>,
  currentTools: readonly ToolDefinition[],
): ToolDrift[] {
  const current = new Map(currentTools.map((tool) => [tool.name, tool]));
  const drift: ToolDrift[] = [];

  for (const [name, locked] of Object.entries(lockedTools)) {
    const tool = current.get(name);
    if (!tool) {
      drift.push({
        server,
        tool: name,
        kind: "removed",
        fields: [],
        beforeHash: locked.hash,
        ...(locked.descriptionPreview ? { beforeDescription: locked.descriptionPreview } : {}),
      });
      continue;
    }

    const next = lockEntryForTool(tool);
    if (next.hash === locked.hash) continue;

    const fields = new Set([...Object.keys(locked.fieldHashes), ...Object.keys(next.fieldHashes)]);
    const changed = [...fields].filter(
      (field) => locked.fieldHashes[field] !== next.fieldHashes[field],
    );

    drift.push({
      server,
      tool: name,
      kind: "changed",
      fields: changed,
      beforeHash: locked.hash,
      afterHash: next.hash,
      ...(locked.descriptionPreview ? { beforeDescription: locked.descriptionPreview } : {}),
      ...(tool.description ? { afterDescription: tool.description.slice(0, 200) } : {}),
    });
  }

  for (const tool of currentTools) {
    if (Object.prototype.hasOwnProperty.call(lockedTools, tool.name)) continue;
    drift.push({
      server,
      tool: tool.name,
      kind: "added",
      fields: [],
      afterHash: hashTool(tool),
      ...(tool.description ? { afterDescription: tool.description.slice(0, 200) } : {}),
    });
  }

  return drift;
}

export function compareServerMeta(
  server: string,
  locked: ServerLockEntry,
  snapshot: ServerSnapshot,
  currentVersion: string,
): ServerDrift[] {
  const drift: ServerDrift[] = [];

  if (locked.version !== currentVersion) {
    drift.push({
      server,
      kind: "version",
      before: locked.version,
      after: currentVersion,
    });
  }

  const beforeInfo = stableStringify(locked.serverInfo ?? null);
  const afterInfo = stableStringify(snapshot.serverInfo);
  if (beforeInfo !== afterInfo) {
    drift.push({ server, kind: "server-info", before: beforeInfo, after: afterInfo });
  }

  const beforeInstructions = locked.instructionsHash ?? null;
  const afterInstructions = hashText(snapshot.instructions);
  if (beforeInstructions !== afterInstructions) {
    drift.push({
      server,
      kind: "instructions",
      before: beforeInstructions ?? "(none)",
      after: afterInstructions ?? "(none)",
    });
  }

  return drift;
}

function driftToFindings(drift: ToolDrift): Finding[] {
  const findings: Finding[] = [];
  if (drift.kind === "changed") {
    pushFinding(
      findings,
      "UMT-010",
      "critical",
      drift.server,
      `Tool definition changed since pin (possible rug pull): ${drift.fields.join(", ")}.`,
      { tool: drift.tool, evidence: `${drift.beforeHash ?? "?"} -> ${drift.afterHash ?? "?"}` },
    );
  } else if (drift.kind === "added") {
    pushFinding(findings, "UMT-011", "medium", drift.server, "Tool was added since pin.", {
      tool: drift.tool,
    });
  } else {
    pushFinding(findings, "UMT-012", "medium", drift.server, "Tool was removed since pin.", {
      tool: drift.tool,
    });
  }
  return findings;
}

function serverDriftToFindings(drift: ServerDrift): Finding[] {
  if (drift.kind === "instructions") {
    return [
      {
        id: "UMT-013",
        severity: "high",
        server: drift.server,
        message: "Server instructions changed since pin.",
        evidence: `${drift.before} -> ${drift.after}`,
      },
    ];
  }
  if (drift.kind === "version") {
    return [
      {
        id: "UMT-014",
        severity: "medium",
        server: drift.server,
        message: "Server package version changed since pin.",
        evidence: `${drift.before} -> ${drift.after}`,
      },
    ];
  }
  return [
    {
      id: "UMT-017",
      severity: "medium",
      server: drift.server,
      message: "Server identity (serverInfo) changed since pin.",
      evidence: `${drift.before} -> ${drift.after}`,
    },
  ];
}

function severityRank(severity: Severity): number {
  return { critical: 0, high: 1, medium: 2, low: 3 }[severity];
}

function renderFinding(finding: Finding): void {
  const label =
    finding.severity === "critical"
      ? chalk.bgRed.white(" CRITICAL ")
      : finding.severity === "high"
        ? chalk.red("HIGH")
        : finding.severity === "medium"
          ? chalk.yellow("MEDIUM")
          : chalk.gray("LOW");

  const target = finding.tool ? `${finding.server}/${finding.tool}` : finding.server;
  console.log(`${label} ${chalk.bold(target)}  ${chalk.gray(finding.id)}`);
  console.log(`  ${finding.message}`);
  if (finding.evidence) console.log(chalk.gray(`  ${finding.evidence}`));
}

export async function runAudit(options: IntegrityOptions, cliVersion: string): Promise<void> {
  const lockfilePath = path.resolve(options.lockfile ?? DEFAULT_LOCKFILE);
  const lockfile = await readLockfile(lockfilePath);
  const findings: Finding[] = [];

  let entries: ServerRegistryEntry[];
  if (options.server?.length) {
    entries = resolveEntries(options.server);
  } else if (lockfile) {
    entries = Object.keys(lockfile.servers).flatMap((id) => {
      try {
        return [getRegistryEntry(id)];
      } catch {
        pushFinding(findings, "UMT-016", "high", id, "Server from the lockfile is not in the registry.");
        return [];
      }
    });
  } else {
    entries = [...SERVER_REGISTRY];
    pushFinding(
      findings,
      "UMT-018",
      "low",
      "(lockfile)",
      "No lockfile found; running static checks only. Run `umt pin` to enable drift detection.",
    );
  }

  const snapshots = new Map<string, ServerSnapshot>();
  for (const entry of entries) {
    try {
      const snapshot = await fetchServerSnapshot(entry, { ...(options.npx === true ? { npx: true } : {}), cliVersion });
      snapshots.set(entry.id, snapshot);
    } catch (error) {
      pushFinding(
        findings,
        "UMT-016",
        "high",
        entry.id,
        `Could not audit server: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  const toolOwners = new Map<string, Set<string>>();
  for (const [serverId, snapshot] of snapshots) {
    for (const tool of snapshot.tools) {
      const owners = toolOwners.get(tool.name) ?? new Set<string>();
      owners.add(serverId);
      toolOwners.set(tool.name, owners);
    }
  }

  for (const [toolName, owners] of toolOwners) {
    if (owners.size < 2) continue;
    for (const serverId of owners) {
      const others = [...owners].filter((owner) => owner !== serverId).join(", ");
      pushFinding(
        findings,
        "UMT-006",
        "high",
        serverId,
        `Duplicate tool name also exposed by ${others}; possible shadowing.`,
        { tool: toolName },
      );
    }
  }

  for (const [serverId, snapshot] of snapshots) {
    for (const tool of snapshot.tools) {
      findings.push(...scanTool(tool, serverId, toolOwners));
    }

    if (snapshot.instructions) {
      findings.push(...scanInstructions(snapshot.instructions, serverId));
    }

    const locked = lockfile?.servers[serverId];
    if (!locked) continue;

    const version = await readPackageVersion(getRegistryEntry(serverId));
    findings.push(
      ...compareServerMeta(serverId, locked, snapshot, version).flatMap(serverDriftToFindings),
    );
    findings.push(...compareServerTools(serverId, locked.tools, snapshot.tools).flatMap(driftToFindings));
  }

  findings.sort((a, b) => severityRank(a.severity) - severityRank(b.severity));

  if (options.json) {
    const summary = {
      critical: findings.filter((f) => f.severity === "critical").length,
      high: findings.filter((f) => f.severity === "high").length,
      medium: findings.filter((f) => f.severity === "medium").length,
      low: findings.filter((f) => f.severity === "low").length,
    };
    console.log(JSON.stringify({ lockfile: lockfilePath, summary, findings }, null, 2));
  } else {
    console.log(chalk.bold(`\nAudit: ${lockfile ? lockfilePath : "static checks only"}`));
    if (findings.length === 0) {
      console.log(chalk.green("\nNo findings. The pinned definitions match and no static risks were detected."));
    } else {
      for (const finding of findings) renderFinding(finding);
      const counts = {
        critical: findings.filter((f) => f.severity === "critical").length,
        high: findings.filter((f) => f.severity === "high").length,
        medium: findings.filter((f) => f.severity === "medium").length,
        low: findings.filter((f) => f.severity === "low").length,
      };
      console.log(
        chalk.gray(
          `\n${counts.critical} critical, ${counts.high} high, ${counts.medium} medium, ${counts.low} low.`,
        ),
      );
    }
  }

  const blocking = findings.some(
    (finding) => finding.severity === "critical" || finding.severity === "high",
  );
  const strictBlocking = options.strict === true && findings.length > 0;
  if (blocking || strictBlocking) process.exitCode = 1;
}

export async function runDiff(options: IntegrityOptions, cliVersion: string): Promise<void> {
  const lockfilePath = path.resolve(options.lockfile ?? DEFAULT_LOCKFILE);
  const lockfile = await readLockfile(lockfilePath);
  if (!lockfile) {
    console.error(chalk.red(`No lockfile found at ${lockfilePath}. Run \`umt pin\` first.`));
    process.exitCode = 1;
    return;
  }

  const failures: Array<{ server: string; error: string }> = [];
  const entries = options.server?.length
    ? resolveEntries(options.server)
    : Object.keys(lockfile.servers).flatMap((id) => {
        try {
          return [getRegistryEntry(id)];
        } catch {
          failures.push({ server: id, error: "Server from the lockfile is not in the registry." });
          return [];
        }
      });

  const toolDrift: ToolDrift[] = [];
  const serverDrift: ServerDrift[] = [];

  for (const entry of entries) {
    const locked = lockfile.servers[entry.id];
    if (!locked) continue;
    try {
      const snapshot = await fetchServerSnapshot(entry, { ...(options.npx === true ? { npx: true } : {}), cliVersion });
      const version = await readPackageVersion(entry);
      serverDrift.push(...compareServerMeta(entry.id, locked, snapshot, version));
      toolDrift.push(...compareServerTools(entry.id, locked.tools, snapshot.tools));
    } catch (error) {
      failures.push({
        server: entry.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ lockfile: lockfilePath, serverDrift, toolDrift, failures }, null, 2));
  } else {
    console.log(chalk.bold(`\nDrift: ${lockfilePath}`));
    for (const change of serverDrift) {
      console.log(
        `${chalk.yellow("~")} ${change.server}  ${change.kind}  ${chalk.gray(`${change.before} -> ${change.after}`)}`,
      );
    }
    for (const change of toolDrift) {
      const marker =
        change.kind === "added" ? chalk.green("+") : change.kind === "removed" ? chalk.red("-") : chalk.yellow("~");
      console.log(`${marker} ${change.server}/${change.tool}  ${change.kind}`);
      if (change.fields.length > 0) {
        console.log(chalk.gray(`  fields: ${change.fields.join(", ")}`));
      }
      if (change.beforeHash && change.afterHash) {
        console.log(chalk.gray(`  hash: ${change.beforeHash} -> ${change.afterHash}`));
      }
      if (change.beforeDescription !== undefined || change.afterDescription !== undefined) {
        console.log(chalk.gray(`  before: ${change.beforeDescription ?? "(none)"}`));
        console.log(chalk.gray(`  after:  ${change.afterDescription ?? "(none)"}`));
      }
    }
    for (const failure of failures) {
      console.log(`${chalk.red("FAIL")} ${failure.server}  ${failure.error}`);
    }
    if (serverDrift.length === 0 && toolDrift.length === 0 && failures.length === 0) {
      console.log(chalk.green("\nNo drift. The current definitions match the lockfile."));
    }
  }

  if (serverDrift.length > 0 || toolDrift.length > 0 || failures.length > 0) {
    process.exitCode = 1;
  }
}
