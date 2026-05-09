import { describe, expect, it } from "vitest";

import { createGeneratedConfig } from "../src/config-store.js";
import { getRegistryEntry, SERVER_REGISTRY } from "../src/registry.js";

describe("CLI registry", () => {
  it("includes all 28 server packages", () => {
    expect(SERVER_REGISTRY).toHaveLength(28);
  });

  it("builds npx config snippets with placeholder environment variables", () => {
    const generated = createGeneratedConfig([getRegistryEntry("github"), getRegistryEntry("filesystem")], "npx");

    expect(generated).toEqual({
      mcpServers: {
        github: {
          command: "npx",
          args: ["-y", "@universal-mcp-toolkit/server-github", "--transport", "stdio"],
          env: {
            GITHUB_TOKEN: "${GITHUB_TOKEN}",
          },
        },
        filesystem: {
          command: "npx",
          args: ["-y", "@universal-mcp-toolkit/server-filesystem", "--transport", "stdio"],
          env: {
            FILESYSTEM_ROOTS: "${FILESYSTEM_ROOTS}",
          },
        },
      },
    });
  });

  it("builds workspace config snippets without npx", () => {
    const generated = createGeneratedConfig([getRegistryEntry("github")], "workspace");
    const githubConfig = generated.mcpServers.github;

    expect(githubConfig).toBeDefined();
    expect(githubConfig?.command).toBe(process.execPath);
    expect(githubConfig?.args[0]?.replaceAll("\\", "/")).toContain("servers/github/dist/index.js");
  });

  it("builds the MemOS MCP config with the SDK bin command", () => {
    const generated = createGeneratedConfig([getRegistryEntry("memos")], "npx");

    expect(generated).toEqual({
      mcpServers: {
        memos: {
          command: "npx",
          args: ["-y", "@mem-os/sdk", "mcp"],
        },
      },
    });
  });
});
