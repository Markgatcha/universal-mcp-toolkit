# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### CI

- **CI minute optimization** — dropped Node 20 from the TypeScript matrix (EOL Apr 2025), reducing the matrix from 9 to 6 jobs (3 OS × 2 Node versions). Added `.github/dependabot.yml` with pnpm/npm/github-actions ecosystems, weekly schedule, auto-rebase, and grouped PRs. Added `.github/workflows/codeql.yml` for javascript-typescript security analysis. Added lockfile verification step to `release.yml`.

### Dependencies Updated

- **axios upgraded from 1.16.0 to 1.18.1** — resolves 10 open GitHub Dependabot alerts (1 High, 9 Moderate) including: NO_PROXY bypass for 0.0.0.0 local addresses, prototype pollution in request construction, excessive recursion DoS in formDataToJSON/deep formToJSON, HTTP/2 and ReadableStream uploads bypassing maxBodyLength, maxDepth bypass in form serializer, and inherited proxy usage after interceptor config cloning.
- **hono upgraded from 4.12.25 to 4.12.31** — resolves 3 moderate vulnerabilities: Server-Side XSS via JSX Escaping Bypass in cx() Utility, API Gateway v1 adapter dropping repeated request header values, and hono/jsx not isolating context per request.
- **@hono/node-server upgraded from 1.19.13 to 2.0.11** — resolves moderate path traversal in `serve-static` on Windows via encoded backslash (`%5C`).
- **js-yaml upgraded from 4.2.0 to 4.3.0** — resolves high-severity quadratic CPU consumption via YAML merge-key chains.
- **fast-uri upgraded from 3.1.2 to 3.1.4** — resolves 2 high-severity host confusion vulnerabilities (literal backslash authority delimiter, failed IDN canonicalization).
- **protobufjs upgraded from 7.6.3 to 7.6.5** — resolves moderate DoS via infinite loop in .proto option parsing.
- **body-parser upgraded from 2.2.2 to 2.3.0** — resolves low-severity denial of service when invalid limit value silently disables size enforcement.
- **pnpm upgraded from 10.32.0 to 11.15.1** (latest). Moved `overrides` from `package.json` (`pnpm.overrides`) to `pnpm-workspace.yaml` — pnpm 11 no longer reads the `pnpm` field in `package.json`. Added `allowBuilds` for native modules (cpu-features, esbuild, protobufjs, ssh2). Regenerated `pnpm-lock.yaml`.

## [1.6.26] - 2026-06-18

### Dependencies Updated

- `@changesets/cli` 2.29→2.31, `@changesets/changelog-github` 0.5→0.7
- `@types/node` 25.4→25.9, `tsx` 4.21→4.22
- Node engine minimum raised to ≥20.19 (ESM stabilization)
- Release pipeline now includes `check:metadata`, `validate:community-catalog`, `audit`, and `conformance` gates

### Added

- **Token-efficient tool responses** — new `token-efficient.ts` module in `@universal-mcp-toolkit/core` with three strategies that reduce the token cost of MCP tool responses:
  - **Tool result caching** — `ToolResultCache` (LRU, bounded, TTL-aware). Identical tool calls return cached results within a 5-minute window.
  - **Smart compression** — `compressOutput()` strips null/undefined values, collapses single-element arrays, removes empty objects. 30-50% size reduction for typical API responses.
  - **Token-aware truncation** — `truncateToTokenBudget()` preserves JSON structure when truncating instead of blindly slicing.
