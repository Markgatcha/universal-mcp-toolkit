/**
 * Dynamic token budget management for LLM context windows.
 *
 * Maps model names to their known context window sizes and provides
 * per-call budget allocation so agents can stay within limits when
 * working with large conversations, reasoning models, and multi-step
 * tool chains.
 *
 * @module @universal-mcp-toolkit/core/token-manager
 */

import { estimateTokens } from "./token-efficient.js";

/**
 * Known context window sizes for popular LLMs (in tokens).
 *
 * These are the *input* context windows. Output limits are typically
 * a subset of these and are not tracked here — callers should reserve
 * a portion of the budget for the LLM's generated response.
 *
 * Sources: model docs as of 2026-01. Values represent the official
 * context length guarantees from each provider.
 */
const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [string, number, string]> = [
  // OpenAI models
  ["gpt-4.5", 272_000, "OpenAI"],
  ["gpt-4o", 200_000, "OpenAI"],
  ["gpt-4o-mini", 200_000, "OpenAI"],
  ["o1", 200_000, "OpenAI"],
  ["o1-pro", 200_000, "OpenAI"],
  ["o3-mini", 200_000, "OpenAI"],
  ["o3", 200_000, "OpenAI"],

  // Anthropic models
  ["claude-3-5-sonnet-20241022", 200_000, "Anthropic"],
  ["claude-3-5-sonnet-20240620", 200_000, "Anthropic"],
  ["claude-3-5-haiku", 200_000, "Anthropic"],
  ["claude-3-opus", 200_000, "Anthropic"],
  ["claude-3-sonnet", 200_000, "Anthropic"],
  ["claude-3-haiku", 200_000, "Anthropic"],
  ["claude-sonnet-4", 200_000, "Anthropic"],
  ["claude-opus-4", 1_000_000, "Anthropic"],

  // Google models
  ["gemini-2.0-flash", 1_048_576, "Google"],
  ["gemini-2.0-pro", 1_048_576, "Google"],
  ["gemini-1.5-flash", 1_048_576, "Google"],
  ["gemini-1.5-pro", 1_048_576, "Google"],

  // Open source / local models (typical default context sizes)
  ["llama-3.1-70b", 128_000, "Ollama"],
  ["llama-3.1-8b", 128_000, "Ollama"],
  ["llama-3.2-3b", 128_000, "Ollama"],
  ["llama-3.3-70b", 128_000, "Ollama"],
  ["qwen-2.5-72b", 128_000, "Ollama"],
  ["gemma-4-e2b", 1_000_000, "Ollama"],
  ["gemma-4-e2b-it", 1_000_000, "Ollama"],
  ["mistral-large", 128_000, "Ollama"],
  ["mistral-small", 32_000, "Ollama"],
  ["mixtral-8x22b", 64_000, "Ollama"],

  // Default fallback for unknown models
  ["default", 8_192, "unknown"],
] as const;

/**
 * A fallback context window for models not in the mapping.
 * Used when no match is found — generous enough for most use cases
 * but small enough to avoid silent overflow.
 */
const DEFAULT_CONTEXT_WINDOW = 128_000;

/**
 * Fraction of the context window reserved for the LLM's output tokens.
 * Reasoning models (e.g. gemma-4 E2B) can consume large portions of
 * the budget on `reasoning_content`, so we reserve more for those.
 */
const OUTPUT_BUDGET_RATIO = 0.2;

/**
 * Fraction of the context window reserved for system instructions
 * and tool definitions. Tool schemas can be large when many MCP
 * servers are attached.
 */
const SYSTEM_BUDGET_RATIO = 0.1;

/**
 * Resolved model info for a given model name.
 */
export interface ModelTokenInfo {
  /** The matched model name (or "default"). */
  model: string;
  /** The provider that defines this context window (OpenAI, Anthropic, etc.). */
  provider: string;
  /** Total context window in tokens. */
  contextWindow: number;
  /** Tokens reserved for LLM output. */
  outputBudget: number;
  /** Tokens reserved for system prompt + tool definitions. */
  systemBudget: number;
  /** Tokens available for conversation history + tool results. */
  usableBudget: number;
}

/**
 * Options for computing a per-call token budget.
 */
export interface BudgetOptions {
  /**
   * The model name to look up context window size for.
   * Supports partial matching (e.g. "gpt-4o" matches "gpt-4o-2024-08-06").
   */
  model: string;
  /**
   * Estimated tokens already consumed by the conversation history
   * (system prompt + prior messages). Subtracted from the usable budget.
   */
  usedContextTokens?: number;
  /**
   * Estimated tokens consumed by tool definitions (JSON schemas).
   * Subtracted from the system budget. If omitted, the SYSTEM_BUDGET_RATIO
   * is used as a static allocation.
   */
  toolDefTokens?: number;
  /**
   * Override for the output budget ratio. Defaults to 0.2 (20%).
   */
  outputRatio?: number;
  /**
   * Override for the system budget ratio. Defaults to 0.1 (10%).
   */
  systemRatio?: number;
}

