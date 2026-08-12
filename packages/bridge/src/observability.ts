/**
 * OpenTelemetry observability instrumentation for the MCP bridge.
 *
 * Emits distributed traces following the OpenTelemetry GenAI semantic
 * conventions (gen_ai.*) so that traces can be ingested by any OTEL-compatible
 * backend — LangFuse, LangSmith, Datadog, Arize Phoenix, OpenObserve, etc.
 *
 * Each `callTool()` invocation creates a child span with attributes for:
 * - Tool name and arguments (redacted)
 * - Duration and success/failure status
 * - Result size in characters
 * - Token estimates (input/output)
 * - Cost estimation (optional, per-provider pricing model)
 *
 * @module @universal-mcp-toolkit/bridge/observability
 */

// We use a minimal type shim instead of importing @opentelemetry/api
// at compile time. The API is loaded dynamically at runtime so the
// bridge works even when OTEL is not installed.
type TraceableSpan = {
  setAttribute(key: string, value: unknown): TraceableSpan;
  attributes: Record<string, unknown>;
  end(): void;
};

type TracerLike = {
  startSpan(name: string, options: { attributes?: Record<string, unknown> }): TraceableSpan;
};

type TraceAPI = {
  getTracer(name: string, version?: string): TracerLike;
};

/**
 * Options for the observability instrumentation.
 */
export interface ObservabilityOptions {
  /** Whether to emit trace spans for tool calls. Default: false. */
  tracing?: boolean;
  /** Optional Tracer instance. If omitted, uses the default global tracer. */
  tracer?: TracerLike;
  /** Optional service name for trace attribution. Default: "umt-bridge". */
  serviceName?: string;
  /** Whether to include tool arguments in span attributes. Default: true. */
  includeArgs?: boolean;
  /** Maximum length of serialized arguments to include. Default: 500 chars. */
  maxArgLength?: number;
  /** Whether to include tool output in span attributes. Default: false (can be large). */
  includeOutput?: boolean;
  /** Maximum length of output to include. Default: 1000 chars. */
  maxOutputLength?: number;
  /** Whether to estimate tokens. Default: true. */
  estimateTokens?: boolean;
  /** Whether to estimate cost. Default: false. */
  estimateCost?: boolean;
}

/**
 * Cost per 1M tokens for major LLM providers (USD).
 * Used for cost estimation in trace attributes.
 * Sources: provider pricing pages as of 2026-01.
 */
const TOKEN_COSTS: ReadonlyArray<{
  modelPrefix: string;
  inputCostPerMtok: number;
  outputCostPerMtok: number;
}> = [
  { modelPrefix: "gpt-4o", inputCostPerMtok: 2.50, outputCostPerMtok: 10.00 },
  { modelPrefix: "gpt-4o-mini", inputCostPerMtok: 0.15, outputCostPerMtok: 0.60 },
  { modelPrefix: "o1", inputCostPerMtok: 15.00, outputCostPerMtok: 60.00 },
  { modelPrefix: "o3-mini", inputCostPerMtok: 3.00, outputCostPerMtok: 12.00 },
  { modelPrefix: "o3", inputCostPerMtok: 15.00, outputCostPerMtok: 60.00 },
  { modelPrefix: "claude-3-5-sonnet", inputCostPerMtok: 3.00, outputCostPerMtok: 15.00 },
  { modelPrefix: "claude-3-5-haiku", inputCostPerMtok: 0.80, outputCostPerMtok: 4.00 },
  { modelPrefix: "claude-3-opus", inputCostPerMtok: 15.00, outputCostPerMtok: 75.00 },
  { modelPrefix: "claude-sonnet-4", inputCostPerMtok: 3.00, outputCostPerMtok: 15.00 },
  { modelPrefix: "claude-opus-4", inputCostPerMtok: 15.00, outputCostPerMtok: 75.00 },
  { modelPrefix: "gemini-2.0-flash", inputCostPerMtok: 0.075, outputCostPerMtok: 0.30 },
  { modelPrefix: "gemini-2.0-pro", inputCostPerMtok: 0.35, outputCostPerMtok: 1.05 },
  { modelPrefix: "gemini-1.5-flash", inputCostPerMtok: 0.075, outputCostPerMtok: 0.30 },
  { modelPrefix: "gemini-1.5-pro", inputCostPerMtok: 1.75, outputCostPerMtok: 5.25 },
];

