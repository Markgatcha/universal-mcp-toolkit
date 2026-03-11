import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createServerCard, defineTool, parseRuntimeOptions, ToolkitServer, type ToolkitServerMetadata } from "../src/index.js";

const metadata: ToolkitServerMetadata = {
  id: "test-server",
  title: "Test Server",
  description: "A test server for the core package.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/test-server",
  homepage: "https://example.com",
  envVarNames: ["TEST_TOKEN"],
  transports: ["stdio", "sse"],
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
      transports: ["stdio", "sse"],
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
});
