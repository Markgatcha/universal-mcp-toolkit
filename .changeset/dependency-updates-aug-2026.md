---
"universal-mcp-toolkit-monorepo": patch
"universal-mcp-toolkit": patch
"@universal-mcp-toolkit/core": patch
"@universal-mcp-toolkit/bridge": patch
"@universal-mcp-toolkit/ai-sdk": patch
---

## Dependency Updates

Routine dependency updates across all workspace packages:

- **turbo** 2.10.6 → 2.10.10 (latest)
- **tsx** 4.23.1 → 4.23.12 (latest)
- **@types/node** 26.1.1 → 26.2.0 (latest)
- **@changesets/cli** 2.31.1 → 3.0.0 (major)
- **@changesets/changelog-github** 0.7.0 → 1.0.0 (major)
- **postcss** 8.5.23 → 8.5.26 (pinned override updated in `pnpm-workspace.yaml`)

The `postcss` override in `pnpm-workspace.yaml` was bumped from `8.5.23` to `8.5.26` (a patch release with no known vulnerabilities, superseding the security pin). All workspace package devDependencies referencing `@types/node` and `tsx` were updated to match the latest versions.