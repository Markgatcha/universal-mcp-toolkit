import { describe, expect, it } from "vitest";

import { createGeneratedConfig } from "../src/config-store.js";
import { getRegistryEntry, SERVER_REGISTRY } from "../src/registry.js";

describe("CLI registry", () => {
  it("includes all 27 server packages", () => {
    expect(SERVER_REGISTRY).toHaveLength(27);
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
});
