---
"@universal-mcp-toolkit/core": patch
"universal-mcp-toolkit": patch
"@universal-mcp-toolkit/server-airtable": patch
"@universal-mcp-toolkit/server-arxiv": patch
"@universal-mcp-toolkit/server-cloudflare-workers": patch
"@universal-mcp-toolkit/server-discord": patch
"@universal-mcp-toolkit/server-docker": patch
"@universal-mcp-toolkit/server-filesystem": patch
"@universal-mcp-toolkit/server-github": patch
"@universal-mcp-toolkit/server-gmail": patch
"@universal-mcp-toolkit/server-google-calendar": patch
"@universal-mcp-toolkit/server-google-drive": patch
"@universal-mcp-toolkit/server-google-sheets": patch
"@universal-mcp-toolkit/server-hackernews": patch
"@universal-mcp-toolkit/server-jira": patch
"@universal-mcp-toolkit/server-linear": patch
"@universal-mcp-toolkit/server-mongodb": patch
"@universal-mcp-toolkit/server-notion": patch
"@universal-mcp-toolkit/server-npm-registry": patch
"@universal-mcp-toolkit/server-postgresql": patch
"@universal-mcp-toolkit/server-redis": patch
"@universal-mcp-toolkit/server-slack": patch
"@universal-mcp-toolkit/server-spotify": patch
"@universal-mcp-toolkit/server-stripe": patch
"@universal-mcp-toolkit/server-supabase": patch
"@universal-mcp-toolkit/server-trello": patch
"@universal-mcp-toolkit/server-twilio": patch
"@universal-mcp-toolkit/server-vercel": patch
"@universal-mcp-toolkit/server-youtube": patch
---

Fix `npx <pkg>` server and CLI startup on macOS/Linux (issue #18).

- Build every `bin` with a `#!/usr/bin/env node` shebang via the shared tsdown config. npm symlinks JS bins on POSIX instead of generating a shim, so a missing shebang made the kernel fall back to `/bin/sh` and parse the bundle as shell.
- Resolve entry points with `realpathSync` before comparing them to `import.meta.url` (new `isMainModule` helper in core). Package-manager `.bin` symlinks made the old comparison false, so the process exited silently even after the shebang was fixed.
- Add a `prepack` guard that refuses to publish a package whose declared `dist` files are missing or whose bins lack a shebang. `core@0.2.1` was published without `dist/`, so every server pinned to it failed with `ERR_MODULE_NOT_FOUND`.
- Run `verify:pack` in CI/release and a Linux-only `verify:launch` smoke test that boots every bin through a `.bin` symlink.
