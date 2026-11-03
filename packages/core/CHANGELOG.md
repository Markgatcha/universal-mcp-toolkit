# @universal-mcp-toolkit/core

## [Unreleased]

### Features

- **TokenBudgetManager — dynamic context window management** — new `token-manager.ts` module that maps model names (OpenAI, Anthropic, Google, Ollama) to their context window sizes and provides per-call token budget allocation. `getTokenInfo()` resolves a model name to its window size + pre-allocated output/system budgets. `computeToolResultBudget()` calculates available tokens for tool results given current conversation state. `TokenBudgetManager` class tracks consumption across multiple allocations within a single turn. Integrates with existing `compressOutput()` and `truncateToTokenBudget()` from `token-efficient.ts`.
- **Exported `CacheOptions`** from `token-efficient.ts` — was previously private, now exported for consumers building custom caching layers.

## 0.3.0

### Minor Changes

- [`6566cb7`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/6566cb7dab454788a70672e070300b3ef93a456e) Thanks [@Markgatcha](https://github.com/Markgatcha)! - ## Experimental `umt vet`: live MCP spec-conformance + security vetting
  
  New live-wire vetting of **running** servers (complements the static
  `mcp-vet`-style source scans): `umt vet <server-id-or-url> [--json]` probes
  what a server actually negotiates over the wire — no LLM anywhere.
  
  **Core (`@universal-mcp-toolkit/core`, new `vet.ts`)**
  - Protocol negotiation matrix: fresh `initialize` per known `protocolVersion`
    (`2026-07-28` → `2024-11-05`), recording the negotiated version so the
    report shows exactly which spec revisions the server accepts.
  - Transport detection for URL targets (Streamable HTTP tried first, legacy
    SSE fallback), `Mcp-Session-Id` issuance + stateless-capability probing,
    observation of deprecated server→client primitives (`sampling/createMessage`,
    `roots/list`, which moved to MRTR in 2026-07-28), and `_meta` inspection.
  - Deterministic tool-poisoning scan of live `tools/list` metadata (instruction
    overrides, system-prompt theft, role hijack, exfiltration directives,
    credential harvesting, suspicious URLs, obfuscated blobs) — every finding
    carries an actionable suggestion.
  - Permission-risk tiering per tool (read/write/network/exec) from MCP
    annotations, name, and schema shapes, plus an aggregate risk profile.
  - Exit-code contract: `0` clean, `1` security findings, `2` protocol error.
  
  **CLI (`universal-mcp-toolkit`)**
  - `umt vet <server-id-or-url> [--json]` with human and machine-readable reports.
  - `tools/list` drift pins persisted to `~/.universal-mcp-toolkit/vet-pins.json`,
    wired into the bridge's `digestToolsList`/`checkDefinitionDrift` machinery —
    first vet records the pin, later vets report `match`/`drift` with
    added/removed/modified tool names.
  - `umt doctor --vet [serverId]` runs vetting as a non-blocking sub-check.
  - New `umt add <server-id-or-url> [--skip-vet] [--json]` registers a server in
    the CLI state file after a non-blocking vet advisory (advisory only — a
    failed vet still registers, loudly).

### Patch Changes

- [`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2) - ## Dependency Updates
  
  Routine dependency updates across all workspace packages:
  
  - **turbo** 2.10.6 → 2.10.10 (latest)
  - **tsx** 4.23.1 → 4.23.12 (latest)
  - **@types/node** 26.1.1 → 26.2.0 (latest)
  - **@changesets/cli** 2.31.1 → 3.0.0 (major)
  - **@changesets/changelog-github** 0.7.0 → 1.0.0 (major)
  - **postcss** 8.5.23 → 8.5.26 (pinned override updated in `pnpm-workspace.yaml`)
  
  The `postcss` override in `pnpm-workspace.yaml` was bumped from `8.5.23` to `8.5.26` (a patch release with no known vulnerabilities, superseding the security pin). All workspace package devDependencies referencing `@types/node` and `tsx` were updated to match the latest versions.

- [#19](https://github.com/Markgatcha/universal-mcp-toolkit/pull/19) [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Fix `npx <pkg>` server and CLI startup on macOS/Linux (issue [#18](https://github.com/Markgatcha/universal-mcp-toolkit/issues/18)).
  
  - Build every `bin` with a `#!/usr/bin/env node` shebang via the shared tsdown config. npm symlinks JS bins on POSIX instead of generating a shim, so a missing shebang made the kernel fall back to `/bin/sh` and parse the bundle as shell.
  - Resolve entry points with `realpathSync` before comparing them to `import.meta.url` (new `isMainModule` helper in core). Package-manager `.bin` symlinks made the old comparison false, so the process exited silently even after the shebang was fixed.
  - Add a `prepack` guard that refuses to publish a package whose declared `dist` files are missing or whose bins lack a shebang. `core@0.2.1` was published without `dist/`, so every server pinned to it failed with `ERR_MODULE_NOT_FOUND`.
  - Run `verify:pack` in CI/release and a Linux-only `verify:launch` smoke test that boots every bin through a `.bin` symlink.

- [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Migrated build system from tsup to tsdown and upgraded TypeScript to 7.0.2. tsdown is the next-generation bundler powered by Rolldown and Oxc, offering faster builds and native TypeScript 7.x support via rolldown-plugin-dts. All 34 workspace packages now use `tsdown src/index.ts --format esm --dts --clean` instead of the equivalent tsup command. The `tsup.config.ts` was replaced with `tsdown.config.ts`. The TypeScript override in `pnpm-workspace.yaml` was updated from 5.7.3 to 7.0.2, which was previously blocked by tsup's rollup-plugin-dts incompatibility with TS 7.x.

## 0.2.1

### Minor Changes

- Added `registerLazyTool()` method to `ToolkitServer` — defers tool registration (handler loading, schema parsing) until the tool is first invoked, improving startup time for servers with many tools.
- `getToolNames()` now includes lazily-registered tools in its return value.

## 0.2.0

### Minor Changes

- [`f92095f`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/f92095fad2d2f823fdcb098972d09dfc51db32af) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Added Notion, Playwright, Slack, OpenAI servers plus new CLI commands
