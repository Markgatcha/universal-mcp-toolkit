---
description: Survey the Universal MCP Toolkit — available servers, install state, and how to connect them to any harness
---

Help the user explore and connect MCP servers from the Universal MCP Toolkit (UMT).

1. Run `npx universal-mcp-toolkit list` to enumerate the available servers, their categories, and tool counts.
2. Summarize the result in a compact table grouped by category, marking which servers the user already has configured if `umt doctor` shows it.
3. Ask what the user wants to accomplish, then recommend 1–3 servers.
4. To connect them, offer to run `npx universal-mcp-toolkit connect` (guided), or write configs directly with `npx universal-mcp-toolkit config -s <server-ids> -t <harness> --write` — supported harnesses: claude-desktop, claude-code, cursor, codex, gemini-cli, vscode, windsurf, zed, opencode, cline, agents-md.
5. Mention `npx universal-mcp-toolkit skill <server-ids>` as the way to scaffold Agent Skills so coding agents know when to use each server.
