# UMT Codebase Improvements Plan

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Systematically improve the universal-mcp-toolkit monorepo across test coverage, code quality, robustness, and developer experience, prioritized by impact and risk.

**Architecture:** The UMT monorepo has 3 internal packages (`core`, `bridge`, `cli`) + a `servers/` directory of 35+ MCP servers. Tests use Vitest, builds use tsdown, linting is `tsc --noEmit`. The CLI uses Commander, pino for logging, and has a server registry in `registry.ts`.

**Tech Stack:** TypeScript 7.0.2 (strict), pnpm 11.20.0 workspace, Turborepo, Vitest 4.x, tsdown (Rolldown), MCP SDK 1.30, Zod 4.4.3, pino, commander, chalk, ora, inquirer, cli-table3.

---

## Summary of Findings

### Current Test Coverage (5 test files total)
- `packages/cli/test/cli.test.ts` — 5 tests (registry config generation, npx/workspace/snippet generation)
- `packages/cli/test/update-notifier.test.ts` — 7 tests (`compareVersions` only)
- `packages/bridge/test/serializers.test.ts` — 8 tests (provider serialization)
- `packages/core/test/toolkit-server.test.ts` — 5 tests (server metadata, runtime options, error normalization)
- `packages/core/test/auth.test.ts` — 5 tests (OAuth2TokenProvider)

**Total: 30 tests across 5 files, covering ~10 source files out of ~30+ source files.**

### Major Gaps Identified

1. **`bridge.ts` (580 lines)** — 0 tests. Contains `MCPFunctionCallingBridge` with caching, timeouts, error wrapping, `callTool`, `callToolStreaming`, `callToolChain`, `normalizeResult`, `buildCacheKey`, `storeInCache`, `getCacheStats`, `disconnect`, `connect`, `listTools`, `createTransport`.
2. **`conversation.ts` (316 lines)** — 0 tests. Contains `BridgeConversation` with `run()`, `detectProviderFormat`, `serializeTools`.
3. **`session.ts` (208 lines)** — 0 tests. Contains `Session` with `create`, `callTool`, `callToolsParallel`, `listAllTools`, `close`.
4. **`health-monitor.ts` (221 lines)** — 0 tests. Circuit breaker, exponential backoff, reconnect logic.
5. **`config-store.ts` (242 lines)** — 0 tests. Profile management, state persistence, env placeholder generation.
6. **`plugin-loader.ts` (151 lines)** — 0 tests. Plugin resolution, npx/workspace modes.
7. **`tool-cache.ts` (217 lines)** — 0 tests. LRU cache with stats.
8. **`core/src/token-efficient.ts` (558 lines)** — 0 tests. `ToolResultCache`, `estimateTokens`, `truncateToTokenBudget`, `compressOutput`, `processToolResult`, `executeToolsInParallel`, `summarizeToolResult`, `orderTools`, `executeWithFallback`.
9. **`core/src/lazy-server.ts` (238 lines)** — 0 tests. `LazyServerManager` with registration, lazy startup, idle sweep.
10. **`core/src/http.ts` (229 lines)** — 0 tests. `HttpServiceClient` with retry, backoff, rate limiting.
11. **`core/src/render-text.ts` (281 lines)** — 0 tests. `formatTable`, `formatList`, `formatKeyValue`, `formatError`, `formatStatus`.
12. **`core/src/card.ts`** — 1 test (via toolkit-server.test.ts integration).
13. **`cli/src/index.ts` (1793 lines, 1 file)** — Only 5 tests. The monolithic `index.ts` contains ~30 CLI command handlers (`runServer`, `runDoctor`, `runUpdate`, `runTest`, `runConformance`, `runExport`, `runProfileList`, `runProfileUse`, `runProfileDelete`, `runProfileRename`, `runProfileDuplicate`, `runStatus`, `runLogs`, `runUpgrade`, `runInit`, `runSearch`, `runExportConfig`, `runLinkMemos`, `runProfileCreate`, `runProfileShow`, `runProfileExport`, `runProfileImport`, `runConformance`, `runStdioHandshake`, `formatUptime`, `rotateLogFile`, `substitutePipe`, etc.) — none directly tested.
14. **`cli/src/output.ts` (76 lines)** — 0 tests. `renderServerTable`, `renderToolTable`, `renderStatusLabel`, `printSection`.
15. **`cli/src/plugin-loader.ts`** — 0 tests. Already covered by gap #6.

### Code Quality Issues Found

1. **`-` placeholder in `cli.ts` (bridge)** — The `createLLMProvider` function and `chatCmd` take `apiKey: ***>` — this is a placeholder that TypeScript accepts but is semantically `any`. The `createLLMProvider` is a **stub** that returns `{ content: "Hello from the bridge!", toolCalls: [] }` — it doesn't actually call any LLM provider. This is a significant gap for anyone trying to use the bridge CLI's chat feature.

2. **Monolithic CLI** — All ~30 command handlers are in a single 1793-line `index.ts`. Should be split into separate command modules (e.g., `commands/server.ts`, `commands/profile.ts`, `commands/cache.ts`, `commands/discovery.ts`).

3. **Duplicated stdio handshake logic** — `runStdioHandshake` in CLI (lines 672-759) and the inline MCP JSON-RPC parsing in `runTest` (lines 500-614) duplicate similar logic for spawning a server process, sending `initialize` + `tools/list`, and parsing responses.

