import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AGENT_PLUGINS_SPEC_VERSION,
  PLUGIN_SCHEMA_URL,
  MCP_SCHEMA_URL,
  MCP_SKILLS_EXTENSION_ID,
  validatePluginName,
  resolvePackServers,
  buildPluginManifest,
  buildMcpServerEntry,
  buildMcpConfig,
  buildClientShims,
  defaultPackDescription,
  planPluginPack,
  writePluginPack,
  sha256Digest,
  skillUriForPackEntry,
  buildSkillEntry,
  buildSkillsList,
  getSkillEntry,
  manifestForPlan,
  recordSkillPins,
  readRecordedSkillPins,
} from "../src/plugin-pack.js";
import { getRegistryEntry } from "../src/registry.js";
import { createHash } from "node:crypto";

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
        "skills.json",
        ".mcp.json",
        ".claude-plugin/plugin.json",
      ].sort(),
    );
    const kinds = Object.fromEntries(plan.files.map((f) => [f.relativePath, f.kind]));
    expect(kinds["plugin.json"]).toBe("manifest");
    expect(kinds["mcp.json"]).toBe("mcp-config");
    expect(kinds["skills/umt-github/SKILL.md"]).toBe("skill");
    expect(kinds["skills.json"]).toBe("skill-manifest");
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

describe("SEP-2640 skills manifest (skills.json)", () => {
  const entry = getRegistryEntry("github");

  it("skillUriForPackEntry uses the skill:// scheme with the name as final segment", () => {
    expect(skillUriForPackEntry(entry)).toBe("skill://umt-github/SKILL.md");
  });

  it("sha256Digest formats as sha256:{64 lowercase hex}", () => {
    const digest = sha256Digest("hello");
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(digest).toBe(`sha256:${createHash("sha256").update("hello", "utf8").digest("hex")}`);
  });

  it("buildSkillEntry emits the SEP-2640 Skill shape with digests over the planned bytes", () => {
    const content = "---\nname: umt-github\ndescription: d\nservers: [github]\n---\n\n# body\n";
    const skill = buildSkillEntry(entry, content);
    expect(skill.uri).toBe("skill://umt-github/SKILL.md");
    // Frontmatter passes through verbatim: name + description plus extras.
    expect(skill.frontmatter).toMatchObject({ name: "umt-github", description: "d", servers: ["github"] });
    // Resources is complete: the SKILL.md entry itself, with size == raw byte length.
    expect(Array.isArray(skill.resources)).toBe(true);
    const resources = skill.resources as Array<{ uri: string; digest: string; size: number }>;
    expect(resources).toHaveLength(1);
    expect(resources[0]!.uri).toBe(skill.uri);
    expect(resources[0]!.digest).toBe(sha256Digest(content));
    expect(resources[0]!.size).toBe(Buffer.byteLength(content, "utf8"));
  });

  it("buildSkillEntry throws when the generated SKILL.md lacks name/description", () => {
    expect(() => buildSkillEntry(entry, "# no frontmatter\n")).toThrow(/name\/description/);
  });

  it("buildSkillsList emits the skills/list result shape", () => {
    const manifest = buildSkillsList([{ entry, content: "---\nname: umt-github\ndescription: d\n---\n" }]);
    expect(manifest.extension).toBe(MCP_SKILLS_EXTENSION_ID);
    expect(manifest.extension).toBe("io.modelcontextprotocol/skills");
    expect(manifest.resultType).toBe("complete");
    expect(manifest.skills).toHaveLength(1);
    expect(manifest.skills[0]!.uri).toBe("skill://umt-github/SKILL.md");
    expect(manifest.ttlMs).toBe(0);
    expect(manifest.cacheScope).toBe("public");
  });

  it("getSkillEntry is the skills/get view: same shape, throws on unknown URI", () => {
    const manifest = buildSkillsList([{ entry, content: "---\nname: umt-github\ndescription: d\n---\n" }]);
    const viaGet = getSkillEntry(manifest, "skill://umt-github/SKILL.md");
    expect(viaGet).toEqual(manifest.skills[0]);
    expect(() => getSkillEntry(manifest, "skill://nope/SKILL.md")).toThrow(/Unknown skill URI/);
  });

  it("planPluginPack emits a parseable skills.json whose digests match the planned files", () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github"] }, "1.0.0");
    const file = plan.files.find((f) => f.relativePath === "skills.json")!;
    const manifest = JSON.parse(file.content);
    expect(manifest.extension).toBe("io.modelcontextprotocol/skills");
    expect(manifest.resultType).toBe("complete");
    expect(manifest.skills).toHaveLength(1);
    const skillFile = plan.files.find((f) => f.relativePath === "skills/umt-github/SKILL.md")!;
    const resource = manifest.skills[0].resources[0];
    expect(resource.uri).toBe("skill://umt-github/SKILL.md");
    expect(resource.digest).toBe(sha256Digest(skillFile.content));
    expect(resource.size).toBe(Buffer.byteLength(skillFile.content, "utf8"));
  });

  it("manifestForPlan rebuilds the same manifest the plan wrote", () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github"] }, "1.0.0");
    const file = plan.files.find((f) => f.relativePath === "skills.json")!;
    expect(JSON.parse(file.content)).toEqual(JSON.parse(JSON.stringify(manifestForPlan(plan))));
  });
});

