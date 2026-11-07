# Tool integrity: pin, audit, and diff

MCP tool definitions are instructions the model trusts. A server can change a
tool description, schema, or annotation after you approved it — a **rug pull** —
and most clients will not ask again. `umt` now keeps a local baseline and tells
you what changed.

This is metadata-level security. It complements, but does not replace,
sandboxing, least-privilege credentials, and human approval for writes.

## Quick start

```bash
# Build the workspace servers first, or add --npx to use the published packages.
pnpm build

# Snapshot every server's tool definitions into umt.lock.json
umt pin

# Check the current definitions against the baseline and run static checks
umt audit

# Show only what drifted
umt diff
```

Scope to specific servers or use the published packages:

```bash
umt pin --server github postgresql
umt audit --server github --strict
umt diff --server github --json
umt pin --npx --lockfile .umt/umt.lock.json
```

`pin` merges into an existing lockfile by default. `--force` replaces it.

## What gets hashed

For each tool:

- `name`
- `title`
- `description`
- `inputSchema`
- `outputSchema`
- `annotations` (`readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`, and any future fields)
- `_meta`

The lockfile stores a full hash plus per-field hashes, so `diff` can say
`description` changed without storing a second copy of every schema. It also
records the server package version, `serverInfo`, and a hash of the
`initialize` instructions.

`icons` are deliberately excluded: they are presentation-only and would create
noise.

## The lockfile

```json
{
  "lockfileVersion": 1,
  "generatedAt": "2026-11-07T00:00:00.000Z",
  "generator": "umt@1.7.0",
  "servers": {
    "github": {
      "package": "@universal-mcp-toolkit/server-github",
      "version": "0.1.0",
      "transport": "stdio",
      "serverInfo": { "name": "github", "version": "0.1.0" },
      "instructionsHash": null,
      "tools": {
        "search_repositories": {
          "hash": "sha256:...",
          "fieldHashes": {
            "name": "sha256:...",
            "title": "sha256:...",
            "description": "sha256:...",
            "inputSchema": "sha256:...",
            "outputSchema": "sha256:...",
            "annotations": "sha256:...",
            "meta": "sha256:..."
          },
          "title": "Search repositories",
          "readOnlyHint": true,
          "descriptionPreview": "Search repositories by name."
        }
      }
    }
  }
}
```

Commit `umt.lock.json` with the project. Review changes to it like you review a
lockfile.

## Findings

| ID | Severity | Meaning |
| --- | --- | --- |
| `UMT-001` | high | Invisible or bidirectional Unicode in tool text |
| `UMT-002` | high | Prompt-injection phrase ("ignore previous instructions", "system prompt") |
| `UMT-003` | high | Asks the model to conceal behavior from the user |
| `UMT-004` | medium | References credential files or environment variables |
| `UMT-005` | medium | Description references a tool from another server (shadowing risk) |
| `UMT-006` | high | Two servers expose the same tool name |
| `UMT-007` | high/low | Annotation mismatch, or a write tool with no `readOnlyHint` |
| `UMT-008` | low | `inputSchema` omits `additionalProperties: false` |
| `UMT-009` | low | Object schema has properties but no `required` fields |
| `UMT-010` | critical | Tool definition changed since pin (possible rug pull) |
| `UMT-011` | medium | Tool added since pin |
| `UMT-012` | medium | Tool removed since pin |
| `UMT-013` | high | Server `instructions` changed since pin |
| `UMT-014` | medium | Server package version changed since pin |
| `UMT-016` | high | Server could not be reached for audit |
| `UMT-017` | medium | `serverInfo` identity changed since pin |
| `UMT-018` | low | No lockfile; static checks only |

`audit` exits non-zero on any critical or high finding. `--strict` fails on any
finding, including low schema lints.

## CI

```yaml
- name: MCP tool integrity
  run: |
    npx -y universal-mcp-toolkit pin --npx
    npx -y universal-mcp-toolkit audit --npx --strict
```

If your CI already builds the workspace, drop `--npx` to verify the local
packages instead of the published ones.

## Limits

- **Metadata only.** A clean-looking description can hide malicious code. This
  cannot inspect server behavior at runtime.
- **Annotations are hints.** A server can claim `readOnlyHint: true` and still
  write. Use least-privilege credentials and human approval for destructive
  actions.
- **Not a sandbox.** Pair this with network controls, filesystem isolation, and
  a gateway that enforces policy.
- **First-party registry only.** `pin`/`audit` currently resolve servers through
  the UMT registry and local build output; remote MCP endpoints are not yet
  covered.

## Relationship to the AI Trio

Tool integrity works standalone. If you also run MemOS, the lockfile is a useful
provenance artifact to store with a project; if you run Guardian, its tool gating
and budget controls are a natural execution-time complement. Neither is
required.
