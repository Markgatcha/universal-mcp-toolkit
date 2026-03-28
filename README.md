# universal-mcp-toolkit
[![CI](https://github.com/Markgatcha/universal-mcp-toolkit/actions/workflows/ci.yml/badge.svg)](https://github.com/Markgatcha/universal-mcp-toolkit/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE) [![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue?logo=typescript)](https://www.typescriptlang.org/) [![pnpm](https://img.shields.io/badge/maintained%20with-pnpm-cc00ff.svg?logo=pnpm)](https://pnpm.io/) [![npm](https://img.shields.io/npm/v/universal-mcp-toolkit?label=npm)](https://www.npmjs.com/package/universal-mcp-toolkit)
[![npm downloads](https://img.shields.io/npm/dm/universal-mcp-toolkit?label=downloads&color=red)](https://www.npmjs.com/package/universal-mcp-toolkit)
[![universal-mcp-toolkit MCP server](https://glama.ai/mcp/servers/Markgatcha/universal-mcp-toolkit/badges/score.svg)](https://glama.ai/mcp/servers/Markgatcha/universal-mcp-toolkit)
![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)
![Code Coverage](https://img.shields.io/codecov/c/github/Markgatcha/universal-mcp-toolkit)


The canonical open-source monorepo for production-ready Model Context Protocol servers.

If you have ever wanted one place to find great MCP servers for GitHub, Slack, Notion, databases, cloud platforms, research sources, and local files without stitching together a dozen half-finished repos, this is it.

## ⚡ Quick Start

The fastest way to get going:

```bash
# See all 20 available servers
npx universal-mcp-toolkit list

# Interactive setup — pick your servers, choose transport, write config
npx universal-mcp-toolkit install

# Generate a Claude Desktop config snippet
npx universal-mcp-toolkit config --server github slack filesystem --target claude-desktop

# Run a server locally
npx universal-mcp-toolkit run github --transport stdio

# Check your environment before debugging
npx universal-mcp-toolkit doctor github
```

Or install globally:

```bash
npm install -g universal-mcp-toolkit
umt list
```

## Why this exists

The MCP ecosystem is exploding, but the developer experience is still fragmented.

- Most repos solve one narrow integration.
- Many servers stop at a demo-quality tool or two.
- Transport support, auth handling, docs, and packaging are wildly inconsistent.
- There is no obvious reference implementation that shows how a serious MCP monorepo should feel.

`universal-mcp-toolkit` fixes that with one opinionated, high-quality Turborepo:

- 23 production-focused MCP servers
- One shared strict-mode TypeScript core
- One polished CLI for install, config, run, and diagnostics
- Consistent Zod validation, structured errors, and pino logging
- Stdio plus HTTP+SSE support across the toolkit
- Discovery-friendly `.well-known/mcp-server.json` server cards

## What makes this worth starring

- Real developer utility right now
- Great default ergonomics for Claude Desktop, Cursor, and local workflows
- A single architecture you can learn once and extend everywhere
- Strong package hygiene with exports maps, keywords, build scripts, and test hooks
- A repo designed to be both a product and a reference implementation

## The short version

| Category | What you get |
| --- | --- |
| Core runtime | `@universal-mcp-toolkit/core` with typed tool registration, env loading, Zod validation, pino logging, stdio and HTTP+SSE runtime bootstrapping |
| Unified CLI | `universal-mcp-toolkit` with `list`, `config`, `install`, `run`, and `doctor` |
| Collaboration servers | GitHub, Notion, Slack, Linear, Jira, Discord, Trello |
| Productivity servers | Google Calendar, Google Drive |
| Media and commerce servers | Spotify, Stripe |
| Data servers | PostgreSQL, MongoDB, Redis, Supabase, Airtable |
| Platform servers | Vercel, Cloudflare Workers, Docker, npm Registry |
| Research and local servers | Hacker News, arXiv, FileSystem |

## Comparison

| Option | Breadth | DX quality | Shared architecture | Host config help | Documentation polish |
| --- | --- | --- | --- | --- | --- |
| `universal-mcp-toolkit` | 23 servers in one monorepo | High | Yes | Yes | High |
| Single-service MCP repos | Narrow | Varies | No | Rarely | Varies |
| Personal one-off scripts | Very narrow | Low | No | No | Usually none |

## Supported servers

| Server | Focus | Primary required env |
| --- | --- | --- |
| GitHub | Repositories, pull requests, workflows, search | `GITHUB_TOKEN` |
| Notion | Pages, databases, structured docs | `NOTION_TOKEN` |
| Slack | Channels, history, messaging | `SLACK_BOT_TOKEN` |
| Linear | Issue triage and planning | `LINEAR_API_KEY` |
| Jira | Tickets, workflow transitions, incident triage | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` |
| Google Calendar | Calendars, events, meeting workflows | `GOOGLE_CALENDAR_ACCESS_TOKEN` |
| Google Drive | Search, metadata, exports | `GOOGLE_DRIVE_ACCESS_TOKEN` |
| Spotify | Playback, search, playlists | `SPOTIFY_ACCESS_TOKEN` |
| Stripe | Customers, invoices, subscriptions | `STRIPE_SECRET_KEY` |
| PostgreSQL | Tables, schema inspection, guarded queries | `POSTGRESQL_URL` |
| MongoDB | Collections, document reads, aggregation | `MONGODB_URI` |
| Redis | Keys, TTLs, cache diagnostics | `REDIS_URL` |
| Supabase | Tables, storage, project access | `SUPABASE_URL`, `SUPABASE_KEY` |
| Vercel | Projects, deployments, environments | `VERCEL_TOKEN` |
| Cloudflare Workers | Workers, routes, edge rollouts | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` |
| Docker | Containers, images, daemon state | none required |
| npm Registry | Search, metadata, versions, dist-tags | none required |
| Hacker News | Top stories, search, threads | none required |
| arXiv | Paper search and reading lists | none required |
| FileSystem | Safe local file search, reads, writes | `FILESYSTEM_ROOTS` |
| Discord | Guilds, channels, messages, members | `DISCORD_BOT_TOKEN` |
| Airtable | Tables, records, CRUD operations | `AIRTABLE_API_KEY`, `AIRTABLE_BASE_ID` |
| Trello | Boards, lists, cards, archiving | `TRELLO_API_KEY`, `TRELLO_TOKEN` |

Some servers also expose optional tuning variables such as `POSTGRESQL_ALLOW_WRITES`, `REDIS_ALLOW_WRITES`, `MONGODB_ALLOW_WRITE_PIPELINES`, `VERCEL_TEAM_ID`, or `FILESYSTEM_MAX_READ_BYTES`. The root `.env.example` includes the most useful knobs.

## Repository layout

```text
universal-mcp-toolkit/
├─ packages/
│  ├─ core/
│  └─ cli/
├─ servers/
│  ├─ github/
│  ├─ notion/
│  ├─ slack/
│  ├─ linear/
│  ├─ jira/
│  ├─ google-calendar/
│  ├─ google-drive/
│  ├─ spotify/
│  ├─ stripe/
│  ├─ postgresql/
│  ├─ mongodb/
│  ├─ redis/
│  ├─ supabase/
│  ├─ vercel/
│  ├─ cloudflare-workers/
│  ├─ docker/
│  ├─ npm-registry/
│  ├─ hackernews/
│  ├─ arxiv/
│  ├─ discord/
│  ├─ airtable/
│  ├─ trello/
│  └─ filesystem/
├─ turbo.json
├─ pnpm-workspace.yaml
└─ README.md
```

## Quick start

### Clone and install

```bash
git clone https://github.com/universal-mcp-toolkit/universal-mcp-toolkit.git
cd universal-mcp-toolkit
corepack pnpm install
```

### Build the workspace

```bash
corepack pnpm build
```

### Explore what is available

```bash
corepack pnpm --filter universal-mcp-toolkit exec umt list
```

### Generate a host config snippet

```bash
corepack pnpm --filter universal-mcp-toolkit exec umt config --server github slack filesystem --target claude-desktop --mode workspace
```

### Run a server locally

```bash
corepack pnpm --filter universal-mcp-toolkit exec umt run github --transport stdio
```

### Check your environment

```bash
corepack pnpm --filter universal-mcp-toolkit exec umt doctor github
```

## CLI experience

The CLI is designed to feel like a real product, not a pile of scripts.

### `umt list`

See every available server, grouped by category with required environment variables and descriptions.

### `umt config`

Generate ready-to-paste JSON for Claude Desktop, Cursor, or any MCP-compatible host config flow.

### `umt install`

Run an interactive setup flow, choose servers, choose `npx` or workspace mode, write the result to disk, and save the profile for later reference.

### `umt run`

Launch any built workspace server locally with stdio or HTTP+SSE transport.

### `umt doctor`

Check build output, config state, and required environment variables before you waste time debugging a missing token or missing `dist` file.

## Configuration examples

### Claude Desktop

Paste a generated snippet into your Claude Desktop config file. On Windows, that is commonly:

```text
%APPDATA%\Claude\claude_desktop_config.json
```

Example:

```json
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-github", "--transport", "stdio"],
      "env": {
        "GITHUB_TOKEN": "${GITHUB_TOKEN}"
      }
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-filesystem", "--transport", "stdio"],
      "env": {
        "FILESYSTEM_ROOTS": "${FILESYSTEM_ROOTS}"
      }
    }
  }
}
```

### Cursor

Generate the same `mcpServers` snippet and place it into the MCP config file you use for Cursor. The CLI keeps the format host-friendly and consistent, so the same generated JSON works well as a reusable snippet:

```json
{
  "mcpServers": {
    "slack": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-slack", "--transport", "stdio"],
      "env": {
        "SLACK_BOT_TOKEN": "${SLACK_BOT_TOKEN}"
      }
    },
    "linear": {
      "command": "npx",
      "args": ["-y", "@universal-mcp-toolkit/server-linear", "--transport", "stdio"],
      "env": {
        "LINEAR_API_KEY": "${LINEAR_API_KEY}"
      }
    }
  }
}
```

## Transport model

Every server in the toolkit is designed around the same transport story:

- `stdio` for local child-process integrations
- `HTTP+SSE` for remote or browser-adjacent integrations
- discovery metadata exposed through `.well-known/mcp-server.json`

The shared core handles runtime bootstrapping, logging, env loading, and tool registration so every server behaves consistently.

## Core package

`@universal-mcp-toolkit/core` is the part you will want to study if you are building your own MCP servers.

It includes:

- `ToolkitServer` base class
- `defineTool<TInput, TOutput>` helper
- `loadEnv()` for strict configuration validation
- `HttpServiceClient` for typed fetch-based integrations
- `createServerCard()` for discovery metadata
- `parseRuntimeOptions()` and `runToolkitServer()` for stdio and HTTP+SSE launch flows
- pino logging configured for stderr-safe server operation

## Engineering standards

- TypeScript strict mode across the workspace
- Zod schemas for input and output validation
- Explicit structured errors for config, validation, and upstream failures
- Consistent package manifests with exports maps and keywords
- Server cards under `.well-known/`
- Turborepo orchestration for build, typecheck, test, and clean flows

## Release philosophy

This repo is meant to be the reference implementation developers point to when they ask:

- What should a serious MCP monorepo look like?
- How should server packages be documented and discovered?
- How do you keep 20 integrations consistent without turning the codebase into a mess?

The answer should be: clone this repo, run the CLI, read the core package, and adapt the parts you need.

## Development workflow

```bash
corepack pnpm install
corepack pnpm build
corepack pnpm typecheck
corepack pnpm test
```

Use Turbo filters when you only want to work on one package:

```bash
corepack pnpm --filter @universal-mcp-toolkit/core build
corepack pnpm --filter universal-mcp-toolkit typecheck
corepack pnpm --filter @universal-mcp-toolkit/server-github test
```

## Package highlights

### `packages/core`

Shared runtime primitives and strict abstractions for server authors.

### `packages/cli`

The operator console for listing, configuring, installing, running, and diagnosing the entire toolkit.

### `servers/*`

Twenty independently publishable MCP server packages that all share the same operational shape.

## Roadmap direction

The monorepo is intentionally structured so it can grow without losing coherence.

- Add more servers without inventing a new architecture every time
- Improve server cards as discovery standards evolve
- Expand host config templates as more MCP clients standardize their formats
- Deepen smoke and contract tests across transports

## Community

Please read [`CODE_OF_CONDUCT.md`](./CODE_OF_CONDUCT.md) before participating in issues, pull requests, reviews, or discussions. The project aims to stay both technically rigorous and welcoming to contributors at every experience level.

## Persistent Memory

Pair universal-mcp-toolkit with **[MemOS](https://github.com/Markgatcha/memos)** for persistent, graph-based memory across agent sessions.

```bash
# Add persistent memory to your MCP agents
pip install memos
npm install @memos/sdk
```

MemOS acts as the **memory layer** for your MCP stack — every tool call, result, and context your agent produces can be stored, retrieved, and searched across restarts and sessions. A native MCP adapter is coming in MemOS v0.2.

| Layer | Tool | Role |
|-------|------|------|
| Transport & Tools | universal-mcp-toolkit | MCP protocol, server registry, tool routing |
| Memory & Persistence | [MemOS](https://github.com/Markgatcha/memos) | Graph-based persistent memory across sessions |
| LLM Inference | Ollama / any LLM | Local model execution |

---

## ⭐ Star History

[![Star History Chart](https://api.star-history.com/svg?repos=Markgatcha/universal-mcp-toolkit&type=Date)](https://star-history.com/#Markgatcha/universal-mcp-toolkit&Date)

---

## 💬 Used By the Community

Building something with `universal-mcp-toolkit`? We'd love to know.

Open a [Discussion](https://github.com/Markgatcha/universal-mcp-toolkit/discussions) and tell us:

- What you're building
- Which servers you're using
- Any integrations or workflows you've set up

You might get featured here.

### Known uses

- **Claude Desktop + GitHub + FileSystem** — local dev assistant that reads repos and writes to disk
- **Cursor + PostgreSQL + Supabase** — database-aware AI code completion
- **Paired with [MemOS](https://github.com/Markgatcha/memos)** — persistent agent memory across sessions

---

## 📦 Show & Tell

If you've created a custom server, workflow, or integration using this toolkit as a base, open a PR to add it to the [Wiki](https://github.com/Markgatcha/universal-mcp-toolkit/wiki) or start a [Discussion](https://github.com/Markgatcha/universal-mcp-toolkit/discussions/new?category=show-and-tell). The best examples will be highlighted in the README.

---

## License

MIT — see [LICENSE](./LICENSE) for full terms.

## License

MIT
