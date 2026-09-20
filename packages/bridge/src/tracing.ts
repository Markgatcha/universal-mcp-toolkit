/**
 * Turn-scoped tracing for the MCP bridge — one trace per agent turn / CLI
 * invocation, with a per-tool-call span named `server.tool`.
 *
 * Each span carries only privacy-safe metadata — span names, durations,
 * payload *sizes*, token estimates, cost estimates, and error status.
 * Tool arguments, tool outputs, credentials, and secrets are NEVER stored:
 * only byte sizes are recorded, never bodies.
 *
 * @example
 * ```ts
 * import { startTrace } from "@universal-mcp-toolkit/bridge";
 *
 * const trace = startTrace({ model: "gpt-4o" });
 * const bridge = new MCPFunctionCallingBridge(config, {
 *   tracing: { trace, server: "github" },
 * });
 * await bridge.connect();
 * await bridge.callTool("search_repositories", { query: "mcp" });
 * await bridge.disconnect();
 *
 * const finished = trace.endTrace();
 * console.log(trace.formatSummary(finished));
 * // → also: trace.toJson(finished) / trace.toOtelJson(finished)
 * ```
 *
 * Cost figures are *estimates* derived from a static, configurable per-model
 * price table — they are not actual billed amounts.
 *
 * @module @universal-mcp-toolkit/bridge/tracing
 */

import { randomUUID } from "node:crypto";
import { estimateTokenCount } from "./observability.js";

/**
 * Per-1M-token prices (USD) for a model. Used only for cost *estimates*.
 */
export interface ModelPrice {
  /** USD per 1M input tokens. */
  inputPerMtok: number;
  /** USD per 1M output tokens. */
  outputPerMtok: number;
}

/**
 * Sane-default per-model price table (USD per 1M tokens).
 *
 * These are approximate public list prices and drift over time — treat every
 * cost figure produced from them as an ESTIMATE, not a bill.
 */
export const DEFAULT_PRICE_TABLE: Readonly<Record<string, ModelPrice>> = {
  "gpt-4o": { inputPerMtok: 2.5, outputPerMtok: 10.0 },
  "gpt-4o-mini": { inputPerMtok: 0.15, outputPerMtok: 0.6 },
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10.0 },
  "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2.0 },
  "o1": { inputPerMtok: 15.0, outputPerMtok: 60.0 },
  "o3": { inputPerMtok: 15.0, outputPerMtok: 60.0 },
  "o3-mini": { inputPerMtok: 3.0, outputPerMtok: 12.0 },
  "claude-sonnet-4": { inputPerMtok: 3.0, outputPerMtok: 15.0 },
  "claude-opus-4": { inputPerMtok: 15.0, outputPerMtok: 75.0 },
  "claude-3-5-sonnet": { inputPerMtok: 3.0, outputPerMtok: 15.0 },
  "claude-3-5-haiku": { inputPerMtok: 0.8, outputPerMtok: 4.0 },
  "claude-3-opus": { inputPerMtok: 15.0, outputPerMtok: 75.0 },
  "gemini-2.5-pro": { inputPerMtok: 1.25, outputPerMtok: 10.0 },
  "gemini-2.5-flash": { inputPerMtok: 0.3, outputPerMtok: 2.5 },
  "gemini-2.0-flash": { inputPerMtok: 0.075, outputPerMtok: 0.3 },
  "gemini-1.5-pro": { inputPerMtok: 1.75, outputPerMtok: 5.25 },
};

/**
 * A cost model maps (model, inputTokens, outputTokens) → estimated USD.
 * Unknown models yield `null` (no estimate) rather than a made-up number.
 */
export interface TraceCostModel {
  /** Estimated USD cost, or `null` when the model has no price entry. */
  estimate(model: string, inputTokens: number, outputTokens: number): number | null;
  /** Whether the model has a price entry. */
  hasModel(model: string): boolean;
  /** The underlying price table (merged defaults + overrides). */
  prices: Readonly<Record<string, ModelPrice>>;
}

/**
 * Build a cost model from the default price table merged with caller
 * overrides. Override keys use prefix matching, so `"gpt-4o-2024-08-06"`
 * matches the `"gpt-4o"` entry.
 */
