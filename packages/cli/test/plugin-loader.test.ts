import { describe, expect, it } from "vitest";

import { clearPluginCache, getSpawnConfig, loadPlugin } from "../src/plugin-loader.js";
import { getRegistryEntry } from "../src/registry.js";

describe("plugin loader", () => {
  it("keeps explicit npxArgs verbatim for companion packages", async () => {
    const entry = getRegistryEntry("memos");
    clearPluginCache();

    const plugin = await loadPlugin(entry, "npx");

    expect(entry.npxArgs).toBeDefined();
    expect(plugin.npxArgs).toEqual(entry.npxArgs);
    expect(getSpawnConfig(entry).args).toEqual(entry.npxArgs);
  });

  it("adds the stdio transport only to first-party npx launches", () => {
    const entry = getRegistryEntry("hackernews");

    expect(entry.npxArgs).toBeUndefined();
    expect(getSpawnConfig(entry)).toEqual({
      command: "npx",
      args: ["-y", entry.packageName, "--transport", "stdio"],
    });
  });
});
