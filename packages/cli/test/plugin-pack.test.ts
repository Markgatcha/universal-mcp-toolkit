import { describe, it, expect } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_PLUGINS_SPEC_VERSION,
  PLUGIN_SCHEMA_URL,
  MCP_SCHEMA_URL,
  validatePluginName,
  resolvePackServers,
  buildPluginManifest,
  buildMcpServerEntry,
  buildMcpConfig,
  buildClientShims,
  defaultPackDescription,
  planPluginPack,
  writePluginPack,
} from "../src/plugin-pack.js";
import { getRegistryEntry } from "../src/registry.js";

describe("validatePluginName", () => {
  it("accepts spec-valid names", () => {
    expect(() => validatePluginName("my-plugin")).not.toThrow();
    expect(() => validatePluginName("umt.github-pack")).not.toThrow();
    expect(() => validatePluginName("a")).not.toThrow();
    expect(() => validatePluginName("x".repeat(64))).not.toThrow();
  });

  it("rejects names that violate the spec", () => {
    expect(() => validatePluginName("")).toThrow();
    expect(() => validatePluginName("UPPERCASE")).toThrow();
    expect(() => validatePluginName("has space")).toThrow();
    expect(() => validatePluginName("double--dash")).toThrow();
    expect(() => validatePluginName("double..dot")).toThrow();
    expect(() => validatePluginName("-leading")).toThrow();
    expect(() => validatePluginName("trailing-")).toThrow();
    expect(() => validatePluginName("x".repeat(65))).toThrow();
    expect(() => validatePluginName("under_score")).toThrow();
  });
});

describe("resolvePackServers", () => {
  it("resolves known ids and de-duplicates", () => {
    const entries = resolvePackServers(["github", "notion", "github"]);
    expect(entries.map((e) => e.id)).toEqual(["github", "notion"]);
  });

  it("fails loudly on unknown ids, listing the valid ones", () => {
    expect(() => resolvePackServers(["github", "nope", "alsono"])).toThrow(/Unknown server id\(s\): nope, alsono/);
    expect(() => resolvePackServers(["github", "nope"])).toThrow(/Valid ids:/);
  });

  it("requires at least one server", () => {
    expect(() => resolvePackServers([])).toThrow(/At least one/);
  });
});

describe("buildPluginManifest", () => {
  it("emits only spec-defined fields with the schema const", () => {
    const manifest = buildPluginManifest("my-pack", "1.2.3", "desc");
    expect(manifest.$schema).toBe(PLUGIN_SCHEMA_URL);
    expect(manifest.name).toBe("my-pack");
    expect(manifest.version).toBe("1.2.3");
    expect(manifest.description).toBe("desc");
    expect(manifest.license).toBe("MIT");
    expect(manifest.author).toEqual({ name: "Markgatcha" });
    expect(Object.keys(manifest).sort()).toEqual(
      ["$schema", "name", "version", "description", "keywords", "author", "homepage", "repository", "license"].sort(),
    );
  });
});

describe("buildMcpServerEntry", () => {
  it("builds a single-token npx stdio entry", () => {
    const entry = getRegistryEntry("github");
    const server = buildMcpServerEntry(entry);
    expect(server.type).toBe("stdio");
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", "@universal-mcp-toolkit/server-github", "--transport", "stdio"]);
    // Secret-shaped env values are never emitted — only ${VAR} placeholders.
    expect(server.env).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}" });
  });

  it("keeps explicit npxArgs verbatim for companion packages", () => {
    const entry = getRegistryEntry("memos");
    const server = buildMcpServerEntry(entry);
    expect(server.args).toEqual(entry.npxArgs);
  });

  it("omits env entirely when the server needs no env vars", () => {
    const entry = getRegistryEntry("hackernews");
    expect("env" in buildMcpServerEntry(entry)).toBe(false);
  });
});

