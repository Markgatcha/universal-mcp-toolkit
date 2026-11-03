#!/usr/bin/env node
/**
 * Fail packaging before a broken tarball reaches npm.
 *
 * Guards the two defects from issue #18:
 *   1. `bin` files without a `#!/usr/bin/env node` shebang (npm symlinks bins on
 *      POSIX, so the kernel falls back to /bin/sh and parses JS as shell).
 *   2. Publishing a package whose `dist/` was never built (core@0.2.1 shipped
 *      with only LICENSE/package.json/README).
 *
 * Usage:
 *   node scripts/verify-packages.mjs            # verify the package in cwd
 *   node scripts/verify-packages.mjs --all      # verify every public package
 *   node scripts/verify-packages.mjs --no-pack  # skip the npm tarball check
 *   node scripts/verify-packages.mjs --launch   # also boot each bin via a symlink
 */
import { execSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NODE_SHEBANG = "#!/usr/bin/env node";
const BOGUS_TRANSPORT = "__umt_invalid_transport__";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const verifyAll = flags.has("--all");
const checkTarball = verifyAll ? !flags.has("--no-pack") : flags.has("--pack");
const checkLaunch = flags.has("--launch");
const isWindows = process.platform === "win32";

/** Package directories in the pnpm workspace. */
function discoverPackages() {
  const directories = [];
  for (const group of ["packages", "servers"]) {
    for (const entry of readdirSync(path.join(repoRoot, group), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const directory = path.join(repoRoot, group, entry.name);
      if (existsSync(path.join(directory, "package.json"))) directories.push(directory);
    }
  }
  return directories;
}

/** Every string path reachable from an `exports` map. */
function collectExportPaths(value, collected = []) {
  if (typeof value === "string") {
    if (value.startsWith("./")) collected.push(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) collectExportPaths(entry, collected);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) collectExportPaths(entry, collected);
  }
  return collected;
}

/** Normalize a manifest path (`./dist/index.mjs`) to a tarball path. */
function toTarballPath(filePath) {
  return path.normalize(filePath).replace(/^\.([\\/])/, "").split(path.sep).join("/");
}

/** Paths npm must ship, with the manifest field that referenced each one. */
function requiredFiles(manifest) {
  const required = new Map();
  const add = (filePath, source) => {
    if (typeof filePath !== "string") return;
    const normalized = toTarballPath(filePath);
    if (!required.has(normalized)) required.set(normalized, source);
  };

  if (typeof manifest.bin === "string") add(manifest.bin, "bin");
  else if (manifest.bin) for (const target of Object.values(manifest.bin)) add(target, "bin");

  for (const entry of collectExportPaths(manifest.exports)) add(entry, "exports");
  add(manifest.main, "main");
  add(manifest.types, "types");

  return required;
}

/** Read the file list npm would publish for this package. */
function packedFiles(directory) {
  const stdout = execSync("npm pack --dry-run --json --ignore-scripts", {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 120_000,
  });
  const jsonStart = stdout.search(/[[{]/);
  if (jsonStart === -1) {
    throw new Error(`npm pack returned no JSON manifest:\n${stdout}`);
  }

  const payload = JSON.parse(stdout.slice(jsonStart).trim());
  // npm 12 returns an object keyed by package name; older npm returns an array.
  const packument = Array.isArray(payload) ? payload[0] : Object.values(payload)[0];
  return new Set((packument.files ?? []).map((file) => file.path.split(path.sep).join("/")));
}

/**
 * Execute a built bin through a package-manager-style symlink.
 *
 * npm links `bin` entries as symlinks on macOS/Linux, so this reproduces the
 * `npx <pkg>` launch path: the kernel runs the shebang, Node loads the real
 * file, and `process.argv[1]` stays on the symlink. Any server that compares
 * those two paths without resolving them exits silently here.
 */
function launchProblems(directory, binTargets) {
  const problems = [];
  if (binTargets.size === 0) return problems;

  const sandbox = mkdtempSync(path.join(tmpdir(), "umt-bin-launch-"));
  try {
    const linkedPackage = path.join(sandbox, "package");
    symlinkSync(directory, linkedPackage, isWindows ? "junction" : "dir");

    for (const target of binTargets) {
      const linkedBin = path.join(linkedPackage, ...target.split("/"));
      const command = isWindows ? process.execPath : linkedBin;
      const args = isWindows ? [linkedBin, "--transport", BOGUS_TRANSPORT] : ["--transport", BOGUS_TRANSPORT];
      const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;

      if (result.error) {
        // A timeout means the server started and waited for MCP input.
        if (result.error.code !== "ETIMEDOUT") {
          problems.push(`${target} could not be launched through a bin symlink: ${result.error.message}`);
        }
      } else if (result.status === 0 && output.trim().length === 0) {
        // The pre-fix symptom: main() never ran, nothing was printed, exit 0.
        problems.push(
          `${target} exited silently through a bin symlink (exit 0, no output); the entry-point check did not match`,
        );
      }
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }

  return problems;
}

function verifyPackage(directory, { pack, launch }) {
  const manifestPath = path.join(directory, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.private) return null;

  const problems = [];
  const required = requiredFiles(manifest);
  const binTargets = new Set(
    (typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {})).map(toTarballPath),
  );

  for (const [filePath, source] of required) {
    const absolute = path.join(directory, ...filePath.split("/"));
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      problems.push(`${filePath} is missing (declared by "${source}"); run \`pnpm build\` before publishing`);
      continue;
    }

    if (binTargets.has(filePath)) {
      const firstLine = readFileSync(absolute, "utf8").split(/\r?\n/, 1)[0];
      if (firstLine !== NODE_SHEBANG) {
        problems.push(`${filePath} must start with "${NODE_SHEBANG}", found ${JSON.stringify(firstLine)}`);
      }
      if (!isWindows && (statSync(absolute).mode & 0o111) === 0) {
        chmodSync(absolute, 0o755);
      }
    }
  }

  const dist = path.join(directory, "dist");
  if (!existsSync(dist) || !statSync(dist).isDirectory()) {
    problems.push('dist/ is missing; run `pnpm build` before publishing');
  } else {
    const built = readdirSync(dist, { recursive: true }).filter((file) => String(file).endsWith(".mjs"));
    if (built.length === 0) problems.push("dist/ contains no .mjs bundles; run `pnpm build` before publishing");
  }

  if (pack && problems.length === 0) {
    let files;
    try {
      files = packedFiles(directory);
    } catch (error) {
      problems.push(`npm pack --dry-run failed: ${error instanceof Error ? error.message : String(error)}`);
      files = null;
    }

    if (files) {
      for (const filePath of required.keys()) {
        if (!files.has(filePath)) {
          problems.push(`${filePath} is not included in the npm tarball (check "files" and .npmignore)`);
        }
      }
    }
  }

  if (launch && problems.length === 0) {
    problems.push(...launchProblems(directory, binTargets));
  }

  return { name: manifest.name, directory, problems, artifacts: required.size, bins: binTargets.size };
}

const targets = verifyAll ? discoverPackages() : [process.cwd()];
const results = [];
for (const directory of targets) {
  const result = verifyPackage(directory, { pack: checkTarball, launch: checkLaunch });
  if (result) results.push(result);
}

const failures = results.filter((result) => result.problems.length > 0);
for (const failure of failures) {
  console.error(`\n[fail] ${failure.name} (${path.relative(repoRoot, failure.directory)})`);
  for (const problem of failure.problems) console.error(`  - ${problem}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} package(s) cannot be published safely.`);
  process.exit(1);
}

const bins = results.reduce((total, result) => total + result.bins, 0);
const checks = [
  `${bins} bin target(s)`,
  checkTarball ? "tarball contents checked" : null,
  checkLaunch ? "bin launch checked" : null,
].filter(Boolean);
console.log(`[ok] ${results.length} package(s) verified (${checks.join(", ")})`);