/**
 * Estimate token count from text using a simple heuristic
 * (chars / 3.5 — consistent with the existing `estimateTokens()` in core).
 */
export function estimateTokenCount(text: string | undefined | null): number {
  if (!text) return 0;
  return Math.max(1, Math.floor(text.length / 3.5));
}

/**
 * Estimate the cost (in USD) of a tool call based on token usage.
 * Returns 0 if the model is not found in the cost table.
 */
export function estimateTokenCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const lower = model.toLowerCase();
  const match = TOKEN_COSTS.find((c) => lower.startsWith(c.modelPrefix.toLowerCase()));
  if (!match) return 0;

  const inputCost = (inputTokens / 1_000_000) * match.inputCostPerMtok;
  const outputCost = (outputTokens / 1_000_000) * match.outputCostPerMtok;
  return Math.round((inputCost + outputCost) * 10000) / 10000; // Round to 4 decimal places.
}

/**
 * Keys in tool arguments that are considered sensitive and should be
 * redacted in trace attributes. Matching is case-insensitive on substrings.
 */
const SENSITIVE_KEYS = ["token", "password", "secret", "apikey", "api_key", "auth", "credential", "key"];

/**
 * Recursively redact sensitive argument keys for safe inclusion
 * in trace attributes.
 */
function redactArgs(args: unknown, maxLength?: number): string {
  const redacted = redactDeep(args);
  let json = JSON.stringify(redacted);
  if (maxLength && json.length > maxLength) {
    json = json.slice(0, maxLength) + "...";
  }
  return json;
}

function redactDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactDeep);
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((s) => lower.includes(s));
      if (isSensitive && typeof v === "string") {
        result[k] = "[REDACTED]";
      } else {
        result[k] = redactDeep(v);
      }
    }
    return result;
  }
  return value;
}

/**
 * Default resolved observability options.
 */
const DEFAULTS = {
  tracing: false,
  serviceName: "umt-bridge",
  includeArgs: true,
  maxArgLength: 500,
  includeOutput: false,
  maxOutputLength: 1000,
  estimateTokens: true,
  estimateCost: false,
};

/**
 * OpenTelemetry observability manager for the MCP bridge.
 *
 * Wraps an OTEL Tracer and provides helpers for creating and ending
 * spans around tool calls, following the GenAI semantic conventions.
 *
 * If the `@opentelemetry/api` package is not installed, the manager
 * operates in a no-op mode — spans are silently skipped.
 */
export class BridgeObservability {
  private readonly options: typeof DEFAULTS & {
    tracer?: TracerLike;
    model?: string;
  };

  private tracer: TracerLike | undefined;

  constructor(options: ObservabilityOptions = {}) {
    this.options = {
      ...DEFAULTS,
      ...options,
    };

    // If a tracer was explicitly provided, use it directly.
    if (this.options.tracer) {
      this.tracer = this.options.tracer;
    } else if (this.options.tracing) {
      // Try to load @opentelemetry/api dynamically.
      // This works even if the package is not installed — the
      // import will fail silently and tracing becomes a no-op.
      this.loadGlobalTracer().catch(() => {
        // No-op — tracing remains disabled.
      });
    }
  }

  /**
   * Attempt to load the global OTEL tracer asynchronously.
   * If @opentelemetry/api is not installed or no tracer is registered,
   * this silently fails.
   */
  private async loadGlobalTracer(): Promise<void> {
    try {
      // Dynamic import — only executed if tracing is enabled.
      const otel = await import("@opentelemetry/api");
      const trace: TraceAPI = otel.trace as unknown as TraceAPI;
      this.tracer = trace.getTracer(this.options.serviceName, "1.0.0");
    } catch {
      // OTEL not installed — tracing is a no-op.
    }
  }

