import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  ConfigurationError,
  createServerCard,
  defineTool,
  normalizeError,
  parseRuntimeOptions,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "../src/index.js";

const metadata: ToolkitServerMetadata = {
  id: "test-server",
  title: "Test Server",
  description: "A test server for the core package.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/test-server",
  homepage: "https://example.com",
  envVarNames: ["TEST_TOKEN"],
  transports: ["stdio", "sse", "streamable-http"],
  toolNames: ["echo"],
  resourceNames: ["test-resource"],
  promptNames: ["test-prompt"],
};

class TestServer extends ToolkitServer {
  public constructor() {
    super(metadata);

    this.registerTool(
      defineTool({
        name: "echo",
        description: "Echo the provided message.",
        inputSchema: {
          message: z.string(),
        },
        outputSchema: {
          echoedMessage: z.string(),
        },
        handler: async ({ message }) => ({
          echoedMessage: message,
        }),
      }),
    );
  }
}

describe("ToolkitServer", () => {
  it("invokes registered tools with validated input and output", async () => {
    const server = new TestServer();
    const result = await server.invokeTool<{ echoedMessage: string }>("echo", { message: "hello" });
    expect(result).toEqual({ echoedMessage: "hello" });
  });

  it("creates a discovery-friendly server card", () => {
    expect(createServerCard(metadata)).toEqual({
      name: "test-server",
      title: "Test Server",
      description: "A test server for the core package.",
      version: "0.1.0",
      packageName: "@universal-mcp-toolkit/test-server",
      homepage: "https://example.com",
      transports: ["stdio", "sse", "streamable-http"],
      authentication: {
        mode: "environment-variables",
        required: ["TEST_TOKEN"],
      },
      capabilities: {
        tools: true,
        resources: true,
        prompts: true,
      },
      tools: ["echo"],
      resources: ["test-resource"],
      prompts: ["test-prompt"],
    });
  });

  it("parses runtime options from CLI flags", () => {
    const parsed = parseRuntimeOptions([
      "--transport",
      "sse",
      "--host",
      "0.0.0.0",
      "--port",
      "4010",
      "--sse-path",
      "/events",
      "--messages-path",
      "/rpc",
    ]);

    expect(parsed).toMatchObject({
      transport: "sse",
      host: "0.0.0.0",
      port: 4010,
      ssePath: "/events",
      messagesPath: "/rpc",
    });
  });

  it("rejects unsupported transports", () => {
    expect(() => parseRuntimeOptions(["--transport", "http"])) .toThrow(ConfigurationError);
  });

  it("parses streamable-http transport from CLI flags", () => {
    const parsed = parseRuntimeOptions(["--transport", "streamable-http"]);
    expect(parsed).toMatchObject({ transport: "streamable-http" });
  });

  it("normalizes unknown errors without exposing their message", () => {
    const normalized = normalizeError(new Error("secret failure"));

    expect(normalized.code).toBe("unexpected_error");
    expect(normalized.toClientMessage()).toBe("The upstream service returned an unexpected error.");
    expect(normalized.details).toEqual({ name: "Error" });
  });
});

describe("ToolkitServer token diet (tools/list wire payload)", () => {
  it("strips redundant $schema keywords while keeping schema semantics", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = new TestServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);

    const client = new Client({ name: "diet-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools).toHaveLength(1);
      const wire = JSON.parse(JSON.stringify(tools[0]));
      // No $schema keyword anywhere in the served payload.
      expect(JSON.stringify(wire)).not.toContain("$schema");
      // Schema semantics intact: structure, types, and required lists survive.
      expect(wire.inputSchema).toMatchObject({
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      });
      expect(wire.outputSchema).toMatchObject({
        type: "object",
        properties: { echoedMessage: { type: "string" } },
      });
      expect(wire.name).toBe("echo");
      expect(wire.description).toBe("Echo the provided message.");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("still executes tools after the diet wrapper is installed", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

    const server = new TestServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.server.connect(serverTransport);

    const client = new Client({ name: "diet-test", version: "0.0.0" });
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "echo", arguments: { message: "hi" } });
      expect(result.structuredContent).toEqual({ echoedMessage: "hi" });
    } finally {
      await client.close();
      await server.close();
    }
  });
});
