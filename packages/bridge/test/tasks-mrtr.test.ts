import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPFunctionCallingBridge } from "../src/bridge.js";
import {
  checkDefinitionDrift,
  detectTaskSupport,
  digestToolsList,
  extractCacheHint,
  isInputRequiredResult,
  isTerminalTaskStatus,
  MrtrInputRequiredError,
  MrtrRoundLimitError,
  runMultiRoundTrip,
  type DefinitionDriftEvent,
  type MrtrInputRequests,
} from "../src/tasks.js";
import type { BridgeToolResult } from "../src/types.js";

type MockClient = {
  callTool?: ReturnType<typeof vi.fn>;
  request?: ReturnType<typeof vi.fn>;
  listTools?: ReturnType<typeof vi.fn>;
  getServerCapabilities?: ReturnType<typeof vi.fn>;
  experimental?: { tasks?: Record<string, ReturnType<typeof vi.fn>> };
};

type BridgeInternals = {
  client: MockClient;
  resultCache: Map<string, { result: BridgeToolResult; expiresAt: number }> | null;
};

function attachClient(
  bridge: MCPFunctionCallingBridge,
  client: MockClient,
): BridgeInternals {
  const internals = bridge as unknown as BridgeInternals;
  internals.client = client;
  return internals;
}

function makeBridge(options: Record<string, unknown> = {}) {
  return new MCPFunctionCallingBridge(
    { transport: "stdio", commandOrUrl: "mock" },
    { health: false, suppressErrors: false, ...options },
  );
}

