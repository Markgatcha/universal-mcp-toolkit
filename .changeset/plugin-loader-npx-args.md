---
"universal-mcp-toolkit": patch
---

Fix plugin launch args for companion packages that declare explicit `npxArgs` (for example MemOS). `getSpawnConfig` and `loadPlugin` appended the package name (and `--transport stdio`) a second time, so `npx` received the package twice and the MemOS `mcp` subcommand was followed by a duplicate package spec.
