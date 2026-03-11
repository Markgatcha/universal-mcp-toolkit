import { spawn } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
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

async function ensurePnpmShim() {
  const shimDirectory = path.join(os.tmpdir(), "universal-mcp-toolkit", "package-manager-shims");
  await mkdir(shimDirectory, { recursive: true });

  if (process.platform === "win32") {
    const shimPath = path.join(shimDirectory, "pnpm.cmd");
    await writeFile(shimPath, "@echo off\r\ncorepack pnpm %*\r\n", "utf8");
    return shimDirectory;
  }

  const shimPath = path.join(shimDirectory, "pnpm");
  await writeFile(shimPath, "#!/usr/bin/env sh\ncorepack pnpm \"$@\"\n", "utf8");
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
