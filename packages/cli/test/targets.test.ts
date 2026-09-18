import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  codexHasServer,
  createGeneratedConfig,
  emitConfig,
  writeTargetConfig,
  type GeneratedConfig,
} from "../src/config-store.js";
import {
  getRegistryEntry,
  getTargetDefaultPath,
  getTargetSpec,
  isConfigTarget,
  listConfigTargets,
  SHAPE_SPECS,
  TARGET_REGISTRY,
} from "../src/registry.js";

/**
 * The harnesses the plugin docs must advertise. Equal to the registry exactly:
 * every entry is a real write target, and no target is undocumented.
 */
const DOCUMENTED_TARGETS = [
  "claude-desktop",
  "claude-code",
  "cursor",
  "kilo",
  "cline",
  "omp",
  "pi",
  "codex",
  "openclaw",
  "zcode",
  "windsurf",
  "zed",
  "vscode",
  "opencode",
  "gemini-cli",
  "json",
] as const;

const JSON_TARGETS = TARGET_REGISTRY.filter((spec) => SHAPE_SPECS[spec.shape].merge === "json-merge");

function sampleConfig(): GeneratedConfig {
  return createGeneratedConfig([getRegistryEntry("hackernews"), getRegistryEntry("github")], "npx");
}

/**
 * Read the subset of TOML that Codex configs use: `[table]` headers plus
 * `key = <JSON literal>` assignments. Enough to prove the emitted document is
 * well-formed without adding a TOML parser to the CLI's dependencies.
 */
function parseTomlSubset(text: string): Record<string, Record<string, unknown>> {
  const tables: Record<string, Record<string, unknown>> = {};
  let current: Record<string, unknown> | undefined;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = {};
      tables[header[1]!] = current;
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!assignment || current === undefined) {
      throw new Error(`Unparseable TOML line: ${rawLine}`);
    }
    current[assignment[1]!] = JSON.parse(assignment[2]!);
  }
  return tables;
}

/** A server entry in any of the JSON shapes UMT writes. */
interface ServerEntry {
  type?: string;
  command: string | string[];
  args?: string[];
  env?: Record<string, string>;
  environment?: Record<string, string>;
  enabled?: boolean;
}

/** Read a nested key path, e.g. `["mcp","servers"]`, as a plain object. */
function readPath(root: unknown, keyPath: readonly string[]): Record<string, unknown> {
  let current: unknown = root;
  for (const key of keyPath) {
    current =
      current === null || typeof current !== "object" ? undefined : (current as Record<string, unknown>)[key];
  }
  return (current ?? {}) as Record<string, unknown>;
}

/** Read the server map at a shape's documented key path. */
function serversAt(root: unknown, keyPath: readonly string[]): Record<string, ServerEntry> {
  return readPath(root, keyPath) as Record<string, ServerEntry>;
}

/** Write a value at a nested key path, creating intermediate objects. */
function writePath(root: Record<string, unknown>, keyPath: readonly string[], value: unknown): void {
  let current = root;
  for (const key of keyPath.slice(0, -1)) {
    if (current[key] === null || typeof current[key] !== "object") current[key] = {};
    current = current[key] as Record<string, unknown>;
  }
  current[keyPath[keyPath.length - 1]!] = value;
}

/** The harness matrix rows of the umt-mcp skill, in order. */
async function harnessMatrixRows(): Promise<string[]> {
  const skillUrl = new URL("../../../plugin/skills/umt-mcp/SKILL.md", import.meta.url);
  const lines = (await readFile(skillUrl, "utf8")).split("\n");
  const start = lines.findIndex((line) => line.startsWith("## Harness matrix"));
  expect(start, "SKILL.md has no '## Harness matrix' section").toBeGreaterThan(-1);

  const rows: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    const row = /^\|\s*([a-z][a-z0-9-]*)\s*\|/.exec(line);
    if (row) rows.push(row[1]!);
  }
  return rows;
}

