/**
 * Agent Plugins 1.0 trust model — the `audit` side of `umt plugin`.
 *
 * The Agent Plugins 1.0 spec defines the package layout but no trust model:
 * a plugin directory is just files, and installing one hands the client
 * executable server configs plus Markdown the agent will read. `umt plugin
 * audit` closes that gap with a deterministic, dependency-free static scan
 * of a plugin package directory:
 *
 * - **Path containment** — no `../` escapes, no absolute paths in configs,
 *   no symlinks resolving outside the package root.
 * - **No secrets** — env values, headers, args, and skill bodies are scanned
 *   against deterministic secret shapes. The spec forbids credentials in
 *   `env`/`headers`; only `${VAR_NAME}` client-managed placeholders pass.
 * - **Component isolation** — skills live at `skills/<name>/SKILL.md`
 *   (immediate children only); a skill may not smuggle extra server entries
 *   (`mcpServers` blocks, `mcp.json`/`plugin.json` inside a skill dir), and
 *   executable bits anywhere in the package are flagged.
 * - **Schema checks** — `plugin.json`/`mcp.json` are validated against the
 *   spec's structural rules (`$schema` const, name pattern, known server
 *   types, stdio `command` single-token + plugin-relative, http(s) URLs with
 *   loopback-only http, no portable OAuth fields expected).
 *
 * Findings have severities: `error` findings fail the audit (non-zero exit);
 * `warning` findings are reported but pass (e.g. unknown `plugin.json`
 * fields, which the spec says clients must report and ignore, or the
 * deprecated `sse` server type). `--json` emits the machine-readable result.
 *
 * Heuristic limits (be honest): the secret scan is shape-based, not
 * entropy-based — a novel token format it doesn't know will pass, and the
 * credential-assignment pattern can only catch `key = value` shapes. The
 * schema checks encode spec 1.0.0 as understood from the published schemas;
 * if the spec drifts, the `$schema` consts in `plugin-pack.ts` are the single
 * place to update.
 */

import { readdir, readFile, lstat, readlink } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_SCHEMA_URL, MCP_SCHEMA_URL, PLUGIN_NAME_PATTERN, PLUGIN_NAME_MAX_LENGTH } from "./plugin-pack.js";

export type AuditSeverity = "error" | "warning";

export interface AuditFinding {
  severity: AuditSeverity;
  /** Machine-readable code, e.g. `schema/plugin-name-invalid`. */
  code: string;
  /** Path relative to the package root (`""` for package-level findings). */
  path: string;
  message: string;
}

export interface AuditResult {
  /** Absolute path of the audited package root. */
  root: string;
  /** True when there are no `error` findings. */
  ok: boolean;
  errors: AuditFinding[];
  warnings: AuditFinding[];
}

/** A `${VAR_NAME}` placeholder: a client-managed reference, never a secret. */
export const ENV_PLACEHOLDER_PATTERN = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

interface SecretShape {
  name: string;
  pattern: RegExp;
}

/**
 * Deterministic secret shapes. Each pattern targets a known token format or
 * an explicit credential assignment — no entropy heuristics, so results are
 * stable run to run. `${VAR}` placeholders are excluded before matching.
 */
