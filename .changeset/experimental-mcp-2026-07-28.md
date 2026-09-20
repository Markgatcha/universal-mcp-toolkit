---
"@universal-mcp-toolkit/bridge": minor
"universal-mcp-toolkit": minor
---

## Experimental MCP 2026-07-28 feature set: Tasks, MRTR, cache hints, drift defense

Additive support for the experimental MCP `2026-07-28` protocol era, with
dual-era compatibility for `2025-06-18` / `2025-11-25` servers.

**Bridge (`@universal-mcp-toolkit/bridge`)**
- Tasks lifecycle: `getTaskSupport()`, `spawnTaskToolCall()`, `getTask()`,
  `listServerTasks()`, `awaitTaskCompletion()` (with `onProgress` polling),
  `cancelTask()`, `linkTaskChild()`, `getSpawnedTaskIds()`
- Cancellation cascades: cancelling a parent task depth-first cancels its
  linked child tasks (disable with `{ cascade: false }`)
- MRTR (`input_required`) loops: `callToolWithMrtr()` answers server input
  requests via an `onInputRequest` handler, resubmits with byte-exact
  `requestState`, caps rounds with `MrtrRoundLimitError`, and surfaces
  unanswered rounds via `MrtrInputRequiredError`
- Server-advertised cache hints: `listTools({ refresh: true })` extracts
  `_meta` TTL/scope hints; result cache honors advertised TTLs and exposes
  them via `getCacheStats()`; `getListCacheHint()` returns the hint
- `tools/list` definition-drift defense: SHA-256 digest pinning of
  canonicalized tool definitions, `definition-drift` events naming added /
  removed / modified tools, `getToolsDigest()` / `resetToolsDigest()`

**CLI (`umt`)**
- `umt tools call <tool> --server <id> --args <json>` — direct calls with
  interactive MRTR prompting (`--max-rounds`, `--json`)
- `umt tools call --task` — spawn a long-running task, stream progress,
  await completion (falls back to a direct call on non-task servers)
- `umt task spawn|status|await|cancel` — full task lifecycle management
- Loud red `definition-drift` warnings on every connect (supply-chain
  attack surface), printed to stderr so `--json` output stays clean
