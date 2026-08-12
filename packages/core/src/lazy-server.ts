// Lazy Server Manager — Start MCP servers only when their tools are needed
//
// Instead of starting all configured MCP servers at startup, the lazy
// manager starts each server on-demand when a tool from that server is
// first requested. This dramatically reduces startup time and memory
// usage when many servers are configured but only a few are used per session.
//
// Servers are started in the background when first needed, and kept alive
// for subsequent calls. Idle servers are shut down after a configurable
// timeout to free resources.

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createLogger } from "./logger.js";

const logger = createLogger({ name: "lazy-server" });

/** Idle timeout before shutting down a server (5 minutes). */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
/** Interval for sweeping idle servers. */
const SWEEP_INTERVAL_MS = 60_000;

/** A lazily-started MCP server. */
interface LazyServer {
	/** The server instance. */
	server: Server;
	/** The transport used to communicate with the server. */
	transport: Transport;
	/** When the server was started (ms). */
	startedAt: number;
	/** When the server was last used (ms). */
	lastUsed: number;
	/** Whether the server is currently being started. */
	starting: boolean;
	/** The startup promise (for concurrent access). */
	startPromise: Promise<void> | null;
}

/**
 * Manages lazy startup of MCP servers.
 *
 * Servers are started on-demand when their tools are first requested.
 * Idle servers are automatically shut down after the idle timeout.
 *
 * @example
 * ```ts
 * const manager = new LazyServerManager();
 *
 * // Register a server factory — called only when the server is first needed.
 * manager.register("github", () => startGithubServer());
 *
 * // When a tool from "github" is requested, the server is started automatically.
 * const server = await manager.get("github");
 * ```
 */
export class LazyServerManager {
	private readonly servers: Map<string, LazyServer> = new Map();
	private readonly factories: Map<string, () => Promise<{ server: Server; transport: Transport }>> = new Map();
	private readonly idleTimeoutMs: number;
	private sweepTimer: ReturnType<typeof setInterval> | null = null;

	constructor(idleTimeoutMs: number = IDLE_TIMEOUT_MS) {
		this.idleTimeoutMs = idleTimeoutMs;
	}

	/**
	 * Register a server factory for lazy startup.
	 *
	 * The factory is called only when the server is first needed.
	 *
	 * @param serverId - Unique identifier for the server.
	 * @param factory - Function that creates and starts the server.
	 */
	register(
		serverId: string,
		factory: () => Promise<{ server: Server; transport: Transport }>,
	): void {
		this.factories.set(serverId, factory);
	}

	/**
	 * Get a server by ID, starting it lazily if not yet started.
	 *
	 * If the server is already running, returns it immediately.
	 * If the server is being started, returns the in-progress startup promise.
	 * If the server hasn't been started, calls the factory to start it.
	 *
	 * @param serverId - The server to get.
	 * @returns The server and transport.
	 */
	async get(serverId: string): Promise<{ server: Server; transport: Transport }> {
		const existing = this.servers.get(serverId);
		if (existing) {
			// Update last used time.
			existing.lastUsed = Date.now();

			if (existing.starting) {
				// Server is being started — wait for it.
				await existing.startPromise;
				return { server: existing.server, transport: existing.transport };
			}

			return { server: existing.server, transport: existing.transport };
		}

		// Server not yet started — start it lazily.
		const factory = this.factories.get(serverId);
		if (!factory) {
			throw new Error(`No factory registered for server '${serverId}'`);
		}

		// Create a lazy server entry with a pending startup promise.
		const lazy: LazyServer = {
			server: null!,
			transport: null!,
			startedAt: Date.now(),
			lastUsed: Date.now(),
			starting: true,
			startPromise: null,
		};

		// Start the server in the background.
		const startPromise = (async () => {
			try {
				logger.info({ serverId }, "Starting MCP server (lazy)");
				const result = await factory();
				lazy.server = result.server;
				lazy.transport = result.transport;
				lazy.starting = false;
				lazy.startedAt = Date.now();
				logger.info({ serverId }, "MCP server started (lazy)");
			} catch (err) {
				logger.error({ serverId, err }, "Failed to start MCP server (lazy)");
				lazy.starting = false;
				throw err;
			}
		})();

		lazy.startPromise = startPromise;
		this.servers.set(serverId, lazy);

		// Wait for startup to complete.
		await startPromise;
		return { server: lazy.server, transport: lazy.transport };
	}

	/**
	 * Check if a server is registered (has a factory).
	 */
	has(serverId: string): boolean {
		return this.factories.has(serverId);
	}

	/**
	 * Check if a server is currently running.
	 */
	isRunning(serverId: string): boolean {
		const server = this.servers.get(serverId);
		return !!server && !server.starting;
	}

	/**
	 * Shut down a specific server.
	 */
	async shutdown(serverId: string): Promise<void> {
		const server = this.servers.get(serverId);
		if (!server) return;

		try {
			await server.transport.close();
			await server.server.close();
		} catch (err) {
			logger.error({ serverId, err }, "Error shutting down MCP server");
		}

		this.servers.delete(serverId);
	}

	/**
	 * Shut down all servers and stop the sweep timer.
	 */
	async shutdownAll(): Promise<void> {
		if (this.sweepTimer) {
			clearInterval(this.sweepTimer);
			this.sweepTimer = null;
		}

		const shutdownPromises = [];
		for (const serverId of this.servers.keys()) {
			shutdownPromises.push(this.shutdown(serverId));
		}
		await Promise.all(shutdownPromises);
	}

	/**
	 * Start the idle sweep timer.
	 *
	 * Periodically checks for servers that haven't been used in a while
	 * and shuts them down to free resources.
	 */
	startSweep(): void {
		if (this.sweepTimer) return;

		this.sweepTimer = setInterval(() => {
			const now = Date.now();
			for (const [serverId, server] of this.servers.entries()) {
				if (server.starting) continue;
				if (now - server.lastUsed > this.idleTimeoutMs) {
					logger.info({ serverId }, "Shutting down idle MCP server");
					void this.shutdown(serverId);
				}
			}
		}, SWEEP_INTERVAL_MS);

		// Don't keep the process alive for the sweep timer.
		if (this.sweepTimer.unref) {
			this.sweepTimer.unref();
		}
	}

	/**
	 * Get the number of currently running servers.
	 */
	runningCount(): number {
		let count = 0;
		for (const server of this.servers.values()) {
			if (!server.starting) count++;
		}
		return count;
	}

	/**
	 * Get the number of registered server factories.
	 */
	registeredCount(): number {
		return this.factories.size;
	}
}