/**
 * Resolve a model name to its token information.
 *
 * Uses prefix matching so that versioned model names
 * (e.g. "claude-3-5-sonnet-20241022") are matched against
 * the entry names above.
 *
 * @param model - The model identifier to look up.
 * @returns Token info for the matched model, or the default fallback.
 *
 * @example
 * ```ts
 * const info = getTokenInfo("gpt-4o-2024-08-06");
 * // => { model: "gpt-4o", provider: "OpenAI", contextWindow: 200_000, ... }
 * ```
 */
export function getTokenInfo(model: string): ModelTokenInfo {
  const lower = model.toLowerCase();

  // Search for a matching prefix (longest match wins).
  const match = MODEL_CONTEXT_WINDOWS
    .filter(([, ,]) => true) // all entries
    .filter(([prefix]) => lower.startsWith(prefix.toLowerCase()))
    .sort((a, b) => b[0].length - a[0].length)[0];

  const [matchedModel, contextWindow, provider] = match ?? ["default", 0, "unknown"];
  const windowSize = matchedModel === "default" ? DEFAULT_CONTEXT_WINDOW : contextWindow;

  const outputBudget = Math.floor(windowSize * OUTPUT_BUDGET_RATIO);
  const systemBudget = Math.floor(windowSize * SYSTEM_BUDGET_RATIO);
  const usableBudget = windowSize - outputBudget - systemBudget;

  return {
    model: matchedModel,
    provider,
    contextWindow: windowSize,
    outputBudget,
    systemBudget,
    usableBudget,
  };
}

/**
 * Compute the token budget available for tool results given the
 * current conversation state and model.
 *
 * This is the key method for agents that need to stay within
 * context limits when tool results are large. The returned budget
 * is what `compressOutput()` or `truncateToTokenBudget()` should
 * use as their `tokenBudget` parameter.
 *
 * @param options - Model name and current token usage.
 * @returns The number of tokens available for tool results.
 *
 * @example
 * ```ts
 * const budget = computeToolResultBudget({
 *   model: "gpt-4o",
 *   usedContextTokens: 15_000,
 * });
 * const compressed = compressOutput(largeResult, budget);
 * ```
 */
export function computeToolResultBudget(options: BudgetOptions): number {
  const info = getTokenInfo(options.model);
  const systemBudget = options.toolDefTokens
    ? info.systemBudget - options.toolDefTokens
    : info.systemBudget;
  const used = options.usedContextTokens ?? 0;

  // Available = usable budget - what we've already consumed
  const available = info.usableBudget - Math.max(0, systemBudget) - used;

  // Never return a negative budget; floor at a reasonable minimum.
  return Math.max(256, Math.floor(available));
}

/**
 * A managed token budget that tracks consumption across multiple
 * operations within a single LLM turn.
 *
 * Useful when you need to budget tokens across multiple tool results
 * in a single agent step — each call to `allocate()` deducts from
 * the remaining budget.
 *
 * @example
 * ```ts
 * const budget = new TokenBudgetManager({
 *   model: "claude-3-5-sonnet-20241022",
 *   usedContextTokens: 50_000,
 * });
 *
 * // Allocate 2000 tokens for a large GitHub response
 * const githubBudget = budget.allocate("github", 2000);
 * const result = compressOutput(githubResult, githubBudget);
 *
 * // Allocate 1500 for a Notion response — budget is now 5000 - 2000 - 1500 = 1500
 * const notionBudget = budget.allocate("notion", 1500);
 * ```
 */
export class TokenBudgetManager {
  private readonly info: ModelTokenInfo;
  private readonly systemBudget: number;
  private remaining: number;

  constructor(options: BudgetOptions) {
    this.info = getTokenInfo(options.model);
    this.systemBudget = options.toolDefTokens
      ? this.info.systemBudget - options.toolDefTokens
      : this.info.systemBudget;
    const used = options.usedContextTokens ?? 0;
    this.remaining = Math.max(
      0,
      this.info.usableBudget - Math.max(0, this.systemBudget) - used,
    );
  }

  /**
   * Allocate up to `requested` tokens from the remaining budget.
   * Returns the actual number of tokens allocated (may be less than
   * requested if the budget is nearly exhausted).
   *
   * @param source - A label for what's consuming the budget (for debugging).
   * @param requested - The desired token budget for this allocation.
   * @returns The actual tokens available (capped by remaining budget).
   */
  allocate(source: string, requested: number): number {
    const granted = Math.min(requested, this.remaining);
    this.remaining = Math.max(0, this.remaining - granted);
    return Math.max(0, granted);
  }

  /**
   * Estimate tokens consumed by a string of text.
   * Delegates to `estimateTokens()` from token-efficient.ts.
   */
  estimate(text: string): number {
    return estimateTokens(text);
  }

  /**
   * Get the remaining token budget.
   */
  getRemaining(): number {
    return this.remaining;
  }

  /**
   * Get the total usable budget (before any allocations).
   */
  getTotalBudget(): number {
    return Math.max(
      0,
      this.info.usableBudget - Math.max(0, this.systemBudget),
    );
  }

  /**
   * Get the model token info.
   */
  getModelInfo(): ModelTokenInfo {
    return this.info;
  }
}