describe("config target registry", () => {
  it("implements exactly the targets the plugin docs advertise", () => {
    expect(listConfigTargets()).toEqual([...DOCUMENTED_TARGETS]);
  });

  it("keeps the skill's harness matrix equal to the registry", async () => {
    expect(await harnessMatrixRows()).toEqual([...DOCUMENTED_TARGETS]);
  });

  it("keeps the umt command's harness list equal to the registry", async () => {
    const commandUrl = new URL("../../../plugin/commands/umt.md", import.meta.url);
    const text = await readFile(commandUrl, "utf8");
    const declared = /supported harnesses: ([^.]+)\./.exec(text);
    expect(declared, "umt.md does not list supported harnesses").not.toBeNull();
    expect(declared![1]!.split(",").map((value) => value.trim())).toEqual([...DOCUMENTED_TARGETS]);
  });

  it("mentions every target id in both plugin docs", async () => {
    for (const relative of ["../../../plugin/commands/umt.md", "../../../plugin/skills/umt-mcp/SKILL.md"]) {
      const text = await readFile(new URL(relative, import.meta.url), "utf8");
      for (const id of listConfigTargets()) {
        expect(text, `${relative} never mentions '${id}'`).toContain(id);
      }
    }
  });

  it("documents an official docs url per target and covers every shape", () => {
    for (const spec of TARGET_REGISTRY) {
      expect(spec.docsUrl, `${spec.id} has no docsUrl`).toMatch(/^https:\/\//);
    }
    const shapes = [...new Set(TARGET_REGISTRY.map((spec) => spec.shape))].sort();
    expect(shapes).toEqual(Object.keys(SHAPE_SPECS).sort());
  });

  it("rejects unknown targets with a message that lists the real ones", () => {
    expect(() => getTargetSpec("not-a-target")).toThrow(/Unknown target 'not-a-target'.*claude-desktop/s);
    expect(isConfigTarget("not-a-target")).toBe(false);
    expect(isConfigTarget("cursor")).toBe(true);
  });

  it("resolves default paths per scope, and none for the json dump", () => {
    expect(getTargetDefaultPath("cursor")).toBe(path.join(homedir(), ".cursor", "mcp.json"));
    expect(getTargetDefaultPath("codex")).toBe(path.join(homedir(), ".codex", "config.toml"));
    // Workspace-scoped harnesses resolve against the project directory.
    expect(getTargetDefaultPath("vscode", "/work/repo")).toBe(path.resolve("/work/repo", ".vscode/mcp.json"));
    expect(getTargetDefaultPath("claude-code", "/work/repo")).toBe(path.resolve("/work/repo", ".mcp.json"));
    expect(getTargetDefaultPath("json")).toBeUndefined();

    for (const spec of TARGET_REGISTRY) {
      if (spec.id === "json") continue;
      expect(getTargetDefaultPath(spec.id), `${spec.id} has no writable path`).toBeTruthy();
    }
  });
});

describe("emitConfig", () => {
  const config = sampleConfig();

  it("emits each JSON target in its harness's documented shape", () => {
    for (const spec of JSON_TARGETS) {
      const shapeSpec = SHAPE_SPECS[spec.shape];
      const parsed: unknown = JSON.parse(emitConfig(config, spec.id));
      const servers = serversAt(parsed, shapeSpec.serverKey);
      const entry = servers.hackernews!;

      expect(servers, `${spec.id} server map`).toBeDefined();
      expect(entry, `${spec.id} entry`).toBeDefined();

      switch (spec.shape) {
        case "vscode-json":
          expect(entry.type).toBe("stdio");
          expect(entry.command).toBe("npx");
          break;
        case "opencode-json":
          expect(entry.type).toBe("local");
          expect(entry.command).toEqual(expect.arrayContaining(["npx"]));
          expect(entry.enabled).toBe(true);
          break;
        default:
          expect(entry.command).toBe("npx");
          expect(Array.isArray(entry.args)).toBe(true);
          break;
      }

      // github declares GITHUB_TOKEN, so the placeholder travels with the entry.
      const env = servers.github!.env ?? servers.github!.environment;
      expect(env, `${spec.id} env`).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}" });
    }
  });

  it("emits Codex TOML that parses, one table per server", () => {
    const tables = parseTomlSubset(emitConfig(config, "codex"));
    expect(tables["mcp_servers.hackernews"]!.command).toBe("npx");
    // The CLI's generated invocations pin each first-party server to the exact
    // npm version the catalog ships, never a floating `latest` tag.
    expect(tables["mcp_servers.hackernews"]!.args).toEqual([
      "-y",
      "@universal-mcp-toolkit/server-hackernews@0.2.0",
      "--transport",
      "stdio",
    ]);
    expect(tables["mcp_servers.github.env"]!.GITHUB_TOKEN).toBe("${GITHUB_TOKEN}");
  });

  it("emits the raw json dump in the standard mcpServers shape", () => {
    const parsed: unknown = JSON.parse(emitConfig(config, "json"));
    expect(serversAt(parsed, ["mcpServers"]).hackernews!.command).toBe("npx");
  });
});

