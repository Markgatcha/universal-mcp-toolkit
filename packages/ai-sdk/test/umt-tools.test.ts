/**
 * Tests for the @universal-mcp-toolkit/ai-sdk integration package.
 *
 * @module @universal-mcp-toolkit/ai-sdk/test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ─── Mock shared state ────────────────────────────────────────────────────────

// We use a shared mock factory so that every `new MCPFunctionCallingBridge()`
// call returns an instance backed by the same mock functions. This lets us
// set up mock return values in beforeEach and have them apply to the
// instance created inside umtTools().

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockListTools = vi.fn();
const mockCallTool = vi.fn();

// Track all instances for assertion
const mockInstances: any[] = [];

vi.mock("@universal-mcp-toolkit/bridge", () => {
  // Each new instance shares the same mock functions.
  const MockBridgeClass = class MockMCPFunctionCallingBridge {
    connect = mockConnect;
    disconnect = mockDisconnect;
    listTools = mockListTools;
    callTool = mockCallTool;

    constructor() {
      mockInstances.push(this);
    }
  };

  return {
    MCPFunctionCallingBridge: MockBridgeClass,
    BridgeConversation: class MockBridgeConversation {
      constructor() {}
    },
  };
});

// Import after mocking
import { umtTools, umtToolsFor } from "../src/umt-tools.js";

describe("umtTools", () => {
  beforeEach(() => {
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);
    mockCallTool.mockResolvedValue({ output: "tool result" });
    // Default: no tools
    mockListTools.mockResolvedValue({ tools: [], rawTools: [] });
    mockInstances.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("config validation", () => {
    it("should throw when no servers are provided", async () => {
      await expect(umtTools({ servers: [] })).rejects.toThrow(
        "at least one server must be specified",
      );
    });

    it("should accept a single server", async () => {
      mockListTools.mockResolvedValue({
        tools: [{
          name: "test_tool",
          description: "A test tool",
          parameters: { type: "object", properties: {}, required: [] },
          mcpTool: { name: "test_tool", inputSchema: {} },
        }],
        rawTools: [],
      });

      const tools = await umtTools({
        servers: ["github"],
        env: { GITHUB_TOKEN: "test-token" },
      });

      expect(Object.keys(tools)).toContain("test_tool");
      expect(tools.test_tool.description).toBe("A test tool");
    });

    it("should accept multiple servers", async () => {
      // listTools is called multiple times — once per server
      mockListTools
        .mockResolvedValueOnce({
          tools: [{ name: "github_tool", description: "GitHub tool", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "github_tool", inputSchema: {} } }],
          rawTools: [],
        })
        .mockResolvedValueOnce({
          tools: [{ name: "slack_tool", description: "Slack tool", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "slack_tool", inputSchema: {} } }],
          rawTools: [],
        });

      const tools = await umtTools({
        servers: ["github", "slack"],
      });

      expect(Object.keys(tools)).toContain("github_tool");
      expect(Object.keys(tools)).toContain("slack_tool");
    });
  });

  describe("tool name collision handling", () => {
    it("should prefix colliding tool names with server id", async () => {
      const mockTool = {
        name: "search",
        description: "Search tool",
        parameters: { type: "object", properties: {}, required: [] },
        mcpTool: { name: "search", inputSchema: {} },
      };

      // Both servers return the same tool name "search"
      mockListTools
        .mockResolvedValueOnce({ tools: [mockTool], rawTools: [] })
        .mockResolvedValueOnce({ tools: [mockTool], rawTools: [] });

      const tools = await umtTools({
        servers: ["github", "slack"],
      });

      // First server gets the plain name
      expect(tools.search).toBeDefined();
      // Second server gets the prefixed name
      expect(tools.slack_search).toBeDefined();
    });
  });

  describe("tool filtering", () => {
    it("should filter tools when toolFilter is provided", async () => {
      mockListTools.mockResolvedValue({
        tools: [
          { name: "tool_a", description: "A", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "tool_a", inputSchema: {} } },
          { name: "tool_b", description: "B", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "tool_b", inputSchema: {} } },
          { name: "tool_c", description: "C", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "tool_c", inputSchema: {} } },
        ],
        rawTools: [],
      });

      const tools = await umtTools({
        servers: ["github"],
        toolFilter: ["tool_a", "tool_c"],
      });

      expect(Object.keys(tools)).toEqual(["tool_a", "tool_c"]);
    });
  });

  describe("tool execute", () => {
    it("should call bridge.callTool with the correct tool name and args", async () => {
      mockListTools.mockResolvedValue({
        tools: [{
          name: "get_issue",
          description: "Get an issue",
          parameters: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" } }, required: ["owner", "repo"] },
          mcpTool: { name: "get_issue", inputSchema: {} },
        }],
        rawTools: [],
      });
      mockCallTool.mockResolvedValue({ output: "Issue #1: Bug report" });

      const tools = await umtTools({ servers: ["github"] });
      const result = await tools.get_issue.execute({ owner: "user", repo: "my-repo" });

      expect(mockCallTool).toHaveBeenCalledWith("get_issue", { owner: "user", repo: "my-repo" });
      expect(result).toBe("Issue #1: Bug report");
    });
  });

  describe("connection error handling", () => {
    it("should disconnect previously connected servers on failure", async () => {
      const instance1 = mockInstances[0] || {};
      const instance2 = mockInstances[1] || {};

      // First server connects successfully
      mockConnect
        .mockResolvedValueOnce(undefined)
        // Second server fails
        .mockRejectedValueOnce(new Error("Connection refused"));

      mockListTools.mockResolvedValueOnce({ tools: [], rawTools: [] });

      await expect(
        umtTools({ servers: ["github", "slack"] }),
      ).rejects.toThrow("failed to connect to server 'slack'");

      // The first bridge instance should have been disconnected
      expect(mockDisconnect).toHaveBeenCalled();
    });
  });

  describe("umtToolsFor convenience function", () => {
    it("should connect to a single server with env vars", async () => {
      mockListTools.mockResolvedValueOnce({
        tools: [{ name: "search_repos", description: "Search repositories", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "search_repos", inputSchema: {} } }],
        rawTools: [],
      });

      const tools = await umtToolsFor("github", { GITHUB_TOKEN: "test-token" });

      expect(Object.keys(tools)).toContain("search_repos");
    });
  });

  describe("cleanup", () => {
    it("should provide a _cleanup method that disconnects all bridges", async () => {
      mockListTools
        .mockResolvedValueOnce({
          tools: [{ name: "tool_a", description: "A", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "tool_a", inputSchema: {} } }],
          rawTools: [],
        })
        .mockResolvedValueOnce({
          tools: [{ name: "tool_b", description: "B", parameters: { type: "object", properties: {}, required: [] }, mcpTool: { name: "tool_b", inputSchema: {} } }],
          rawTools: [],
        });

      const tools = await umtTools({ servers: ["github", "slack"] });

      expect(typeof (tools as any)._cleanup).toBe("function");

      mockDisconnect.mockClear();
      await (tools as any)._cleanup();

      // Two bridges were created
      expect(mockDisconnect).toHaveBeenCalledTimes(2);
    });
  });

  describe("Zod schema building", () => {
    it("should handle tools with no parameters", async () => {
      mockListTools.mockResolvedValueOnce({
        tools: [{
          name: "ping",
          description: "Ping the server",
          parameters: { type: "object", properties: {}, required: [] },
          mcpTool: { name: "ping", inputSchema: { type: "object", properties: {}, required: [] } },
        }],
        rawTools: [],
      });

      const tools = await umtTools({ servers: ["github"] });
      expect(tools.ping.parameters).toBeDefined();
    });

    it("should handle tools with string and number parameters", async () => {
      mockListTools.mockResolvedValueOnce({
        tools: [{
          name: "get_repo",
          description: "Get repository info",
          parameters: {
            type: "object",
            properties: {
              owner: { type: "string" },
              limit: { type: "integer" },
              verbose: { type: "boolean" },
            },
            required: ["owner"],
          },
          mcpTool: { name: "get_repo", inputSchema: {} },
        }],
        rawTools: [],
      });

      const tools = await umtTools({ servers: ["github"] });
      expect(tools.get_repo).toBeDefined();
      expect(tools.get_repo.description).toBe("Get repository info");
    });
  });

  describe("health and cache options", () => {
    it("should work with health:false", async () => {
      const tools = await umtTools({ servers: ["github"], health: false });
      expect(Object.keys(tools)).toEqual([]);
    });

    it("should accept cache options", async () => {
      const tools = await umtTools({
        servers: ["github"],
        cache: { ttlMs: 60000, maxSize: 100 },
      });
      expect(Object.keys(tools)).toEqual([]);
    });

    it("should accept allowedTools", async () => {
      const tools = await umtTools({
        servers: ["github"],
        allowedTools: ["list_repos"],
      });
      expect(Object.keys(tools)).toEqual([]);
    });
  });
});
