---
"universal-mcp-toolkit-monorepo": minor
"universal-mcp-toolkit": patch
"@universal-mcp-toolkit/core": patch
---

Migrated build system from tsup to tsdown and upgraded TypeScript to 7.0.2. tsdown is the next-generation bundler powered by Rolldown and Oxc, offering faster builds and native TypeScript 7.x support via rolldown-plugin-dts. All 34 workspace packages now use `tsdown src/index.ts --format esm --dts --clean` instead of the equivalent tsup command. The `tsup.config.ts` was replaced with `tsdown.config.ts`. The TypeScript override in `pnpm-workspace.yaml` was updated from 5.7.3 to 7.0.2, which was previously blocked by tsup's rollup-plugin-dts incompatibility with TS 7.x.