4. **`detectProvider` duplication** — The provider detection logic (`starts with "claude"` → anthropic, etc.) is duplicated in three places:
   - `packages/bridge/src/serializers.ts` (lines 243-253)
   - `packages/bridge/src/conversation.ts` (lines 289-297)
   
   This should be centralized in one place, ideally in `core` or `bridge`'s types.

5. **`BridgeConversation.detectProviderFormat`** duplicates `detectProvider` from `serializers.ts` instead of reusing it.

6. **`serializePipe` in `substitutePipe`** — The `__PIPE__` substitution in the `compose` command works but doesn't handle nested objects or arrays containing `__PIPE__` as a sub-value within strings (it only matches exact string equality). This is acceptable but could be documented better.

7. **`tool-cache.ts` uses tabs** while the rest of the codebase uses 2-space indentation (see `tsconfig.base.json` — no `useTabs` setting, but other files consistently use 2 spaces). The `tool-cache.ts` file should be reformatted to match.

8. **`RateLimiter` in `core/src/rate-limiter.ts`** — The `acquire()` method uses `setTimeout` with a calculated wait time but doesn't actually implement a proper token bucket. Each call creates a new timer rather than queueing. If `tokens < 1`, it waits `waitMs = intervalMs` but doesn't refill on the same tick. Under high concurrency, all waiters get the same `waitMs` delay, which doesn't properly implement burst limiting.

