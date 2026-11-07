---
"universal-mcp-toolkit": minor
---

Add `umt pin`, `umt audit`, and `umt diff` for MCP tool-definition integrity. The lockfile hashes complete tool definitions (including schemas and annotations), detects rug pulls, server-instruction changes, duplicate tool names, and common poisoning patterns, and can fail CI on critical or high findings.
