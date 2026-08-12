// Tool Result Cache — Cache expensive MCP tool results with TTL
//
// When an MCP server's tool is called with the same arguments, we can
// return the cached result instead of making a new call. This is
// especially valuable for:
//   - GitHub API calls (rate-limited)
//   - Database queries
//   - File system reads
//   - Any tool that returns the same result for the same input
//
// The cache key is a hash of: serverName + toolName + JSON.stringify(args).
// Entries expire after `ttlMs` (default: 5 minutes) to avoid stale data.
//
// This is a local, in-memory cache — no external dependencies.

import { createHash } from "node:crypto";

/** Cache entry with metadata for observability. */
export interface ToolCacheEntry {
	/** The cached result data. */
	result: unknown;
	/** Server that produced this result. */
	serverName: string;
	/** Tool that produced this result. */
	toolName: string;
	/** When this entry was created (ms). */
	createdAt: number;
	/** When this entry expires (ms). */
	expiresAt: number;
	/** Number of times this entry has been served from cache. */
	hitCount: number;
}

/** Configuration for the tool cache. */
export interface ToolCacheConfig {
	/** Maximum number of entries to keep. Default: 500. */
	maxSize?: number;
	/** Time-to-live in milliseconds. Default: 300_000 (5 minutes). */
	ttlMs?: number;
}

const DEFAULT_MAX_SIZE = 500;
const DEFAULT_TTL_MS = 300_000;

/**
 * In-memory LRU cache for MCP tool results.
 *
 * @example
 * ```ts
 * const cache = new ToolCache();
 * const key = cache.buildKey("github", "listIssues", { owner: "org", repo: "repo" });
 * const cached = cache.get(key);
 * if (cached) return cached.result;
 * const result = await callTool("github", "listIssues", args);
 * cache.set(key, result, "github", "listIssues");
 * ```
 */
export class ToolCache {
	private readonly cache: Map<string, ToolCacheEntry> = new Map();
	private readonly maxSize: number;
	private readonly ttlMs: number;
	private totalHits = 0;
	private totalEvictions = 0;

	constructor(config: ToolCacheConfig = {}) {
		this.maxSize = Math.max(1, config.maxSize ?? DEFAULT_MAX_SIZE);
		this.ttlMs = Math.max(1, config.ttlMs ?? DEFAULT_TTL_MS);
	}

	/**
	 * Build a deterministic cache key from the tool call parameters.
	 */
	buildKey(serverName: string, toolName: string, args: unknown): string {
		const argsStr = JSON.stringify(args ?? {});
		return createHash("sha256")
			.update(`${serverName}|${toolName}|${argsStr}`)
			.digest("hex");
	}

	/**
	 * Look up a cache entry by key. Returns null if not found or expired.
	 */
	get(key: string): ToolCacheEntry | null {
		const entry = this.cache.get(key);
		if (!entry) return null;

		// Check expiration.
		if (Date.now() > entry.expiresAt) {
			this.cache.delete(key);
			this.totalEvictions += 1;
			return null;
		}

		// Update hit count and move to end (LRU).
		entry.hitCount += 1;
		this.totalHits += 1;
		this.cache.delete(key);
		this.cache.set(key, entry);
		return entry;
	}

	/**
	 * Store a tool result in the cache.
	 */
	set(
		key: string,
		result: unknown,
		serverName: string,
		toolName: string,
	): void {
		// Evict oldest entries if at capacity.
		if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
				this.totalEvictions += 1;
			}
		}

		const now = Date.now();
		this.cache.set(key, {
			result,
			serverName,
			toolName,
			createdAt: now,
			expiresAt: now + this.ttlMs,
			hitCount: 0,
		});
	}

	/**
	 * Remove a specific entry from the cache.
	 */
	delete(key: string): boolean {
		return this.cache.delete(key);
	}

	/**
	 * Clear all entries from the cache.
	 */
	clear(): { entriesCleared: number } {
		const count = this.cache.size;
		this.cache.clear();
		return { entriesCleared: count };
	}

	/**
	 * Get the current cache size.
	 */
	size(): number {
		return this.cache.size;
	}

	/**
	 * Get cache statistics for monitoring.
	 */
	stats(): {
		size: number;
		maxSize: number;
		totalHits: number;
		totalEvictions: number;
		hitRate: number;
	} {
		const totalRequests = this.totalHits + this.cache.size;
		return {
			size: this.cache.size,
			maxSize: this.maxSize,
			totalHits: this.totalHits,
			totalEvictions: this.totalEvictions,
			hitRate: totalRequests > 0 ? this.totalHits / totalRequests : 0,
		};
	}
}

/** Singleton instance for the CLI. */
let singleton: ToolCache | null = null;

/**
 * Get the global ToolCache singleton.
 */
export function getToolCache(): ToolCache {
	if (!singleton) {
		singleton = new ToolCache();
	}
	return singleton;
}

/**
 * Clear the singleton cache (used by `umt cache clear`).
 */
export function clearToolCache(): { entriesCleared: number } {
	if (!singleton) return { entriesCleared: 0 };
	return singleton.clear();
}

/**
 * Get cache statistics (used by `umt cache stats`).
 */
export function getToolCacheStats() {
	if (!singleton) {
		return {
			size: 0,
			maxSize: DEFAULT_MAX_SIZE,
			totalHits: 0,
			totalEvictions: 0,
			hitRate: 0,
		};
	}
	return singleton.stats();
}

/**
 * Reset the singleton (useful for tests).
 */
export function resetToolCache(): void {
	singleton = null;
}