9. **`createLLMProvider` in bridge CLI** — The `***>` placeholder is actually `any` in TypeScript (the `***>` is an elision by the read tool — it's actually `<string>`) but the function body is a stub that doesn't implement actual LLM provider logic. This means `umt-bridge chat` is non-functional.

10. **`bridge.ts` cache key** — The `buildCacheKey` method uses `JSON.stringify(args)` which is not deterministic for objects with the same key-value pairs but different ordering. This could cause cache misses for semantically identical calls. (Minor — `tool-cache.ts` handles this correctly with sorted keys.)

### Performance / Robustness Issues

1. **`serializeAll` eagerly computes all three formats** — The JSDoc says "Each format is computed lazily — only the ones you access incur the mapping cost" but the implementation calls `toOpenAI(tools)`, `toAnthropic(tools)`, and `toOllama(tools)` all eagerly. Either fix the implementation to be lazy or fix the JSDoc.

2. **`BridgeConversation.run()` calls `listTools()` on every round** — Inside the while loop (line 203), `bridge.listTools()` is called each iteration. Since the tools don't change between rounds, this should be hoisted outside the loop. The `listing.tools` and serialization can be cached per `run()` call.

3. **`HttpClient.fetch()` uses global `fetch`** — If `this.options.fetchImpl` is not provided, it falls through to the global `fetch` (implicitly). But there's no `fetchImpl` option in `HttpServiceClientOptions` — the class always uses the global `fetch`. This makes it harder to test or swap in a custom fetch implementation.

4. **Log rotation is best-effort** — `rotateLogFile` catches all errors silently. While intentional, there's no logging of rotation failures.

5. **`runServer` auto-build** — The `runServer` CLI function auto-builds if `dist/` is missing, but spawns `pnpm build` from `process.cwd()` with no scope. In a monorepo, this builds everything. It should ideally pass `--filter` to Turbo for just the relevant server.

### DX / Developer Experience Issues

1. **No `lint` script using a real linter** — Both `core` and `bridge` use `"lint": "tsc --noEmit"`. The root has no Biome or ESLint config. Only `llm-guardian` (sibling repo) uses Biome. UMT should adopt a real linter for code-style enforcement.

2. **`--no-update-check` flag** not respected in the `checkForUpdate` logic — The `shouldSkipUpdateCheck` function checks `argv` for `"--no-update-check"` but the actual Commander option is defined as `.option("--no-update-check", ...)`, which means the parsed value would be `updateCheck: false`, and `argv` would contain `--no-update-check` as a string token. This works but is fragile — it's a string match on the raw argv, not using the parsed Commander result.

3. **`registry-server.json` version mismatch** — The `.well-known/mcp-server.json` declares `version: "1.6.26"` but `package.json` is at `1.6.28`. This should be updated or synchronized automatically.

4. **`pnpm-workspace.yaml` `minimumReleaseAgeExclude`** — Contains `verkit@0.3.0` which doesn't appear in the overrides section. Should be cleaned up.

5. **No `.editorconfig`** — The repo uses 2-space indentation but has no `.editorconfig` to enforce it across editors.

6. **`tsconfig.base.json` doesn't set `noUnusedLocals` or `noUnusedParameters`** — Strict mode is on but unused locals/params aren't flagged, leading to dead code accumulating.

---

## Proposed Approach

**Phase 1: Test Coverage Foundation (3-4 days)**
Add tests for the most critical untested modules: `token-efficient.ts`, `serializers.ts` edge cases, `config-store.ts`, `output.ts`.

**Phase 2: Code Quality & Deduplication (2-3 days)**
Centralize `detectProvider`, fix `serializeAll` lazy evaluation, hoist `listTools()` in conversation loop, fix indentation in `tool-cache.ts`.

**Phase 3: CLI Refactoring (3-4 days)**
Split the monolithic `index.ts` into command modules, deduplicate stdio handshake logic.

**Phase 4: Robustness & Security (1-2 days)**
Improve `RateLimiter`, add `fetchImpl` to `HttpServiceClient`, fix log rotation logging.

**Phase 5: Developer Experience (1-2 days)**
Add linter config, `.editorconfig`, `tsconfig` strictness improvements, fix version sync.

---

## Step-by-Step Plan

### Task 1: Add tests for `token-efficient.ts`

**Objective:** Cover `ToolResultCache`, `estimateTokens`, `truncateToTokenBudget`, `compressOutput`, `processToolResult`, `executeToolsInParallel`, `summarizeToolResult`, `orderTools`, `executeWithFallback`.

**Files:**
- Create: `packages/core/test/token-efficient.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi } from "vitest";
import {
  ToolResultCache,
  estimateTokens,
  truncateToTokenBudget,
  compressOutput,
  processToolResult,
  executeToolsInParallel,
  summarizeToolResult,
  orderTools,
  executeWithFallback,
} from "../src/token-efficient.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
  it("returns positive number for non-empty text", () => {
    expect(estimateTokens("hello world")).toBeGreaterThan(0);
  });
  it("scales with text length", () => {
    const short = estimateTokens("hi");
    const long = estimateTokens("hi ".repeat(100));
    expect(long).toBeGreaterThan(short * 10);
  });
});

describe("truncateToTokenBudget", () => {
  it("returns text unchanged when within budget", () => {
    const text = "short text";
    expect(truncateToTokenBudget(text, 1000)).toBe(text);
  });
  it("truncates text that exceeds budget", () => {
    const text = "a".repeat(1000);
    const result = truncateToTokenBudget(text, 10);
    expect(result).toContain("[truncated]");
    expect(estimateTokens(result)).toBeLessThanOrEqual(10);
  });
  it("uses custom suffix", () => {
    const text = "a".repeat(1000);
    const result = truncateToTokenBudget(text, 10, "... cut");
    expect(result).toContain("... cut");
  });
});

describe("ToolResultCache", () => {
  it("stores and retrieves results", () => {
    const cache = new ToolResultCache({ ttlMs: 60_000 });
    const key = cache.makeKey("tool", { a: 1 });
    const result: CallToolResult = { content: [{ type: "text", text: "data" }] };
    cache.set(key, result);
    expect(cache.get(key)).toEqual(result);
  });
  it("returns undefined for expired entries", () => {
    const cache = new ToolResultCache({ ttlMs: 1 });
    const key = cache.makeKey("tool", { a: 1 });
    const result: CallToolResult = { content: [{ type: "text", text: "data" }] };
    cache.set(key, result);
    // Manually age the entry by manipulating internal state via get on an expired key
    expect(cache.has(key)).toBe(false);
  });
  it("evicts oldest entries when maxSize exceeded", () => {
    const cache = new ToolResultCache({ maxSize: 2, ttlMs: 60_000 });
    cache.set(cache.makeKey("a", {}), { content: [] });
    cache.set(cache.makeKey("b", {}), { content: [] });
    cache.set(cache.makeKey("c", {}), { content: [] });
    expect(cache.size).toBe(2);
  });
  it("makeKey sorts arguments for deterministic keys", () => {
    const cache = new ToolResultCache();
    const key1 = cache.makeKey("tool", { b: 2, a: 1 });
    const key2 = cache.makeKey("tool", { a: 1, b: 2 });
    expect(key1).toBe(key2);
  });
  it("stats returns correct hit rate", () => {
    const cache = new ToolResultCache({ ttlMs: 60_000 });
    const key = cache.makeKey("tool", {});
    cache.set(key, { content: [] });
    cache.get(key);
    const stats = cache.stats();
    expect(stats.totalHits).toBe(1);
    expect(stats.size).toBe(1);
  });
});

describe("compressOutput", () => {
  it("returns result unchanged when within token budget", () => {
    const result: CallToolResult = { content: [{ type: "text", text: "small" }] };
    expect(compressOutput(result, 2000)).toEqual(result);
  });
  it("truncates content that exceeds budget", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "x".repeat(10000) }],
    };
    const compressed = compressOutput(result, 10);
    expect(estimateTokens(compressed.content!.map(c => c.type === "text" ? c.text : "").join("")))
      .toBeLessThanOrEqual(10);
  });
});

describe("processToolResult", () => {
  it("marks compressed results in _meta", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "x".repeat(10000) }],
    };
    const processed = processToolResult(result, 10);
    expect(processed._meta?.compressed).toBe(true);
    expect(processed._meta?.originalTokens).toBeGreaterThan(0);
  });
  it("leaves small results untouched", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "small" }],
    };
    const processed = processToolResult(result, 2000);
    expect(processed._meta).toBeUndefined();
    expect(processed).toEqual(result);
  });
});

describe("executeToolsInParallel", () => {
  it("executes tools and returns results in order", async () => {
    const executor = vi.fn(async (name: string) => ({
      content: [{ type: "text", text: `result for ${name}` }],
    }));
    const results = await executeToolsInParallel(
      [{ name: "toolA", arguments: { x: 1 } }, { name: "toolB", arguments: { y: 2 } }],
      executor,
    );
    expect(results).toHaveLength(2);
    expect(results[0]!.content![0]).toMatchObject({ text: "result for toolA" });
    expect(results[1]!.content![0]).toMatchObject({ text: "result for toolB" });
  });
  it("uses cache to deduplicate identical calls", async () => {
    const cache = new ToolResultResult({ ttlMs: 60_000 });
    const executor = vi.fn(async (name: string) => ({ content: [] }));
    await executeToolsInParallel(
      [{ name: "tool", arguments: { a: 1 } }, { name: "tool", arguments: { a: 1 } }],
      executor,
      cache,
    );
    expect(executor).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd packages/core && npx vitest run test/token-efficient.test.ts
# Expected: FAIL — module exports may differ, test imports may fail
```

**Step 3: Fix any import/export issues** (minimal — ensure exports exist)

**Step 4: Run test to verify pass**

```bash
cd packages/core && npx vitest run test/token-efficient.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/core/test/token-efficient.test.ts
git commit -m "test(core): add comprehensive tests for token-efficient utilities"
```

---

### Task 2: Add tests for `config-store.ts`

**Objective:** Cover profile CRUD, state persistence, generated config creation, env placeholder generation.

**Files:**
- Create: `packages/cli/test/config-store.test.ts`

**Step 1: Write failing test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// We need to set APPDATA or HOME before importing config-store
// since it reads process.env at module load time
const tmpStateDir = path.join(os.tmpdir(), `umt-test-${process.pid}`);

describe("config-store", () => {
  beforeEach(async () => {
    process.env.APPDATA = tmpStateDir;
    // Re-import to pick up the new APPDATA
    const { getStateDirectory } = await import("../src/config-store.js");
    expect(getStateDirectory()).toBe(tmpStateDir);
  });

  afterEach(async () => {
    await rm(tmpStateDir, { recursive: true, force: true });
    delete process.env.APPDATA;
  });

  it("creates and reads state", async () => {
    const { readState, writeState } = await import("../src/config-store.js");
    await writeState({ installs: [] });
    const state = await readState();
    expect(state.installs).toEqual([]);
  });

  it("generates npx config with placeholder env vars", async () => {
    const { createGeneratedConfig } = await import("../src/config-store.js");
    const { getRegistryEntry } = await import("../src/registry.js");
    const entry = getRegistryEntry("github");
    const config = createGeneratedConfig([entry], "npx");
    expect(config.mcpServers.github.command).toBe("npx");
    expect(config.mcpServers.github.env).toEqual({ GITHUB_TOKEN: "${GITHUB_TOKEN}" });
  });

  it("generates workspace config with local path", async () => {
    const { createGeneratedConfig } = await import("../src/config-store.js");
    const { getRegistryEntry } = await import("../src/registry.js");
    const entry = getRegistryEntry("docker");
    const config = createGeneratedConfig([entry], "workspace");
    expect(config.mcpServers.docker.command).toBe(process.execPath);
    expect(config.mcpServers.docker.env).toBeUndefined();
  });

  it("saves, lists, and loads named profiles", async () => {
    const { saveNamedProfile, listProfiles, loadProfile, deleteProfile } = await import("../src/config-store.js");
    await saveNamedProfile({
      name: "test-profile",
      target: "claude-desktop",
      mode: "npx",
      outputPath: "/tmp/test.json",
      serverIds: ["github"],
      createdAt: new Date().toISOString(),
    });
    const profiles = await listProfiles();
    expect(profiles).toContainEqual(expect.objectContaining({ name: "test-profile" }));
    const loaded = await loadProfile("test-profile");
    expect(loaded.serverIds).toEqual(["github"]);
    await deleteProfile("test-profile");
    const afterDelete = await listProfiles();
    expect(afterDelete).toHaveLength(0);
  });

  it("throws when loading a non-existent profile", async () => {
    const { loadProfile } = await import("../src/config-store.js");
    await expect(loadProfile("nonexistent")).rejects.toThrow("not found");
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd packages/cli && npx vitest run test/config-store.test.ts
# Expected: FAIL — state file paths may conflict with global APPDATA
```

**Step 3: Fix issues** (the module reads `process.env.APPDATA` at import time; we need to ensure the import happens after env is set)

**Step 4: Run test to verify pass**

```bash
cd packages/cli && npx vitest run test/config-store.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/cli/test/config-store.test.ts
git commit -m "test(cli): add tests for config-store profile CRUD and config generation"
```

---

### Task 3: Add tests for `output.ts` rendering functions

**Objective:** Cover `renderServerTable`, `renderStatusLabel`, `printSection`, `renderToolTable`.

**Files:**
- Create: `packages/cli/test/output.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderServerTable, renderStatusLabel, renderToolTable } from "../src/output.js";
import { SERVER_REGISTRY } from "../src/registry.js";

describe("renderStatusLabel", () => {
  it("renders OK for true", () => {
    const result = renderStatusLabel(true);
    expect(result).toContain("OK");
  });
  it("renders Missing for false", () => {
    const result = renderStatusLabel(false);
    expect(result).toContain("Missing");
  });
});

describe("renderServerTable", () => {
  it("renders a table with all servers", () => {
    const table = renderServerTable(SERVER_REGISTRY.slice(0, 3));
    expect(table).toContain("ID");
    expect(table).toContain("Title");
    expect(table).toContain("Category");
    // Should include server names
    expect(table).toContain(SERVER_REGISTRY[0]!.id);
    expect(table).toContain(SERVER_REGISTRY[1]!.id);
  });
  it("shows EXPERIMENTAL badge for experimental servers", () => {
    const table = renderServerTable([SERVER_REGISTRY.find(e => e.experimental)!]);
    expect(table).toContain("[EXPERIMENTAL]");
  });
});

describe("renderToolTable", () => {
  it("renders tool rows with server ID, name, and description", () => {
    const rows = [{ serverId: "github", toolName: "list_issues", description: "List issues" }];
    const table = renderToolTable(rows);
    expect(table).toContain("github");
    expect(table).toContain("list_issues");
    expect(table).toContain("List issues");
  });
  it("renders with no tools", () => {
    const table = renderToolTable([]);
    expect(table).toContain("Server");
    expect(table).toContain("Tool");
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd packages/cli && npx vitest run test/output.test.ts
# Expected: FAIL or PASS depending on chalk table rendering in test env
```

**Step 3: No implementation needed — output.ts already exists**

**Step 4: Run test to verify pass**

```bash
cd packages/cli && npx vitest run test/output.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/cli/test/output.test.ts
git commit -m "test(cli): add tests for output rendering functions"
```

---

### Task 4: Add tests for serializers edge cases

**Objective:** Cover `detectProvider` for additional model patterns, `serializeAll` correctness, and edge cases in `extractJsonSchema`.

**Files:**
- Create: `packages/bridge/test/serializers-edge-cases.test.ts`

**Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { detectProvider, serializeAll, toAnthropic } from "../src/serializers.js";
import type { BridgeTool } from "../src/types.js";

describe("detectProvider edge cases", () => {
  it("detects GPT-4.1 and o1/o3 variants", () => {
    expect(detectProvider("gpt-4.1")).toBe("openai");
    expect(detectProvider("gpt-4.1-turbo")).toBe("openai");
    expect(detectProvider("o1-pro")).toBe("openai");
    expect(detectProvider("o3-pro")).toBe("openai");
  });
  it("detects Claude 4 and other Anthropic models", () => {
    expect(detectProvider("claude-sonnet-4-20250514")).toBe("anthropic");
    expect(detectProvider("claude-opus-4-20250516")).toBe("anthropic");
  });
  it("detects Llama 4 and modern Ollama models", () => {
    expect(detectProvider("llama4:16b")).toBe("ollama");
    expect(detectProvider("qwen2.5:14b")).toBe("openai"); // Not a recognized prefix → defaults to openai
  });
  it("defaults to openai for unknown providers", () => {
    expect(detectProvider("command-r-plus")).toBe("openai");
    expect(detectProvider("gemini-2.0-flash")).toBe("openai");
  });
});

describe("serializeAll", () => {
  const toolWithEmptySchema: BridgeTool = {
    name: "ping",
    description: "Ping",
    parameters: { type: "object", properties: {}, required: [] },
    mcpTool: {
      name: "ping",
      description: "Ping",
      inputSchema: {},
    } as any,
  };

  it("serializes tools with empty schemas", () => {
    const result = serializeAll([toolWithEmptySchema]);
    expect(result.openai[0]!.function.parameters.type).toBe("object");
    expect(result.anthropic[0]!.input_schema.type).toBe("object");
    expect(result.ollama[0]!.function.parameters.type).toBe("object");
  });
});
```

**Step 2: Run test to verify failure**

```bash
cd packages/bridge && npx vitest run test/serializers-edge-cases.test.ts
# Expected: Some tests may fail (e.g., llama4 detection, qwen2.5 defaults)
```

**Step 3: Fix `detectProvider`** to handle new model prefixes

```typescript
// In serializers.ts, update detectProvider:
export function detectProvider(model: string): ProviderFormat {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3"))
    return "openai";
  if (lower.startsWith("llama") || lower.startsWith("mistral") || lower.startsWith("mixtral"))
    return "ollama";
  return "openai";
}
```

**Step 4: Run test to verify pass**

```bash
cd packages/bridge && npx vitest run test/serializers-edge-cases.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/bridge/test/serializers-edge-cases.test.ts packages/bridge/src/serializers.ts
git commit -m "test(bridge): add serializer edge case tests and detectProvider coverage"
```

---

### Task 5: Centralize `detectProvider` to eliminate duplication

**Objective:** Remove the duplicated `detectProvider`/`detectProviderFormat` logic from `conversation.ts` by importing from `serializers.ts`.

**Files:**
- Modify: `packages/bridge/src/conversation.ts:289-297` (remove `detectProviderFormat`, import `detectProvider`)
- Modify: `packages/bridge/src/conversation.ts:204` (use imported `detectProvider`)

**Step 1: Write a test that catches the duplication**

```typescript
// In packages/bridge/test/serializers-edge-cases.test.ts, add:
import { toProvider } from "../src/serializers.js";

describe("toProvider", () => {
  it("routes to the correct provider format", () => {
    const mockTool: BridgeTool = {
      name: "test",
      description: "test",
      parameters: { type: "object", properties: {}, required: [] },
      mcpTool: { name: "test", inputSchema: {} } as any,
    };
    // toProvider should delegate to detectProvider internally
    const openAIResult = toProvider([mockTool], "gpt-4o");
    const anthropicResult = toProvider([mockTool], "claude-3-opus");
    const ollamaResult = toProvider([mockTool], "llama3.1:70b");
    expect(openAIResult[0]!.type).toBe("function");
    expect(anthropicResult[0]!.name).toBe("test");
    expect(ollamaResult[0]!.type).toBe("function");
  });
});
```

**Step 2: Refactor `conversation.ts`**

Replace the `detectProviderFormat` method with a call to the imported `detectProvider`:

```typescript
import { toOpenAI, toAnthropic, toOllama, detectProvider } from "./serializers.js";
// ... in run() method, line 204:
const providerFormat = detectProvider(model);
// ... remove the detectProviderFormat method entirely
```

**Step 3: Run typecheck**

```bash
cd packages/bridge && npx tsc --noEmit
# Expected: passes
```

**Step 4: Run tests**

```bash
cd packages/bridge && npx vitest run
# Expected: all existing tests pass
```

**Step 5: Commit**

```bash
git add packages/bridge/src/conversation.ts packages/bridge/test/serializers-edge-cases.test.ts
git commit -m "refactor(bridge): centralize detectProvider, remove duplication from conversation.ts"
```

---

### Task 6: Fix `serializeAll` lazy evaluation claim

**Objective:** Either make `serializeAll` actually lazy or fix the JSDoc to match the eager implementation.

**Files:**
- Read: `packages/bridge/src/serializers.ts:215-226`

**Step 1: Decide approach** — Given that the function returns a typed object `{}` with all three arrays, making it truly lazy would require getters or a Proxy. The simplest correct fix is to update the JSDoc to accurately describe the eager behavior:

**Step 2: Update JSDoc**

```typescript
/**
 * Convert bridge tools to all three provider formats at once.
 * Each format is computed eagerly — all three arrays are always populated.
 */
```

**Step 3: Run tests**

```bash
cd packages/bridge && npx vitest run
# Expected: all tests pass
```

**Step 4: Commit**

```bash
git add packages/bridge/src/serializers.ts
git commit -m "docs(bridge): correct serializeAll JSDoc — it is eager, not lazy"
```

---

### Task 7: Hoist `listTools()` in `BridgeConversation.run()`

**Objective:** Avoid calling `bridge.listTools()` on every conversation round — tools don't change between rounds within a single `run()`.

**Files:**
- Modify: `packages/bridge/src/conversation.ts:199-206`

**Step 1: Write a test** that verifies `listTools` is called once per `run()`:

```typescript
// In packages/bridge/test/conversation.test.ts
import { describe, it, expect, vi } from "vitest";
import { BridgeConversation } from "../src/conversation.js";
import type { MCPFunctionCallingBridge } from "../src/bridge.js";
import type { LLMProvider } from "../src/conversation.js";

describe("BridgeConversation", () => {
  it("calls listTools once per run, not once per round", async () => {
    const mockBridge = {
      listTools: vi.fn().mockResolvedValue({ tools: [], rawTools: [] }),
      callTool: vi.fn().mockResolvedValue({ output: "result", error: false }),
      isConnected: () => true,
    } as unknown as MCPFunctionCallingBridge;

    const mockProvider: LLMProvider = {
      chat: vi.fn()
        .mockResolvedValueOnce({ content: "Let me check", toolCalls: [{ id: "1", name: "tool_a", arguments: {} }] })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
    };

    const convo = new BridgeConversation(mockBridge, { maxRounds: 10 });
    await convo.run("test query", mockProvider, "gpt-4o");
    
    // listTools should be called only once (hoisted out of the loop)
    expect(mockBridge.listTools).toHaveBeenCalledTimes(1);
  });
});
```

**Step 2: Run test to verify failure** (listTools currently called per round)

**Step 3: Fix `run()`** — hoist `listTools()` before the while loop:

```typescript
async run(userMessage, provider, model, onStep) {
  this.messages.push({ role: "user", content: userMessage });

  // List tools once — they don't change between rounds within a single run()
  const listing = await this.bridge.listTools();
  const providerFormat = detectProvider(model);
  const tools = this.serializeTools(listing.tools, providerFormat);

  let currentRound = 0;
  let lastToolCalls: BridgeToolCall[] = [];

  while (currentRound < this.config.maxRounds) {
    currentRound++;
    // Remove the per-round listTools() call here
    const response = await provider.chat(this.messages, tools, providerFormat);
    // ... rest unchanged
  }
}
```

**Step 4: Run test to verify pass**

```bash
cd packages/bridge && npx vitest run test/conversation.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/bridge/src/conversation.ts packages/bridge/test/conversation.test.ts
git commit -m "perf(bridge): hoist listTools() out of conversation loop"
```

---

### Task 8: Fix `tool-cache.ts` indentation (tabs → spaces)

**Objective:** Make `tool-cache.ts` consistent with the rest of the codebase (2-space indentation).

**Files:**
- Modify: `packages/cli/src/tool-cache.ts`

**Step 1: Run prettier or manual fix**

```bash
cd packages/cli && npx prettier --write src/tool-cache.ts
# Or manually replace all tabs with 2 spaces
```

**Step 2: Verify with tsc**

```bash
npx tsc --noEmit
# Expected: passes
```

**Step 3: Commit**

```bash
git add packages/cli/src/tool-cache.ts
git commit -m "style(cli): convert tool-cache.ts from tabs to 2-space indentation"
```

---

### Task 9: Add `fetchImpl` override to `HttpServiceClient`

**Objective:** Allow injecting a custom `fetch` implementation for testing and edge environments.

**Files:**
- Modify: `packages/core/src/http.ts` (add `fetchImpl` to options)
- Modify: `packages/core/src/types.ts` (if needed for exported types)

**Step 1: Write failing test**

```typescript
// In packages/core/test/http.test.ts
import { describe, it, expect, vi } from "vitest";
import { HttpServiceClient } from "../src/http.js";
import { createLogger } from "../src/index.js";

describe("HttpServiceClient", () => {
  it("uses injected fetchImpl when provided", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    const client = new HttpServiceClient({
      serviceName: "test",
      baseUrl: "https://api.test.com",
      logger: createLogger({ name: "test" }),
      fetchImpl: mockFetch,
    });
    await client.requestText("/endpoint");
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ method: "GET" })
    );
  });
});
```

**Step 2: Add `fetchImpl` to `HttpServiceClientOptions`**

```typescript
export interface HttpServiceClientOptions {
  serviceName: string;
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  retryOptions?: Partial<RetryOptions>;
  rateLimiter?: RateLimiter;
  /** Optional fetch override for testing or custom HTTP runtimes. */
  fetchImpl?: typeof fetch;
}
```

**Step 3: Use `fetchImpl` in the `fetch()` method**

```typescript
// In HttpServiceClient constructor:
this.fetchImpl = options.fetchImpl ?? fetch;

// In fetch() method, replace `fetch(url, requestInit)` with `this.fetchImpl(url, requestInit)`
```

**Step 4: Run tests**

```bash
cd packages/core && npx vitest run test/http.test.ts
# Expected: All tests pass
```

**Step 5: Commit**

```bash
git add packages/core/src/http.ts packages/core/test/http.test.ts
git commit -m "feat(core): allow injecting custom fetch implementation in HttpServiceClient"
```

---

### Task 10: Fix `RateLimiter` token bucket implementation

**Objective:** The current implementation doesn't properly implement a token bucket under concurrency. When tokens are exhausted, all waiting callers compute the same wait time and race through the `setTimeout`, potentially exceeding the burst limit.

**Files:**
- Modify: `packages/core/src/rate-limiter.ts`
- Create: `packages/core/test/rate-limiter.test.ts`

**Step 1: Write failing tests**

```typescript
describe("RateLimiter", () => {
  it("allows burst of requests up to burstLimit", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 10, burstLimit: 3 });
    const start = Date.now();
    await Promise.all([
      limiter.acquire(),
      limiter.acquire(),
      limiter.acquire(),
    ]);
    expect(limiter.tokens).toBe(0);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(100); // Should not block for burst
  });

  it("blocks when tokens are exhausted", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 100, burstLimit: 1 });
    await limiter.acquire(); // Consume the only token
    const start = Date.now();
    await limiter.acquire();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(8); // ~10ms per token at 100 rps
  });
});
```

**Step 2: Rewrite `acquire()` using a proper queue-based token bucket**

```typescript
private waitQueue: Array<() => void> = [];

public async acquire(): Promise<void> {
  this.refill();
  if (this.tokens >= 1) {
    this.tokens -= 1;
    return;
  }
  // Queue the request
  return new Promise<void>((resolve) => {
    this.waitQueue.push(resolve);
  });
}

private checkQueue(): void {
  this.refill();
  while (this.tokens >= 1 && this.waitQueue.length > 0) {
    this.tokens -= 1;
    const resolve = this.waitQueue.shift()!;
    resolve();
  }
}
```

Use `setInterval` to periodically refill and check the queue:

```typescript
private refillTimer: ReturnType<typeof setInterval> | null = null;

constructor(options: RateLimiterOptions) {
  // ... existing validation ...
  this.refillTimer = setInterval(() => {
    this.checkQueue();
  }, 50);
  if (this.refillTimer.unref) this.refillTimer.unref();
}
```

**Step 3: Run tests**

```bash
cd packages/core && npx vitest run test/rate-limiter.test.ts
# Expected: All tests pass
```

**Step 4: Commit**

```bash
git add packages/core/src/rate-limiter.ts packages/core/test/rate-limiter.test.ts
git commit -m "fix(core): rewrite RateLimiter as proper queue-based token bucket"
```

---

### Task 11: Split monolithic CLI `index.ts` into command modules

**Objective:** The `index.ts` file is 1793 lines with ~30 command handlers. Split into logical modules.

**Files:**
- Create: `packages/cli/src/commands/server.ts` (runServer, runDoctor, runTest, runConformance, runStdioHandshake)
- Create: `packages/cli/src/commands/profile.ts` (profile CRUD, runProfileList/Use/Delete/Rename/Duplicate, runProfileCreate/Show/Export/Import)
- Create: `packages/cli/src/commands/diagnostics.ts` (runStatus, runLogs, rotateLogFile, formatUptime, runUpgrade)
- Create: `packages/cli/src/commands/discovery.ts` (runSearch, runConformance is split between server.ts and discovery.ts)
- Create: `packages/cli/src/commands/config.ts` (runExport, runExportConfig, runLinkMemos, generateConfig, substitutePipe)
- Modify: `packages/cli/src/index.ts` (keep only main() and command wiring)

**Step 1: Create `commands/config.ts`** with `generateConfig`, `substitutePipe`, `runExportConfig`, `runLinkMemos`

```bash
# Extract these functions into packages/cli/src/commands/config.ts
```

**Step 2: Create `commands/profile.ts`** with all profile subcommands

**Step 3: Create `commands/server.ts`** with runServer, runDoctor, runTest, runConformance

**Step 4: Create `commands/diagnostics.ts`** with runStatus, runLogs, runUpgrade, formatUptime

**Step 5: Create `commands/discovery.ts`** with runSearch

**Step 6: Update `index.ts`** to import from command modules

**Step 7: Run typecheck + tests**

```bash
cd packages/cli && npx tsc --noEmit && npx vitest run
# Expected: All pass
```

**Step 8: Commit**

```bash
git add packages/cli/src/commands/ packages/cli/src/index.ts
git commit -m "refactor(cli): split monolithic index.ts into command modules"
```

---

### Task 12: Add `.editorconfig` and tighten `tsconfig.base.json`

**Objective:** Enforce consistent formatting and catch unused code.

**Files:**
- Create: `.editorconfig`
- Modify: `tsconfig.base.json`

**Step 1: Create `.editorconfig`**

```ini
root = true

[*]
indent_style = space
indent_size = 2
end_of_line = lf
charset = utf-8
trim_trailing_whitespace = true
insert_final_newline = true

[*.md]
trim_trailing_whitespace = false

[Makefile]
indent_style = tab
```

**Step 2: Add `noUnusedLocals` and `noUnusedParameters` to `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    // ... existing ...
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

**Step 3: Run typecheck**

```bash
pnpm typecheck 2>&1 | head -50
# Expected: may show unused locals — fix those as a follow-up task
```

**Step 4: Commit**

```bash
git add .editorconfig tsconfig.base.json
git commit -m "chore: add .editorconfig and tighten tsconfig with noUnusedLocals/Parameters"
```

---

### Task 13: Add lint CI step with Biome

**Objective:** Move beyond `tsc --noEmit` for linting. Add Biome for code style.

**Files:**
- Create: `biome.json` (or `.config/biome.json`)
- Modify: `.github/workflows/ci.yml` (add lint step)
- Modify: `packages/*/package.json` (update lint scripts)

**Step 1: Create `biome.json`**

```json
{
  "$schema": "https://biomejs.dev/schemas/2.0.0-beta/stability/schema.json",
  "vcs": {
    "enabled": true,
    "clientKind": "git",
    "repository": "worktree"
  },
  "formatter": {
    "files": {
      "includes": ["**/*.ts", "**/*.js", "**/*.json", "**/*.md"]
    }
  },
  "linter": {
    "enabled": true,
    "rules": {
      "recommended": true
    }
  }
}
```

**Step 2: Add to CI**

```yaml
# In ci.yml, after Typecheck step:
- name: Lint
  run: pnpm exec biome check packages/cli/src packages/bridge/src packages/core/src --max-diagnostics=50
```

**Step 3: Update package.json lint scripts**

```json
// In each package:
"lint": "tsc --noEmit && biome check src/ test/"
```

**Step 4: Commit**

```bash
git add biome.json .github/workflows/ci.yml packages/*/package.json
git commit -m "chore: add Biome linter with CI integration"
```

---

### Task 14: Sync version in `.well-known/mcp-server.json`

**Objective:** The manifest says `1.6.26` but `package.json` says `1.6.28`.

**Files:**
- Modify: `.well-known/mcp-server.json`

**Step 1: Update version**

```json
// Change "version": "1.6.26" → "version": "1.6.28"
```

**Step 2: Commit**

```bash
git add .well-known/mcp-server.json
git commit -m "fix: sync .well-known/mcp-server.json version to 1.6.28"
```

---

## Risks, Tradeoffs, and Open Questions

### Risks
1. **Monorepo builds are expensive** — Each `pnpm build` runs tsdown across 34 packages. Use `turbo run build --filter` for scoped builds during development.
2. **No existing e2e test framework** — The CLI test for the `compose` command and `conformance` command require spawning actual server processes, which tests would need to mock.
3. **Strict TypeScript** (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`) — May cause friction when writing test fixtures; the bridge's `cli.ts` already uses `as any` casts for `mcpTool`.
4. **The bridge CLI's `createLLMProvider` is a stub** — Fixing this is a significant effort (implementing OpenAI, Anthropic, and Ollama API clients). Should be a separate phase.

### Tradeoffs
1. **Splitting `index.ts`** increases file count but reduces cognitive load per file. The `main()` function will need to import from all command modules, but the separation of concerns is worth it.
2. **Adding Biome** adds a new dependency and learning curve, but the project is already at 0 lint coverage beyond `tsc`. The sibling `llm-guardian` repo already uses Biome, so the team has familiarity.
3. **Rate limiter rewrite** changes a critical path component — thorough testing with concurrency tests is essential.

### Open Questions
1. Should we add a `--format <format>` option to `umt tools list` for JSON/CSV output? (Currently only `--json` is supported.)
2. Should the `umt compose` command support parallel source calls (multiple `--from` specs)?
3. Should we add a `umt cache` subcommand group for the CLI-level `ToolCache`? (Currently only `cli/src/tool-cache.ts` has it but no CLI command references it.)

---

## Verification Plan

After all tasks are complete:

```bash
# 1. Full typecheck
pnpm typecheck

# 2. Full test suite
pnpm test

# 3. Lint (if Biome added)
pnpm exec biome check packages/cli/src packages/bridge/src packages/core/src

# 4. Build
pnpm build

# 5. Verify no tests were removed
pnpm test -- --coverage 2>/dev/null | tail -20
```

Expected: All tests pass, typecheck passes, lint passes, build succeeds.
