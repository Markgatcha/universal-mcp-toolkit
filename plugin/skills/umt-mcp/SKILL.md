---
name: umt-mcp
description: Use when the user wants to connect tools or MCP servers to any coding agent or harness (Claude Code, Claude Desktop, Cursor, OpenAI Codex, Gemini CLI, VS Code, Windsurf, Zed, Cline, OpenCode), asks what MCP servers are available, or wants agentic tooling configured, scaffolded as skills, diagnosed, or updated. Drives the `umt` CLI from the Universal MCP Toolkit.
---

# Universal MCP Toolkit (UMT)

UMT is a registry of 28+ production-ready MCP servers plus a CLI (`umt`) that
connects them to every major coding harness. Data lives locally; servers run
over stdio by default.

## Core commands

- `umt list` — enumerate servers with categories and tool counts
- `umt search <query>` — find servers by name, description, or tool name
- `umt connect` — guided flow: pick servers + harness, writes the real config
- `umt config -s <ids> -t <harness> --write` — non-interactive config write
- `umt skill <ids>` — scaffold Agent Skills (.agents/skills/umt-*/SKILL.md)
  that teach agents when/how to use each server
- `umt run <id>` — launch one server (with optional `--supervise`)
- `umt doctor [id] [--fix]` — check builds, env vars, and config health
- `umt update [--check]` — self-upgrade the CLI

Prefer `umt connect` for interactive setup and `umt config … --write` for
scripts. Both merge into the harness's real config file and keep a `.umt-bak`
backup — never ask the user to hand-edit harness JSON.

## Harness matrix (`-t/--target`)

| Target | Config location |
| --- | --- |
| claude-desktop | OS-specific `claude_desktop_config.json` |
| claude-code | `./.mcp.json` (project scope) |
| cursor | `~/.cursor/mcp.json` |
| codex | `~/.codex/config.toml` (managed TOML block) |
| gemini-cli | `~/.gemini/settings.json` |
| vscode | `./.vscode/mcp.json` (workspace scope) |
| windsurf | `~/.codeium/windsurf/mcp_config.json` |
| zed | OS-specific Zed `settings.json` |
| opencode | `~/.config/opencode/opencode.json` |
| cline | VS Code globalStorage `cline_mcp_settings.json` |
| agents-md | `./AGENTS.md` (managed markdown section) |
| json | stdout snippet for manual copying |

## Zero-config servers

`hackernews`, `arxiv`, and `npm-registry` need no environment variables —
good defaults for a first setup. Most others need a token (e.g. `github`
needs `GITHUB_TOKEN`); `umt config` prints exactly which ones after writing.

## When NOT to use

Do not use UMT to run servers the user's harness already configured, and do
not create MCP configs by hand — regenerate them with `umt config --write`
instead so existing settings are merged safely.
