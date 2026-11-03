# @universal-mcp-toolkit/server-youtube

## 0.1.1

### Patch Changes

- [#19](https://github.com/Markgatcha/universal-mcp-toolkit/pull/19) [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24) Thanks [@Markgatcha](https://github.com/Markgatcha)! - Fix `npx <pkg>` server and CLI startup on macOS/Linux (issue [#18](https://github.com/Markgatcha/universal-mcp-toolkit/issues/18)).
  
  - Build every `bin` with a `#!/usr/bin/env node` shebang via the shared tsdown config. npm symlinks JS bins on POSIX instead of generating a shim, so a missing shebang made the kernel fall back to `/bin/sh` and parse the bundle as shell.
  - Resolve entry points with `realpathSync` before comparing them to `import.meta.url` (new `isMainModule` helper in core). Package-manager `.bin` symlinks made the old comparison false, so the process exited silently even after the shebang was fixed.
  - Add a `prepack` guard that refuses to publish a package whose declared `dist` files are missing or whose bins lack a shebang. `core@0.2.1` was published without `dist/`, so every server pinned to it failed with `ERR_MODULE_NOT_FOUND`.
  - Run `verify:pack` in CI/release and a Linux-only `verify:launch` smoke test that boots every bin through a `.bin` symlink.
- Updated dependencies [[`ae25a08`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/ae25a08afb74c95a8a43d113275ad7d797dd49b2), [`5254223`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/52542238e000ffab11c1184c31527bb61ab74c24), [`3b1dddf`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/3b1dddf11d027f6453e641c960dc4050efacfcb3), [`6566cb7`](https://github.com/Markgatcha/universal-mcp-toolkit/commit/6566cb7dab454788a70672e070300b3ef93a456e)]:
  - @universal-mcp-toolkit/core@0.3.0

## 0.1.0

Initial release.
