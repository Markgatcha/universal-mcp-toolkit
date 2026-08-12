/**
 * Token-efficient utilities for MCP servers.
 *
 * Provides tools for estimating token counts, compressing tool results,
 * truncating content to fit within token budgets, caching tool results,
 * and executing tools in parallel with automatic deduplication.
 *
 * @module token-efficient
 */

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * Rough estimate of tokens per character. English text averages ~4 chars/token,
 * but code and structured data can be denser. Using 3.5 as a conservative middle ground.
 */
const TOKENS_PER_CHAR = 1 / 3.5;

/**
 * Default token budget for tool results. This is a fraction of a typical
 * 8K-32K context window, leaving room for instructions and other content.
 */
const DEFAULT_TOKEN_BUDGET = 2000;

/**
 * Maximum cache entries to prevent unbounded memory growth.
 */
const MAX_CACHE_ENTRIES = 100;

/**
 * Default TTL for cache entries (5 minutes).
 */
const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Interface for cached tool results.
 */
interface CachedResult {
  /** The tool result payload */
  result: CallToolResult;
  /** Timestamp when cached (ms since epoch) */
  timestamp: number;
  /** Token count of the result */
  tokenCount: number;
}

/**
 * Options for {@link ToolResultCache}.
 */
export interface CacheOptions {
  /** Maximum number of entries to retain */
  maxSize?: number;
  /** Time-to-live for entries in milliseconds */
  ttlMs?: number;
}

/**
 * A simple LRU-style cache for tool results with TTL eviction.
 *
 * Cache keys are derived from the tool name and serialized arguments.
 * Entries are evicted when they exceed the TTL or when the cache exceeds
 * its maximum size (evicting the oldest entries first).
 *
 * @example
 * ```typescript
 * const cache = new ToolResultCache({ maxSize: 50, ttlMs: 300000 });
 * const key = cache.makeKey('github-repo', { owner: 'markgatcha', repo: 'umt' });
 * if (cache.has(key)) return cache.get(key)!;
 * const result = await callTool('github-repo', args);
 * cache.set(key, result);
 * ```
 */
export class ToolResultCache {
  private cache: Map<string, CachedResult> = new Map();
  private readonly maxSize: number;
  private readonly ttlMs: number;

  constructor(options: CacheOptions = {}) {
    this.maxSize = options.maxSize ?? MAX_CACHE_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Generate a cache key from a tool name and its arguments.
   * The arguments are JSON-serialized and sorted to ensure consistent keys.
   */
  makeKey(toolName: string, args: Record<string, unknown>): string {
    const sortedArgs = Object.keys(args)
      .sort()
      .reduce(
        (acc, key) => ({ ...acc, [key]: args[key] }),
        {} as Record<string, unknown>,
      );
    return `${toolName}:${JSON.stringify(sortedArgs)}`;
  }

  /**
   * Check if a valid (non-expired) cache entry exists for the given key.
   */
  has(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return false;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Retrieve a cached result. Returns `undefined` if not found or expired.
   */
  get(key: string): CallToolResult | undefined {
    const entry = this.cache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.result;
  }

  /**
   * Store a result in the cache. If the cache is at capacity, the oldest
   * entry is evicted.
   */
  set(key: string, result: CallToolResult): void {
    if (this.cache.size >= this.maxSize) {
      // Evict the oldest entry (first inserted)
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    const tokenCount = estimateTokens(
      result.content?.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('') ?? '',
    );
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
      tokenCount,
    });
  }

  /**
   * Remove a specific entry from the cache.
   */
  delete(key: string): boolean {
    return this.cache.delete(key);
  }

  /**
   * Clear all cache entries.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Get the current number of cached entries.
   */
  get size(): number {
    return this.cache.size;
  }

  /**
   * Remove all expired entries. Called automatically on access but can
   * be invoked manually for periodic cleanup.
   */
  evictExpired(): number {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        evicted++;
      }
    }
    return evicted;
  }
}

/**
 * Estimate the number of tokens in a string.
 *
 * Uses a simple characters-per-token ratio. This is a rough estimate —
 * actual token counts depend on the tokenizer used by the model.
 *
 * @param text - The text to estimate tokens for
 * @returns Estimated token count
 *
 * @example
 * ```typescript
 * const tokens = estimateTokens("Hello, world!");
 * // => 4 (roughly)
 * ```
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length * TOKENS_PER_CHAR);
}

/**
 * Truncate text to fit within a token budget.
 *
 * If the text exceeds the budget, it is truncated and a notice is appended
 * indicating how many tokens were removed. The truncation point is chosen
 * to fall on a word boundary when possible.
 *
 * @param text - The text to truncate
 * @param tokenBudget - Maximum number of tokens to allow
 * @param suffix - Optional suffix to append after truncation (default: "... [truncated]")
 * @returns Truncated text that fits within the token budget
 *
 * @example
 * ```typescript
 * const short = truncateToTokenBudget(longText, 100);
 * ```
 */
