import { describe, it, expect } from "vitest";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  toSlimManifest,
  buildSlimManifest,
  formatSlimManifest,
  describeTool,
  oneLineDescription,
  compareManifestSize,
} from "../src/slim-manifest.js";
import type { BridgeTool } from "../src/types.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

function makeTool(
  name: string,
  description: string,
  properties: Record<string, unknown> = {},
  required: string[] = [],
): BridgeTool {
  return {
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required,
    },
    mcpTool: {
      name,
      description,
      inputSchema: {
        type: "object",
        properties,
        required,
        $schema: "http://json-schema.org/draft-07/schema#",
      },
    } as Tool,
  };
}

// Realistic, verbose schemas like production MCP servers ship.
const mockTools: BridgeTool[] = [
  makeTool(
    "github_list_issues",
    "List open issues for a GitHub repository.\nSupports pagination and filtering by labels, assignee, and milestone.",
    {
      owner: { type: "string", description: "The repository owner (username or organization name). Must be a valid GitHub login." },
      repo: { type: "string", description: "The repository name without the owner prefix." },
      state: { type: "string", description: "Filter issues by state.", enum: ["open", "closed", "all"], default: "open" },
      labels: { type: "array", description: "Only show issues with these labels.", items: { type: "string" } },
      per_page: { type: "integer", description: "Results per page (max 100).", default: 30, minimum: 1, maximum: 100 },
      page: { type: "integer", description: "Page number of results to fetch.", default: 1, minimum: 1 },
    },
    ["owner", "repo"],
  ),
  makeTool(
    "github_create_issue",
    "Create a new issue in a GitHub repository.",
    {
      owner: { type: "string", description: "The repository owner." },
      repo: { type: "string", description: "The repository name." },
      title: { type: "string", description: "The title of the issue.", maxLength: 256 },
      body: { type: "string", description: "The issue body as GitHub-flavored markdown." },
      labels: { type: "array", items: { type: "string" }, description: "Labels to apply." },
      assignees: { type: "array", items: { type: "string" }, description: "Usernames to assign." },
    },
    ["owner", "repo", "title"],
  ),
];

// ─── oneLineDescription ──────────────────────────────────────────────────────

describe("oneLineDescription", () => {
  it("keeps single-line descriptions as-is", () => {
    expect(oneLineDescription("Create a new issue.")).toBe("Create a new issue.");
  });

  it("cuts multi-line descriptions to the first line", () => {
    expect(oneLineDescription("First line.\nSecond line.\nThird.")).toBe("First line.");
  });

  it("truncates very long descriptions with an ellipsis", () => {
    const long = "x".repeat(500);
    const result = oneLineDescription(long);
    expect(result.length).toBeLessThanOrEqual(160);
    expect(result.endsWith("...")).toBe(true);
  });

  it("returns empty string for missing descriptions", () => {
    expect(oneLineDescription(undefined)).toBe("");
    expect(oneLineDescription(null)).toBe("");
    expect(oneLineDescription("")).toBe("");
  });
});

// ─── toSlimManifest ──────────────────────────────────────────────────────────

describe("toSlimManifest", () => {
  it("produces name + one-line description entries tagged with the server", () => {
    const entries = toSlimManifest(mockTools, "github");
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      server: "github",
      name: "github_create_issue",
      description: "Create a new issue in a GitHub repository.",
    });
    // Multi-line description collapsed to its first line.
    expect(entries[1]!.description).toBe(
      "List open issues for a GitHub repository.",
    );
  });

  it("sorts entries by tool name", () => {
    const entries = toSlimManifest(mockTools, "github");
    expect(entries.map((e) => e.name)).toEqual([
      "github_create_issue",
      "github_list_issues",
    ]);
  });

  it("defaults the server label to 'default'", () => {
    const entries = toSlimManifest(mockTools);
    expect(entries[0]!.server).toBe("default");
  });
});

// ─── buildSlimManifest / formatSlimManifest ──────────────────────────────────

describe("buildSlimManifest", () => {
  it("merges per-server tools into one manifest grouped by server", () => {
    const manifest = buildSlimManifest([
      { server: "github", tools: mockTools },
      { server: "slack", tools: [makeTool("slack_post_message", "Post a message.")] },
    ]);
    expect(manifest.totalTools).toBe(3);
    expect(manifest.servers).toEqual(["github", "slack"]);
    // Grouped by server, then sorted by name within each server.
    expect(manifest.entries.map((e) => `${e.server}/${e.name}`)).toEqual([
      "github/github_create_issue",
      "github/github_list_issues",
      "slack/slack_post_message",
    ]);
  });
});

describe("formatSlimManifest", () => {
  it("renders grouped text with server headers and one line per tool", () => {
    const manifest = buildSlimManifest([{ server: "github", tools: mockTools }]);
    const text = formatSlimManifest(manifest);
    expect(text).toContain("## github (2 tools)");
    expect(text).toContain("- github_create_issue — Create a new issue in a GitHub repository.");
    expect(text).toContain("- github_list_issues — List open issues for a GitHub repository.");
    // No JSON Schema noise leaks into the slim rendering.
    expect(text).not.toContain("properties");
    expect(text).not.toContain("$schema");
  });
});

// ─── describeTool ────────────────────────────────────────────────────────────

describe("describeTool", () => {
  it("expands the full input schema for a named tool", () => {
    const detail = describeTool(mockTools, "github_list_issues", "github");
    expect(detail.name).toBe("github_list_issues");
    expect(detail.server).toBe("github");
    expect(detail.description).toContain("List open issues");
    const schema = detail.inputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(schema.properties)).toContain("per_page");
    expect(schema.properties["state"]).toMatchObject({ enum: ["open", "closed", "all"] });
  });

  it("throws a helpful error for unknown tools", () => {
    expect(() => describeTool(mockTools, "nope", "github")).toThrow(
      /Unknown tool "nope" on server "github"/,
    );
  });
});

// ─── compareManifestSize ─────────────────────────────────────────────────────

describe("compareManifestSize", () => {
  it("shows the slim manifest is substantially smaller than full schemas", () => {
    const { fullTokens, slimTokens, reductionPct } = compareManifestSize(mockTools, "github");
    expect(fullTokens).toBeGreaterThan(0);
    expect(slimTokens).toBeGreaterThan(0);
    expect(slimTokens).toBeLessThan(fullTokens);
    // Verbose production-style schemas should slim down by well over half.
    expect(reductionPct).toBeGreaterThan(50);
  });
});
