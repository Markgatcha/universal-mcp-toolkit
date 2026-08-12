# universal-mcp-toolkit

## 1.6.28

### Patch Changes

- 7bb3c95: ## Bridge: MCP-to-Function-Calling Bridge (v1.1.0)

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
  import {
    MCPFunctionCallingBridge,
    toOpenAI,
  } from "@universal-mcp-toolkit/bridge";

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

- 7bb3c95: Fixed 5 security vulnerabilities by bumping transitive dependency overrides in `pnpm-workspace.yaml`:

  - **hono** 4.12.34 → 4.13.0 — resolves Algorithmic Complexity DoS (Language Middleware), ReDoS in CORS middleware (Access-Control-Request-Headers), data leakage via `memo()` retaining SSR output across requests, and response header leakage in Proxy Helper Connection header handling.
  - **fast-uri** 3.1.5 → 4.1.2 — resolves host confusion vulnerabilities: CVE-2026-6322 (percent-encoded authority delimiters), CVE-2026-16221 (literal backslash authority delimiter), CVE-2026-18446 (backslash authority introducer).
  - **ip-address** 10.3.1 → 10.4.0 — latest clean release (10.3.1 was the initial CVE-2026-69192 fix; 10.4.0 confirmed 0 vulnerabilities by Snyk).
  - **js-yaml** — range overrides for 3.x bumped to 3.15.1 and 4.x bumped to 4.3.1, resolving CVE-2026-59870 (Quadratic CPU consumption in `!!omap` resolution).
  - **nanoid** 3.3.16 → 3.3.18 — resolves CVE-2026-67213 (infinite loop in custom generators when size is zero).

- 3b1dddf: Migrated build system from tsup to tsdown and upgraded TypeScript to 7.0.2. tsdown is the next-generation bundler powered by Rolldown and Oxc, offering faster builds and native TypeScript 7.x support via rolldown-plugin-dts. All 34 workspace packages now use `tsdown src/index.ts --format esm --dts --clean` instead of the equivalent tsup command. The `tsup.config.ts` was replaced with `tsdown.config.ts`. The TypeScript override in `pnpm-workspace.yaml` was updated from 5.7.3 to 7.0.2, which was previously blocked by tsup's rollup-plugin-dts incompatibility with TS 7.x.
- Updated dependencies [7bb3c95]
- Updated dependencies [7bb3c95]
  - @universal-mcp-toolkit/bridge@1.2.0

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
