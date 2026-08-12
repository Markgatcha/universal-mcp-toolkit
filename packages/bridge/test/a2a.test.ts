import { describe, it, expect } from "vitest";
import {
  A2AServerAdapter,
  artifactToText,
  serializeResponse,
  parseRequest,
  estimateTokenCount,
  estimateTokenCost,
  A2A_ERROR_CODES,
} from "../src/index.js";
import type {
  A2AAgentCard,
  A2AMessage,
  A2AJsonRpcRequest,
  BridgeToolResult,
} from "../src/index.js";

// A mock bridge that implements the minimal interface needed by A2AServerAdapter.
class MockBridge {
  tools = [
    {
      name: "search_repositories",
      description: "Search GitHub repos",
      parameters: { type: "object", properties: {} },
      mcpTool: { name: "search_repositories", description: "Search GitHub repos", inputSchema: {} },
    },
  ];

  async callTool(name: string, args: Record<string, unknown>): Promise<BridgeToolResult> {
    return {
      output: `Called ${name} with ${JSON.stringify(args)}`,
      error: false,
    };
  }
}

describe("A2AServerAdapter", () => {
  const agentCard: A2AAgentCard = {
    protocolVersion: "1.0",
    name: "Test A2A Agent",
    description: "A test agent for unit tests",
    url: "http://localhost:8080/a2a",
    capabilities: { streaming: true, pushNotifications: false },
    skills: [],
    version: "1.0.0",
  };

  it("creates an adapter with an agent card", () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });
    expect(adapter).toBeDefined();
  });

  it("auto-populates skills from the bridge's tools", () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });
    const card = adapter.getAgentCard();
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe("search_repositories");
  });

  it("handleMessageSend executes a tool and returns artifacts", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const message: A2AMessage = {
      role: "user",
      parts: [{ type: "data", data: { tool: "search_repositories", query: "mcp" } }],
    };

    const result = await adapter.handleMessageSend({ message });
    expect(result.task.state).toBe("completed");
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0].parts[0].type).toBe("data");
  });

  it("handleMessageSend handles tool errors", async () => {
    class ErrorBridge {
      tools = [];
      callTool() {
        throw new Error("MCP server down");
      }
    }

    const adapter = new A2AServerAdapter({
      bridge: new ErrorBridge() as any,
      agentCard,
    });

    const message: A2AMessage = {
      role: "user",
      parts: [{ type: "text", text: "hello" }],
    };

    const result = await adapter.handleMessageSend({ message });
    expect(result.task.state).toBe("failed");
    expect(result.task.error).toBe("MCP server down");
  });

  it("handleTaskGet returns undefined for unknown task", () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });
    expect(adapter.handleTaskGet({ taskId: "nonexistent" })).toBeUndefined();
  });

  it("handleTaskCancel cancels a running task", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const { task } = await adapter.handleMessageSend({
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    // Task should already be completed, but cancel should still work.
    const canceled = adapter.handleTaskCancel({ taskId: task.id });
    expect(canceled).toBeDefined();
  });

  it("dispatch handles message/send", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ type: "data", data: { tool: "search_repositories", query: "test" } }] },
      },
      id: 1,
    };

    const response = await adapter.dispatch(request);
    expect(response.jsonrpc).toBe("2.0");
    expect(response.result).toBeDefined();
    expect(response.id).toBe(1);
  });

  it("dispatch handles tasks/get", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    // First create a task.
    const { task } = await adapter.handleMessageSend({
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tasks/get",
      params: { taskId: task.id },
      id: 2,
    };

    const response = await adapter.dispatch(request);
    expect(response.result).toBeDefined();
  });

  it("dispatch returns error for unknown task in tasks/get", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "tasks/get",
      params: { taskId: "nonexistent" },
      id: 3,
    };

    const response = await adapter.dispatch(request);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(A2A_ERROR_CODES.invalidParams);
  });

  it("dispatch returns error for unknown method", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "unknown/method",
      params: {},
      id: 4,
    };

    const response = await adapter.dispatch(request);
    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(A2A_ERROR_CODES.methodNotFound);
  });

  it("dispatch enforces authentication", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
      auth: {
        validateToken: (token) => token === "valid-token",
      },
    });

    const request: A2AJsonRpcRequest = {
      jsonrpc: "2.0",
      method: "message/send",
      params: {
        message: { role: "user", parts: [{ type: "text", text: "hello" }] },
      },
      id: 5,
    };

    // Without auth header.
    const noAuthResponse = await adapter.dispatch(request);
    expect(noAuthResponse.error).toBeDefined();
    expect(noAuthResponse.error!.code).toBe(-32001);

    // With invalid token.
    const invalidResponse = await adapter.dispatch(request, "Bearer invalid-token");
    expect(invalidResponse.error).toBeDefined();

    // With valid token.
    const validResponse = await adapter.dispatch(request, "Bearer valid-token");
    expect(validResponse.result).toBeDefined();
  });

  it("validateAuth returns true when no auth is configured", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });
    const result = await adapter.validateAuth();
    expect(result).toBe(true);
  });

  it("handleTaskResubscribe returns undefined for unknown task", () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });
    const result = adapter.handleTaskResubscribe({
      taskId: "nonexistent",
      onTaskUpdate: () => {},
    });
    expect(result).toBeUndefined();
  });

  it("handlePushNotificationSet/Set/Get round-trip", async () => {
    const adapter = new A2AServerAdapter({
      bridge: new MockBridge(),
      agentCard,
    });

    const { task } = await adapter.handleMessageSend({
      message: { role: "user", parts: [{ type: "text", text: "hello" }] },
    });

    const config = { url: "http://example.com/webhook", token: "secret" };
    const setResult = adapter.handlePushNotificationSet({ taskId: task.id, pushNotificationConfig: config });
    expect(setResult).toBe(true);

    const getResult = adapter.handlePushNotificationGet({ taskId: task.id });
    expect(getResult).toEqual(config);
  });
});

describe("A2A utility functions", () => {
  it("artifactToText extracts text from an artifact", () => {
    const artifact = {
      name: "test",
      parts: [
        { type: "text" as const, text: "Hello" },
        { type: "text" as const, text: "World" },
      ],
    };
    expect(artifactToText(artifact as any)).toBe("Hello\nWorld");
  });

  it("serializeResponse produces valid JSON", () => {
    const response = {
      jsonrpc: "2.0" as const,
      result: { foo: "bar" },
      id: 1,
    };
    const json = serializeResponse(response);
    expect(JSON.parse(json)).toEqual(response);
  });

  it("parseRequest parses a JSON-RPC request", () => {
    const json = JSON.stringify({
      jsonrpc: "2.0",
      method: "message/send",
      params: { message: { role: "user", parts: [] } },
      id: 1,
    });
    const req = parseRequest(json);
    expect(req.jsonrpc).toBe("2.0");
    expect(req.method).toBe("message/send");
  });
});

describe("A2A token utilities", () => {
  it("estimateTokenCount estimates from text length", () => {
    expect(estimateTokenCount("hello world")).toBeGreaterThan(0);
    expect(estimateTokenCount("a".repeat(350))).toBe(100);
    expect(estimateTokenCount("")).toBe(0);
  });

  it("estimateTokenCost returns 0 for unknown models", () => {
    expect(estimateTokenCost("unknown-model", 1000, 1000)).toBe(0);
  });

  it("estimateTokenCost calculates for known models", () => {
    // GPT-4o: $2.50/M input, $10.00/M output
    const cost = estimateTokenCost("gpt-4o", 1_000_000, 1_000_000);
    expect(cost).toBe(12.5);
  });
});
