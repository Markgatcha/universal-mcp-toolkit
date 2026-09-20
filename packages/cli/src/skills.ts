/**
 * Agent Skills interop — skills carry workflow knowledge, MCP stays narrow.
 *
 * An [Agent Skill](https://agentskills.io) (open standard, Dec 2025) is a
 * directory with a `SKILL.md` file: YAML frontmatter (`name`, `description`)
 * plus Markdown body teaching an agent *when* and *how* to do something.
 * MCP servers, by contrast, expose *execution* — narrow tools the agent calls.
 *
 * UMT treats both as one installable catalog:
 *
 * - **Discovery** — `umt skills` builds a unified catalog of local skills
 *   (scanned from `~/.universal-mcp-toolkit/skills`, `./.agents/skills`, and
 *   `./skills`, or `$UMT_SKILLS_DIR`) alongside the MCP server registry.
 * - **Generation** — `umt skills generate` emits a `SKILL.md` per UMT server
 *   from its tool metadata, so Claude Code / Cursor / Goose auto-discover
 *   servers through the standard skill mechanism.
 *
 * ## Skill manifest format (versioned)
 *
 * Local skills are plain Agent Skills: a directory containing `SKILL.md`
 * with frontmatter. UMT reads `name` (required), `description` (required),
 * and the optional UMT extensions `version`, `servers` (UMT server IDs this
 * skill drives), `tools` (tool names), and `umt-format` (manifest format
 * version, currently `1`):
 *
 * ```markdown
 * ---
 * name: github-triage
 * description: Triage GitHub issues — label, assign, and summarize.
 * version: 1.0.0
 * umt-format: 1
 * servers: [github]
 * tools: [search_repositories, list_workflow_runs]
 * ---
 *
 * # GitHub triage
 * ...
 * ```
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getStateDirectory } from "./config-store.js";
import type { ServerRegistryEntry } from "./registry.js";

/** Current version of the UMT skill manifest format. */
export const SKILL_FORMAT_VERSION = 1;

/** A discovered local skill (Agent Skill). */
export interface SkillManifest {
  /** Manifest format version — always {@link SKILL_FORMAT_VERSION} when parsed. */
  format: number;
  /** Skill name (from frontmatter `name`; also the directory name fallback). */
  name: string;
  /** Skill version (frontmatter `version`, default `"0.0.0"`). */
  version: string;
  /** One-line description (frontmatter `description`). */
  description: string;
  /** UMT server IDs this skill drives (frontmatter `servers`). */
  servers: string[];
  /** Tool names this skill uses (frontmatter `tools`). */
  tools: string[];
  /** Absolute path of the skill directory. */
  source: string;
}

/** A skill directory that was skipped during discovery, with the reason. */
export interface SkillDiscoveryWarning {
  source: string;
  reason: string;
}

export interface SkillDiscoveryResult {
  skills: SkillManifest[];
  warnings: SkillDiscoveryWarning[];
}

/**
 * Directories scanned for local skills, in priority order:
 * `$UMT_SKILLS_DIR` (if set) → `~/.universal-mcp-toolkit/skills` →
 * `<cwd>/.agents/skills` → `<cwd>/skills`.
 */
export function defaultSkillsDirs(): string[] {
  const dirs: string[] = [];
  if (process.env.UMT_SKILLS_DIR) dirs.push(process.env.UMT_SKILLS_DIR);
  dirs.push(path.join(getStateDirectory(), "skills"));
  dirs.push(path.join(process.cwd(), ".agents", "skills"));
  dirs.push(path.join(process.cwd(), "skills"));
  return dirs;
}

/**
 * Parse the YAML frontmatter of a SKILL.md file. Supports the small subset
 * UMT needs: `key: value`, `key: [a, b]`, and `key:` followed by `- item`
 * lines. Returns `null` when there is no frontmatter block.
 */
