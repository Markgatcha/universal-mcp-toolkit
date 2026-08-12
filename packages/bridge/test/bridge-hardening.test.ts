import { afterEach, describe, expect, it, vi } from "vitest";
import { MCPFunctionCallingBridge } from "../src/bridge.js";
import type { BridgeToolResult } from "../src/types.js";

type MockClient = {
  callTool: ReturnType<typeof vi.fn>;
};

type BridgeInternals = {
  client: MockClient;
  resultCache: Map<string, { result: BridgeToolResult; expiresAt: number }> | null;
  buildCacheKey(toolName: string, args: Record<string, unknown>): string;
};

function attachClient(
  bridge: MCPFunctionCallingBridge,
  callTool: MockClient["callTool"],
): BridgeInternals {
  const internals = bridge as unknown as BridgeInternals;
  internals.client = { callTool };
  return internals;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("MCPFunctionCallingBridge hardening", () => {
  it("preserves observability options and activates tracing", async () => {
    const span = {
      attributes: {},
      setAttribute: vi.fn().mockReturnThis(),
      end: vi.fn(),
    };
    const tracer = {
      startSpan: vi.fn(() => span),
    };
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      {
        health: false,
        observability: { tracing: true, tracer },
      },
    );
    attachClient(
      bridge,
      vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    );

    await expect(bridge.callTool("safe_tool")).resolves.toMatchObject({ output: "ok" });
    expect(tracer.startSpan).toHaveBeenCalledWith(
      "mcp.tool.safe_tool",
      expect.objectContaining({
        attributes: expect.objectContaining({ "gen_ai.tool.name": "safe_tool" }),
      }),
    );
    expect(span.end).toHaveBeenCalledOnce();
  });

  it("preserves policies and enforces them before remote execution", async () => {
    const remoteCall = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "should not run" }],
    });
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      {
        health: false,
        suppressErrors: false,
        policies: {
          policies: [{ name: "deny-all", defaultAction: "deny", rules: [] }],
        },
      },
    );
    attachClient(bridge, remoteCall);

    await expect(bridge.callTool("restricted_tool")).rejects.toThrow(
      "Access denied: tool 'restricted_tool' is not allowed",
    );
    expect(remoteCall).not.toHaveBeenCalled();
  });

  it("denies direct calls outside allowedTools before cache or remote execution", async () => {
    const auditLog = { log: vi.fn() };
    const remoteCall = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "remote result" }],
    });
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      {
        allowedTools: ["safe_tool"],
        auditLog,
        cache: { ttlMs: 60_000 },
        health: false,
      },
    );
    const internals = attachClient(bridge, remoteCall);
    const args = { value: 1 };
    internals.resultCache!.set(
      internals.buildCacheKey("forbidden_tool", args),
      {
        result: { output: "cached forbidden result" },
        expiresAt: Date.now() + 60_000,
      },
    );

    const result = await bridge.callTool("forbidden_tool", args);

    expect(result).toMatchObject({
      error: true,
      output: expect.stringContaining(
        "Access denied: Tool 'forbidden_tool' is not included in allowedTools",
      ),
    });
    expect(result.output).not.toContain("cached forbidden result");
    expect(remoteCall).not.toHaveBeenCalled();
    expect(auditLog.log).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "forbidden_tool",
        success: false,
        error: expect.stringContaining("Access denied"),
        policyDecision: expect.objectContaining({
          allowed: false,
          policyName: "allowedTools",
        }),
      }),
    );
  });

  it("clears a tool timeout after the call settles", async () => {
    vi.useFakeTimers();
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      { health: false },
    );
    attachClient(
      bridge,
      vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
    );

    await bridge.callTool("fast_tool", {}, 30_000);

    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports only likely transport failures to connection health", async () => {
    const remoteCall = vi
      .fn()
      .mockRejectedValueOnce(new Error("Tool validation failed"))
      .mockRejectedValueOnce(
        Object.assign(new Error("socket closed during request"), {
          code: "ECONNRESET",
        }),
      );
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      { health: { failureThreshold: 5 } },
    );
    attachClient(bridge, remoteCall);
    const monitor = bridge.getHealthMonitor()!;

    await expect(bridge.callTool("failing_tool")).resolves.toMatchObject({ error: true });
    expect(monitor.getFailureCount()).toBe(0);

    await expect(bridge.callTool("failing_tool")).resolves.toMatchObject({ error: true });
    expect(monitor.getFailureCount()).toBe(1);
  });

  it("shares a full-digest cache key for reordered JSON arguments", async () => {
    const remoteCall = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "cached result" }],
    });
    const bridge = new MCPFunctionCallingBridge(
      { transport: "stdio", commandOrUrl: "mock" },
      { cache: { ttlMs: 60_000 }, health: false },
    );
    const internals = attachClient(bridge, remoteCall);
    const firstArgs = {
      query: "bugs",
      filters: { state: "open", labels: ["bug", "priority"] },
    };
    const reorderedArgs = {
      filters: { labels: ["bug", "priority"], state: "open" },
      query: "bugs",
    };

    const firstKey = internals.buildCacheKey("search", firstArgs);
    const reorderedKey = internals.buildCacheKey("search", reorderedArgs);
    expect(reorderedKey).toBe(firstKey);
    expect(firstKey).toMatch(/:[a-f0-9]{64}$/);

    await bridge.callTool("search", firstArgs);
    await bridge.callTool("search", reorderedArgs);

    expect(remoteCall).toHaveBeenCalledOnce();
  });
});
