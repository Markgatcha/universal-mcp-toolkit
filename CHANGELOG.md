# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.0] - 2026-03-21

### 🎉 Initial Release

This is the first stable release of `universal-mcp-toolkit` — a production-ready MCP monorepo that brings 20 real-world integrations under one architecture.

### Added

#### Core Infrastructure
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

## [Unreleased]

### Planned
- Individual per-server npm package publishing (`@universal-mcp-toolkit/server-*`)
- MemOS native MCP adapter integration (v0.2)
- Expanded host config templates as more MCP clients standardize
- Deeper smoke and contract tests across transports
- More servers based on community requests

---

[1.0.0]: https://github.com/Markgatcha/universal-mcp-toolkit/releases/tag/v1.0.0