const SECRET_SHAPES: SecretShape[] = [
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "anthropic-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { name: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b/ },
  { name: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "google-api-key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "gitlab-token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { name: "private-key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
  {
    name: "bearer-credentials",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/,
  },
  {
    name: "credential-assignment",
    // e.g. api_key: "abc...", password=secret123 — key-ish name, `:`/`=`, value.
    pattern:
      /\b(?:api[_-]?key|api[_-]?secret|secret[_-]?key|client[_-]?secret|password|passwd|auth[_-]?token|access[_-]?token|refresh[_-]?token)\b\s*[:=]\s*['"]?([A-Za-z0-9._~+/=-]{12,})['"]?/i,
  },
];

/**
 * Return the matched secret-shape name when `value` looks like a credential,
 * or `null` when it is clean. Pure `${VAR_NAME}` placeholders always pass —
 * they are references, not values.
 */
export function detectSecret(value: string): string | null {
  if (typeof value !== "string" || value.length === 0) return null;
  if (ENV_PLACEHOLDER_PATTERN.test(value.trim())) return null;
  for (const shape of SECRET_SHAPES) {
    if (shape.pattern.test(value)) return shape.name;
  }
  return null;
}

const KNOWN_PLUGIN_FIELDS = new Set([
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
]);

const KNOWN_MCP_SERVER_TYPES = new Set(["stdio", "streamable-http", "sse"]);

const KNOWN_MCP_SERVER_FIELDS: Record<string, Set<string>> = {
  stdio: new Set(["type", "command", "args", "env", "cwd"]),
  "streamable-http": new Set(["type", "url", "headers"]),
  sse: new Set(["type", "url", "headers"]),
};

/** Root-level members a spec-conformant package may contain. */
const KNOWN_ROOT_FILES = new Set(["plugin.json", "mcp.json", ".mcp.json", "license", "license.md", "readme", "readme.md"]);
const KNOWN_ROOT_DIRS = new Set(["skills", ".claude-plugin"]);
const REVERSE_DOMAIN_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;

const SEMVER_PATTERN = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;

function isAbsolutePath(p: string): boolean {
  return path.isAbsolute(p) || /^[a-zA-Z]:[\\/]/.test(p);
}

function err(code: string, relPath: string, message: string): AuditFinding {
  return { severity: "error", code, path: relPath, message };
}

function warn(code: string, relPath: string, message: string): AuditFinding {
  return { severity: "warning", code, path: relPath, message };
}

async function readJsonFile(absPath: string): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (error) {
    return { ok: false, error: `Cannot read file: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, error: `Invalid JSON: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Recursively collect every string value in a JSON structure with its JSON-pointer-ish location. */
function collectStrings(value: unknown, at: string, out: Array<{ at: string; value: string }>): void {
  if (typeof value === "string") {
    out.push({ at, value });
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => collectStrings(item, `${at}[${i}]`, out));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      collectStrings(item, at ? `${at}.${key}` : key, out);
    }
  }
}

function auditPluginJson(manifest: unknown, findings: AuditFinding[]): void {
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) {
    findings.push(err("schema/plugin-not-object", "plugin.json", "plugin.json must be a JSON object."));
    return;
  }
  const doc = manifest as Record<string, unknown>;

  if (doc.$schema === undefined) {
    findings.push(err("schema/plugin-schema-missing", "plugin.json", "plugin.json is missing required `$schema`."));
  } else if (doc.$schema !== PLUGIN_SCHEMA_URL) {
    findings.push(
      err(
        "schema/plugin-schema-mismatch",
        "plugin.json",
        `plugin.json \`$schema\` must be exactly '${PLUGIN_SCHEMA_URL}'.`,
      ),
    );
  }

  const name = doc.name;
  if (typeof name !== "string" || name.length === 0) {
    findings.push(err("schema/plugin-name-missing", "plugin.json", "plugin.json requires a `name` field."));
  } else if (name.length > PLUGIN_NAME_MAX_LENGTH || !PLUGIN_NAME_PATTERN.test(name)) {
    findings.push(
      err(
        "schema/plugin-name-invalid",
        "plugin.json",
        `Invalid plugin name '${name}': 1–64 lowercase chars, letters/digits/'.'/'-' only.`,
      ),
    );
  }

  for (const key of Object.keys(doc)) {
    if (!KNOWN_PLUGIN_FIELDS.has(key)) {
      // The spec says unknown top-level fields are reported and ignored — not fatal.
      findings.push(
        warn("schema/plugin-unknown-field", "plugin.json", `Unknown top-level field '${key}' will be ignored by clients.`),
      );
    }
  }

  if (doc.version !== undefined) {
    if (typeof doc.version !== "string" || doc.version.length === 0) {
      findings.push(err("schema/plugin-version-invalid", "plugin.json", "`version` must be a non-empty string."));
    } else if (!SEMVER_PATTERN.test(doc.version)) {
      findings.push(
        warn("schema/plugin-version-not-semver", "plugin.json", `\`version\` '${doc.version}' is not semver-shaped.`),
      );
    }
  }

  if (doc.description !== undefined && typeof doc.description !== "string") {
    findings.push(err("schema/plugin-description-invalid", "plugin.json", "`description` must be a string."));
  }

  if (doc.author !== undefined) {
    if (doc.author === null || typeof doc.author !== "object" || Array.isArray(doc.author)) {
      findings.push(err("schema/plugin-author-invalid", "plugin.json", "`author` must be an object."));
    } else {
      for (const field of ["name", "email", "url"]) {
        const v = (doc.author as Record<string, unknown>)[field];
        if (v !== undefined && typeof v !== "string") {
          findings.push(err("schema/plugin-author-invalid", "plugin.json", `\`author.${field}\` must be a string.`));
        }
      }
    }
  }

  for (const field of ["homepage", "repository"]) {
    const v = doc[field];
    if (v !== undefined) {
      if (typeof v !== "string") {
        findings.push(err("schema/plugin-url-invalid", "plugin.json", `\`${field}\` must be a string.`));
      } else if (!/^https?:\/\//.test(v)) {
        findings.push(warn("schema/plugin-url-not-http", "plugin.json", `\`${field}\` '${v}' is not an http(s) URL.`));
      }
    }
  }

  if (doc.license !== undefined && typeof doc.license !== "string") {
    findings.push(err("schema/plugin-license-invalid", "plugin.json", "`license` must be a string."));
  }

  if (doc.keywords !== undefined) {
    if (!Array.isArray(doc.keywords) || doc.keywords.some((k) => typeof k !== "string")) {
      findings.push(err("schema/plugin-keywords-invalid", "plugin.json", "`keywords` must be an array of strings."));
    }
  }

  if (doc.extensions !== undefined && (doc.extensions === null || typeof doc.extensions !== "object" || Array.isArray(doc.extensions))) {
    findings.push(err("schema/plugin-extensions-invalid", "plugin.json", "`extensions` must be an object keyed by namespace."));
  }

  // Defense in depth: prose fields should never carry credential-shaped text.
  const strings: Array<{ at: string; value: string }> = [];
  collectStrings(doc, "", strings);
  for (const { at, value } of strings) {
    const shape = detectSecret(value);
    if (shape) {
      findings.push(
        err("secret/plugin-manifest", "plugin.json", `Possible ${shape} secret in plugin.json at '${at || "<root>"}'.`),
      );
    }
  }
}

/**
 * Resolve a plugin-relative path (e.g. a stdio `cwd`) against the package
 * root. Returns the resolved absolute path, or `null` when the value escapes
 * the root or is otherwise unusable.
 */
function resolveContained(root: string, relPath: string): string | null {
  // The spec interpolates ${PLUGIN_ROOT} / ${PLUGIN_DATA} in cwd; strip the
  // root anchor before resolving — what matters is the remainder stays inside.
  const stripped = relPath.replace(/^\$\{(?:PLUGIN_ROOT|PLUGIN_DATA)\}/, "").replace(/^[\\/]+/, "");
  const resolved = path.resolve(root, stripped);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

function auditMcpServerConfig(
  key: string,
  server: unknown,
  root: string,
  relFile: string,
  findings: AuditFinding[],
): void {
  const at = `${relFile}#/mcpServers/${key}`;
  if (server === null || typeof server !== "object" || Array.isArray(server)) {
    findings.push(err("schema/mcp-server-not-object", relFile, `Server '${key}' must be an object (${at}).`));
    return;
  }
  const cfg = server as Record<string, unknown>;
  const type = cfg.type;

  if (typeof type !== "string" || !KNOWN_MCP_SERVER_TYPES.has(type)) {
    findings.push(
      err(
        "schema/mcp-server-type-invalid",
        relFile,
        `Server '${key}' has invalid type '${String(type)}' — expected stdio, streamable-http, or sse.`,
      ),
    );
    return;
  }

  if (type === "sse") {
    findings.push(
      warn("schema/mcp-server-type-deprecated", relFile, `Server '${key}' uses deprecated 'sse' transport.`),
    );
  }

  for (const field of Object.keys(cfg)) {
    if (!KNOWN_MCP_SERVER_FIELDS[type]!.has(field)) {
      findings.push(warn("schema/mcp-server-unknown-field", relFile, `Server '${key}' has unknown field '${field}'.`));
    }
  }

  if (type === "stdio") {
    const command = cfg.command;
    if (typeof command !== "string" || command.length === 0) {
      findings.push(err("schema/mcp-stdio-command-missing", relFile, `Server '${key}': stdio requires a 'command'.`));
    } else {
      if (/\s/.test(command)) {
        findings.push(
          err(
            "schema/mcp-stdio-command-multi-token",
            relFile,
            `Server '${key}': 'command' must be a single token, no shell (got '${command}').`,
          ),
        );
      }
      if (isAbsolutePath(command)) {
        findings.push(
          err(
            "path/mcp-stdio-command-absolute",
            relFile,
            `Server '${key}': 'command' must not be an absolute path (got '${command}').`,
          ),
        );
      }
      if (command.split(/[\\/]/).includes("..")) {
        findings.push(
          err("path/mcp-stdio-command-escape", relFile, `Server '${key}': 'command' must not contain '..' segments.`),
        );
      }
    }

    if (cfg.args !== undefined) {
      if (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== "string")) {
        findings.push(err("schema/mcp-stdio-args-invalid", relFile, `Server '${key}': 'args' must be an array of strings.`));
      }
    }

    if (cfg.env !== undefined) {
      if (cfg.env === null || typeof cfg.env !== "object" || Array.isArray(cfg.env)) {
        findings.push(err("schema/mcp-stdio-env-invalid", relFile, `Server '${key}': 'env' must be an object.`));
      } else {
        for (const [name, value] of Object.entries(cfg.env as Record<string, unknown>)) {
          if (typeof value !== "string") {
            findings.push(
              err("schema/mcp-stdio-env-invalid", relFile, `Server '${key}': env value for '${name}' must be a string.`),
            );
            continue;
          }
          const shape = detectSecret(value);
          if (shape) {
            findings.push(
              err(
                "secret/mcp-env",
                relFile,
                `Server '${key}': env '${name}' looks like a ${shape} secret — the spec forbids credentials in env (use a \${${name}} placeholder).`,
              ),
            );
          }
        }
      }
    }

    if (cfg.cwd !== undefined) {
      if (typeof cfg.cwd !== "string" || cfg.cwd.length === 0) {
        findings.push(err("schema/mcp-stdio-cwd-invalid", relFile, `Server '${key}': 'cwd' must be a non-empty string.`));
      } else {
        // The spec interpolates ${PLUGIN_ROOT} / ${PLUGIN_DATA} in cwd — an
        // anchor followed by a plugin-relative remainder is allowed.
        const anchored = /^\$\{(?:PLUGIN_ROOT|PLUGIN_DATA)\}/.test(cfg.cwd);
        if (!anchored && isAbsolutePath(cfg.cwd)) {
          findings.push(
            err("path/mcp-stdio-cwd-absolute", relFile, `Server '${key}': 'cwd' must be plugin-relative (got '${cfg.cwd}').`),
          );
        } else if (resolveContained(root, cfg.cwd) === null) {
          findings.push(
            err("path/mcp-stdio-cwd-escape", relFile, `Server '${key}': 'cwd' escapes the plugin root (got '${cfg.cwd}').`),
          );
        }
      }
    }
  } else {
    // streamable-http / sse
    const url = cfg.url;
    if (typeof url !== "string" || url.length === 0) {
      findings.push(err("schema/mcp-http-url-missing", relFile, `Server '${key}': '${type}' requires a 'url'.`));
    } else {
      let parsed: URL | null = null;
      try {
        parsed = new URL(url);
      } catch {
        parsed = null;
      }
      if (!parsed) {
        findings.push(err("schema/mcp-http-url-invalid", relFile, `Server '${key}': 'url' is not a valid URL.`));
      } else {
        const host = parsed.hostname.toLowerCase();
        const isLoopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
        if (parsed.protocol === "https:") {
          // fine
        } else if (parsed.protocol === "http:" && isLoopback) {
          // fine — spec allows loopback http
        } else {
          findings.push(
            err(
              "schema/mcp-http-url-insecure",
              relFile,
              `Server '${key}': remote URL must be https (loopback http allowed); got '${url}'.`,
            ),
          );
        }
      }
    }

    if (cfg.headers !== undefined) {
      if (cfg.headers === null || typeof cfg.headers !== "object" || Array.isArray(cfg.headers)) {
        findings.push(err("schema/mcp-http-headers-invalid", relFile, `Server '${key}': 'headers' must be an object.`));
      } else {
        for (const [name, value] of Object.entries(cfg.headers as Record<string, unknown>)) {
          if (typeof value !== "string") {
            findings.push(
              err("schema/mcp-http-headers-invalid", relFile, `Server '${key}': header '${name}' must be a string.`),
            );
            continue;
          }
          const shape = detectSecret(value);
          if (shape) {
            findings.push(
              err(
                "secret/mcp-headers",
                relFile,
                `Server '${key}': header '${name}' looks like a ${shape} secret — the spec forbids credentials in headers.`,
              ),
            );
          }
        }
      }
    }
  }

  // Catch-all: any other string in the server config with a secret shape.
  const strings: Array<{ at: string; value: string }> = [];
  collectStrings(cfg, "", strings);
  for (const { at: loc, value } of strings) {
    if (loc === "env" || loc.startsWith("env.") || loc === "headers" || loc.startsWith("headers.")) continue; // already reported
    const shape = detectSecret(value);
    if (shape) {
      findings.push(
        err("secret/mcp-config", relFile, `Server '${key}': possible ${shape} secret at '${loc}'.`),
      );
    }
  }
}

function auditMcpJson(doc: unknown, relFile: string, root: string, findings: AuditFinding[]): void {
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    findings.push(err("schema/mcp-not-object", relFile, `${relFile} must be a JSON object.`));
    return;
  }
  const cfg = doc as Record<string, unknown>;

  if (cfg.$schema === undefined) {
    findings.push(warn("schema/mcp-schema-missing", relFile, `${relFile} is missing \`$schema\`.`));
  } else if (cfg.$schema !== MCP_SCHEMA_URL) {
    findings.push(
      err("schema/mcp-schema-mismatch", relFile, `${relFile} \`$schema\` must be exactly '${MCP_SCHEMA_URL}'.`),
    );
  }

  const servers = cfg.mcpServers;
  if (servers === undefined) {
    findings.push(err("schema/mcp-servers-missing", relFile, `${relFile} requires a \`mcpServers\` map.`));
    return;
  }
  if (servers === null || typeof servers !== "object" || Array.isArray(servers)) {
    findings.push(err("schema/mcp-servers-invalid", relFile, `${relFile} \`mcpServers\` must be an object map.`));
    return;
  }
  for (const [key, server] of Object.entries(servers as Record<string, unknown>)) {
    if (key.length === 0) {
      findings.push(err("schema/mcp-server-key-empty", relFile, "mcpServers has an empty server key."));
      continue;
    }
    auditMcpServerConfig(key, server, root, relFile, findings);
  }
}

interface WalkEntry {
  /** Path relative to the package root, POSIX-style. */
  rel: string;
  /** Absolute path. */
  abs: string;
  isDir: boolean;
  isSymlink: boolean;
  mode: number;
}

/** Walk the package tree without following symlinks. */
async function walkPackage(root: string): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  async function visit(abs: string, rel: string): Promise<void> {
    let dirents;
    try {
      dirents = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dirent of dirents) {
      const childAbs = path.join(abs, dirent.name);
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      let st;
      try {
        st = await lstat(childAbs);
      } catch {
        continue;
      }
      const isSymlink = st.isSymbolicLink();
      const isDir = st.isDirectory();
      out.push({ rel: childRel, abs: childAbs, isDir, isSymlink, mode: st.mode });
      if (isDir && !isSymlink) {
        await visit(childAbs, childRel);
      }
    }
  }
  await visit(root, "");
  return out;
}