describe("planPluginPack", () => {
  it("plans the full package layout", () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github", "notion"] }, "9.9.9");
    expect(plan.name).toBe("my-pack");
    expect(plan.version).toBe("9.9.9");
    const paths = plan.files.map((f) => f.relativePath).sort();
    expect(paths).toEqual(
      [
        "plugin.json",
        "mcp.json",
        "skills/umt-github/SKILL.md",
        "skills/umt-notion/SKILL.md",
        ".mcp.json",
        ".claude-plugin/plugin.json",
      ].sort(),
    );
    const kinds = Object.fromEntries(plan.files.map((f) => [f.relativePath, f.kind]));
    expect(kinds["plugin.json"]).toBe("manifest");
    expect(kinds["mcp.json"]).toBe("mcp-config");
    expect(kinds["skills/umt-github/SKILL.md"]).toBe("skill");
    expect(kinds[".mcp.json"]).toBe("client-shim");
  });

  it("uses the CLI version and a generated description by default", () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github"] }, "1.6.28");
    expect(plan.version).toBe("1.6.28");
    expect(plan.description).toContain("GitHub");
    expect(plan.outDir.endsWith("my-pack")).toBe(true);
  });

  it("throws before touching the disk on invalid input", () => {
    expect(() => planPluginPack({ name: "BAD NAME", serverIds: ["github"] })).toThrow(/Invalid plugin name/);
    expect(() => planPluginPack({ name: "ok", serverIds: ["nope"] })).toThrow(/Unknown server/);
  });

  it("emits valid JSON with the spec schema consts", () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github"] }, "1.0.0");
    const manifestFile = plan.files.find((f) => f.relativePath === "plugin.json")!;
    const mcpFile = plan.files.find((f) => f.relativePath === "mcp.json")!;
    expect(JSON.parse(manifestFile.content).$schema).toBe(PLUGIN_SCHEMA_URL);
    const mcp = JSON.parse(mcpFile.content);
    expect(mcp.$schema).toBe(MCP_SCHEMA_URL);
    expect(Object.keys(mcp.mcpServers)).toEqual(["umt-github"]);
  });

  it("documents the target spec version", () => {
    expect(AGENT_PLUGINS_SPEC_VERSION).toBe("1.0.0");
  });
});

describe("writePluginPack", () => {
  it("writes every planned file to disk", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "umt-pack-"));
    try {
      const outDir = path.join(root, "my-pack");
      const plan = planPluginPack({ name: "my-pack", serverIds: ["hackernews"], outDir }, "1.0.0");
      const written = await writePluginPack(plan);
      expect(written).toHaveLength(plan.files.length);
      for (const abs of written) {
        const st = await stat(abs);
        expect(st.isFile()).toBe(true);
      }
      const skill = await readFile(path.join(outDir, "skills", "umt-hackernews", "SKILL.md"), "utf8");
      expect(skill).toContain("name: umt-hackernews");
      const shim = JSON.parse(await readFile(path.join(outDir, ".mcp.json"), "utf8"));
      expect(Object.keys(shim.mcpServers)).toEqual(["umt-hackernews"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("buildClientShims / defaultPackDescription", () => {
  it("strips type/$schema in the Codex-historical shim", () => {
    const mcp = buildMcpConfig([getRegistryEntry("github")]);
    const shims = buildClientShims("my-pack", "1.0.0", "desc", mcp);
    const mcpShim = shims.find((s) => s.relativePath === ".mcp.json")!;
    const parsed = JSON.parse(mcpShim.content);
    expect(parsed.$schema).toBeUndefined();
    expect(parsed.mcpServers["umt-github"].type).toBeUndefined();
    expect(parsed.mcpServers["umt-github"].command).toBe("npx");
  });

  it("generates a description naming the servers", () => {
    const desc = defaultPackDescription([getRegistryEntry("github"), getRegistryEntry("notion")]);
    expect(desc).toContain("GitHub");
    expect(desc).toContain("Notion");
  });
});
