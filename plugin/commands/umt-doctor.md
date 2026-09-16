---
description: Diagnose UMT MCP server setup — builds, environment variables, and config health
---

Diagnose the user's Universal MCP Toolkit (UMT) setup.

1. Run `npx universal-mcp-toolkit doctor` for a full pass over the server registry: missing build outputs, missing environment variables, and config health.
2. If the user names a specific server, scope it: `npx universal-mcp-toolkit doctor <server-id>`.
3. For each issue reported:
   - Missing env var → tell the user exactly which variable and where to set it (shell profile or harness config). Offer to add a placeholder via `umt config -s <id> -t <harness> --write`.
   - Missing build output (workspace mode) → offer `npx universal-mcp-toolkit doctor --fix`, which auto-builds the local package.
4. Finish with a one-line verdict: healthy, or the single next action that fixes the most issues.
