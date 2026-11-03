#!/usr/bin/env node
/**
 * Keep the distributable plugin in lockstep with the npm packages.
 *
 * The plugin's `mcp.json` pins exact server versions and the plugin manifests
 * carry the CLI version, so a release that forgets to update either would keep
 * users on old (possibly broken) packages. Runs in CI and in the release
 * workflow before `changeset publish`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));

const cli = readJson("packages/cli/package.json");
const pluginManifests = ["plugin/plugin.json", "plugin/.claude-plugin/plugin.json"];
const mcpConfig = readJson("plugin/mcp.json");

const workspaceVersions = new Map();
for (const group of ["packages", "servers"]) {
  for (const directory of readdirSync(path.join(repoRoot, group))) {
    const manifestPath = path.join(repoRoot, group, directory, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    workspaceVersions.set(manifest.name, manifest.version);
  }
}

const problems = [];

for (const manifestPath of pluginManifests) {
  const manifest = readJson(manifestPath);
  if (manifest.version !== cli.version) {
    problems.push(`${manifestPath}: version ${manifest.version} != packages/cli ${cli.version}`);
  }
}

const marketplacePath = ".claude-plugin/marketplace.json";
if (existsSync(path.join(repoRoot, marketplacePath))) {
  const marketplace = readJson(marketplacePath);
  const listing = marketplace.plugins?.find((entry) => entry.name === "umt");
  if (!listing) {
    problems.push(`${marketplacePath}: does not list the "umt" plugin`);
  } else if (listing.version !== cli.version) {
    problems.push(`${marketplacePath}: umt version ${listing.version} != packages/cli ${cli.version}`);
  }
}

const pinnedPackage = /^(@[^/]+\/[^@]+|[^@][^@]*)@(.+)$/;
for (const [serverName, config] of Object.entries(mcpConfig.mcpServers ?? {})) {
  if (config.command !== "npx") {
    problems.push(`plugin/mcp.json: ${serverName} must launch through npx`);
    continue;
  }

  const requested = (config.args ?? []).find((arg) => typeof arg === "string" && pinnedPackage.test(arg));
  if (!requested) {
    problems.push(`plugin/mcp.json: ${serverName} does not pin a package version`);
    continue;
  }

  const [, packageName, version] = requested.match(pinnedPackage);
  const localVersion = workspaceVersions.get(packageName);
  if (!localVersion) {
    problems.push(`plugin/mcp.json: ${serverName} points at ${packageName}, which is not a workspace package`);
  } else if (localVersion !== version) {
    problems.push(`plugin/mcp.json: ${serverName} pins ${packageName}@${version}, workspace has ${localVersion}`);
  }
}

if (problems.length > 0) {
  console.error("Plugin/package drift detected:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(`\nFix: set both plugin manifests to ${cli.version} and re-pin plugin/mcp.json to the workspace versions.`);
  process.exit(1);
}

console.log(`[ok] plugin manifests and mcp.json pins match the workspace (CLI ${cli.version})`);
