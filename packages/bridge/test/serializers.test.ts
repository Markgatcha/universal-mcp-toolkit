import { describe, it, expect } from "vitest";
import { detectProvider, toOpenAI, toAnthropic, toOllama, serializeAll } from "../src/serializers.js";
import type { BridgeTool } from "../src/types.js";

// ─── Test fixtures ───────────────────────────────────────────────────────────

const mockTool: BridgeTool = {
  name: "github_list_issues",
  description: "List open issues for a GitHub repository.",
  title: "List Issues",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      repo: { type: "string", description: "Repository name" },
      state: { type: "string", description: "Issue state", default: "open" },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
  mcpTool: {
    name: "github_list_issues",
    description: "List open issues for a GitHub repository.",
    title: "List Issues",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        repo: { type: "string", description: "Repository name" },
        state: { type: "string", description: "Issue state", default: "open" },
      },
      required: ["owner", "repo"],
    },
  } as any,
};

const mockTools: BridgeTool[] = [
  mockTool,
  {
    name: "github_create_issue",
    description: "Create a new issue in a GitHub repository.",
    parameters: {
      type: "object",
      properties: {
        owner: { type: "string" },
        repo: { type: "string" },
        title: { type: "string" },
        body: { type: "string" },
      },
      required: ["owner", "repo", "title"],
    },
    mcpTool: {
      name: "github_create_issue",
      description: "Create a new issue in a GitHub repository.",
      inputSchema: {
        type: "object",
        properties: {
          owner: { type: "string" },
          repo: { type: "string" },
          title: { type: "string" },
          body: { type: "string" },
        },
        required: ["owner", "repo", "title"],
      },
    } as any,
  },
];

// ─── detectProvider tests ────────────────────────────────────────────────────

describe("detectProvider", () => {
  it("detects Anthropic/Claude models", () => {
    expect(detectProvider("claude-3-5-sonnet-20241022")).toBe("anthropic");
    expect(detectProvider("Claude-3-5-Sonnet-20241022")).toBe("anthropic");
    expect(detectProvider("claude-3-opus-20240229")).toBe("anthropic");
  });

  it("detects OpenAI models", () => {
    expect(detectProvider("gpt-4o")).toBe("openai");
    expect(detectProvider("gpt-4-turbo")).toBe("openai");
    expect(detectProvider("o1-mini")).toBe("openai");
    expect(detectProvider("o3-mini")).toBe("openai");
  });

  it("detects Ollama models", () => {
    expect(detectProvider("llama3.1:70b")).toBe("ollama");
    expect(detectProvider("mistral-nemo")).toBe("ollama");
    expect(detectProvider("mixtral:8x7b")).toBe("ollama");
  });

  it("defaults to OpenAI for unknown providers", () => {
    expect(detectProvider("some-random-model")).toBe("openai");
    expect(detectProvider("command-r-plus")).toBe("openai");
  });
});

// ─── OpenAI serializer tests ─────────────────────────────────────────────────

describe("toOpenAI", () => {
  it("converts tools to OpenAI function-calling format", () => {
    const result = toOpenAI(mockTools);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "function",
      function: {
        name: "github_list_issues",
        description: "List open issues for a GitHub repository.",
        parameters: {
          type: "object",
          properties: expect.any(Object),
          required: ["owner", "repo"],
        },
      },
    });
  });

  it("preserves all parameter properties", () => {
    const result = toOpenAI([mockTool]);
    const params = result[0].function.parameters;

    expect(params.properties.owner).toEqual({ type: "string", description: "Repository owner" });
    expect(params.properties.repo).toEqual({ type: "string", description: "Repository name" });
    expect(params.required).toEqual(["owner", "repo"]);
  });

  it("handles tools with no required parameters", () => {
    const noRequiredTool: BridgeTool = {
      name: "get_status",
      description: "Get system status.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      mcpTool: {
        name: "get_status",
        description: "Get system status.",
        inputSchema: { type: "object", properties: {} },
      } as any,
    };

    const result = toOpenAI([noRequiredTool]);
    expect(result[0].function.parameters.required).toEqual([]);
  });

  it("handles tools with empty input schemas", () => {
    const emptyTool: BridgeTool = {
      name: "ping",
      description: "Ping the server.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
      mcpTool: {
        name: "ping",
        description: "Ping the server.",
      } as any,
    };

    const result = toOpenAI([emptyTool]);
    expect(result[0].function.parameters.type).toBe("object");
    expect(result[0].function.parameters.properties).toEqual({});
  });
});