  /**
   * Whether tracing is enabled.
   */
  isTracingEnabled(): boolean {
    return this.options.tracing === true && this.tracer !== undefined;
  }

  /**
   * Start a new span for a tool call. Returns a handle that must
   * be ended by calling `endSpan()`.
   *
   * @returns A span handle, or `undefined` if tracing is disabled.
   */
  startToolSpan(
    toolName: string,
    args: Record<string, unknown>,
    model?: string,
  ): { span: TraceableSpan; startTime: number } | undefined {
    if (!this.tracer) return undefined;

    const startTime = Date.now();

    const attrs: Record<string, unknown> = {
      "gen_ai.tool.name": toolName,
      "gen_ai.tool.type": "mcp",
      "gen_ai.operation.name": "tool_call",
      "service.name": this.options.serviceName,
    };

    if (this.options.includeArgs) {
      attrs["gen_ai.tool.arguments"] = redactArgs(args, this.options.maxArgLength);
    }

    if (model) {
      attrs["gen_ai.request.model"] = model;
    }

    const span = this.tracer.startSpan(`mcp.tool.${toolName}`, { attributes: attrs });

    return { span, startTime };
  }

  /**
   * End a tool-call span, recording the outcome.
   */
  endToolSpan(
    handle: { span: TraceableSpan; startTime: number } | undefined,
    output?: string,
    error?: string,
    model?: string,
  ): void {
    if (!handle?.span) return;

    const { span, startTime } = handle;
    const durationMs = Date.now() - startTime;

    // Update attributes with result info.
    if (output !== undefined) {
      span.setAttribute("gen_ai.tool.output.length", output.length);
      if (this.options.includeOutput) {
        const truncated =
          output.length > this.options.maxOutputLength
            ? output.slice(0, this.options.maxOutputLength) + "..."
            : output;
        span.setAttribute("gen_ai.tool.output", truncated);
      }
    }

    if (error) {
      span.setAttribute("gen_ai.error", error);
      span.setAttribute("error", true);
    }

    span.setAttribute("duration_ms", durationMs);

    // Record token/cost estimates.
    if (this.options.estimateTokens) {
      const spanToolName = span.attributes["gen_ai.tool.name"] as string;
      const inputText = this.options.includeArgs
        ? (span.attributes["gen_ai.tool.arguments"] as string) || spanToolName
        : spanToolName;
      const outputText = output ?? "";
      const inputTokens = estimateTokenCount(inputText);
      const outputTokens = outputText ? estimateTokenCount(outputText) : 0;
      span.setAttribute("gen_ai.usage.input_tokens", inputTokens);
      span.setAttribute("gen_ai.usage.output_tokens", outputTokens);
      span.setAttribute("gen_ai.usage.total_tokens", inputTokens + outputTokens);
    }

    if (this.options.estimateCost && model) {
      const argsAttr = span.attributes["gen_ai.tool.arguments"] as string;
      const inputText = this.options.includeArgs ? argsAttr : span.attributes["gen_ai.tool.name"] as string;
      const inputTokens = estimateTokenCount(inputText || "");
      const outputTokens = output ? estimateTokenCount(output) : 0;
      const cost = estimateTokenCost(model, inputTokens, outputTokens);
      if (cost > 0) {
        span.setAttribute("gen_ai.cost.usd", cost);
      }
    }

    span.end();
  }

  /**
   * Get the current tracer instance (if any).
   */
  getTracer(): TracerLike | undefined {
    return this.tracer;
  }

  /**
   * Get the resolved options.
   */
  getOptions(): Readonly<typeof DEFAULTS> {
    return this.options as typeof DEFAULTS;
  }
}