export function createCostModel(
  overrides: Readonly<Record<string, ModelPrice>> = {},
): TraceCostModel {
  const prices: Record<string, ModelPrice> = { ...DEFAULT_PRICE_TABLE, ...overrides };

  function findPrice(model: string): ModelPrice | undefined {
    const lower = model.toLowerCase();
    const exact = Object.keys(prices).find((k) => k.toLowerCase() === lower);
    if (exact) return prices[exact];
    const prefix = Object.keys(prices).find((k) => lower.startsWith(k.toLowerCase()));
    return prefix ? prices[prefix] : undefined;
  }

  return {
    prices,
    hasModel: (model) => findPrice(model) !== undefined,
    estimate: (model, inputTokens, outputTokens) => {
      const price = findPrice(model);
      if (!price) return null;
      const cost =
        (inputTokens / 1_000_000) * price.inputPerMtok +
        (outputTokens / 1_000_000) * price.outputPerMtok;
      return Math.round(cost * 1_000_000) / 1_000_000; // 6dp — estimates, not invoices.
    },
  };
}

/** Privacy-safe span for a single tool call. No bodies, args, or secrets — ever. */
export interface ToolCallSpan {
  /** Span name: `server.tool`. */
  name: string;
  server: string;
  tool: string;
  /** ISO-8601 start timestamp. */
  startTime: string;
  /** Wall-clock latency in milliseconds. */
  durationMs: number;
  /** Serialized input payload size in bytes (body never stored). */
  inputBytes: number;
  /** Serialized output payload size in bytes (body never stored). */
  outputBytes: number;
  /** Estimated input tokens (chars/3.5 heuristic). */
  inputTokens: number;
  /** Estimated output tokens. */
  outputTokens: number;
  /** Estimated USD cost, or `null` when the model has no price entry. */
  costUsd: number | null;
  status: "ok" | "error";
  /**
   * Error constructor name only (e.g. `"McpError"`), never the message —
   * messages can carry secrets. Set only when `status === "error"`.
   */
  errorType?: string;
  /** True when the result was served from the bridge result cache. */
  cached?: boolean;
}

/** Aggregate totals across every span in a trace. */
export interface TraceTotals {
  calls: number;
  errors: number;
  cachedHits: number;
  durationMs: number;
  inputBytes: number;
  outputBytes: number;
  inputTokens: number;
  outputTokens: number;
  /** Sum of per-span cost estimates; `null` when no span had a priced model. */
  costUsd: number | null;
}

/** A finished, exportable trace. */
export interface Trace {
  /** UMT trace envelope version. */
  format: "umt-trace/1";
  id: string;
  startedAt: string;
  endedAt: string;
  /** Model used for cost estimation (or `null` when unset). */
  model: string | null;
  spans: ToolCallSpan[];
  totals: TraceTotals;
}

/** Options for {@link startTrace}. */
export interface StartTraceOptions {
  /**
   * Model name used for cost estimation (prefix-matched against the price
   * table). Omit for token-only traces with no cost column.
   */
  model?: string;
  /** Custom per-model prices merged over {@link DEFAULT_PRICE_TABLE}. */
  prices?: Readonly<Record<string, ModelPrice>>;
  /**
   * Opt-in to storing truncated error messages on error spans.
   * Default `false` — only the error *type* is stored, since messages
   * can leak secrets.
   */
  captureErrorMessages?: boolean;
}

/** Opaque handle for an in-flight span; end it with `endSpan()`. */
export interface SpanHandle {
  server: string;
  tool: string;
  inputText: string;
  startTimeMs: number;
  startTimeIso: string;
  cached: boolean;
}

const COST_NOTE =
  "Cost figures are estimates from a static price table, not actual billed amounts.";