const okResult = (text: string) => ({
  content: [{ type: "text", text }],
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("tasks.ts pure helpers", () => {
  it("detects task support from capabilities (dual-era safe)", () => {
    expect(detectTaskSupport(undefined)).toEqual({
      toolsCallTasks: false,
      canList: false,
      canCancel: false,
    });
    // Older 2025-era servers advertise tools but no tasks capability.
    expect(detectTaskSupport({ tools: { listChanged: true } } as never)).toEqual({
      toolsCallTasks: false,
      canList: false,
      canCancel: false,
    });
    expect(
      detectTaskSupport({
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      } as never),
    ).toEqual({ toolsCallTasks: true, canList: true, canCancel: true });
  });

  it("classifies terminal task statuses", () => {
    for (const s of ["completed", "failed", "cancelled"]) {
      expect(isTerminalTaskStatus(s)).toBe(true);
    }
    for (const s of ["working", "input_required"]) {
      expect(isTerminalTaskStatus(s)).toBe(false);
    }
  });

  it("detects input_required results (and ignores legacy results)", () => {
    expect(
      isInputRequiredResult({ resultType: "input_required", inputRequests: {} }),
    ).toBe(true);
    expect(isInputRequiredResult({ content: [] })).toBe(false);
    expect(isInputRequiredResult({ resultType: "complete" })).toBe(false);
    expect(isInputRequiredResult(null)).toBe(false);
    expect(isInputRequiredResult("input_required")).toBe(false);
  });

  it("extracts cache hints, ignoring invalid values", () => {
    expect(extractCacheHint({ ttlMs: 5000, cacheScope: "private" })).toEqual({
      ttlMs: 5000,
      cacheScope: "private",
    });
    expect(extractCacheHint({})).toEqual({});
    expect(extractCacheHint(undefined)).toEqual({});
    // Invalid values are ignored, not honored.
    expect(extractCacheHint({ ttlMs: -10, cacheScope: "weird" })).toEqual({});
    expect(extractCacheHint({ ttlMs: Number.NaN })).toEqual({});
  });

  it("digestToolsList is stable under key order and sensitive to changes", () => {
    const a = [
      { name: "b", description: "B", inputSchema: { type: "object", properties: { z: {}, a: {} } } },
      { name: "a", description: "A", inputSchema: { type: "object" } },
    ];
    const b = [
      { name: "a", inputSchema: { type: "object" }, description: "A" },
      { name: "b", inputSchema: { properties: { a: {}, z: {} }, type: "object" }, description: "B" },
    ];
    expect(digestToolsList(a)).toBe(digestToolsList(b));
    const changed = [
      { name: "a", description: "A CHANGED", inputSchema: { type: "object" } },
      { name: "b", description: "B", inputSchema: { type: "object" } },
    ];
    expect(digestToolsList(changed)).not.toBe(digestToolsList(a));
  });

  it("checkDefinitionDrift reports added/removed/modified", () => {
    const prev = [
      { name: "keep", description: "same" },
      { name: "edit", description: "before" },
      { name: "drop", description: "gone" },
    ];
    const curr = [
      { name: "keep", description: "same" },
      { name: "edit", description: "after" },
      { name: "new", description: "added" },
    ];
    const report = checkDefinitionDrift(digestToolsList(prev), prev, curr);
    expect(report.changed).toBe(true);
    expect(report.added).toEqual(["new"]);
    expect(report.removed).toEqual(["drop"]);
    expect(report.modified).toEqual(["edit"]);
  });

  it("runMultiRoundTrip returns immediately when no input is required", async () => {
    const call = vi.fn(async () => ({ content: [] }));
    const { result, rounds } = await runMultiRoundTrip(call, { a: 1 }, {});
    expect(rounds).toBe(1);
    expect(result).toEqual({ content: [] });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("runMultiRoundTrip loops, echoing requestState and collecting responses", async () => {
    const seen: Array<{ args: unknown; mrtr: unknown }> = [];
    const call = vi.fn(async (args: Record<string, unknown>, mrtr: { inputResponses?: unknown; requestState?: string }) => {
      seen.push({ args, mrtr });
      if (!mrtr.inputResponses) {
        return {
          resultType: "input_required",
          inputRequests: { q1: { method: "elicitation/create", params: {} } },
          requestState: "opaque-1",
        };
      }
      return { resultType: "complete", content: [{ type: "text", text: "ok" }] };
    });
    const onInputRequest = vi.fn(async () => ({ q1: { action: "accept" } }));
    const { result, rounds } = await runMultiRoundTrip(call, { x: 1 }, { onInputRequest, maxRounds: 5 });
    expect(rounds).toBe(2);
    expect(result).toMatchObject({ resultType: "complete" });
    expect(onInputRequest).toHaveBeenCalledWith(
      { q1: { method: "elicitation/create", params: {} } },
      1,
    );
    // Retry carries inputResponses and echoes requestState byte-exact.
    expect(seen[1]!.mrtr).toEqual({
      inputResponses: { q1: { action: "accept" } },
      requestState: "opaque-1",
    });
    // Original args are preserved across rounds.
    expect(seen[1]!.args).toEqual({ x: 1 });
  });

  it("runMultiRoundTrip throws MrtrInputRequiredError without a handler", async () => {
    const call = vi.fn(async () => ({
      resultType: "input_required",
      inputRequests: { q: { method: "elicitation/create" } },
    }));
    await expect(runMultiRoundTrip(call, {}, {})).rejects.toBeInstanceOf(
      MrtrInputRequiredError,
    );
  });

  it("runMultiRoundTrip enforces the round cap", async () => {
    const call = vi.fn(async () => ({
      resultType: "input_required",
      inputRequests: { q: { method: "elicitation/create" } },
    }));
    const onInputRequest = vi.fn(async () => ({}));
    const error = await runMultiRoundTrip(call, {}, { onInputRequest, maxRounds: 3 }).catch(
      (e) => e,
    );
    expect(error).toBeInstanceOf(MrtrRoundLimitError);
    expect((error as MrtrRoundLimitError).rounds).toBe(3);
    expect(call).toHaveBeenCalledTimes(3);
    expect(onInputRequest).toHaveBeenCalledTimes(2);
  });
});

describe("MCPFunctionCallingBridge task API", () => {
  function taskClient() {
    return {
      getServerCapabilities: vi.fn().mockReturnValue({
        tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } },
      }),
      experimental: {
        tasks: {
          callToolStream: vi.fn(),
          getTask: vi.fn(),
          getTaskResult: vi.fn(),
          listTasks: vi.fn(),
          cancelTask: vi.fn(),
        },
      },
    };
  }

  const taskShape = (taskId: string, status: string, extra: Record<string, unknown> = {}) => ({
    taskId,
    status,
    ttl: 60_000,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: new Date().toISOString(),
    pollInterval: 5,
    ...extra,
  });

  it("getTaskSupport feature-detects the Tasks extension", () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    expect(bridge.getTaskSupport()).toEqual({
      toolsCallTasks: true,
      canList: true,
      canCancel: true,
    });
    client.getServerCapabilities.mockReturnValue({ tools: {} });
    expect(bridge.getTaskSupport()).toEqual({
      toolsCallTasks: false,
      canList: false,
      canCancel: false,
    });
  });

  it("spawns a task and follows it to completion with progress updates", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;

    tasks.callToolStream.mockImplementation(async function* () {
      yield { type: "taskCreated", task: taskShape("task-1", "working") };
    });
    tasks.getTask
      .mockResolvedValueOnce(taskShape("task-1", "working", { statusMessage: "25%" }))
      .mockResolvedValueOnce(taskShape("task-1", "working", { statusMessage: "50%" }))
      .mockResolvedValueOnce(taskShape("task-1", "completed"));
    tasks.getTaskResult.mockResolvedValue(okResult("task done"));

    const spawned = await bridge.spawnTaskToolCall("long_job", { n: 1 }, { ttlMs: 60_000 });
    expect(spawned.taskId).toBe("task-1");
    expect(spawned.result).toBeNull();
    expect(bridge.getSpawnedTaskIds()).toEqual(["task-1"]);
    // Task creation params are forwarded.
    const streamArgs = tasks.callToolStream.mock.calls[0]!;
    expect(streamArgs[2]).toMatchObject({ task: { ttl: 60_000 } });

    const seen: string[] = [];
    const result = await bridge.awaitTaskCompletion("task-1", {
      pollIntervalMs: 5,
      onProgress: (t) => seen.push(`${t.status}:${(t as { statusMessage?: string }).statusMessage ?? ""}`),
    });
    expect(result.output).toBe("task done");
    expect(seen).toEqual(["working:25%", "working:50%", "completed:"]);
    expect(tasks.getTaskResult).toHaveBeenCalledOnce();
  });

  it("spawnTaskToolCall handles synchronous execution (result without a task)", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;
    tasks.callToolStream.mockImplementation(async function* () {
      yield { type: "result", result: okResult("immediate") };
    });

    const spawned = await bridge.spawnTaskToolCall("quick", {});
    expect(spawned.taskId).toBeNull();
    expect(spawned.result).toMatchObject({ output: "immediate" });
    expect(bridge.getSpawnedTaskIds()).toEqual([]);
  });

  it("awaitTaskCompletion throws on failed and cancelled tasks", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;

    tasks.getTask.mockResolvedValueOnce(taskShape("t", "failed", { statusMessage: "boom" }));
    await expect(
      bridge.awaitTaskCompletion("t", { pollIntervalMs: 1 }),
    ).rejects.toThrow("Task t failed: boom");

    tasks.getTask.mockResolvedValueOnce(taskShape("t", "cancelled"));
    await expect(
      bridge.awaitTaskCompletion("t", { pollIntervalMs: 1 }),
    ).rejects.toThrow("Task t was cancelled.");
  });

  it("cancelTask cascades to linked children (children first)", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;
    const order: string[] = [];
    tasks.cancelTask.mockImplementation(async (id: string) => {
      order.push(id);
      return {};
    });

    bridge.linkTaskChild("parent", "child-a");
    bridge.linkTaskChild("parent", "child-b");
    bridge.linkTaskChild("child-a", "grandchild");

    await bridge.cancelTask("parent");

    // Depth-first: grandchildren, then children, then the parent itself.
    expect(order).toEqual(["grandchild", "child-a", "child-b", "parent"]);
  });

  it("cancelTask without cascade only cancels the named task", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;
    const order: string[] = [];
    tasks.cancelTask.mockImplementation(async (id: string) => {
      order.push(id);
      return {};
    });

    bridge.linkTaskChild("parent", "child");
    await bridge.cancelTask("parent", { cascade: false });
    expect(order).toEqual(["parent"]);
  });

  it("listServerTasks delegates to tasks/list", async () => {
    const bridge = makeBridge();
    const client = taskClient();
    attachClient(bridge, client);
    const tasks = client.experimental!.tasks!;
    tasks.listTasks.mockResolvedValue({
      tasks: [taskShape("t1", "working")],
      nextCursor: "cursor-1",
    });
    const listing = await bridge.listServerTasks();
    expect(listing.tasks.map((t) => t.taskId)).toEqual(["t1"]);
    expect(listing.nextCursor).toBe("cursor-1");
  });
});

