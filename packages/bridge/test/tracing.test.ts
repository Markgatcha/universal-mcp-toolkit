import { describe, it, expect } from "vitest";
import {
  ActiveTrace,
  startTrace,
  createCostModel,
  DEFAULT_PRICE_TABLE,
  MCPFunctionCallingBridge,
} from "../src/index.js";
import type { Trace } from "../src/index.js";

function finish(trace: ActiveTrace): Trace {
  return trace.endTrace();
}

describe("turn-scoped tracing", () => {
  describe("startTrace / record / endTrace", () => {
    it("records one privacy-safe span per tool call named `server.tool`", async () => {
      const trace = startTrace({ model: "gpt-4o" });
      await trace.record("github", "search_repositories", { query: "mcp" }, async () => ({
        output: "found 3 repos",
      }));

      const finished = finish(trace);
      expect(finished.format).toBe("umt-trace/1");
      expect(finished.spans).toHaveLength(1);

      const span = finished.spans[0];
      expect(span.name).toBe("github.search_repositories");
      expect(span.server).toBe("github");
      expect(span.tool).toBe("search_repositories");
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
      expect(span.status).toBe("ok");
      expect(span.errorType).toBeUndefined();

      // Sizes recorded, bodies never stored.
      expect(span.inputBytes).toBeGreaterThan(0);
      expect(span.outputBytes).toBe("found 3 repos".length);
      expect(span.inputTokens).toBeGreaterThan(0);
      expect(span.outputTokens).toBeGreaterThan(0);

      const json = trace.toJson(finished);
      expect(json).not.toContain("found 3 repos");
      expect(json).not.toContain('"query"');
      expect(json).not.toContain("mcp");
    });

    it("computes totals across spans", async () => {
      const trace = startTrace({ model: "gpt-4o" });
      await trace.record("a", "t1", { x: 1 }, async () => ({ output: "one" }));
      await trace.record("a", "t2", { x: 2 }, async () => ({ output: "two" }));

      const totals = finish(trace).totals;
      expect(totals.calls).toBe(2);
      expect(totals.errors).toBe(0);
      expect(totals.inputBytes).toBeGreaterThan(0);
      expect(totals.outputBytes).toBe("one".length + "two".length);
      expect(totals.costUsd).not.toBeNull();
    });

    it("records error spans with error type only — never the message", async () => {
      const trace = startTrace();
      const secretMessage = "boom-secret-credential-leak-xyz";
      await expect(
        trace.record("github", "broken_tool", { token: "tok_abc123" }, async () => {
          const err = new Error(secretMessage);
          err.name = "McpError";
          throw err;
        }),
      ).rejects.toThrow(secretMessage);

      const finished = finish(trace);
      const span = finished.spans[0];
      expect(span.status).toBe("error");
      expect(span.errorType).toBe("McpError");
      expect(finished.totals.errors).toBe(1);

      const json = trace.toJson(finished);
      expect(json).not.toContain(secretMessage);
      expect(json).not.toContain("tok_abc123");
    });

    it("records cache-hit spans with zero duration", async () => {
      const trace = startTrace();
      const handle = trace.startSpan("github", "search", { q: "x" }, { cached: true });
      trace.endSpan(handle, "cached-output-body");

      const finished = finish(trace);
      const span = finished.spans[0];
      expect(span.cached).toBe(true);
      expect(span.status).toBe("ok");

      const json = trace.toJson(finished);
      expect(json).not.toContain("cached-output-body");
    });

    it("stores truncated error messages only under explicit opt-in", async () => {
      const trace = startTrace({ captureErrorMessages: true });
      await expect(
        trace.record("s", "t", {}, async () => {
          throw new Error("detailed failure reason");
        }),
      ).rejects.toThrow();

      const span = finish(trace).spans[0];
      expect(span.errorType).toContain("detailed failure reason");
    });

    it("supports manual startSpan/endSpan", () => {
      const trace = startTrace();
      const handle = trace.startSpan("notion", "get-page", { page_id: "abc" });
      const span = trace.endSpan(handle, "page body here");
      expect(span.name).toBe("notion.get-page");
      expect(trace.spanCount()).toBe(1);
    });
  });

  describe("cost model", () => {
    it("has sane defaults", () => {
      expect(DEFAULT_PRICE_TABLE["gpt-4o"]).toEqual({ inputPerMtok: 2.5, outputPerMtok: 10.0 });
    });

    it("estimates cost for known models", () => {
      const model = createCostModel();
      // gpt-4o: $2.50/M in, $10.00/M out → 1M in + 1M out = $12.50
      expect(model.estimate("gpt-4o", 1_000_000, 1_000_000)).toBe(12.5);
      expect(model.hasModel("gpt-4o")).toBe(true);
    });

    it("prefix-matches versioned model names", () => {
      const model = createCostModel();
      expect(model.estimate("gpt-4o-2024-08-06", 1_000_000, 0)).toBe(2.5);
    });

    it("returns null for unknown models instead of inventing a price", () => {
      const model = createCostModel();
      expect(model.estimate("mystery-model-9000", 1000, 1000)).toBeNull();
      expect(model.hasModel("mystery-model-9000")).toBe(false);
    });

    it("applies caller overrides over defaults", () => {
      const model = createCostModel({ "gpt-4o": { inputPerMtok: 1, outputPerMtok: 1 } });
      expect(model.estimate("gpt-4o", 1_000_000, 1_000_000)).toBe(2);
    });

    it("yields null cost totals when no model is set", async () => {
      const trace = startTrace();
      await trace.record("s", "t", {}, async () => ({ output: "x" }));
      const finished = finish(trace);
      expect(finished.model).toBeNull();
      expect(finished.spans[0].costUsd).toBeNull();
      expect(finished.totals.costUsd).toBeNull();
    });
  });

  describe("exports", () => {
    it("toJson produces the umt-trace/1 envelope with a cost disclaimer", async () => {
      const trace = startTrace({ model: "gpt-4o-mini" });
      await trace.record("s", "t", { a: 1 }, async () => ({ output: "out" }));
      const parsed = JSON.parse(trace.toJson(finish(trace)));
      expect(parsed.format).toBe("umt-trace/1");
      expect(parsed.id).toBe(trace.getId());
      expect(parsed.costNote).toMatch(/estimates/i);
      expect(parsed.spans[0].name).toBe("s.t");
      expect(parsed.totals.calls).toBe(1);
    });

    it("toOtelJson produces OTLP-compatible resourceSpans", async () => {
      const trace = startTrace({ model: "gpt-4o" });
      await trace.record("github", "search", {}, async () => ({ output: "x".repeat(100) }));
      const parsed = JSON.parse(trace.toOtelJson(finish(trace)));

      const spans = parsed.resourceSpans[0].scopeSpans[0].spans;
      expect(spans).toHaveLength(1);
      const span = spans[0];
      expect(span.name).toBe("github.search");
      expect(span.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
      expect(span.status.code).toBe(1);

      const attrs = Object.fromEntries(span.attributes.map((a: { key: string; value: object }) => [a.key, a.value]));
      expect(attrs["umt.server"]).toEqual({ stringValue: "github" });
      expect(attrs["gen_ai.usage.input_tokens"]).toBeDefined();
      expect(attrs["umt.input.bytes"]).toBeDefined();
      // No bodies in OTEL attributes either.
      const attrJson = JSON.stringify(span.attributes);
      expect(attrJson).not.toContain("x".repeat(100));
    });

    it("formatSummary renders a human-readable one-pager", async () => {
      const trace = startTrace({ model: "gpt-4o" });
      await trace.record("github", "search", { q: "mcp" }, async () => ({ output: "results" }));
      const summary = trace.formatSummary(finish(trace));
      expect(summary).toContain("github.search");
      expect(summary).toContain("1 call");
      expect(summary).toContain("Totals:");
      expect(summary).toContain("est.");
    });
  });

  describe("bridge integration", () => {
    function stubbedBridge(trace: ActiveTrace, opts: { suppressErrors?: boolean } = {}) {
      const bridge = new MCPFunctionCallingBridge(
        { transport: "stdio", commandOrUrl: "echo" },
        { tracing: { trace, server: "github" }, suppressErrors: opts.suppressErrors ?? false },
      );
      return bridge;
    }

    it("records a span for each callTool invocation", async () => {
      const trace = startTrace({ model: "gpt-4o-mini" });
      const bridge = stubbedBridge(trace);
      (bridge as unknown as { client: unknown }).client = {
        callTool: async () => ({ content: [{ type: "text", text: "issue #1: fix bug" }] }),
      };

      await bridge.callTool("list_issues", { owner: "octo", repo: "hello" });

      const finished = finish(trace);
      expect(finished.spans).toHaveLength(1);
      const span = finished.spans[0];
      expect(span.name).toBe("github.list_issues");
      expect(span.status).toBe("ok");
      expect(span.outputBytes).toBe("issue #1: fix bug".length);

      // Privacy: raw bodies never land in the trace.
      const json = trace.toJson(finished);
      expect(json).not.toContain("issue #1: fix bug");
      expect(json).not.toContain("octo");
    });

    it("records error spans when the tool call throws", async () => {
      const trace = startTrace();
      const bridge = stubbedBridge(trace);
      const secret = "transport-secret-failure-xyz";
      (bridge as unknown as { client: unknown }).client = {
        callTool: async () => {
          throw new Error(secret);
        },
      };

      await expect(bridge.callTool("broken", {})).rejects.toThrow();
      const finished = finish(trace);
      expect(finished.spans[0].status).toBe("error");
      expect(finished.totals.errors).toBe(1);
      expect(trace.toJson(finished)).not.toContain(secret);
    });

    it("marks tool-level isError results as error spans", async () => {
      const trace = startTrace();
      const bridge = stubbedBridge(trace, { suppressErrors: true });
      (bridge as unknown as { client: unknown }).client = {
        callTool: async () => ({
          content: [{ type: "text", text: "rate limited" }],
          isError: true,
        }),
      };

      await bridge.callTool("flaky", {});
      const finished = finish(trace);
      expect(finished.spans[0].status).toBe("error");
      expect(finished.spans[0].errorType).toBe("ToolError");
    });

    it("records cached results as cached spans", async () => {
      const trace = startTrace();
      const bridge = new MCPFunctionCallingBridge(
        { transport: "stdio", commandOrUrl: "echo" },
        {
          tracing: { trace, server: "github" },
          suppressErrors: false,
          cache: { ttlMs: 60_000 },
        },
      );
      (bridge as unknown as { client: unknown }).client = {
        callTool: async () => ({ content: [{ type: "text", text: "cached body" }] }),
      };

      await bridge.callTool("search", { q: "x" });
      await bridge.callTool("search", { q: "x" }); // cache hit

      const finished = finish(trace);
      expect(finished.spans).toHaveLength(2);
      expect(finished.spans[1].cached).toBe(true);
      expect(finished.spans[1].durationMs).toBe(0);
      expect(finished.totals.cachedHits).toBe(1);
    });

    it("does nothing when no trace is configured", async () => {
      const bridge = new MCPFunctionCallingBridge(
        { transport: "stdio", commandOrUrl: "echo" },
        { suppressErrors: false },
      );
      (bridge as unknown as { client: unknown }).client = {
        callTool: async () => ({ content: [{ type: "text", text: "ok" }] }),
      };
      const result = await bridge.callTool("t", {});
      expect(result.output).toBe("ok");
    });
  });
});
