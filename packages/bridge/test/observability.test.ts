import { describe, it, expect, vi } from "vitest";
import { BridgeObservability, estimateTokenCount, estimateTokenCost } from "../src/observability.js";

describe("Observability", () => {
  describe("estimateTokenCount", () => {
    it("estimates tokens from text length", () => {
      // 3.5 chars per token heuristic
      expect(estimateTokenCount("hello world")).toBeGreaterThan(0);
      expect(estimateTokenCount("a".repeat(350))).toBe(100);
    });

    it("returns 0 for empty or undefined text", () => {
      expect(estimateTokenCount("")).toBe(0);
      expect(estimateTokenCount(undefined)).toBe(0);
      expect(estimateTokenCount(null)).toBe(0);
    });
  });

  describe("estimateTokenCost", () => {
    it("returns 0 for unknown models", () => {
      expect(estimateTokenCost("unknown-model", 1000, 1000)).toBe(0);
    });

    it("calculates cost for known models", () => {
      // GPT-4o: $2.50/M input, $10.00/M output
      const cost = estimateTokenCost("gpt-4o", 1_000_000, 1_000_000);
      // 1M input = $2.50, 1M output = $10.00, total = $12.50
      expect(cost).toBe(12.5);
    });

    it("calculates cost for claude models", () => {
      // Claude 3.5 Sonnet: $3.00/M input, $15.00/M output
      const cost = estimateTokenCost("claude-3-5-sonnet-20241022", 500_000, 100_000);
      // 500K input = $1.50, 100K output = $1.50, total = $3.00
      expect(cost).toBe(3.0);
    });

    it("supports prefix matching for versioned model names", () => {
      const cost = estimateTokenCost("gpt-4o-2024-08-06", 1_000_000, 0);
      expect(cost).toBe(2.5); // Just input cost
    });
  });

  describe("BridgeObservability", () => {
    it("creates instance with default options", () => {
      const obs = new BridgeObservability({ tracing: false });
      expect(obs.isTracingEnabled()).toBe(false);
      expect(obs.getTracer()).toBeUndefined();
    });

    it("does not enable tracing when tracing is false", () => {
      const obs = new BridgeObservability({ tracing: false });
      expect(obs.isTracingEnabled()).toBe(false);
    });

    it("attempts to load global tracer when tracing is true", async () => {
      // @opentelemetry/api may or may not be installed in the test environment.
      // If it is installed, a tracer will be created (even if no backend is configured).
      // If it's not installed, the tracer remains undefined.
      const obs = new BridgeObservability({ tracing: true });
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Either a tracer was loaded (OTEL installed) or tracing stays disabled (OTEL not installed).
      // Both are valid outcomes — tracing won't actually emit anywhere without a backend.
      const tracer = obs.getTracer();
      if (tracer !== undefined) {
        expect(typeof tracer.startSpan).toBe("function");
      }
      // In either case, isTracingEnabled should reflect whether we have a tracer.
      expect(obs.isTracingEnabled()).toBe(tracer !== undefined);
    });

    it("accepts a custom tracer instance", () => {
      const mockTracer = {
        startSpan: vi.fn().mockReturnValue({
          setAttribute: vi.fn().mockReturnThis(),
          attributes: {},
          end: vi.fn(),
        }),
      };
      const obs = new BridgeObservability({
        tracing: true,
        tracer: mockTracer,
      });
      expect(obs.isTracingEnabled()).toBe(true);
      expect(obs.getTracer()).toBe(mockTracer);
    });

    it("startToolSpan returns undefined when no tracer", () => {
      const obs = new BridgeObservability({ tracing: false });
      const result = obs.startToolSpan("test_tool", { arg: "value" });
      expect(result).toBeUndefined();
    });

    it("endToolSpan is a no-op when handle is undefined", () => {
      const obs = new BridgeObservability({ tracing: false });
      // Should not throw.
      obs.endToolSpan(undefined, "output", "error", "gpt-4o");
      expect(true).toBe(true);
    });

    it("startToolSpan/endToolSpan work with custom tracer", () => {
      const endFn = vi.fn();
      const setAttributeFn = vi.fn().mockReturnThis();
      const mockTracer = {
        startSpan: vi.fn().mockReturnValue({
          setAttribute: setAttributeFn,
          attributes: {},
          end: endFn,
        }),
      };
      const obs = new BridgeObservability({
        tracing: true,
        tracer: mockTracer,
      });

      const handle = obs.startToolSpan("test_tool", { query: "hello" });
      expect(handle).toBeDefined();
      expect(mockTracer.startSpan).toHaveBeenCalledWith("mcp.tool.test_tool", {
        attributes: expect.objectContaining({
          "gen_ai.tool.name": "test_tool",
          "gen_ai.tool.type": "mcp",
          "gen_ai.operation.name": "tool_call",
          "service.name": "umt-bridge",
          "gen_ai.tool.arguments": '{"query":"hello"}',
        }),
      });

      obs.endToolSpan(handle, "result output", undefined, "gpt-4o");
      expect(setAttributeFn).toHaveBeenCalled();
      expect(endFn).toHaveBeenCalled();
    });

    it("getOptions returns resolved options", () => {
      const obs = new BridgeObservability({
        serviceName: "my-service",
        maxArgLength: 100,
      });
      const opts = obs.getOptions();
      expect(opts.serviceName).toBe("my-service");
      expect(opts.maxArgLength).toBe(100);
      expect(opts.tracing).toBe(false);
    });
  });
});