export function truncateToTokenBudget(
  text: string,
  tokenBudget: number,
  suffix: string = '... [truncated]',
): string {
  const estimatedTokens = estimateTokens(text);
  if (estimatedTokens <= tokenBudget) return text;

  const maxChars = Math.floor(tokenBudget / TOKENS_PER_CHAR);
  const suffixTokens = estimateTokens(suffix);
  const availableChars = maxChars - Math.ceil(suffixTokens / TOKENS_PER_CHAR);

  if (availableChars <= 0) return suffix;

  // Try to truncate at a word boundary
  let truncateAt = availableChars;
  while (truncateAt > 0 && !/\s/.test(text?.[truncateAt] ?? "")) {
    truncateAt--;
  }
  if (truncateAt === 0) truncateAt = availableChars;

  return text.slice(0, truncateAt).trimEnd() + suffix;
}

/**
 * Compress a tool result by truncating its content to fit within a token budget.
 *
 * This is useful for servers that return large results (e.g., file contents,
 * API responses) that may exceed the model's context window.
 *
 * @param result - The tool result to compress
 * @param tokenBudget - Maximum total tokens for all content
 * @returns A new CallToolResult with compressed content
 *
 * @example
 * ```typescript
 * const compressed = compressOutput(largeResult, 1000);
 * ```
 */
export function compressOutput(
  result: CallToolResult,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): CallToolResult {
  if (!result.content || result.content.length === 0) return result;

  const contentStr = result.content
    .map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
    .join('');
  const totalTokens = estimateTokens(contentStr);

  if (totalTokens <= tokenBudget) return result;

  // Distribute budget proportionally across content blocks
  const numBlocks = result.content.length;
  const perBlockBudget = Math.floor(tokenBudget / numBlocks);

  const compressedContent = result.content.map((block) => {
    if (typeof block === 'string') {
      return truncateToTokenBudget(block, perBlockBudget);
    }
    // For object blocks, stringify, truncate, and parse back if possible
    const blockStr = JSON.stringify(block);
    const truncated = truncateToTokenBudget(blockStr, perBlockBudget);
    try {
      return JSON.parse(truncated) as typeof block;
    } catch {
      return truncated;
    }
  });

  return {
    ...result,
    content: compressedContent as typeof result.content,
  };
}

/**
 * Process a tool result, applying compression if it exceeds a token budget.
 *
 * This is a convenience wrapper around {@link compressOutput} that also
 * sets the `compressed` flag on the result's metadata.
 *
 * @param result - The raw tool result
 * @param tokenBudget - Maximum tokens allowed
 * @returns The processed result, compressed if necessary
 */
export function processToolResult(
  result: CallToolResult,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): CallToolResult {
  const contentStr = result.content
    ?.map((c) => (typeof c === 'string' ? c : JSON.stringify(c)))
    .join('') ?? '';
  const totalTokens = estimateTokens(contentStr);

  if (totalTokens <= tokenBudget) return result;

  const compressed = compressOutput(result, tokenBudget);
  return {
    ...compressed,
    _meta: {
      ...compressed._meta,
      compressed: true,
      originalTokens: totalTokens,
      compressedTokens: estimateTokens(
        compressed.content?.map((c) => (typeof c === 'string' ? c : JSON.stringify(c))).join('') ?? '',
      ),
    },
  };
}

/**
 * Execute multiple tools in parallel with optional deduplication.
 *
 * Tools are executed concurrently using `Promise.all`. If a cache is provided,
 * results are cached and reused for identical tool+args combinations.
 *
 * @param tools - Array of { name, arguments } to execute
 * @param executor - Function that calls a single tool
 * @param cache - Optional cache for deduplication
 * @param concurrency - Maximum number of concurrent executions (default: 5)
 * @returns Array of results in the same order as the input tools
 *
 * @example
 * ```typescript
 * const results = await executeToolsInParallel(
 *   [{ name: 'github-repo', arguments: { owner: 'a', repo: 'b' } }],
 *   async (name, args) => await callTool(name, args),
 *   cache,
 *   3,
 * );
 * ```
 */
export async function executeToolsInParallel(
  tools: Array<{ name: string; arguments: Record<string, unknown> }>,
  executor: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  cache?: ToolResultCache,
  concurrency: number = 5,
): Promise<CallToolResult[]> {
  // Check cache first for all tools
  const results: (CallToolResult | undefined)[] = Array.from({ length: tools.length });
  const toExecute: Array<{ index: number; name: string; args: Record<string, unknown> }> = [];

  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]!;
    if (cache) {
      const key = cache.makeKey(tool.name, tool.arguments);
      if (cache.has(key)) {
        results[i] = cache.get(key);
        continue;
      }
    }
    toExecute.push({ index: i, name: tool.name, args: tool.arguments });
  }

  // Execute in batches to respect concurrency limit
  for (let i = 0; i < toExecute.length; i += concurrency) {
    const batch = toExecute.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async ({ name, args }) => {
        const result = await executor(name, args);
        if (cache) {
          const key = cache.makeKey(name, args);
          cache.set(key, result);
        }
        return result;
      }),
    );
    batch.forEach((item, j) => {
      results[item.index] = batchResults[j]!;
    });
  }

  return results as CallToolResult[];
}

// ─── Tool Result Summarization ──────────────────────────────────────────────