/**
 * Audit a plugin package directory. Never throws on malformed input — every
 * problem becomes a finding.
 */
export async function auditPluginPackage(dir: string): Promise<AuditResult> {
  const root = path.resolve(dir);
  const findings: AuditFinding[] = [];

  let rootStat;
  try {
    rootStat = await lstat(root);
  } catch {
    findings.push(err("path/root-missing", "", `Package directory does not exist: ${dir}`));
    return toResult(root, findings);
  }
  if (!rootStat.isDirectory()) {
    findings.push(err("path/root-not-dir", "", `Package path is not a directory: ${dir}`));
    return toResult(root, findings);
  }

  const entries = await walkPackage(root);
  const byRel = new Map(entries.map((e) => [e.rel, e]));

  // --- Path containment: symlinks must not escape the package root. ---------
  for (const entry of entries) {
    if (!entry.isSymlink) continue;
    let target: string;
    try {
      target = await readlink(entry.abs);
    } catch {
      findings.push(warn("path/symlink-unreadable", entry.rel, `Cannot read symlink target: ${entry.rel}`));
      continue;
    }
    const resolved = path.resolve(path.dirname(entry.abs), target);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      findings.push(
        err("path/symlink-escape", entry.rel, `Symlink '${entry.rel}' resolves outside the package root.`),
      );
    }
  }

  // --- Required manifest ------------------------------------------------------
  const manifest = byRel.get("plugin.json");
  if (!manifest || manifest.isDir) {
    findings.push(err("schema/plugin-missing", "", "plugin.json is required at the package root."));
  } else {
    const parsed = await readJsonFile(manifest.abs);
    if (!parsed.ok) {
      findings.push(err("schema/plugin-unparseable", "plugin.json", parsed.error));
    } else {
      auditPluginJson(parsed.value, findings);
    }
  }

  // --- MCP configs ------------------------------------------------------------
  for (const relFile of ["mcp.json", ".mcp.json"]) {
    const entry = byRel.get(relFile);
    if (!entry || entry.isDir) continue;
    const parsed = await readJsonFile(entry.abs);
    if (!parsed.ok) {
      findings.push(err("schema/mcp-unparseable", relFile, parsed.error));
      continue;
    }
    const doc = parsed.value as Record<string, unknown> | null;
    if (relFile === ".mcp.json") {
      // The `.mcp.json` client shim is the Codex-historical shape: a bare
      // `mcpServers` map with no `$schema`, and entries that omit `type`
      // (always stdio there). Validate its servers the same way, defaulting
      // a missing type to stdio.
      if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
        findings.push(err("schema/mcp-not-object", relFile, `${relFile} must be a JSON object.`));
        continue;
      }
      const serversRaw = (doc.mcpServers ?? doc) as Record<string, unknown>;
      if (serversRaw === null || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
        findings.push(err("schema/mcp-servers-invalid", relFile, `${relFile} must contain a server map.`));
        continue;
      }
      for (const [key, server] of Object.entries(serversRaw)) {
        if (key.length === 0) {
          findings.push(err("schema/mcp-server-key-empty", relFile, "mcpServers has an empty server key."));
          continue;
        }
        const withType =
          server !== null && typeof server === "object" && !Array.isArray(server) && (server as Record<string, unknown>).type === undefined
            ? { ...(server as Record<string, unknown>), type: "stdio" }
            : server;
        auditMcpServerConfig(key, withType, root, relFile, findings);
      }
      continue;
    }
    auditMcpJson(parsed.value, relFile, root, findings);
  }

  // --- Skills: fixed location, immediate children, component isolation --------
  const skillsDir = byRel.get("skills");
  if (skillsDir && !skillsDir.isDir) {
    findings.push(err("schema/skills-not-dir", "skills", "`skills` must be a directory."));
  } else if (skillsDir) {
    const children = entries.filter((e) => {
      const parts = e.rel.split("/");
      return parts.length === 2 && parts[0] === "skills";
    });
    for (const child of children) {
      if (!child.isDir || child.isSymlink) {
        findings.push(
          warn("schema/skill-not-dir", child.rel, `skills/ entries must be directories (one skill per immediate child).`),
        );
        continue;
      }
      const skillMd = byRel.get(`${child.rel}/SKILL.md`);
      if (!skillMd || skillMd.isDir) {
        // Per spec failure isolation an invalid skill is skipped — warn, don't fail.
        findings.push(
          warn("schema/skill-missing-manifest", child.rel, `Skill '${child.rel}' has no SKILL.md; clients will skip it.`),
        );
        continue;
      }
      let body = "";
      try {
        body = await readFile(skillMd.abs, "utf8");
      } catch {
        findings.push(warn("path/skill-unreadable", skillMd.rel, `Cannot read ${skillMd.rel}.`));
        continue;
      }
      // Component isolation: a skill must not smuggle extra server entries.
      if (/"mcpServers"\s*:/.test(body)) {
        findings.push(
          err(
            "isolation/skill-smuggled-servers",
            skillMd.rel,
            `Skill declares 'mcpServers' — server entries belong in mcp.json only.`,
          ),
        );
      }
      for (const smuggled of ["mcp.json", "plugin.json"]) {
        if (byRel.has(`${child.rel}/${smuggled}`)) {
          findings.push(
            err(
              "isolation/skill-smuggled-manifest",
              `${child.rel}/${smuggled}`,
              `Skill directories must not contain '${smuggled}' — component isolation.`,
            ),
          );
        }
      }
      const shape = detectSecret(body);
      if (shape) {
        findings.push(
          err("secret/skill-body", skillMd.rel, `Possible ${shape} secret in skill body.`),
        );
      }
    }
  }

  // --- Unexpected executables ---------------------------------------------------
  for (const entry of entries) {
    if (entry.isDir || entry.isSymlink) continue;
    if ((entry.mode & 0o111) !== 0) {
      findings.push(
        warn("isolation/unexpected-executable", entry.rel, `File '${entry.rel}' has an executable bit set.`),
      );
    }
  }

  // --- Root layout: only known components or reverse-domain namespaces ---------
  for (const entry of entries) {
    const parts = entry.rel.split("/");
    if (parts.length !== 1) continue;
    if (entry.isDir) {
      const name = parts[0]!;
      if (!KNOWN_ROOT_DIRS.has(name) && !REVERSE_DOMAIN_PATTERN.test(name)) {
        findings.push(
          warn(
            "schema/unknown-component-dir",
            entry.rel,
            `Directory '${name}/' is not 'skills/' or a reverse-domain client namespace; clients may ignore it.`,
          ),
        );
      }
    } else if (!entry.isSymlink) {
      if (!KNOWN_ROOT_FILES.has(parts[0]!.toLowerCase())) {
        findings.push(
          warn("schema/unexpected-root-file", entry.rel, `Unexpected file at package root: '${entry.rel}'.`),
        );
      }
    }
  }

  return toResult(root, findings);
}

function toResult(root: string, findings: AuditFinding[]): AuditResult {
  const errors = findings.filter((f) => f.severity === "error");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { root, ok: errors.length === 0, errors, warnings };
}

/** Render an audit result as human-readable text. */
export function formatAuditResult(result: AuditResult): string {
  const lines: string[] = [];
  const total = result.errors.length + result.warnings.length;
  if (total === 0) {
    return `✓ plugin audit passed — no findings in ${result.root}`;
  }
  lines.push(
    `${result.ok ? "⚠" : "✗"} plugin audit ${result.ok ? "passed with warnings" : "FAILED"} — ` +
      `${result.errors.length} error(s), ${result.warnings.length} warning(s) in ${result.root}`,
  );
  const all = [...result.errors, ...result.warnings];
  for (const f of all) {
    const icon = f.severity === "error" ? "✗" : "⚠";
    const where = f.path ? ` [${f.path}]` : "";
    lines.push(`  ${icon} ${f.code}${where}: ${f.message}`);
  }
  return lines.join("\n");
}