// ─── Anthropic serializer tests ──────────────────────────────────────────────

describe("toAnthropic", () => {
  it("converts tools to Anthropic format", () => {
    const result = toAnthropic(mockTools);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      name: "github_list_issues",
      description: "List open issues for a GitHub repository.",
      input_schema: {
        type: "object",
        properties: expect.any(Object),
        required: ["owner", "repo"],
      },
    });
  });

  it("does not include a type wrapper (Anthropic format)", () => {
    const result = toAnthropic([mockTool]);
    expect(result[0]).not.toHaveProperty("type");
    expect(result[0]).not.toHaveProperty("function");
  });
});

// ─── Ollama serializer tests ──────────────────────────────────────────────────

describe("toOllama", () => {
  it("converts tools to Ollama format", () => {
    const result = toOllama(mockTools);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      type: "function",
      function: {
        name: "github_list_issues",
        description: "List open issues for a GitHub repository.",
        parameters: {
          type: "object",
          properties: expect.any(Object),
          required: ["owner", "repo"],
        },
      },
    });
  });
});

// ─── serializeAll tests ───────────────────────────────────────────────────────

describe("serializeAll", () => {
  it("serializes tools for all providers at once", () => {
    const result = serializeAll(mockTools);

    expect(result.openai).toHaveLength(2);
    expect(result.anthropic).toHaveLength(2);
    expect(result.ollama).toHaveLength(2);

    // Verify OpenAI format
    expect(result.openai[0]).toHaveProperty("type", "function");
    expect(result.openai[0]).toHaveProperty("function");

    // Verify Anthropic format
    expect(result.anthropic[0]).toHaveProperty("name");
    expect(result.anthropic[0]).toHaveProperty("input_schema");

    // Verify Ollama format
    expect(result.ollama[0]).toHaveProperty("type", "function");
    expect(result.ollama[0]).toHaveProperty("function");
  });

  it("all formats share the same parameter schema", () => {
    const result = serializeAll([mockTool]);
    const openaiProps = result.openai[0].function.parameters.properties;
    const anthropicProps = result.anthropic[0].input_schema.properties;
    const ollamaProps = result.ollama[0].function.parameters.properties;

    expect(openaiProps).toEqual(anthropicProps);
    expect(openaiProps).toEqual(ollamaProps);
  });

  it("materializes and memoizes each provider format on first access", () => {
    let schemaAccesses = 0;
    const tool: BridgeTool = {
      ...mockTool,
      mcpTool: {
        ...mockTool.mcpTool,
        get inputSchema() {
          schemaAccesses++;
          return mockTool.mcpTool.inputSchema;
        },
      } as any,
    };
    const result = serializeAll([tool]);

    expect(Object.keys(result)).toEqual(["openai", "anthropic", "ollama"]);
    expect(schemaAccesses).toBe(0);

    const openai = result.openai;
    expect(schemaAccesses).toBe(1);
    expect(result.openai).toBe(openai);
    expect(schemaAccesses).toBe(1);

    const anthropic = result.anthropic;
    expect(schemaAccesses).toBe(2);
    expect(result.anthropic).toBe(anthropic);
    expect(schemaAccesses).toBe(2);

    const ollama = result.ollama;
    expect(schemaAccesses).toBe(3);
    expect(result.ollama).toBe(ollama);
    expect(schemaAccesses).toBe(3);
  });
});
