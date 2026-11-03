#!/usr/bin/env node
/**
 * Keep the versions that are not in package.json in sync with it:
 *   - `metadata.version` (or `SERVER_VERSION`) in each server's src/index.ts
 *   - the `version` field in each server's .well-known/mcp-server.json
 *
 * `changeset version` only bumps package.json, so without this step every
 * server reports the previous release in its MCP handshake and discovery
 * manifest. Run via `pnpm version-packages`.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serversDirectory = path.join(repoRoot, "servers");
const changed = [];

for (const directory of readdirSync(serversDirectory)) {
  const serverDirectory = path.join(serversDirectory, directory);
  const manifestPath = path.join(serverDirectory, "package.json");
  if (!existsSync(manifestPath)) continue;

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const version = manifest.version;

  const sourcePath = path.join(serverDirectory, "src", "index.ts");
  if (existsSync(sourcePath)) {
    let source = readFileSync(sourcePath, "utf8");
    const original = source;

    if (/const SERVER_VERSION = "[^"]*";/.test(source)) {
      source = source.replace(/const SERVER_VERSION = "[^"]*";/, `const SERVER_VERSION = "${version}";`);
    } else {
      const metadataStart = source.indexOf("export const metadata");
      if (metadataStart !== -1) {
        const head = source.slice(0, metadataStart);
        const tail = source.slice(metadataStart);
        source = head + tail.replace(/version:\s*"[^"]*"/, `version: "${version}"`);
      }
    }

    if (source !== original) {
      writeFileSync(sourcePath, source);
      changed.push(path.relative(repoRoot, sourcePath));
    }
  }

  const wellKnownPath = path.join(serverDirectory, ".well-known", "mcp-server.json");
  if (existsSync(wellKnownPath)) {
    const card = JSON.parse(readFileSync(wellKnownPath, "utf8"));
    if (card.version !== version) {
      card.version = version;
      writeFileSync(wellKnownPath, `${JSON.stringify(card, null, 2)}\n`);
      changed.push(path.relative(repoRoot, wellKnownPath));
    }
  }
}

for (const file of changed) console.log(`updated ${file}`);
console.log(`[ok] synced ${changed.length} file(s) to package.json versions`);