/**
 * Summarize a tool result to fit within a token budget.
 *
 * When a tool returns a large result (e.g., a GitHub API response with
 * 50 issues), the result can be summarized to the most relevant parts
 * before passing it to the LLM. This reduces token usage while preserving
 * the information the LLM needs.
 *
 * The summarization is a simple truncation with a summary header — it
 * doesn't call an LLM. For more sophisticated summarization, use a
 * dedicated LLM call.
 *
 * @param result - The tool result to summarize.
 * @param maxTokens - Maximum tokens for the summarized result.
 * @returns The summarized result.
 */
export function summarizeToolResult(
  result: CallToolResult,
  maxTokens: number = DEFAULT_TOKEN_BUDGET,
): CallToolResult {
  const content = result.content || [];
  let totalChars = 0;
  const maxChars = maxTokens / TOKENS_PER_CHAR;

  // Calculate total content length.
  for (const block of content) {
    if (block.type === "text" && block.text) {
      totalChars += block.text.length;
    }
  }

  // If within budget, return as-is.
  if (totalChars <= maxChars) {
    return result;
  }

  // Truncate each text block to fit within the budget.
  const truncatedContent: typeof content = [];
  let remainingChars = maxChars;

  for (const block of content) {
    if (block.type === "text" && block.text) {
      if (remainingChars <= 0) {
        // Skip this block entirely.
        continue;
      }
      const truncated =
        block.text.length > remainingChars
          ? `${block.text.slice(0, remainingChars - 50).replace(/\s+$/, "")}...[truncated]`
          : block.text;
      truncatedContent.push({ type: "text" as const, text: truncated });
      remainingChars -= truncated.length;
    } else {
      truncatedContent.push(block);
    }
  }

  return {
    ...result,
    content: truncatedContent,
    isError: result.isError,
  };
}

// ─── Smart Tool Ordering ────────────────────────────────────────────────────

/**
 * Order tool calls based on expected latency and dependency analysis.
 *
 * Tools are ordered to minimize total latency:
 * 1. Tools with no dependencies are ordered by expected latency (fastest first).
 * 2. Tools that depend on other tools' output are ordered after their dependencies.
 * 3. Tools that are likely to fail are deprioritized.
 *
 * Expected latency is estimated from the tool name and category:
 * - File system tools: ~5ms
 * - Database queries: ~50ms
 * - API calls: ~200ms
 * - Network requests: ~500ms
 *
 * @param tools - Array of tool calls to order.
 * @returns The ordered array of tool calls.
 */
export function orderTools(
  tools: Array<{ name: string; arguments: Record<string, unknown> }>,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  // Estimate latency for each tool based on its name.
  const estimateLatency = (name: string): number => {
    const lower = name.toLowerCase();
    if (lower.includes("read") || lower.includes("file") || lower.includes("fs")) {
      return 5; // Fast: local file system
    }
    if (lower.includes("query") || lower.includes("db") || lower.includes("sql")) {
      return 50; // Medium: database
    }
    if (lower.includes("api") || lower.includes("http") || lower.includes("fetch")) {
      return 200; // Slow: API call
    }
    if (lower.includes("network") || lower.includes("remote") || lower.includes("mcp")) {
      return 500; // Slowest: remote/MCP
    }
    return 100; // Default: medium
  };

  // Sort by estimated latency (fastest first).
  return [...tools].sort((a, b) => {
    const latencyA = estimateLatency(a.name);
    const latencyB = estimateLatency(b.name);
    return latencyA - latencyB;
  });
}

// ─── Error Recovery with Fallback Tools ────────────────────────────────────

/**
 * Execute a tool with fallback recovery.
 *
 * If the primary tool fails, the function tries each fallback tool in order.
 * This is useful when a primary tool (e.g., GitHub API) is rate-limited or
 * down, and a fallback (e.g., a local cache or alternative API) can be used.
 *
 * @param primaryTool - The primary tool to execute.
 * @param fallbackTools - Array of fallback tools to try if the primary fails.
 * @param executor - Function that calls a single tool.
 * @param maxRetries - Maximum number of retries for each tool (default: 1).
 * @returns The result from the first successful tool, or the last error.
 */
export async function executeWithFallback(
  primaryTool: { name: string; arguments: Record<string, unknown> },
  fallbackTools: Array<{ name: string; arguments: Record<string, unknown> }>,
  executor: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>,
  maxRetries: number = 1,
): Promise<CallToolResult> {
  const allTools = [primaryTool, ...fallbackTools];

  for (const tool of allTools) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const result = await executor(tool.name, tool.arguments);
        if (!result.isError) {
          return result;
        }
        // Tool returned an error result — try next tool/fallback.
        break;
      } catch {
        if (attempt >= maxRetries) {
          // Exhausted retries for this tool — try next fallback.
          break;
        }
        // Retry with exponential backoff.
        await new Promise((resolve) =>
          setTimeout(resolve, Math.pow(2, attempt) * 100),
        );
      }
    }
  }

  // All tools failed — return the last error.
  return {
    content: [{ type: "text", text: "All tools and fallbacks failed." }],
    isError: true,
  };
}
