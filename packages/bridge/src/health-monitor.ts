// Health monitoring and resilience for MCPFunctionCallingBridge.
//
// Provides auto-reconnect with exponential backoff, circuit breaking
// for failing servers, and health event callbacks. These features
// dramatically improve reliability when MCP servers are flaky or
// when upstream APIs return errors.
//
// @module @universal-mcp-toolkit/bridge/health

import type { BridgeServerConfig, BridgeOptions } from "./types.js";

/** Events emitted by the health monitor. */
export type HealthEventType =
  | "connected"
  | "disconnected"
  | "reconnecting"
  | "reconnected"
  | "circuit_open"
  | "circuit_closed"
  | "error";

/** A health monitor event. */
export interface HealthEvent {
  type: HealthEventType;
  timestamp: number;
  message: string;
  retryCount?: number;
}

/** Callback for health events. */
export type HealthEventListener = (event: HealthEvent) => void;

/** Circuit breaker state. */
export type CircuitState = "closed" | "open" | "half_open";

export interface HealthMonitorOptions {
  /** Maximum number of reconnection attempts. Default: 5. */
  maxRetries?: number;
  /** Base delay for exponential backoff in ms. Default: 1000. */
  baseDelayMs?: number;
  /** Maximum delay between retries in ms. Default: 30000. */
  maxDelayMs?: number;
  /** Jitter factor (0-1) to randomize backoff. Default: 0.3. */
  jitter?: number;
  /** Number of consecutive failures before opening the circuit. Default: 5. */
  failureThreshold?: number;
  /** How long the circuit stays open before attempting half-open. Default: 30000 (30s). */
  circuitTimeoutMs?: number;
  /** Whether to auto-reconnect on disconnect. Default: true. */
  autoReconnect?: boolean;
  /** Optional callback for health events (connect, disconnect, reconnect, circuit state changes). */
  onEvent?: HealthEventListener;
}

/** Resolved options with all values filled in. */
interface ResolvedHealthMonitorOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number;
  failureThreshold: number;
  circuitTimeoutMs: number;
  autoReconnect: boolean;
}

const DEFAULTS: ResolvedHealthMonitorOptions = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  jitter: 0.3,
  failureThreshold: 5,
  circuitTimeoutMs: 30000,
  autoReconnect: true,
};

/**
 * Health monitor that wraps a bridge's connection lifecycle with
 * resilience features: auto-reconnect, circuit breaking, and health events.
 *
 * @example
 * ```ts
 * const monitor = new HealthMonitor({
 *   maxRetries: 3,
 *   onEvent: (event) => console.log(event.type, event.message),
 * });
 * ```
 */
export class HealthMonitor {
  private readonly options: ResolvedHealthMonitorOptions;
  private state: CircuitState = "closed";
  private failureCount = 0;
  private retryCount = 0;
  private listeners: HealthEventListener[] = [];
  private circuitOpenAt: number = 0;

  constructor(options: HealthMonitorOptions = {}) {
    // Destructure onEvent out of the options so it doesn't get spread into
    // the resolved (required) config — functions can't be Required<T>.
    const { onEvent, ...rest } = options;
    this.options = { ...DEFAULTS, ...rest };
    // If an onEvent callback is provided, register it as a listener.
    if (onEvent) {
      this.listeners.push(onEvent);
    }
  }

  /** Add a health event listener. */
  on(listener: HealthEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /** Get the current circuit breaker state. */
  getCircuitState(): CircuitState {
    return this.state;
  }

  /** Get the current failure count. */
  getFailureCount(): number {
    return this.failureCount;
  }

  /** Reset the circuit breaker and failure count. */
  reset(): void {
    this.state = "closed";
    this.failureCount = 0;
    this.retryCount = 0;
    this.circuitOpenAt = 0;
  }

  /**
   * Called when a connection succeeds. Resets failure count and closes circuit.
   */
  onConnect(): void {
    this.failureCount = 0;
    this.retryCount = 0;
    if (this.state === "open") {
      this.state = "closed";
      this.emit({ type: "circuit_closed", timestamp: Date.now(), message: "Circuit closed after successful connection." });
    }
    this.emit({ type: "connected", timestamp: Date.now(), message: "Connected to MCP server." });
  }

  /**
   * Called when a connection fails. Opens circuit if threshold reached.
   */
  onError(error: unknown): boolean {
    const msg = error instanceof Error ? error.message : String(error);
    this.failureCount += 1;
    this.emit({ type: "error", timestamp: Date.now(), message: msg });

    if (this.failureCount >= this.options.failureThreshold) {
      this.state = "open";
      this.circuitOpenAt = Date.now();
      this.emit({
        type: "circuit_open",
        timestamp: Date.now(),
        message: `Circuit opened after ${this.failureCount} consecutive failures.`,
        retryCount: this.retryCount,
      });
    }
    return this.state === "open";
  }

  /**
   * Check if a reconnect attempt should be made.
   * Returns the delay in ms, or 0 if no retry should be attempted.
   */
  getReconnectDelay(): number {
    if (this.state === "open") {
      const elapsed = Date.now() - this.circuitOpenAt;
      if (elapsed < this.options.circuitTimeoutMs) {
        return 0; // Circuit still open, don't retry.
      }
      this.state = "half_open";
      return 0; // Try once in half-open state.
    }

    if (this.retryCount >= this.options.maxRetries) {
      return 0; // Exhausted retries.
    }

    // Exponential backoff with jitter.
    const exponentialDelay = this.options.baseDelayMs * Math.pow(2, this.retryCount);
    const clampedDelay = Math.min(exponentialDelay, this.options.maxDelayMs);
    const jitter = clampedDelay * this.options.jitter * Math.random();
    return Math.round(clampedDelay + jitter);
  }

  /**
   * Called to record a reconnection attempt.
   */
  onReconnectAttempt(): void {
    this.retryCount += 1;
    this.emit({
      type: "reconnecting",
      timestamp: Date.now(),
      message: `Reconnection attempt ${this.retryCount}/${this.options.maxRetries}`,
      retryCount: this.retryCount,
    });
  }

  /**
   * Called after a successful reconnect.
   */
  onReconnected(): void {
    this.retryCount = 0;
    this.state = "closed";
    this.emit({ type: "reconnected", timestamp: Date.now(), message: "Reconnected to MCP server." });
  }

  /**
   * Called on disconnect. Triggers auto-reconnect if enabled.
   *
   * The reconnect is delegated back to the bridge via the `reconnect` event.
   * The bridge's `onDisconnect` handler on the MCP client will tear down
   * the client, and the next `callTool()` attempt will invoke `reconnect()`
   * using the backoff computed here. This method emits a `disconnected`
   * event and, if auto-reconnect is enabled and the circuit is closed,
   * schedules a `reconnecting` event after the computed delay.
   */
  onDisconnect(): void {
    this.emit({ type: "disconnected", timestamp: Date.now(), message: "Disconnected from MCP server." });
    if (this.options.autoReconnect && this.state !== "open") {
      const delay = this.getReconnectDelay();
      if (delay > 0) {
        this.onReconnectAttempt();
        setTimeout(() => {
          // Emit a reconnecting event. The bridge's callTool() is responsible
          // for calling reconnect() when it detects the client is gone.
          this.emit({
            type: "reconnecting",
            timestamp: Date.now(),
            message: `Auto-reconnect in ${delay}ms (attempt ${this.retryCount}/${this.options.maxRetries}).`,
            retryCount: this.retryCount,
          });
        }, delay);
      }
    }
  }

  private emit(event: HealthEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Silently ignore listener errors to prevent cascade.
      }
    }
  }
}
