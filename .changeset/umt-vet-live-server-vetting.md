---
"@universal-mcp-toolkit/core": minor
"universal-mcp-toolkit": minor
---

## Experimental `umt vet`: live MCP spec-conformance + security vetting

New live-wire vetting of **running** servers (complements the static
`mcp-vet`-style source scans): `umt vet <server-id-or-url> [--json]` probes
what a server actually negotiates over the wire — no LLM anywhere.

**Core (`@universal-mcp-toolkit/core`, new `vet.ts`)**
- Protocol negotiation matrix: fresh `initialize` per known `protocolVersion`
  (`2026-07-28` → `2024-11-05`), recording the negotiated version so the
  report shows exactly which spec revisions the server accepts.
- Transport detection for URL targets (Streamable HTTP tried first, legacy
  SSE fallback), `Mcp-Session-Id` issuance + stateless-capability probing,
  observation of deprecated server→client primitives (`sampling/createMessage`,
  `roots/list`, which moved to MRTR in 2026-07-28), and `_meta` inspection.
- Deterministic tool-poisoning scan of live `tools/list` metadata (instruction
  overrides, system-prompt theft, role hijack, exfiltration directives,
  credential harvesting, suspicious URLs, obfuscated blobs) — every finding
  carries an actionable suggestion.
- Permission-risk tiering per tool (read/write/network/exec) from MCP
  annotations, name, and schema shapes, plus an aggregate risk profile.
- Exit-code contract: `0` clean, `1` security findings, `2` protocol error.

**CLI (`universal-mcp-toolkit`)**
- `umt vet <server-id-or-url> [--json]` with human and machine-readable reports.
- `tools/list` drift pins persisted to `~/.universal-mcp-toolkit/vet-pins.json`,
  wired into the bridge's `digestToolsList`/`checkDefinitionDrift` machinery —
  first vet records the pin, later vets report `match`/`drift` with
  added/removed/modified tool names.
- `umt doctor --vet [serverId]` runs vetting as a non-blocking sub-check.
- New `umt add <server-id-or-url> [--skip-vet] [--json]` registers a server in
  the CLI state file after a non-blocking vet advisory (advisory only — a
  failed vet still registers, loudly).