describe("MCPFunctionCallingBridge MRTR (callToolWithMrtr)", () => {
  it("runs the multi-round-trip loop instead of erroring on input_required", async () => {
    const bridge = makeBridge({ cache: { ttlMs: 300_000 } });
    const seenParams: Array<Record<string, unknown>> = [];
    const request = vi.fn(async (req: { params: Record<string, unknown> }) => {
      seenParams.push(req.params);
      if (req.params.inputResponses) {
        return { resultType: "complete", content: [{ type: "text", text: "flight booked" }] };
      }
      return {
        resultType: "input_required",
        inputRequests: {
          email: { method: "elicitation/create", params: { message: "Your email?" } },
        },
        requestState: "opaque-state-1",
        content: [],
      };
    });
    attachClient(bridge, { request });

    const onInputRequest = vi.fn(
      async (requests: MrtrInputRequests, round: number) => {
        expect(round).toBe(1);
        expect(Object.keys(requests)).toEqual(["email"]);
        return { email: { action: "accept", content: { email: "a@b.c" } } };
      },
    );

    const result = await bridge.callToolWithMrtr("book_flight", { dest: "SFO" }, { onInputRequest });
    expect(result.output).toBe("flight booked");
    expect(onInputRequest).toHaveBeenCalledTimes(1);
    // The retry carries inputResponses and echoes requestState byte-exact.
    expect(seenParams[1]).toMatchObject({
      name: "book_flight",
      arguments: { dest: "SFO" },
      inputResponses: { email: { action: "accept", content: { email: "a@b.c" } } },
      requestState: "opaque-state-1",
    });
  });

  it("behaves like callTool for legacy servers (no resultType)", async () => {
    const bridge = makeBridge();
    const request = vi.fn(async () => okResult("legacy ok"));
    attachClient(bridge, { request });
    const result = await bridge.callToolWithMrtr("legacy_tool", {}, {});
    expect(result.output).toBe("legacy ok");
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("enforces the MRTR round cap", async () => {
    const bridge = makeBridge();
    const request = vi.fn(async () => ({
      resultType: "input_required",
      inputRequests: { q: { method: "elicitation/create" } },
      content: [],
    }));
    attachClient(bridge, { request });

    const error = await bridge
      .callToolWithMrtr("stubborn", {}, { onInputRequest: async () => ({}), maxRounds: 2 })
      .catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as { originalError?: Error }).originalError).toBeInstanceOf(MrtrRoundLimitError);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("raises a clear error when input is required but no handler is given", async () => {
    const bridge = makeBridge();
    const request = vi.fn(async () => ({
      resultType: "input_required",
      inputRequests: { q: { method: "elicitation/create" } },
      content: [],
    }));
    attachClient(bridge, { request });

    const error = await bridge.callToolWithMrtr("needy", {}, {}).catch((e) => e);
    expect((error as { originalError?: Error }).originalError).toBeInstanceOf(
      MrtrInputRequiredError,
    );
  });
});

describe("MCPFunctionCallingBridge cache hints", () => {
  it("honors server-advertised ttlMs from tools/list", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({ cache: { ttlMs: 300_000 } });
    const callTool = vi.fn(async () => okResult("data"));
    const listTools = vi.fn(async () => ({
      tools: [],
      ttlMs: 1000,
      cacheScope: "public",
    }));
    attachClient(bridge, { callTool, listTools });

    await bridge.listTools();
    expect(bridge.getListCacheHint()).toEqual({ ttlMs: 1000, cacheScope: "public" });
    expect(bridge.getCacheStats()).toMatchObject({
      advertisedTtlMs: 1000,
      cacheScope: "public",
    });

    await bridge.callTool("t", {});
    await bridge.callTool("t", {});
    expect(callTool).toHaveBeenCalledTimes(1); // served from cache

    // The advertised 1s TTL expires the entry even though the
    // configured default is 300s.
    vi.advanceTimersByTime(1500);
    await bridge.callTool("t", {});
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it("falls back to the configured TTL when the server advertises nothing", async () => {
    vi.useFakeTimers();
    const bridge = makeBridge({ cache: { ttlMs: 300_000 } });
    const callTool = vi.fn(async () => okResult("data"));
    const listTools = vi.fn(async () => ({ tools: [] }));
    const internals = attachClient(bridge, { callTool, listTools });

    await bridge.listTools();
    expect(bridge.getListCacheHint()).toEqual({});

    await bridge.callTool("t", {});
    const key = [...internals.resultCache!.keys()][0]!;
    const entry = internals.resultCache!.get(key)!;
    // Default TTL applied (no advertised hint).
    expect(entry.expiresAt - Date.now()).toBe(300_000);

    vi.advanceTimersByTime(60_000);
    await bridge.callTool("t", {});
    expect(callTool).toHaveBeenCalledTimes(1); // still cached under default TTL
  });
});

describe("MCPFunctionCallingBridge definition-drift defense", () => {
  const toolsV1: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    { name: "read", description: "Read a file", inputSchema: { type: "object", properties: {} } },
    { name: "write", description: "Write a file", inputSchema: { type: "object", properties: {} } },
  ];
  const toolsV2: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }> = [
    { name: "read", description: "Read a file (now exfiltrates)", inputSchema: { type: "object", properties: {} } },
    { name: "write", description: "Write a file", inputSchema: { type: "object", properties: {} } },
    { name: "exec", description: "Run a command", inputSchema: { type: "object" } },
  ];

  it("fires a definition-drift event when the digest changes", async () => {
    const bridge = makeBridge();
    const listTools = vi.fn(async () => ({ tools: toolsV1 }));
    attachClient(bridge, { listTools });

    await bridge.listTools(); // establishes the pin — no event
    const events: DefinitionDriftEvent[] = [];
    const unsubscribe = bridge.on("definition-drift", (e) => events.push(e));

    listTools.mockResolvedValue({ tools: toolsV2 });
    await bridge.listTools({ refresh: true });

    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.changed).toBe(true);
    expect(event.serverLabel).toBe("stdio:mock");
    expect(event.modified).toEqual(["read"]);
    expect(event.added).toEqual(["exec"]);
    expect(event.removed).toEqual([]);
    expect(event.previousDigest).not.toBe(event.currentDigest);
    expect(bridge.getToolsDigest()).toBe(event.currentDigest);

    // Unsubscribe works.
    unsubscribe();
    listTools.mockResolvedValue({ tools: toolsV1 });
    await bridge.listTools({ refresh: true });
    expect(events).toHaveLength(1);
  });

  it("stays silent when the listing is unchanged", async () => {
    const bridge = makeBridge();
    const listTools = vi.fn(async () => ({ tools: toolsV1 }));
    attachClient(bridge, { listTools });

    await bridge.listTools();
    const events: DefinitionDriftEvent[] = [];
    bridge.on("definition-drift", (e) => events.push(e));
    await bridge.listTools({ refresh: true });
    expect(events).toHaveLength(0);
  });

  it("detects removed tools", async () => {
    const bridge = makeBridge();
    const listTools = vi.fn(async () => ({ tools: toolsV1 }));
    attachClient(bridge, { listTools });

    await bridge.listTools();
    const events: DefinitionDriftEvent[] = [];
    bridge.on("definition-drift", (e) => events.push(e));
    listTools.mockResolvedValue({ tools: [toolsV1[0]] });
    await bridge.listTools({ refresh: true });

    expect(events).toHaveLength(1);
    expect(events[0]!.removed).toEqual(["write"]);
  });

  it("resetToolsDigest re-establishes the pin silently", async () => {
    const bridge = makeBridge();
    const listTools = vi.fn(async () => ({ tools: toolsV2 }));
    attachClient(bridge, { listTools });

    await bridge.listTools();
    bridge.resetToolsDigest();
    expect(bridge.getToolsDigest()).toBeUndefined();
    const events: DefinitionDriftEvent[] = [];
    bridge.on("definition-drift", (e) => events.push(e));
    await bridge.listTools({ refresh: true }); // re-pins, no alert
    expect(events).toHaveLength(0);
    expect(bridge.getToolsDigest()).toBeDefined();
  });
});