describe("recordSkillPins — disk persistence dovetailing with vet drift pins", () => {
  let appDataDir: string;
  let savedAppData: string | undefined;

  beforeEach(async () => {
    appDataDir = await mkdtemp(path.join(tmpdir(), "umt-skillpin-test-"));
    savedAppData = process.env.APPDATA;
    process.env.APPDATA = appDataDir; // getStateDirectory() prefers APPDATA.
  });

  afterEach(async () => {
    if (savedAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = savedAppData;
    await rm(appDataDir, { recursive: true, force: true });
  });

  it("persists one pin per skill URI and reads them back", async () => {
    const plan = planPluginPack({ name: "my-pack", serverIds: ["github", "notion"] }, "1.0.0");
    const manifest = manifestForPlan(plan);
    expect(await recordSkillPins(plan, manifest)).toBe(true);
    const pins = await readRecordedSkillPins();
    expect(Object.keys(pins).sort()).toEqual(["skill://umt-github/SKILL.md", "skill://umt-notion/SKILL.md"]);
    const pin = pins["skill://umt-github/SKILL.md"]!;
    expect(pin.plugin).toBe("my-pack");
    expect(pin.uri).toBe("skill://umt-github/SKILL.md");
    expect(pin.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(pin.size).toBeGreaterThan(0);
    expect(pin.pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    // The pinned digest is the manifest digest, byte-for-byte.
    const manifestResources = manifest.skills[0]!.resources;
    expect(Array.isArray(manifestResources)).toBe(true);
    expect(pin.digest).toBe((manifestResources as Array<{ digest: string }>)[0]!.digest);
  });

  it("merges with existing pins instead of clobbering other plugins", async () => {
    const planA = planPluginPack({ name: "pack-a", serverIds: ["github"] }, "1.0.0");
    await recordSkillPins(planA, manifestForPlan(planA));
    const planB = planPluginPack({ name: "pack-b", serverIds: ["notion"] }, "1.0.0");
    await recordSkillPins(planB, manifestForPlan(planB));
    const pins = await readRecordedSkillPins();
    expect(pins["skill://umt-github/SKILL.md"]!.plugin).toBe("pack-a");
    expect(pins["skill://umt-notion/SKILL.md"]!.plugin).toBe("pack-b");
  });

  it("returns an empty record when nothing was pinned yet", async () => {
    expect(await readRecordedSkillPins()).toEqual({});
  });
});
