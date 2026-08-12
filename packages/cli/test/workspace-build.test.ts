import { describe, expect, it } from "vitest";

import { createWorkspaceBuildArgs } from "../src/workspace-build.js";

describe("workspace build arguments", () => {
  it("targets each missing package once in a single build command", () => {
    expect(createWorkspaceBuildArgs([
      "@universal-mcp-toolkit/server-github",
      "@universal-mcp-toolkit/server-notion",
      "@universal-mcp-toolkit/server-github",
    ])).toEqual([
      "--filter",
      "@universal-mcp-toolkit/server-github",
      "--filter",
      "@universal-mcp-toolkit/server-notion",
      "build",
    ]);
  });

  it("does not produce a root-wide build command without package targets", () => {
    expect(createWorkspaceBuildArgs([])).toEqual([]);
  });
});
