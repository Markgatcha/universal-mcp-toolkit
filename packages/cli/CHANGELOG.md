# universal-mcp-toolkit

## [Unreleased]

### Features

- **Extended `umt discover` with `--remote` and `--url` flags** — discover remote MCP servers over HTTP by fetching `.well-known/mcp-server.json` manifests from any URL. Supports comma-separated URL lists and 10-second timeouts per fetch. Merged with local node_modules discovery so a single command shows both local and remote servers.

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
