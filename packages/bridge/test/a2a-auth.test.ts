import { describe, it, expect } from "vitest";
import { A2AServerAdapter, estimateTokenCount, estimateTokenCost } from "../src/index.js";
import type { BridgeToolResult } from "../src/types.js";

// A mock bridge that implements the minimal interface needed by A2AServerAdapter.
class MockBridge {
  tools = [
    {
      name: "search_repositories",
      description: "Search GitHub repos",
      parameters: { type: "object", properties: {} },
      mcpTool: { name: "search_repositories", description: "Search GitHub repos", tags: ["github", "search"] },
    },
  ];

  async callTool(_name: string, _args: Record<string, unknown>): Promise<BridgeToolResult> {
    return {
      output: "mock result",
      error: false,
    };
  }
}

describe("A2AServerAdapter - auth", () => {
  it("validateAuth returns true when no auth is configured", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard: {
        protocolVersion: "1.0",
        name: "Test",
        description: "test",
        url: "http://localhost:8080",
        capabilities: { streaming: true },
        skills: [],
        version: "1.0.0",
      },
    });
    expect(await adapter.validateAuth()).toBe(true);
  });

  it("validateAuth rejects when auth is configured but no token provided", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard: {
        protocolVersion: "1.0",
        name: "Test",
        description: "test",
        url: "http://localhost:8080",
        capabilities: { streaming: true },
        skills: [],
        version: "1.0.0",
      },
      auth: {
        validateToken: (token: string) => token === "valid",
      },
    });

    const result = await adapter.validateAuth();
    expect(result).not.toBe(true);
    if (typeof result !== "boolean") {
      expect(result.code).toBe(-32001);
    } else {
      expect(true).toBe(false); // Should not be true
    }
  });

  it("validateAuth accepts valid bearer token", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard: {
        protocolVersion: "1.0",
        name: "Test",
        description: "test",
        url: "http://localhost:8080",
        capabilities: { streaming: true },
        skills: [],
        version: "1.0.0",
      },
      auth: {
        validateToken: (token: string) => token === "valid-token",
      },
    });

    expect(await adapter.validateAuth("Bearer valid-token")).toBe(true);
    expect(await adapter.validateAuth("Bearer invalid")).not.toBe(true);
  });
});

describe("A2AServerAdapter - dispatch", () => {
  const agentCard = {
    protocolVersion: "1.0" as const,
    name: "Test",
    description: "test",
    url: "http://localhost:8080",
    capabilities: { streaming: true },
    skills: [],
    version: "1.0.0",
  };

  it("dispatch returns error for unknown method", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const response = await adapter.dispatch({
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
      id: 1,
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32601);
  });

  it("dispatch enforces auth when configured", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
      auth: {
        validateToken: () => false,
      },
    });

    const response = await adapter.dispatch({
      jsonrpc: "2.0",
      method: "message/send",
      params: {},
      id: 1,
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001);
  });

  it("dispatch allows requests when auth passes", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
      auth: {
        validateToken: () => true,
      },
    });

    const response = await adapter.dispatch({
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: {
          role: "user",
          parts: [{ type: "text", text: "hello" }],
        },
      },
      id: 1,
    }, "Bearer test");

    expect(response.result).toBeDefined();
  });
});

describe("A2AServerAdapter - agent card", () => {
  it("auto-populates skills from bridge tools", () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard: {
        protocolVersion: "1.0",
        name: "Test",
        description: "test",
        url: "http://localhost:8080",
        capabilities: { streaming: true },
        skills: [],
        version: "1.0.0",
      },
    });

    const card = adapter.getAgentCard();
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("search_repositories");
    expect(card.skills[0].tags).toContain("github");
  });
});
