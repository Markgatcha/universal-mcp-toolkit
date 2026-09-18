---
name: umt-mcp
description: Use when the user wants to connect tools or MCP servers to any coding agent or harness (Claude Code, Claude Desktop, Cursor, Kilo Code, Cline, omp, pi, OpenAI Codex, OpenClaw, ZCode, VS Code, Windsurf, Zed, OpenCode, Gemini CLI), asks what MCP servers are available, or wants agentic tooling configured, scaffolded as skills, diagnosed, or updated. Drives the `umt` CLI from the Universal MCP Toolkit.
---

# Universal MCP Toolkit (UMT)

UMT is a registry of 28+ production-ready MCP servers plus a CLI (`umt`) that
connects them to every major coding harness. Data lives locally; servers run
over stdio by default.

## Core commands

- `umt list` — enumerate servers with categories and tool counts
- `umt search <query>` — find servers by name, description, or tool name
- `umt connect` — guided flow: pick servers + harness, writes the real config
- `umt config -s <ids> -t <harness>` — write the harness's own config file
  (merged, `.umt-bak` backup; `--write <path>` overrides the destination)
- `umt config -s <ids> -t json` — print the snippet instead of writing it
- `umt skill <ids>` — scaffold Agent Skills (.agents/skills/umt-*/SKILL.md)
  that teach agents when/how to use each server
- `umt run <id>` — launch one server (with optional `--supervise`)
- `umt doctor [id] [--fix]` — check builds, env vars, and config health
- `umt update [--check]` — self-upgrade the CLI

Prefer `umt connect` for interactive setup and `umt config -t <harness>` for
scripts. Both merge into the harness's real config file and keep a `.umt-bak`
backup — never ask the user to hand-edit harness JSON.

## Harness matrix (`-t/--target`)

Every harness below is a registered write target: `umt config -t <id>` writes
into that harness's own config file, merging with the servers already there and
keeping a `.umt-bak` backup. Paths and schemas were checked against each
harness's official documentation on 2026-09-18.

| Target | Config location | Shape |
| --- | --- | --- |
| claude-desktop | OS-specific `claude_desktop_config.json` | `mcpServers` |
| claude-code | `./.mcp.json` (project) or `~/.claude.json` (user) | `mcpServers` |
| cursor | `~/.cursor/mcp.json` | `mcpServers` |
| kilo | `~/.config/kilo/kilo.jsonc` (project: `.kilo/kilo.jsonc`) | `mcp` (local) |
| cline | VS Code globalStorage `saoudrizwan.claude-dev` → `cline_mcp_settings.json` | `mcpServers` |
| omp | `~/.omp/agent/mcp.json` (project: `.omp/mcp.json`) | `mcpServers` |
| pi | `./.mcp.json` (project) or `~/.config/mcp/mcp.json` (user) | `mcpServers` |
| codex | `~/.codex/config.toml` | `[mcp_servers.*]` TOML |
| openclaw | `~/.openclaw/openclaw.json` | `mcp.servers` |
| zcode | `~/.zcode/cli/config.json` (project: `.zcode/config.json`) | `mcp.servers` |
| windsurf | `~/.codeium/windsurf/mcp_config.json` | `mcpServers` |
| zed | OS-specific Zed `settings.json` | `context_servers` |
| vscode | `./.vscode/mcp.json` (workspace scope) | `servers` |
| opencode | `~/.config/opencode/opencode.json` | `mcp` (local) |
| gemini-cli | `~/.gemini/settings.json` | `mcpServers` |
| json | stdout snippet for manual copying | `mcpServers` |

`pi` needs the `pi-mcp-adapter` extension installed for MCP support at all;
`omp`, `claude-code` and `zcode` also read workspace-scoped files that take
precedence over the user-scope file UMT writes.

## Zero-config servers

`hackernews`, `arxiv`, and `npm-registry` need no environment variables —
good defaults for a first setup. Most others need a token (e.g. `github`
needs `GITHUB_TOKEN`); `umt config` prints exactly which ones after writing.

## When NOT to use

Do not use UMT to run servers the user's harness already configured, and do
not create MCP configs by hand — regenerate them with `umt config --write`
instead so existing settings are merged safely.