export function parseSkillFrontmatter(markdown: string): Record<string, string | string[]> | null {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const result: Record<string, string | string[]> = {};
  let currentListKey: string | null = null;
  for (const rawLine of (match[1] ?? "").split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue;
    const listItem = line.match(/^\s*-\s+(.*)$/);
    if (listItem && currentListKey) {
      (result[currentListKey] as string[]).push((listItem[1] ?? "").trim().replace(/^["']|["']$/g, ""));
      continue;
    }
    currentListKey = null;
    const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key: string = kv[1] ?? "";
    const value = (kv[2] ?? "").trim();
    if (key === "") continue;
    if (value === "") {
      result[key] = [];
      currentListKey = key;
    } else if (value.startsWith("[") && value.endsWith("]")) {
      result[key] = value
        .slice(1, -1)
        .split(",")
        .map((s) => s.trim().replace(/^["']|["']$/g, ""))
        .filter((s) => s.length > 0);
    } else {
      result[key] = value.replace(/^["']|["']$/g, "");
    }
  }
  return result;
}

function toStringList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Discover local skills in the given directories. Each immediate
 * subdirectory containing a `SKILL.md` is a skill. Directories without
 * `SKILL.md`, or with frontmatter missing `name`/`description`, are skipped
 * with a warning — discovery never throws on bad input.
 */
export async function discoverSkills(dirs: readonly string[] = defaultSkillsDirs()): Promise<SkillDiscoveryResult> {
  const skills: SkillManifest[] = [];
  const warnings: SkillDiscoveryWarning[] = [];
  const seen = new Set<string>();

  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // Missing/unreadable skills dir — not an error.
    }
    for (const entry of entries) {
      const skillDir = path.join(dir, entry);
      const skillFile = path.join(skillDir, "SKILL.md");
      let markdown: string;
      try {
        markdown = await readFile(skillFile, "utf8");
      } catch {
        continue; // Not a skill — no SKILL.md.
      }
      if (seen.has(skillDir)) continue;
      seen.add(skillDir);

      const frontmatter = parseSkillFrontmatter(markdown);
      if (!frontmatter) {
        warnings.push({ source: skillDir, reason: "SKILL.md has no YAML frontmatter." });
        continue;
      }
      const name = frontmatter.name;
      const description = frontmatter.description;
      if (typeof name !== "string" || name.length === 0 || typeof description !== "string" || description.length === 0) {
        warnings.push({ source: skillDir, reason: "Frontmatter must define `name` and `description`." });
        continue;
      }
      const formatRaw = frontmatter["umt-format"];
      const format = typeof formatRaw === "string" ? parseInt(formatRaw, 10) : SKILL_FORMAT_VERSION;
      skills.push({
        format: Number.isNaN(format) ? SKILL_FORMAT_VERSION : format,
        name,
        version: typeof frontmatter.version === "string" ? frontmatter.version : "0.0.0",
        description,
        servers: toStringList(frontmatter.servers),
        tools: toStringList(frontmatter.tools),
        source: skillDir,
      });
    }
  }

  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, warnings };
}

/** The unified catalog: local skills (workflow knowledge) + MCP servers (execution). */
export interface SkillCatalog {
  skills: SkillManifest[];
  servers: readonly ServerRegistryEntry[];
}

/** Build the unified catalog from discovered skills and the server registry. */
export function buildSkillCatalog(skills: readonly SkillManifest[], servers: readonly ServerRegistryEntry[]): SkillCatalog {
  return { skills: [...skills], servers };
}

/** Render the unified catalog as human-readable text. */
export function renderSkillCatalog(catalog: SkillCatalog): string {
  const lines: string[] = [];
  lines.push("Agent Skills — workflow knowledge (when/how), discovered locally:");
  if (catalog.skills.length === 0) {
    lines.push("  (none — add a skill dir with SKILL.md to ~/.universal-mcp-toolkit/skills)");
  } else {
    for (const skill of catalog.skills) {
      const via = skill.servers.length > 0 ? ` [via ${skill.servers.join(", ")}]` : "";
      lines.push(`  ${skill.name} v${skill.version}${via}`);
      lines.push(`    ${skill.description}`);
    }
  }
  lines.push("");
  lines.push("MCP servers — execution (tools), from the UMT registry:");
  for (const server of catalog.servers) {
    lines.push(`  ${server.id} — ${server.title} (${server.toolNames.length} tools)`);
    lines.push(`    ${server.description}`);
  }
  return lines.join("\n");
}

/**
 * Generate a SKILL.md for one UMT server from its registry metadata, so
 * Claude Code / Cursor / Goose can auto-discover the server through the
 * standard Agent Skills mechanism (`<dir>/umt-<id>/SKILL.md`).
 */
export function generateServerSkill(entry: ServerRegistryEntry): string {
  const skillName = `umt-${entry.id}`;
  const toolList = entry.toolNames.join(", ");
  const description =
    `Use the ${entry.title} MCP server from the Universal MCP Toolkit — ${entry.description}` +
    (toolList ? ` Tools: ${toolList}.` : "");
  const toolRows = entry.toolNames
    .map((tool) => `| ${tool} | \`umt tools describe ${tool} -s ${entry.id}\` |`)
    .join("\n");
  const envNotes =
    entry.envVarNames.length > 0
      ? `Requires environment variables: ${entry.envVarNames.join(", ")}.`
      : "No environment variables required.";

  return `---
name: ${skillName}
description: ${description}
version: 1.0.0
umt-format: ${SKILL_FORMAT_VERSION}
servers: [${entry.id}]
---

# ${skillName} — ${entry.title} via the Universal MCP Toolkit

${entry.description}

${envNotes}

## When to use

Use this skill when the user asks about ${entry.title.toLowerCase()} — or anything
matching: ${entry.description} Prefer the \`umt\` CLI over hand-writing MCP
client configs; it merges safely into the harness config.

## Tools

This server exposes ${entry.toolNames.length} tool(s). Expand any full input
schema on demand with \`umt tools describe\`:

| Tool | Inspect schema |
| ---- | -------------- |
${toolRows}

## Connect this server

\`\`\`bash
# Non-interactive: write into the harness config (claude-code, cursor, …)
umt config -s ${entry.id} -t claude-code --write

# Or browse the slim tool catalog first
umt tools list -s ${entry.id} --slim
\`\`\`

## Skills vs MCP

Skills carry *workflow knowledge* — when to act, in what order, with what
judgment. MCP servers provide *execution* — narrow, typed tools the agent
calls. This skill exists so the agent discovers the right server; the server
itself does the work.
`;
}

/**
 * Write one `umt-<id>/SKILL.md` per server entry into `outDir`.
 * Returns the written file paths.
 */
export async function writeServerSkills(
  entries: readonly ServerRegistryEntry[],
  outDir: string,
): Promise<string[]> {
  const written: string[] = [];
  for (const entry of entries) {
    const dir = path.join(outDir, `umt-${entry.id}`);
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, "SKILL.md");
    await writeFile(filePath, generateServerSkill(entry), "utf8");
    written.push(filePath);
  }
  return written;
}

/** Default output directory for `umt skills generate` (Claude Code auto-discovers here). */
export function defaultSkillsOutDir(): string {
  return path.join(process.cwd(), ".agents", "skills");
}

/** User-level skills directory (same state dir family as traces/config). */
export function userSkillsDir(): string {
  return path.join(getStateDirectory(), "skills");
}
