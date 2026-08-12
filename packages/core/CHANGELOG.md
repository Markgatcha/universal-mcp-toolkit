# @universal-mcp-toolkit/core

## 0.2.2

### Patch Changes

- 3b1dddf: Migrated build system from tsup to tsdown and upgraded TypeScript to 7.0.2. tsdown is the next-generation bundler powered by Rolldown and Oxc, offering faster builds and native TypeScript 7.x support via rolldown-plugin-dts. All 34 workspace packages now use `tsdown src/index.ts --format esm --dts --clean` instead of the equivalent tsup command. The `tsup.config.ts` was replaced with `tsdown.config.ts`. The TypeScript override in `pnpm-workspace.yaml` was updated from 5.7.3 to 7.0.2, which was previously blocked by tsup's rollup-plugin-dts incompatibility with TS 7.x.

## [Unreleased]

### Features

- **TokenBudgetManager — dynamic context window management** — new `token-manager.ts` module that maps model names (OpenAI, Anthropic, Google, Ollama) to their context window sizes and provides per-call token budget allocation. `getTokenInfo()` resolves a model name to its window size + pre-allocated output/system budgets. `computeToolResultBudget()` calculates available tokens for tool results given current conversation state. `TokenBudgetManager` class tracks consumption across multiple allocations within a single turn. Integrates with existing `compressOutput()` and `truncateToTokenBudget()` from `token-efficient.ts`.
- **Exported `CacheOptions`** from `token-efficient.ts` — was previously private, now exported for consumers building custom caching layers.

## 0.2.1

### Minor Changes

- Added `registerLazyTool()` method to `ToolkitServer` — defers tool registration (handler loading, schema parsing) until the tool is first invoked, improving startup time for servers with many tools.
- `getToolNames()` now includes lazily-registered tools in its return value.

## 0.2.0

### Minor Changes

- [`f92095f`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/f92095fad2d2f823fdcb098972d09dfc51db32af) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Added Notion, Playwright, Slack, OpenAI servers plus new CLI commands
