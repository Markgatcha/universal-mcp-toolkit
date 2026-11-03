import { readFileSync } from "node:fs";
import path from "node:path";

import { defineConfig } from "tsdown";

const NODE_SHEBANG = "#!/usr/bin/env node";

/**
 * `bin` targets declared by the package being built, as output file names
 * relative to the build directory (for example `index.mjs`). tsdown resolves
 * this shared config from each workspace package, so the manifest is read from
 * the package that is currently building.
 */
function readBinOutputs(): Set<string> {
  try {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      bin?: string | Record<string, string>;
    };
    const declared = typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});
    return new Set(declared.map((target) => path.basename(target)));
  } catch {
    return new Set();
  }
}

const binOutputs = readBinOutputs();

export default defineConfig({
  // Executables need a shebang: npm on macOS/Linux symlinks `bin` entries
  // instead of generating a shim, and the kernel cannot exec a file without
  // one (it falls back to `/bin/sh` and chokes on the first `import`).
  ...(binOutputs.size > 0
    ? {
        banner: ({ fileName }: { fileName: string }) =>
          binOutputs.has(path.basename(fileName)) ? { js: NODE_SHEBANG } : undefined,
      }
    : {}),
});
