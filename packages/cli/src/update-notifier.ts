import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

/**
 * Update notification system for the UMT CLI.
 *
 * Checks the npm registry for a newer version of `universal-mcp-toolkit`
 * and shows a non-blocking notification at CLI startup. Results are cached
 * in the user's state directory to avoid hitting the registry on every
 * invocation (checks once per day).
 *
 * This helps drive download spikes after releases — when a new version is
 * published, users see the prompt, update, and the package climbs npm charts.
 */

const PACKAGE_NAME = "universal-mcp-toolkit";
const REGISTRY_URL = "https://registry.npmjs.org";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface UpdateCheckResult {
  latestVersion: string;
  checkedAt: number;
}

/**
 * Get the path to the update check cache file.
 */
function getUpdateCachePath(): string {
  const stateDir = process.env.APPDATA
    ? path.join(process.env.APPDATA, "universal-mcp-toolkit")
    : path.join(os.homedir(), ".universal-mcp-toolkit");
  return path.join(stateDir, "update-check.json");
}

/**
 * Read the cached update check result, if it exists and is fresh.
 */
async function getCachedUpdateCheck(currentVersion: string): Promise<UpdateCheckResult | null> {
  try {
    const contents = await readFile(getUpdateCachePath(), "utf8");
    const cached = JSON.parse(contents) as UpdateCheckResult;
    if (cached.latestVersion === currentVersion) {
      return cached;
    }
    if (Date.now() - cached.checkedAt < CHECK_INTERVAL_MS) {
      return cached;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Persist the update check result to disk.
 */
async function setCachedUpdateCheck(result: UpdateCheckResult): Promise<void> {
  try {
    await mkdir(path.dirname(getUpdateCachePath()), { recursive: true });
    await writeFile(getUpdateCachePath(), JSON.stringify(result, null, 2), "utf8");
  } catch {
    // Silently ignore cache write failures — the update check is best-effort.
  }
}

/**
 * Fetch the latest version of the package from the npm registry.
 */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const response = await fetch(`${REGISTRY_URL}/${PACKAGE_NAME}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { "dist-tags"?: { latest?: string } };
    return data["dist-tags"]?.latest ?? null;
  } catch {
    return null;
  }
}

/**
 * Compare two semver version strings. Returns:
 *  - positive if a > b
 *  - negative if a < b
 *  - 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .replace(/^[v^~]/, "")
      .split(".")
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] ?? 0;
    const nb = pb[i] ?? 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

/**
 * Commands that should skip the update check entirely.
 */
const SKIP_UPDATE_CHECK_COMMANDS = new Set([
  "update",
  "--version",
  "-V",
  "--help",
  "-h",
  "config",
]);

/**
 * Check if the update notification should be skipped based on CLI args.
 */
function shouldSkipUpdateCheck(argv: readonly string[]): boolean {
  if (argv.includes("--no-update-check")) return true;
  for (const arg of argv) {
    if (SKIP_UPDATE_CHECK_COMMANDS.has(arg)) return true;
  }
  return false;
}

export interface UpdateNotification {
  currentVersion: string;
  latestVersion: string;
  updateCommand: string;
}

/**
 * Check for a newer version of the CLI and return a notification if one is available.
 *
 * This is a best-effort check — failures are silently ignored. The result is
 * cached for 24 hours to avoid hitting the registry on every invocation.
 *
 * @param currentVersion The currently installed version.
 * @param argv The CLI arguments (used to skip the check for certain commands).
 * @returns An update notification if a newer version is available, null otherwise.
 */
export async function checkForUpdate(
  currentVersion: string,
  argv: readonly string[] = process.argv,
): Promise<UpdateNotification | null> {
  if (shouldSkipUpdateCheck(argv)) return null;

  // Try cache first
  const cached = await getCachedUpdateCheck(currentVersion);
  if (cached && compareVersions(cached.latestVersion, currentVersion) <= 0) {
    return null;
  }

  const latestVersion = cached?.latestVersion ?? (await fetchLatestVersion());
  if (!latestVersion) return null;

  // Update cache
  await setCachedUpdateCheck({ latestVersion, checkedAt: Date.now() });

  if (compareVersions(latestVersion, currentVersion) > 0) {
    return {
      currentVersion,
      latestVersion,
      updateCommand: "umt update",
    };
  }

  return null;
}
