import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Inline the workspace packages so vitest can mock them properly.
    // This is needed because the workspace packages are ESM-only and
    // vitest's default CJS resolution can't handle them on Windows with
    // pnpm's isolated linker.
    deps: {
      inline: [/node_modules/],
    },
    server: {
      deps: {
        inline: [/universal-mcp-toolkit/],
      },
    },
  },
});
