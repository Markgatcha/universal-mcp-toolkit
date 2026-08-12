// Dynamic plugin loader for MCP server packages.
//
// Instead of bundling all server dependencies at build time, we resolve
// server packages lazily at runtime. This keeps the base CLI install small
// and only pulls in the packages you actually use.
//
// The loader works with three modes:
// 1. "npx" — spawn `npx -y @universal-mcp-toolkit/server-<id>` (default)
// 2. "workspace" — use the locally linked workspace package
// 3. "auto" — prefer workspace package if found, fall back to npx

import { existsSync } from "node:fs";
import path from "node:path";

import type { ServerRegistryEntry } from "./registry.js";

/** Whether we're running on Windows (affects how npx is invoked). */
const IS_WINDOWS = process.platform === "win32";

/** How to resolve a server package at runtime. */
export type PluginLoadMode = "npx" | "workspace" | "auto";

/** The loaded server module's capabilities. */
export interface LoadedPlugin {
  /** The resolved package directory (may not exist for npx mode). */
  packageDir: string | undefined;
  /** The entry file path. */
  entryFile: string | undefined;
  /** Whether the package was found locally (workspace mode). */
  local: boolean;
  /** The npm package name that would be used. */
  packageName: string;
  /** The npx args for spawning the server process. */
  npxArgs: readonly string[];
}

/** Cache of resolved plugins to avoid re-checking on every call. */
const pluginCache = new Map<string, LoadedPlugin>();

/**
 * Load a server plugin by its registry entry.
 *
 * In "npx" mode (default), the plugin is marked as not-local since the
 * package will be resolved by npx at spawn time. In "workspace" mode,
 * we look for the package in `node_modules` relative to the CLI's
 * installed location. In "auto" mode, we try workspace first and
 * fall back to npx if the package isn't found locally.
 */
export async function loadPlugin(
  entry: ServerRegistryEntry,
  mode: PluginLoadMode = "auto",
): Promise<LoadedPlugin> {
  const cacheKey = `${entry.id}:${mode}`;
  const cached = pluginCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const npxArgs = entry.npxArgs
    ? [...entry.npxArgs, entry.packageName]
    : ["-y", entry.packageName];

  // Try to locate the package locally in node_modules.
  // This works for both workspace installs and global installs.
  let packageDir: string | undefined;
  let entryFile: string | undefined;
  let local = false;

  if (mode === "workspace" || mode === "auto") {
    // Search for the package in node_modules directories.
    const candidates = [
      path.join(process.cwd(), "node_modules", entry.packageName),
      path.join(import.meta.dirname ?? ".", "..", "..", "node_modules", entry.packageName),
    ];

    for (const candidate of candidates) {
      const normalizedPath = path.resolve(candidate);
      if (existsSync(normalizedPath)) {
        packageDir = normalizedPath;
        break;
      }
    }

    if (packageDir) {
      local = true;
      // Try to find the entry point.
      const entryPath = path.join(packageDir, "dist", "index.mjs");
      if (existsSync(entryPath)) {
        entryFile = entryPath;
      }
    }
  }

  // In "npx" mode, never consider local.
  if (mode === "npx") {
    local = false;
    packageDir = undefined;
    entryFile = undefined;
  }

  const result: LoadedPlugin = {
    packageDir,
    entryFile,
    local,
    packageName: entry.packageName,
    npxArgs,
  };

  pluginCache.set(cacheKey, result);
  return result;
}

/**
 * Check whether a server plugin is available locally (installed in node_modules).
 * Useful for `umt doctor` and `umt install` to warn users about missing packages.
 */
export async function checkPluginAvailability(
  entry: ServerRegistryEntry,
): Promise<{ available: boolean; mode: "local" | "npx" | "missing" }> {
  const plugin = await loadPlugin(entry, "auto");
  if (plugin.local) {
    return { available: true, mode: "local" };
  }
  // For npx mode, we assume npx will resolve it.
  return { available: true, mode: "npx" };
}

/**
 * Clear the plugin cache. Useful for testing or after `umt install`.
 */
export function clearPluginCache(): void {
  pluginCache.clear();
}

/**
 * Get the spawn config for running a server plugin via npx.
 * This is the primary way servers are launched — via stdio transport
 * with `npx -y <package> <args>`.
 */
export function getSpawnConfig(entry: ServerRegistryEntry): {
  command: string;
  args: string[];
} {
  // On Windows, npx may need to be invoked as npx.cmd
  const command = IS_WINDOWS ? "npx" : "npx";
  const args = entry.npxArgs
    ? [...entry.npxArgs, entry.packageName, "--transport", "stdio"]
    : ["-y", entry.packageName, "--transport", "stdio"];

  return { command, args };
}