- **`processToolResult()` API** — combined helper integrated into `ToolkitServer`'s tool callback. All servers benefit automatically.
- **Exported from core** — `ToolResultCache`, `compressOutput`, `estimateTokens`, `truncateToTokenBudget`, `processToolResult`.
- **MCP 2025-06-18 spec compliance**: Full support for OAuth 2.1 Protected Resource Metadata (`/.well-known/oauth-protected-resource`), Elicitation, Sampling, and Roots in the core runtime.
- **Connection pooling** — shared `http.Agent` / `https.Agent` with keep-alive enabled (30s timeout, 100 max sockets per origin). Reuses warm TCP connections, saving ~50ms per TLS handshake.
- **Parallel tool execution** — `executeToolsInParallel()` runs multiple tool calls concurrently with bounded concurrency (default 4). Preserves result ordering, handles partial failures, supports per-tool timeouts.
- **Adaptive SSE keepalive** — SSE connections start with 3-second keepalive probes (first 3) to quickly detect dead connections, then back off to 15-second steady-state. 5x faster dead-connection detection.
- **Fast dev builds** — `pnpm build:fast` skips DTS (.d.ts) generation, cutting cold build time from ~56s to ~12s (4.7x faster). Use for local development; use `pnpm build` for production/publish builds that need type declarations.
- **Optimized tsup config** — disabled `minify`, `treeshake`, and `splitting` for server-side packages. These passes added ~12s to cold builds with no benefit for Node.js runtime. Sourcemaps retained for debugging.
- **Turbo cache inputs** — added explicit `inputs` to all turbo tasks so cache invalidation is precise (only rebuilds when source actually changes, not when unrelated files are touched).
- **Anthropic prompt caching support** — `processToolResult()` now accepts `cacheable: true` which adds `cacheControl: { type: "ephemeral" }` to the returned result. MCP servers can pass this directly to the Anthropic API for **84-85% cost reduction on repeated identical tool results** (e.g. same `git log` output across multiple turns). First call is a cache write (1.25x cost), subsequent calls within the 5-minute window are cache reads (0.10x cost).
- **Sentry observability server** (`servers/sentry`): Error tracking and performance monitoring with 8 tools (`capture_exception`, `capture_message`, `add_breadcrumb`, `set_user`, `set_tag`, `set_context`, `start_span`, `get_dsn`).
- **Qdrant vector database server** (`servers/qdrant`): Semantic search and vector operations with 8 tools (`upsert_points`, `search_points`, `scroll_points`, `delete_points`, `create_collection`, `delete_collection`, `list_collections`, `get_collection_info`).
- **Streaming memory leak fix**: Added 1MB buffer limit (`MAX_STREAMING_BUFFER_CHARS`) to prevent memory exhaustion in streaming tool handlers (`packages/core/src/server.ts`).
- **Session eviction race condition fix**: Collect idle session IDs before iteration to avoid map modification during iteration (`packages/core/src/runtime.ts`).
- **`umt doctor --json`**: Machine-readable diagnostics output for CI/CD integration.
- **`umt conformance --json`**: Machine-readable conformance results for CI/CD integration.
- **Guardian config target** (`.guardian/mcp.jsonc`): Full support in config store and CLI with merge-safe writes.
- **Fixed `umt create` scaffold**: Generated servers now work outside the monorepo with proper `tsconfig.json`, devDependencies, and publishable dependencies (`@universal-mcp-toolkit/core` pinned to `^0.2.0`, devDependencies for `@types/node`, `tsup`, `typescript`, `vitest`).
- **Streaming tool buffer limit**: Added `MAX_STREAMING_BUFFER_CHARS = 1_000_000` to prevent memory exhaustion.
- **MCP Registry manifest** (`registry-server.json`) — official [MCP Registry](https://github.com/modelcontextprotocol/registry) submission document under the reverse-DNS name `io.github.markgatcha.universal-mcp-toolkit`. Lists the full tool surface, transports, and environment variables so UMT appears in `mcp-cli search` and registry-aware clients without manual entry.
- **Smithery well-known server card** (`.well-known/mcp/server-card.json`) — the discovery card Smithery and RFC-style crawlers fetch to build a live profile. `version` and `description` are kept in sync with `packages/cli/package.json`.
- **`.well-known/mcp-server.json`** bumped to `1.6.26` with the updated registry description so the runtime-served discovery document matches the published manifests.

### Fixed

- **Session eviction race condition**: Fixed map modification during iteration in `evictIdleSessions` (`packages/core/src/runtime.ts:152-171`).
- **Streaming tool memory leak**: Added `MAX_STREAMING_BUFFER_CHARS = 1_000_000` limit with bounds checking in both invoke and stream paths (`packages/core/src/server.ts:244-268, 358-368`).
- **Doctor/Conformance JSON output**: Optional `--json` flag for machine-readable output.
- **Guardian config support**: Added `guardian` to `ConfigTarget` type with merge-safe `.guardian/mcp.jsonc` writes.
- **Scaffold improvements**: `umt create` now generates publishable packages with `tsconfig.json`, devDependencies, and pinned core dependency.

### Changed

- Core runtime now advertises experimental MCP capabilities (`elicitation`, `sampling`, `roots`) via `experimental` capability field.
- Session eviction now uses two-phase collection to avoid concurrent modification.
- **Cacheable flag on by default** — `packages/core/src/server.ts` now passes `cacheable: true` to `processToolResult()`, so every tool result is emitted with Anthropic `cacheControl: { type: "ephemeral" }` metadata out of the box. Compatible MCP hosts and sibling projects (e.g. llm-guardian) can short-circuit repeated calls without each server opting in. Servers that want the old behavior can pass `cacheable: false` explicitly.
- `packages/cli/package.json` — fixed the package description (now "35 prebuilt MCP servers…"), expanded npm-discovery keywords (9→20) for the revamped npm search, and added `sideEffects: false` for cleaner bundler treeshaking.

### Removed

- Removed server-startup streaming async iterable abort bug (previously aborted consumers before iteration completed).

## [1.2.0-stable] - 2026-03-27

### New MCP Servers

- `@contextcore/mcp-notion` — full Notion workspace integration (8 tools)
- `@contextcore/mcp-playwright` — browser automation and scraping (9 tools)
- `@contextcore/mcp-slack` — Slack workspace integration (10 tools)
- `@contextcore/mcp-openai` — OpenAI/Codex API + any OpenAI-compatible endpoint (8 tools)

### CLI Improvements

- `umt doctor` — environment and config health checker
- `umt status` — view running server processes
- `umt logs` — tail server log files with --follow support
- `umt upgrade` — check and apply package updates
- `umt init` — interactive setup wizard for new users
- `umt run` — start individual servers with hot reload
- `umt search` — search available servers by keyword
- `umt export-config` — export config for Claude Desktop, Cursor, or VS Code
- `umt link memos` — connect to local MemOS/ContextCore memory database

### Multi-Profile Support

- `umt profile create/use/list/show/delete/export/import`
- All commands respect active profile

### Reliability

- Auto-restart on crash via `umt run --supervise`
- Crash loop detection (5 crashes in 60s = stop)
- PID tracking and uptime in `umt status`

### ContextCore Integration

- `umt link memos` bridges universal-mcp-toolkit with MemOS
- Shared namespace support groundwork for v1.3.0

---

## [1.0.0] - 2026-03-21

### 🎉 Initial Release

This is the first stable release of `universal-mcp-toolkit` — a production-ready MCP monorepo that brings 20 real-world integrations under one architecture.

- `@universal-mcp-toolkit/core` — shared runtime with `ToolkitServer` base class, `defineTool` helper, `loadEnv()`, `HttpServiceClient`, `createServerCard()`, and pino logging configured for stderr-safe operation
- `universal-mcp-toolkit` CLI with `list`, `config`, `install`, `run`, and `doctor` commands
- Turborepo monorepo orchestration with shared `tsconfig.base.json`, `vitest.config.ts`, and `pnpm-workspace.yaml`
- TypeScript strict mode across the entire workspace
- Zod schemas for all tool input/output validation
- Stdio and HTTP+SSE transport support across all servers
- `.well-known/mcp-server.json` discovery cards per server
- CI workflow for build, typecheck, and test via GitHub Actions

#### Collaboration Servers

- `@universal-mcp-toolkit/server-github` — repositories, pull requests, workflows, code search
- `@universal-mcp-toolkit/server-notion` — pages, databases, structured document workflows
- `@universal-mcp-toolkit/server-slack` — channels, message history, messaging
- `@universal-mcp-toolkit/server-linear` — issue triage, project planning
- `@universal-mcp-toolkit/server-jira` — tickets, workflow transitions, incident triage

#### Productivity Servers

- `@universal-mcp-toolkit/server-google-calendar` — calendars, events, meeting workflows
- `@universal-mcp-toolkit/server-google-drive` — file search, metadata, exports

#### Media & Commerce Servers

- `@universal-mcp-toolkit/server-spotify` — playback control, search, playlist management
- `@universal-mcp-toolkit/server-stripe` — customers, invoices, subscriptions

#### Data Servers

- `@universal-mcp-toolkit/server-postgresql` — tables, schema inspection, guarded queries
- `@universal-mcp-toolkit/server-mongodb` — collections, document reads, aggregation
- `@universal-mcp-toolkit/server-redis` — keys, TTLs, cache diagnostics
- `@universal-mcp-toolkit/server-supabase` — tables, storage, project access

#### Platform & DevOps Servers

- `@universal-mcp-toolkit/server-vercel` — projects, deployments, environments
- `@universal-mcp-toolkit/server-cloudflare-workers` — workers, routes, edge rollouts
- `@universal-mcp-toolkit/server-docker` — containers, images, daemon state
- `@universal-mcp-toolkit/server-npm-registry` — search, metadata, versions, dist-tags

#### Research & Local Servers

- `@universal-mcp-toolkit/server-hackernews` — top stories, search, threads
- `@universal-mcp-toolkit/server-arxiv` — paper search and reading lists
- `@universal-mcp-toolkit/server-filesystem` — safe local file search, reads, and writes

#### Developer Experience

- `umt list` — browse all 20 servers with env var requirements grouped by category
- `umt config` — generate ready-to-paste JSON for Claude Desktop, Cursor, and any MCP host
- `umt install` — interactive setup: pick servers, choose transport, write config to disk
- `umt run` — launch any server locally with stdio or HTTP+SSE transport
- `umt doctor` — check build output, config state, and required env vars before debugging
- Root `.env.example` covering every integration's required and optional variables
- Claude Desktop and Cursor configuration examples in README

#### Community

- MIT License
- Code of Conduct (Contributor Covenant v2.1)
- GitHub Actions CI workflow
- Listed in [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers) under Aggregators
- Listed on [Glama MCP directory](https://glama.ai/mcp/servers/Markgatcha/universal-mcp-toolkit)

---

[1.0.0]: https://github.com/Markgatcha/universal-mcp-toolkit/releases/tag/v1.0.0