describe("writeTargetConfig", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "umt-targets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("preserves pre-existing servers and unrelated settings for every JSON target", async () => {
    for (const spec of JSON_TARGETS) {
      const file = path.join(dir, `${spec.id}.json`);
      const existing: Record<string, unknown> = { "umt-test-marker": "keep-me" };
      writePath(existing, SHAPE_SPECS[spec.shape].serverKey, {
        "existing-server": { command: "node", args: ["x.js"] },
      });
      await writeFile(file, JSON.stringify(existing, null, 2));

      const result = await writeTargetConfig(spec.id, file, sampleConfig());
      const parsed: Record<string, unknown> = JSON.parse(await readFile(file, "utf8"));
      const servers = serversAt(parsed, SHAPE_SPECS[spec.shape].serverKey);

      expect(servers["existing-server"], `${spec.id} clobbered an existing server`).toEqual({
        command: "node",
        args: ["x.js"],
      });
      expect(servers.hackernews, `${spec.id} did not write the new server`).toBeDefined();
      expect(parsed["umt-test-marker"], `${spec.id} dropped unrelated settings`).toBe("keep-me");
      expect(result.merged).toBe(true);
      expect(result.backupPath).toBe(`${file}.umt-bak`);
      const backup: Record<string, unknown> = JSON.parse(await readFile(result.backupPath!, "utf8"));
      expect(backup["umt-test-marker"]).toBe("keep-me");
    }
  });

  it("appends Codex TOML blocks without disturbing existing content", async () => {
    const file = path.join(dir, "config.toml");
    await writeFile(file, '# codex config\nmodel = "gpt-5"\n\n[mcp_servers.other]\ncommand = "node"\nargs = []\n');

    await writeTargetConfig("codex", file, sampleConfig());
    const out = await readFile(file, "utf8");

    expect(out).toContain('model = "gpt-5"');
    expect(out).toContain("[mcp_servers.other]"); // pre-existing server preserved
    expect(codexHasServer(out, "hackernews")).toBe(true);
    expect(codexHasServer(out, "github")).toBe(true);
  });

  it("replaces an existing Codex block for a server it rewrites", async () => {
    const file = path.join(dir, "config.toml");
    await writeFile(
      file,
      '[mcp_servers.github]\ncommand = "old"\nargs = []\n\n[mcp_servers.keep]\ncommand = "node"\nargs = []\n',
    );

    await writeTargetConfig("codex", file, sampleConfig());
    const out = await readFile(file, "utf8");

    expect(out.match(/\[mcp_servers\.github\]/g) ?? []).toHaveLength(1);
    expect(out).not.toContain('command = "old"');
    expect(out).toContain("[mcp_servers.keep]");
  });

  it("refuses to rewrite a JSON file it cannot parse, keeping the backup", async () => {
    const file = path.join(dir, "broken.json");
    await writeFile(file, "{ not valid json ");

    await expect(writeTargetConfig("cursor", file, sampleConfig())).rejects.toThrow(/not valid JSON/);
    expect(await readFile(file, "utf8")).toBe("{ not valid json ");
    expect(await readFile(`${file}.umt-bak`, "utf8")).toBe("{ not valid json ");
  });

  it("writes a fresh file when none exists, with no backup", async () => {
    const file = path.join(dir, "nested", "cursor.json");
    const result = await writeTargetConfig("cursor", file, sampleConfig());
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));

    expect(serversAt(parsed, ["mcpServers"]).hackernews).toBeDefined();
    expect(result.merged).toBe(false);
    expect(result.backupPath).toBeUndefined();
  });
});