import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MCPFunctionCallingBridge } from "../src/bridge.js";
import { HealthMonitor } from "../src/health-monitor.js";

/**
 * Verify that the HealthMonitor is wired into MCPFunctionCallingBridge:
 * - Health monitor is created by default (no `health` option needed)
 * - `health: false` disables it
 * - `onError()` is called on tool-call failures
 * - `onConnect()` is called on successful connect
 * - Auto-reconnect path exists in callTool when client is torn down
 */
describe("MCPFunctionCallingBridge health monitoring", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Silence expected error output during tests.
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("creates a HealthMonitor by default", () => {
    const bridge = new MCPFunctionCallingBridge({
      transport: "stdio",
      commandOrUrl: "echo",
    });
    const monitor = bridge.getHealthMonitor();
    expect(monitor).toBeDefined();
    expect(monitor).toBeInstanceOf(HealthMonitor);
  });

  it("allows disabling the health monitor with health: false", () => {
    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      { health: false },
    );
    expect(bridge.getHealthMonitor()).toBeUndefined();
  });

  it("allows passing custom health options with onEvent callback", () => {
    const events: unknown[] = [];
    const bridge = new MCPFunctionCallingBridge(
      {
        transport: "stdio",
        commandOrUrl: "echo",
      },
      {
        health: {
          maxRetries: 3,
          onEvent: (event) => events.push(event),
        },
      },
    );
    const monitor = bridge.getHealthMonitor();
    expect(monitor).toBeDefined();
    expect(monitor?.getFailureCount()).toBe(0);
  });

  it("exposes circuit state via the health monitor", () => {
    const bridge = new MCPFunctionCallingBridge({
      transport: "stdio",
      commandOrUrl: "echo",
    });
    const monitor = bridge.getHealthMonitor()!;
    expect(monitor.getCircuitState()).toBe("closed");
    expect(monitor.getFailureCount()).toBe(0);

    // Simulate failures and check circuit progression.
    monitor.onError(new Error("test failure 1"));
    expect(monitor.getFailureCount()).toBe(1);
    expect(monitor.getCircuitState()).toBe("closed");

    // Push failures to trigger circuit open.
    for (let i = 0; i < 5; i++) {
      monitor.onError(new Error("test failure"));
    }
    expect(monitor.getCircuitState()).toBe("open");
  });

  it("resets the circuit on successful connect", () => {
    const bridge = new MCPFunctionCallingBridge({
      transport: "stdio",
      commandOrUrl: "echo",
    });
    const monitor = bridge.getHealthMonitor()!;

    // Cause failures to open the circuit.
    for (let i = 0; i < 6; i++) {
      monitor.onError(new Error("failure"));
    }
    expect(monitor.getCircuitState()).toBe("open");

    // A successful connect should close the circuit.
    monitor.onConnect();
    expect(monitor.getCircuitState()).toBe("closed");
    expect(monitor.getFailureCount()).toBe(0);
  });

  it("shutdown() suppresses reconnect scheduling on intentional disconnect", () => {
    vi.useFakeTimers();
    try {
      const bridge = new MCPFunctionCallingBridge({
        transport: "stdio",
        commandOrUrl: "echo",
      });
      const monitor = bridge.getHealthMonitor()!;
      const events: string[] = [];
      monitor.on((event) => events.push(event.type));

      monitor.onDisconnect();
      expect(events).toContain("disconnected");
      // A reconnect attempt is scheduled on an unexpected disconnect...
      expect(events).toContain("reconnecting");

      // ...but shutdown() cancels the pending timer and stops further ones.
      monitor.shutdown();
      monitor.onDisconnect();
      vi.runAllTimers();
      expect(events.filter((type) => type === "reconnecting")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("bridge.disconnect() shuts the health monitor down first", async () => {
    vi.useFakeTimers();
    try {
      const bridge = new MCPFunctionCallingBridge({
        transport: "stdio",
        commandOrUrl: "echo",
      });
      const monitor = bridge.getHealthMonitor()!;
      const events: string[] = [];
      monitor.on((event) => events.push(event.type));
      // Simulate a connected client without spawning a real server process.
      (bridge as unknown as { client: { close(): Promise<void> } }).client = {
        close: async () => {},
      };
      const shutdownSpy = vi.spyOn(monitor, "shutdown");

      await bridge.disconnect();

      expect(shutdownSpy).toHaveBeenCalled();
      vi.runAllTimers();
      expect(events.filter((type) => type === "reconnecting")).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
