/**
 * Enforces the runtime npx pinning invariant.
 *
 * Every installable (non-experimental) SERVER_REGISTRY entry must resolve to an
 * immutable `packageName@x.y.z` token wherever the CLI spawns or writes an npx
 * invocation: generated configs (`umt config` / profiles / doctor), the stdio
 * bridge, and the plugin loader. The four experimental `@contextcore/*` entries
 * are exempt — their packages were never published to npm (404, verified
 * 2026-09-18), so there is no version to pin and they are never installed via
 * npx.
 */

import { describe, expect, it } from "vitest";

import {
  createGeneratedConfig,
  resolvePinnedNpxPackage,
  SERVER_NPM_VERSIONS,
} from "../src/config-store.js";
import { resolveBridgeConfig } from "../src/index.js";
import { clearPluginCache, getSpawnConfig, loadPlugin } from "../src/plugin-loader.js";
import { getRegistryEntry, SERVER_REGISTRY } from "../src/registry.js";

/** Registry ids whose packages were never published to npm. */
const EXPERIMENTAL_IDS = ["notion-mcp", "playwright-mcp", "slack-mcp", "openai-mcp"];

const INSTALLABLE = SERVER_REGISTRY.filter((entry) => !entry.experimental);

describe("experimental gating", () => {
  it("marks the four never-published @contextcore entries experimental", () => {
    for (const id of EXPERIMENTAL_IDS) {
      expect(getRegistryEntry(id).experimental, `${id} must be experimental`).toBe(true);
    }
  });

  it("keeps arxiv's pre-existing experimental flag intact", () => {
    expect(getRegistryEntry("arxiv").experimental).toBe(true);
  });

  it("exempts experimental entries from the pin map", () => {
    for (const id of EXPERIMENTAL_IDS) {
      const entry = getRegistryEntry(id);
      expect(SERVER_NPM_VERSIONS[entry.id], `${id} must not have a pin`).toBeUndefined();
      // Documented resolver behaviour for unpinnable entries: the bare name.
      expect(resolvePinnedNpxPackage(entry)).toBe(entry.packageName);
    }
  });
});

describe("runtime npx pinning", () => {
  it("pins the generated config of every installable entry", () => {
    for (const entry of INSTALLABLE) {
      const server = createGeneratedConfig([entry], "npx").mcpServers[entry.id]!;

      expect(server.command).toBe("npx");
      const token = server.args.find((arg) => arg.startsWith(entry.packageName));
      expect(token, `${entry.id} generated no package token`).toBeDefined();
      expect(token).toBe(resolvePinnedNpxPackage(entry));
      expect(token!.startsWith(`${entry.packageName}@`), `${entry.id} is not pinned: ${token}`).toBe(true);
      expect(token).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  it("keeps the first-party pins in sync with plugin/mcp.json", () => {
    expect(SERVER_NPM_VERSIONS.hackernews).toBe("0.2.0");
    expect(SERVER_NPM_VERSIONS.arxiv).toBe("0.1.1");
    expect(SERVER_NPM_VERSIONS["npm-registry"]).toBe("0.2.0");
  });

  it("pins the memos entry to the reviewed SDK version", () => {
    expect(getRegistryEntry("memos").npxArgs).toEqual(["-y", "@mem-os/sdk@1.6.26", "mcp"]);
    expect(resolvePinnedNpxPackage(getRegistryEntry("memos"))).toBe("@mem-os/sdk@1.6.26");
  });

  it("pins the stdio bridge for installable entries", async () => {
    const github = await resolveBridgeConfig(getRegistryEntry("github"));
    expect(github.commandOrUrl).toBe("npx");
    expect(github.args[0]).toBe("-y");
    expect(github.args[1]).toBe("@universal-mcp-toolkit/server-github@0.1.1");

    const memos = await resolveBridgeConfig(getRegistryEntry("memos"));
    expect(memos.args).toContain("@mem-os/sdk@1.6.26");
    expect(memos.args).not.toContain("@mem-os/sdk");
  });

  it("pins the plugin loader's npx args, preserving arg order", async () => {
    clearPluginCache();
    const github = await loadPlugin(getRegistryEntry("github"), "npx");
    expect(github.npxArgs).toEqual(["-y", "@universal-mcp-toolkit/server-github@0.1.1"]);

    // The npxArgs override is kept verbatim; only the appended package token is
    // pinned (the append position is intentional and unchanged).
    clearPluginCache();
    const memos = await loadPlugin(getRegistryEntry("memos"), "npx");
    expect(memos.npxArgs).toEqual(["-y", "@mem-os/sdk@1.6.26", "mcp", "@mem-os/sdk@1.6.26"]);

    const spawn = getSpawnConfig(getRegistryEntry("github"));
    expect(spawn.args).toEqual([
      "-y",
      "@universal-mcp-toolkit/server-github@0.1.1",
      "--transport",
      "stdio",
    ]);

    const memosSpawn = getSpawnConfig(getRegistryEntry("memos"));
    expect(memosSpawn.args).toEqual([
      "-y",
      "@mem-os/sdk@1.6.26",
      "mcp",
      "@mem-os/sdk@1.6.26",
      "--transport",
      "stdio",
    ]);
  });

  it("maps every pin to a real registry id and covers every installable entry", () => {
    const ids = new Set(SERVER_REGISTRY.map((entry) => entry.id));

    for (const key of Object.keys(SERVER_NPM_VERSIONS)) {
      expect(ids.has(key), `orphan pin '${key}'`).toBe(true);
    }
    for (const entry of INSTALLABLE) {
      const version = SERVER_NPM_VERSIONS[entry.id];
      expect(version, `${entry.id} has no pin (unpinned fallback reachable)`).toBeDefined();
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });
});