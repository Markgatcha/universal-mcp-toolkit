# universal-mcp-toolkit

## [Unreleased]

### Features

- **Extended `umt discover` with `--remote` and `--url` flags** — discover remote MCP servers over HTTP by fetching `.well-known/mcp-server.json` manifests from any URL. Supports comma-separated URL lists and 10-second timeouts per fetch. Merged with local node_modules discovery so a single command shows both local and remote servers.

## 1.7.0

### Minor Changes

- [`162dea9`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/162dea9780b4a9b21922595647b9a336f5ba8059) Thanks [@Markgatcha](https://github.com/Markgatcha)! - ## Experimental MCP 2026-07-28 feature set: Tasks, MRTR, cache hints, drift defense
  
  Additive support for the experimental MCP `2026-07-28` protocol era, with
  dual-era compatibility for `2025-06-18` / `2025-11-25` servers.
  
  **Bridge (`@universal-mcp-toolkit/bridge`)**
  - Tasks lifecycle: `getTaskSupport()`, `spawnTaskToolCall()`, `getTask()`,
    `listServerTasks()`, `awaitTaskCompletion()` (with `onProgress` polling),
    `cancelTask()`, `linkTaskChild()`, `getSpawnedTaskIds()`
  - Cancellation cascades: cancelling a parent task depth-first cancels its
    linked child tasks (disable with `{ cascade: false }`)
  - MRTR (`input_required`) loops: `callToolWithMrtr()` answers server input
    requests via an `onInputRequest` handler, resubmits with byte-exact
    `requestState`, caps rounds with `MrtrRoundLimitError`, and surfaces
    unanswered rounds via `MrtrInputRequiredError`
  - Server-advertised cache hints: `listTools({ refresh: true })` extracts
    `_meta` TTL/scope hints; result cache honors advertised TTLs and exposes
    them via `getCacheStats()`; `getListCacheHint()` returns the hint
  - `tools/list` definition-drift defense: SHA-256 digest pinning of
    canonicalized tool definitions, `definition-drift` events naming added /
    removed / modified tools, `getToolsDigest()` / `resetToolsDigest()`
  
  **CLI (`umt`)**
  - `umt tools call <tool> --server <id> --args <json>` — direct calls with
    interactive MRTR prompting (`--max-rounds`, `--json`)
  - `umt tools call --task` — spawn a long-running task, stream progress,
    await completion (falls back to a direct call on non-task servers)
  - `umt task spawn|status|await|cancel` — full task lifecycle management
  - Loud red `definition-drift` warnings on every connect (supply-chain
    attack surface), printed to stderr so `--json` output stays clean

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

- [`7bb3c95`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/7bb3c9536705d2067604b48099f3c00d5127a974) Thanks [@Markgatcha](https://github.com/Markgatcha)! - ## Bridge: MCP-to-Function-Calling Bridge (v1.1.0)
  
  Published the `@universal-mcp-toolkit/bridge` package — connect any MCP server to OpenAI, Anthropic, or Ollama function-calling format. This package makes the 27 UMT servers usable with any LLM provider, not just MCP-compatible ones.
  
  **Features:**
  - `MCPFunctionCallingBridge` — connect to any MCP server (stdio/SSE/HTTP), list tools, and call them
  - `toOpenAI()`, `toAnthropic()`, `toOllama()` — serialize MCP tools to any provider's function-calling format
  - `toProvider(tools, model)` — auto-detect provider from model name
  - `serializeAll()` — generate all three formats lazily
  - `BridgeConversation` — full agent conversation loop with tool calling
  - TTL + LRU result caching
  - Health monitoring with circuit breaker and auto-reconnect
  - Policy-based RBAC (allow/deny rules with conditions)
  - Audit logging with automatic secret redaction
  - Transport-level auth (OAuth 2.1 bearer tokens, API keys)
  - A2A Protocol server adapter (expose MCP tools via Google's A2A)
  - Multi-server sessions with parallel tool calls
  - `umt-bridge` CLI for testing
  
  **Usage:**
  ```typescript
  import { MCPFunctionCallingBridge, toOpenAI } from "@universal-mcp-toolkit/bridge";
  
  const bridge = new MCPFunctionCallingBridge({
    transport: "stdio",
    commandOrUrl: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
  });
  await bridge.connect();
  const { tools } = await bridge.listTools();
  const openAITools = toOpenAI(tools);
  ```
  
  ## AI SDK: Vercel AI SDK Integration
  
  Published `@universal-mcp-toolkit/ai-sdk` — adapter that lets you use UMT's 27 MCP servers directly with the Vercel AI SDK's `streamText()` and `generateText()` functions. Zero boilerplate — turn any MCP server into AI SDK tools in one line.
  
  **Features:**
  - `umtTools({ servers })` — returns AI SDK-compatible tool objects
  - Streaming tool results via async generators
  - Auto-reconnect with circuit breaker from the bridge
  - Per-tool TTL caching of results
  - Works with any AI SDK provider (OpenRouter, OpenAI, Anthropic, Ollama)
  
  **Usage:**
  ```typescript
  import { streamText } from "ai";
  import { umtTools } from "@universal-mcp-toolkit/ai-sdk";
  
  const tools = await umtTools({
    servers: ["github"],
    env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
  });
  
  const result = await streamText({
    model: openrouter("google/gemini-2.0-flash"),
    prompt: "List open issues in owner/repo",
    tools,
  });
  ```
  
  ## CLI: Bridge CLI + experimental server surfacing
  
  - `umt-bridge` CLI command for testing MCP servers with any LLM provider
  - `packages/bridge` integrated into the Turbo build pipeline
  - Server discovery now distinguishes 27 production-ready servers from 8 experimental stubs
  - Documentation updated for consistent server counts across README, docs, and well-known manifests

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

- Fix plugin launch args for companion packages that declare explicit `npxArgs` (for example MemOS). `getSpawnConfig` and `loadPlugin` appended the package name (and `--transport stdio`) a second time, so `npx` received the package twice and the MemOS `mcp` subcommand was followed by a duplicate package spec.

- [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Migrated build system from tsup to tsdown and upgraded TypeScript to 7.0.2. tsdown is the next-generation bundler powered by Rolldown and Oxc, offering faster builds and native TypeScript 7.x support via rolldown-plugin-dts. All 34 workspace packages now use `tsdown src/index.ts --format esm --dts --clean` instead of the equivalent tsup command. The `tsup.config.ts` was replaced with `tsdown.config.ts`. The TypeScript override in `pnpm-workspace.yaml` was updated from 5.7.3 to 7.0.2, which was previously blocked by tsup's rollup-plugin-dts incompatibility with TS 7.x.
- Updated dependencies [[`7bb3c95`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/7bb3c9536705d2067604b48099f3c00d5127a974), [`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2), [`162dea9`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/162dea9780b4a9b21922595647b9a336f5ba8059), [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24), [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3), [`6566cb7`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/6566cb7dab454788a70672e070300b3ef93a456e)]:
  - @universal-mcp-toolkit/bridge@1.2.0
  - @universal-mcp-toolkit/core@0.3.0

## 1.6.28

### Features

- **New `umt discover` command** — scan local `node_modules` and npx-installed packages for MCP servers that publish `.well-known/mcp-server.json` manifests. Lists discovered servers with their tools, descriptions, and paths. Supports `--json` output for programmatic use. Finds third-party MCP servers not in the built-in registry.
- **Lazy plugin loader** — server packages are now resolved dynamically at runtime instead of being statically bundled. New `plugin-loader.ts` module supports `npx`, `workspace`, and `auto` load modes with caching.
- **Bridge dependency added** — CLI now depends on `@universal-mcp-toolkit/bridge` for the `compose` command.
- **Bridge upgraded to 1.1.0** — includes sessions, health monitoring, streaming, caching, and type-safe chaining.

## 1.6.27

### Features

- **New `umt tools list` command** — discover all MCP tools exposed by servers in the toolkit. Supports `--server` filtering (e.g. `--server github,slack`) and `--query` substring search (e.g. `--query issue`). Outputs a table or JSON with server ID, tool name, and description.
- **New `umt compose` command** — pipe the output of one MCP server's tool into another server's tool. Useful for chaining workflows (e.g., search GitHub → create a Notion page from results). Supports `__PIPE__` placeholder for auto-substituting source output into destination args.

### Minor Changes

- Added `@universal-mcp-toolkit/bridge` as a dependency of the CLI package for the `compose` command.
- Updated `packageManager` from pnpm 11.17.0 to 11.20.0.

## 1.3.0

### Minor Changes

- [`f92095f`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/f92095fad2d2f823fdcb098972d09dfc51db32af) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Added Notion, Playwright, Slack, OpenAI servers plus new CLI commands

### Patch Changes

- Updated dependencies [[`f92095f`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/f92095fad2d2f823fdcb098972d09dfc51db32af)]:
  - @universal-mcp-toolkit/server-notion@0.2.0
  - @contextcore/mcp-notion@1.3.0
  - @universal-mcp-toolkit/server-npm-registry@0.2.0
  - @contextcore/mcp-openai@1.3.0
  - @contextcore/mcp-playwright@1.3.0
  - @universal-mcp-toolkit/server-slack@0.2.0
  - @contextcore/mcp-slack@1.3.0
  - @universal-mcp-toolkit/server-airtable@0.1.1
  - @universal-mcp-toolkit/server-arxiv@0.1.1
  - @universal-mcp-toolkit/server-cloudflare-workers@0.1.1
  - @universal-mcp-toolkit/server-discord@0.1.1
  - @universal-mcp-toolkit/server-docker@0.1.1
  - @universal-mcp-toolkit/server-filesystem@0.1.1
  - @universal-mcp-toolkit/server-github@0.1.1
  - @universal-mcp-toolkit/server-google-calendar@0.1.1
  - @universal-mcp-toolkit/server-google-drive@0.1.1
  - @universal-mcp-toolkit/server-hackernews@0.1.1
  - @universal-mcp-toolkit/server-jira@0.1.1
  - @universal-mcp-toolkit/server-linear@0.1.1
  - @universal-mcp-toolkit/server-mongodb@0.1.1
  - @universal-mcp-toolkit/server-postgresql@0.1.1
  - @universal-mcp-toolkit/server-redis@0.1.1
  - @universal-mcp-toolkit/server-spotify@0.1.1
  - @universal-mcp-toolkit/server-stripe@0.1.1
  - @universal-mcp-toolkit/server-supabase@0.1.1
  - @universal-mcp-toolkit/server-trello@0.1.1
  - @universal-mcp-toolkit/server-vercel@0.1.1
