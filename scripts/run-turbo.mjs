import { spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

function getTurboBinaryPath() {
  return process.platform === "win32"
    ? path.join(repositoryRoot, "node_modules", ".bin", "turbo.cmd")
    : path.join(repositoryRoot, "node_modules", ".bin", "turbo");
}

/**
 * Read the pinned pnpm version from the root `packageManager` field
 * (e.g. "pnpm@11.20.0" -> "11.20.0"), so the fallback below installs the
 * exact version CI pins instead of drifting to whatever `npx` resolves.
 */
async function getPinnedPnpmVersion() {
  const raw = await readFile(path.join(repositoryRoot, "package.json"), "utf8");
  const pkg = JSON.parse(raw);
  const spec = typeof pkg.packageManager === "string" ? pkg.packageManager : "";
  const match = /^pnpm@(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(spec);
  return match ? match[1] : null;
}

/**
 * Probe whether `corepack` is actually runnable on THIS machine.
 *
 * CI environments run `corepack enable` before invoking these scripts, but
 * plenty of developer machines (Windows installs without corepack on PATH)
 * do not have it. Hardcoding `corepack pnpm` in the shim made every root
 * script (`pnpm build` / `test` / `typecheck`) fail outright on such machines,
 * even though CI stayed green — so we detect instead of assuming.
 */
function hasCorepack() {
  const probe = spawnSync("corepack", ["--version"], {
    // Windows resolves corepack.cmd through the shell; POSIX does not need it.
    shell: process.platform === "win32",
    stdio: "ignore",
    timeout: 15_000,
  });
  return probe.status === 0;
}

/**
 * Probe whether a working `pnpm` binary is already on PATH.
 *
 * The standalone pnpm install (`pnpm setup` / `self-update`) places a shim on
 * PATH that honors the root `packageManager` field and switches versions
 * automatically, so it always runs the pinned version. On Windows with
 * npm 12, the `npx -y pnpm@<version>` fallback is broken (npx writes a .bin
 * launcher pointing at an extensionless path that cmd.exe cannot execute),
 * so a real pnpm on PATH must take priority over the npx fallback.
 */
function hasWorkingPnpmOnPath() {
  const probe = spawnSync("pnpm", ["--version"], {
    shell: process.platform === "win32",
    stdio: "ignore",
    timeout: 30_000,
  });
  return probe.status === 0;
}

/**
 * Build the platform-specific shim body that forwards to pnpm.
 *
 * Preference order:
 *   1. A working `pnpm` already on PATH — no shim needed at all (handled by
 *      the caller; the standalone shim honors `packageManager` itself).
 *   2. `corepack pnpm` when corepack is installed (honors `packageManager`).
 *   3. `npx -y pnpm@<pinned-version>` otherwise — deterministic because the
 *      version comes from the root package.json, not whatever is latest.
 */
async function buildPnpmShimBody() {
  if (hasCorepack()) {
    return process.platform === "win32" ? "corepack pnpm %*" : 'corepack pnpm "$@"';
  }

  const pinnedVersion = await getPinnedPnpmVersion();
  const pnpmSpec = pinnedVersion ? `pnpm@${pinnedVersion}` : "pnpm";
  return process.platform === "win32" ? `npx -y ${pnpmSpec} %*` : `npx -y ${pnpmSpec} "$@"`;
}

/**
 * Ensure a `pnpm` shim is available for turbo's per-package script spawns.
 *
 * Returns the shim directory to prepend to PATH, or `null` when the machine
 * already has a working `pnpm` on PATH (the common case — the standalone
 * pnpm install honors the root `packageManager` pin and switches versions
 * automatically). Prepending a broken npx shim in that case would SHADOW
 * the working binary, which is exactly what broke `pnpm test` on Windows.
 */
async function ensurePnpmShim() {
  if (hasWorkingPnpmOnPath()) {
    return null;
  }

  const shimDirectory = path.join(os.tmpdir(), "universal-mcp-toolkit", "package-manager-shims");
  await mkdir(shimDirectory, { recursive: true });

  const shimBody = await buildPnpmShimBody();

  if (process.platform === "win32") {
    const shimPath = path.join(shimDirectory, "pnpm.cmd");
    await writeFile(shimPath, "@echo off\r\n" + shimBody + "\r\n", "utf8");
    return shimDirectory;
  }

  const shimPath = path.join(shimDirectory, "pnpm");
  await writeFile(shimPath, `#!/usr/bin/env sh\n${shimBody}\n`, "utf8");
  await chmod(shimPath, 0o755);
  return shimDirectory;
}

async function run() {
  const [task, ...extraArgs] = process.argv.slice(2);
  if (!task) {
    throw new Error("Usage: node scripts/run-turbo.mjs <task> [...turbo args]");
  }

  const turboBinaryPath = getTurboBinaryPath();
  const shimDirectory = await ensurePnpmShim();
  const env = {
    ...process.env,
    PATH: `${shimDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
  };

  await new Promise((resolve, reject) => {
    const child = spawn(turboBinaryPath, ["run", task, ...extraArgs], {
      cwd: repositoryRoot,
      env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Turbo task '${task}' exited with code ${code ?? 1}.`));
    });
  });
}

await run().catch((error) => {
  console.error(error instanceof Error ? error.message : "Unknown Turbo wrapper failure.");
  process.exitCode = 1;
});