function byteLengthOf(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function serializeForMeasurement(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

function toHex(bytes: number): string {
  let out = "";
  const alphabet = "0123456789abcdef";
  for (let i = 0; i < bytes; i++) {
    out += alphabet[Math.floor(Math.random() * 16)];
  }
  return out;
}

/**
 * A turn-scoped trace recorder. Create one per agent turn / CLI invocation
 * with {@link startTrace}, record spans as tools are called, then finish with
 * {@link ActiveTrace.endTrace}.
 */
export class ActiveTrace {
  private readonly costModel: TraceCostModel;
  private readonly captureErrorMessages: boolean;
  private model: string | null;
  private readonly id: string;
  private readonly startedAt: string;
  private readonly spans: ToolCallSpan[] = [];

  constructor(options: StartTraceOptions = {}) {
    this.id = randomUUID();
    this.startedAt = new Date().toISOString();
    this.model = options.model ?? null;
    this.costModel = createCostModel(options.prices);
    this.captureErrorMessages = options.captureErrorMessages ?? false;
  }

  /** Trace ID (also used as the saved-trace filename). */
  getId(): string {
    return this.id;
  }

  /** Change the model used for cost estimation mid-trace. */
  setModel(model: string | null): void {
    this.model = model;
  }

  /**
   * Start a span for a tool call. The input is measured (serialized size,
   * token estimate) but never stored.
   */
  startSpan(server: string, tool: string, input: unknown, opts: { cached?: boolean } = {}): SpanHandle {
    const inputText = serializeForMeasurement(input);
    const now = Date.now();
    return {
      server,
      tool,
      inputText,
      startTimeMs: now,
      startTimeIso: new Date(now).toISOString(),
      cached: opts.cached ?? false,
    };
  }

  /**
   * End a span, computing latency, sizes, token estimates, cost estimate,
   * and error status. The output is measured but never stored.
   */
  endSpan(handle: SpanHandle, output?: unknown, error?: unknown): ToolCallSpan {
    const endMs = Date.now();
    const outputText = serializeForMeasurement(output);
    const inputBytes = byteLengthOf(handle.inputText);
    const outputBytes = byteLengthOf(outputText);
    const inputTokens = estimateTokenCount(handle.inputText);
    const outputTokens = outputText ? estimateTokenCount(outputText) : 0;
    const costUsd = this.model ? this.costModel.estimate(this.model, inputTokens, outputTokens) : null;

    const span: ToolCallSpan = {
      name: `${handle.server}.${handle.tool}`,
      server: handle.server,
      tool: handle.tool,
      startTime: handle.startTimeIso,
      durationMs: Math.max(0, endMs - handle.startTimeMs),
      inputBytes,
      outputBytes,
      inputTokens,
      outputTokens,
      costUsd,
      status: error === undefined || error === null ? "ok" : "error",
    };
    if (handle.cached) span.cached = true;
    if (span.status === "error") {
      span.errorType = error instanceof Error ? error.name : typeof error;
      if (this.captureErrorMessages) {
        const message = error instanceof Error ? error.message : String(error);
        // Stored only under explicit opt-in; still truncated for safety.
        span.errorType = `${span.errorType}: ${message.slice(0, 200)}`;
      }
    }
    this.spans.push(span);
    return span;
  }

  /**
   * Record a single tool call around an async function. Resolves with the
   * function's value; the span records `ok`, rejects record `error`.
   *
   * `extractOutput` maps the function's return value to the output payload
   * to measure. By default, a `.output` string property is used when present
   * (matching `BridgeToolResult`); otherwise the value is serialized.
   */
  async record<T>(
    server: string,
    tool: string,
    input: unknown,
    fn: () => Promise<T>,
    opts: { extractOutput?: (result: T) => unknown; cached?: boolean } = {},
  ): Promise<T> {
    const handle = this.startSpan(server, tool, input, { cached: opts.cached });
    try {
      const result = await fn();
      const output = opts.extractOutput
        ? opts.extractOutput(result)
        : (result as { output?: unknown } | null)?.output !== undefined
          ? (result as { output?: unknown }).output
          : result;
      this.endSpan(handle, output);
      return result;
    } catch (error) {
      this.endSpan(handle, undefined, error);
      throw error;
    }
  }

  /** Number of spans recorded so far. */
  spanCount(): number {
    return this.spans.length;
  }

  /** Finish the trace and compute totals. */
  endTrace(): Trace {
    const endedAt = new Date().toISOString();
    const totals: TraceTotals = {
      calls: this.spans.length,
      errors: 0,
      cachedHits: 0,
      durationMs: 0,
      inputBytes: 0,
      outputBytes: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
    };
    let costSum = 0;
    let costSeen = false;
    for (const span of this.spans) {
      if (span.status === "error") totals.errors++;
      if (span.cached) totals.cachedHits++;
      totals.durationMs += span.durationMs;
      totals.inputBytes += span.inputBytes;
      totals.outputBytes += span.outputBytes;
      totals.inputTokens += span.inputTokens;
      totals.outputTokens += span.outputTokens;
      if (span.costUsd !== null) {
        costSum += span.costUsd;
        costSeen = true;
      }
    }
    totals.costUsd = costSeen ? Math.round(costSum * 1_000_000) / 1_000_000 : null;

    return {
      format: "umt-trace/1",
      id: this.id,
      startedAt: this.startedAt,
      endedAt,
      model: this.model,
      spans: [...this.spans],
      totals,
    };
  }

  /**
   * Serialize a finished trace to the UMT trace JSON envelope.
   * Privacy-safe: contains sizes, never bodies.
   */
  toJson(trace: Trace): string {
    return JSON.stringify({ ...trace, costNote: COST_NOTE }, null, 2);
  }

  /**
   * Serialize a finished trace to OpenTelemetry OTLP/HTTP-compatible JSON
   * (`resourceSpans` → `scopeSpans` → `spans`), so traces can be shipped to
   * any OTEL-compatible backend (Langfuse, Datadog, Arize Phoenix, …).
   */
  toOtelJson(trace: Trace): string {
    const traceId = toHex(32);
    const otelSpans = trace.spans.map((span) => {
      const startNs = String(Date.parse(span.startTime) * 1_000_000);
      const endNs = String(Date.parse(span.startTime) * 1_000_000 + span.durationMs * 1_000_000);
      const attributes: Array<{ key: string; value: Record<string, string> }> = [
        { key: "umt.span.kind", value: { stringValue: "tool_call" } },
        { key: "umt.server", value: { stringValue: span.server } },
        { key: "umt.tool", value: { stringValue: span.tool } },
        { key: "umt.input.bytes", value: { intValue: String(span.inputBytes) } },
        { key: "umt.output.bytes", value: { intValue: String(span.outputBytes) } },
        { key: "gen_ai.usage.input_tokens", value: { intValue: String(span.inputTokens) } },
        { key: "gen_ai.usage.output_tokens", value: { intValue: String(span.outputTokens) } },
        { key: "umt.status", value: { stringValue: span.status } },
      ];
      if (span.costUsd !== null) {
        attributes.push({ key: "umt.cost_usd.estimated", value: { stringValue: String(span.costUsd) } });
      }
      if (span.errorType) {
        attributes.push({ key: "umt.error.type", value: { stringValue: span.errorType } });
      }
      if (span.cached) {
        attributes.push({ key: "umt.cached", value: { stringValue: "true" } });
      }
      if (trace.model) {
        attributes.push({ key: "gen_ai.request.model", value: { stringValue: trace.model } });
      }
      return {
        traceId,
        spanId: toHex(16),
        name: span.name,
        startTimeUnixNano: startNs,
        endTimeUnixNano: endNs,
        attributes,
        status: span.status === "error" ? { code: 2 } : { code: 1 },
      };
    });

    return JSON.stringify(
      {
        resourceSpans: [
          {
            resource: {
              attributes: [{ key: "service.name", value: { stringValue: "umt-bridge" } }],
            },
            scopeSpans: [
              {
                scope: { name: "umt-bridge/tracing", version: "1.0.0" },
                spans: otelSpans,
              },
            ],
          },
        ],
      },
      null,
      2,
    );
  }

  /**
   * Human-readable one-page summary of a finished trace.
   */
  formatSummary(trace: Trace): string {
    const lines: string[] = [];
    const t = trace.totals;
    lines.push(
      `Trace ${trace.id} — ${t.calls} call${t.calls === 1 ? "" : "s"}, ` +
        `${t.errors} error${t.errors === 1 ? "" : "s"}, ${t.durationMs}ms total`,
    );
    for (const span of trace.spans) {
      const status = span.status === "ok" ? (span.cached ? "cached" : "ok") : `error:${span.errorType ?? "?"}`;
      const cost = span.costUsd !== null ? `$${span.costUsd.toFixed(6)} est.` : "n/a";
      lines.push(
        `  ${span.name}  ${span.durationMs}ms  ` +
          `in ${span.inputBytes}B/${span.inputTokens}tok  ` +
          `out ${span.outputBytes}B/${span.outputTokens}tok  ` +
          `${cost}  ${status}`,
      );
    }
    const totalCost = t.costUsd !== null ? `$${t.costUsd.toFixed(6)} est.` : "n/a";
    lines.push(
      `Totals: ${t.calls} calls · ${t.errors} errors · ${t.cachedHits} cached · ` +
        `${t.inputTokens} in tok · ${t.outputTokens} out tok · ${totalCost}`,
    );
    return lines.join("\n");
  }
}

/**
 * Start a new turn-scoped trace. One trace per agent turn / CLI invocation.
 */
export function startTrace(options: StartTraceOptions = {}): ActiveTrace {
  return new ActiveTrace(options);
}
