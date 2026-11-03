import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Whether the calling module is the process entry point.
 *
 * Call with `isMainModule(import.meta.url)`; `import.meta.url` is module-scoped,
 * so the caller must pass its own URL.
 *
 * Package managers expose `bin` entries as symlinks on macOS and Linux (for
 * example `node_modules/.bin/umt-hackernews` -> `../@universal-mcp-toolkit/
 * server-hackernews/dist/index.mjs`). Node resolves the real path for
 * `import.meta.url` but leaves `process.argv[1]` pointing at the symlink, so a
 * plain string comparison makes every `npx <pkg>`-launched server exit before
 * it can start. Comparing real paths keeps direct execution and symlinked
 * execution equivalent.
 */
export function isMainModule(
  metaUrl: string,
  entryPoint: string | undefined = process.argv[1],
): boolean {
  if (typeof entryPoint !== "string" || entryPoint.length === 0) {
    return false;
  }

  try {
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(entryPoint);
  } catch {
    // The entry point can be missing (REPL, `node -e`, bundlers), and a stale
    // symlink can make realpath fail. Neither case is a main-module launch.
    return false;
  }
}
