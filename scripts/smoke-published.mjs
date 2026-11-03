#!/usr/bin/env node
/**
 * Post-publish smoke test: install the just-published tarballs from npm and
 * boot them the same way an MCP host does (`node_modules/.bin/<bin>`).
 *
 * This catches the failure modes from issue #18 at the only place they matter:
 * the registry. Runs after `changeset publish` in the release workflow.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const unexpectedTransport = "__umt_invalid_transport__";

const readJson = (relativePath) => JSON.parse(readFileSync(path.join(repoRoot, relativePath), "utf8"));
const cli = readJson("packages/cli/package.json");
const core = readJson("packages/core/package.json");
const server = readJson("servers/hackernews/package.json");

const targets = [
  { label: core.name, install: `${core.name}@${core.version}`, check: checkCore },
  { label: server.name, install: `${server.name}@${server.version}`, check: checkServer },
  { label: cli.name, install: `${cli.name}@${cli.version}`, check: checkCli },
];

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** npm needs a moment to expose a fresh publish on the read registry. */
async function installWithRetry(directory, spec) {
  let lastError;
  for (let attempt = 1; attempt <= 5; attempt++) {
    const result = spawnSync(
      "npm",
      ["install", "--prefix", directory, "--no-package-lock", "--no-audit", "--no-fund", spec],
      {
        encoding: "utf8",
        shell: isWindows,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 180_000,
      },
    );

    if (!result.error && result.status === 0) return;

    lastError = result.error ?? new Error((result.stderr || result.stdout || "").trim());
    if (result.error?.code === "ENOENT") break;
    console.log(`install ${spec} attempt ${attempt} failed, retrying...`);
    await wait(10_000);
  }
  throw new Error(`could not install ${spec}: ${lastError instanceof Error ? lastError.message : lastError}`);
}

function installedManifest(directory, packageName) {
  const packagePath = path.join(directory, "node_modules", ...packageName.split("/"), "package.json");
  if (!existsSync(packagePath)) throw new Error(`${packageName} was not installed at ${packagePath}`);
  return JSON.parse(readFileSync(packagePath, "utf8"));
}

function binPath(directory, name) {
  return path.join(directory, "node_modules", ".bin", isWindows ? `${name}.cmd` : name);
}

function runBin(directory, name, args) {
  const executable = binPath(directory, name);
  if (!existsSync(executable)) {
    throw new Error(`${name} did not create a .bin shim; the published tarball is probably missing dist/`);
  }
  return spawnSync(executable, args, {
    cwd: directory,
    encoding: "utf8",
    shell: isWindows,
    timeout: 30_000,
  });
}

function checkCore(directory) {
  const manifest = installedManifest(directory, core.name);
  if (manifest.version !== core.version) {
    throw new Error(`registry has ${core.name}@${manifest.version}, expected ${core.version}`);
  }
  for (const file of ["dist/index.mjs", "dist/index.d.mts"]) {
    const absolute = path.join(directory, "node_modules", ...core.name.split("/"), file);
    if (!existsSync(absolute)) throw new Error(`${core.name}@${core.version} is missing ${file}`);
  }
}

function checkServer(directory) {
  const manifest = installedManifest(directory, server.name);
  if (manifest.version !== server.version) {
    throw new Error(`registry has ${server.name}@${manifest.version}, expected ${server.version}`);
  }

  const binName = Object.keys(manifest.bin ?? {})[0];
  if (!binName) throw new Error(`${server.name} declares no bin`);
  const result = runBin(directory, binName, ["--transport", unexpectedTransport]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`${binName} could not execute: ${result.error.message}`);
  if (result.status === 0 && output.trim().length === 0) {
    throw new Error(`${binName} exited silently through the .bin shim (the issue #18 symptom)`);
  }
}

function checkCli(directory) {
  const manifest = installedManifest(directory, cli.name);
  if (manifest.version !== cli.version) {
    throw new Error(`registry has ${cli.name}@${manifest.version}, expected ${cli.version}`);
  }

  const result = runBin(directory, "umt", ["--version"]);
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.status !== 0) throw new Error(`umt --version exited with ${result.status}: ${output.trim()}`);
  if (!output.includes(manifest.version)) {
    throw new Error(`umt --version printed ${JSON.stringify(output.trim())}, expected ${manifest.version}`);
  }
}

let failed = false;
for (const target of targets) {
  const directory = mkdtempSync(path.join(tmpdir(), "umt-published-"));
  try {
    await installWithRetry(directory, target.install);
    target.check(directory);
    console.log(`[ok] ${target.install}`);
  } catch (error) {
    failed = true;
    console.error(`[fail] ${target.install}: ${error instanceof Error ? error.message : error}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (failed) process.exit(1);
