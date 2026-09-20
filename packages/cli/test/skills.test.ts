import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  SKILL_FORMAT_VERSION,
  parseSkillFrontmatter,
  discoverSkills,
  buildSkillCatalog,
  renderSkillCatalog,
  generateServerSkill,
  writeServerSkills,
  defaultSkillsOutDir,
} from "../src/skills.js";
import { getRegistryEntry } from "../src/registry.js";

async function makeSkillDir(root: string, name: string, skillMd: string): Promise<string> {
  const dir = path.join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "SKILL.md"), skillMd, "utf8");
  return dir;
}

describe("parseSkillFrontmatter", () => {
  it("parses name/description and scalar values", () => {
    const fm = parseSkillFrontmatter(`---
name: github-triage
description: Triage GitHub issues.
version: 1.2.3
---

# body
`);
    expect(fm).toMatchObject({ name: "github-triage", description: "Triage GitHub issues.", version: "1.2.3" });
  });

  it("parses inline and dash lists", () => {
    const fm = parseSkillFrontmatter(`---
name: s
description: d
servers: [github, notion]
tools:
  - search_repositories
  - get-page
---
`);
    expect(fm?.servers).toEqual(["github", "notion"]);
    expect(fm?.tools).toEqual(["search_repositories", "get-page"]);
  });

  it("returns null when there is no frontmatter", () => {
    expect(parseSkillFrontmatter("# just a heading\n")).toBeNull();
  });

  it("strips quotes from values", () => {
    const fm = parseSkillFrontmatter(`---
name: "quoted"
description: 'also quoted'
---
`);
    expect(fm).toMatchObject({ name: "quoted", description: "also quoted" });
  });
});

describe("discoverSkills", () => {
  it("discovers skills with SKILL.md and skips the rest with warnings", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "umt-skills-"));
    try {
      await makeSkillDir(
        root,
        "triage",
        `---
name: github-triage
description: Triage GitHub issues — label, assign, summarize.
version: 2.0.0
umt-format: 1
servers: [github]
tools: [search_repositories]
---

# body
`,
      );
      await makeSkillDir(root, "no-frontmatter", "# no frontmatter here\n");
      await makeSkillDir(root, "missing-name", `---\ndescription: no name\n---\n`);
      await mkdir(path.join(root, "empty-dir"), { recursive: true });

      const { skills, warnings } = await discoverSkills([root]);
      expect(skills).toHaveLength(1);
      expect(skills[0]).toMatchObject({
        format: SKILL_FORMAT_VERSION,
        name: "github-triage",
        version: "2.0.0",
        description: "Triage GitHub issues — label, assign, summarize.",
        servers: ["github"],
        tools: ["search_repositories"],
      });
      expect(skills[0]!.source).toBe(path.join(root, "triage"));
      expect(warnings).toHaveLength(2); // no-frontmatter + missing-name
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns empty results for missing directories without throwing", async () => {
    const { skills, warnings } = await discoverSkills(["/does/not/exist"]);
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("deduplicates the same skill dir scanned twice", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "umt-skills-"));
    try {
      await makeSkillDir(root, "s", `---\nname: s\ndescription: d\n---\n`);
      const { skills } = await discoverSkills([root, root]);
      expect(skills).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("skill catalog", () => {
  it("builds and renders the unified skills + MCP catalog", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "umt-skills-"));
    try {
      await makeSkillDir(
        root,
        "triage",
        `---\nname: github-triage\ndescription: Triage issues.\nservers: [github]\n---\n`,
      );
      const { skills } = await discoverSkills([root]);
      const catalog = buildSkillCatalog(skills, [getRegistryEntry("github")]);
      const rendered = renderSkillCatalog(catalog);
      expect(rendered).toContain("github-triage");
      expect(rendered).toContain("[via github]");
      expect(rendered).toContain("github — GitHub");
      expect(rendered).toContain("workflow knowledge");
      expect(rendered).toContain("execution");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("renders a helpful empty state when no skills are installed", () => {
    const rendered = renderSkillCatalog(buildSkillCatalog([], [getRegistryEntry("github")]));
    expect(rendered).toContain("(none");
    expect(rendered).toContain("~/.universal-mcp-toolkit/skills");
  });
});

describe("generateServerSkill", () => {
  it("emits a valid SKILL.md with frontmatter and tool metadata", () => {
    const entry = getRegistryEntry("github");
    const md = generateServerSkill(entry);
    const fm = parseSkillFrontmatter(md);
    expect(fm?.name).toBe("umt-github");
    expect(fm?.["umt-format"]).toBe(String(SKILL_FORMAT_VERSION));
    expect(fm?.description as string).toContain("GitHub");
    expect(fm?.description as string).toContain("get_pull_request");
    expect(fm?.servers).toEqual(["github"]);

    // Body: every tool gets a describe hint.
    for (const tool of entry.toolNames) {
      expect(md).toContain(`umt tools describe ${tool} -s github`);
    }
    expect(md).toContain("Skills vs MCP");
    expect(md).toContain("workflow knowledge");
  });

  it("notes required environment variables", () => {
    const md = generateServerSkill(getRegistryEntry("github"));
    expect(md).toContain("GITHUB_TOKEN");
  });
});

describe("writeServerSkills", () => {
  it("writes one umt-<id>/SKILL.md per server", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "umt-skills-out-"));
    try {
      const outDir = path.join(root, "skills");
      const written = await writeServerSkills([getRegistryEntry("github"), getRegistryEntry("notion")], outDir);
      expect(written).toHaveLength(2);
      expect(written[0]).toBe(path.join(outDir, "umt-github", "SKILL.md"));
      const content = await readFile(written[0]!, "utf8");
      expect(parseSkillFrontmatter(content)?.name).toBe("umt-github");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("defaults to ./.agents/skills for auto-discovery", () => {
    expect(defaultSkillsOutDir()).toBe(path.join(process.cwd(), ".agents", "skills"));
  });
});
