# @universal-mcp-toolkit/core

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
