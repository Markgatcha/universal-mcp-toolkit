import { describe, expect, it, vi } from "vitest";

import {
  executeWorkflow,
  parseWorkflowJson,
  resolveWorkflowReferences,
  validateWorkflow,
  WorkflowExecutionError,
  WorkflowValidationError,
  type WorkflowBridge,
  type WorkflowDefinition,
} from "../src/workflow.js";

const validWorkflow: WorkflowDefinition = {
  version: "umt.dev/workflow/v1",
  name: "search and publish",
  inputs: ["query", "limit"],
  steps: [
    {
      id: "search",
      server: "github",
      tool: "search_repositories",
      args: {
        query: "$inputs.query",
        options: { limit: "$inputs.limit" },
      },
    },
    {
      id: "publish",
      server: "notion",
      tool: "create-page",
      args: {
        content: "$steps.search.output",
      },
    },
  ],
};

describe("workflow parsing and validation", () => {
  it("parses a valid JSON workflow", () => {
    expect(parseWorkflowJson(JSON.stringify(validWorkflow))).toEqual(validWorkflow);
  });

  it("reports malformed JSON as a workflow validation error", () => {
    expect(() => parseWorkflowJson("{", "broken.json")).toThrowError(WorkflowValidationError);
    expect(() => parseWorkflowJson("{", "broken.json")).toThrow("broken.json is not valid JSON");
  });

  it("rejects malformed definitions and duplicate step ids", () => {
    expect(() => validateWorkflow({
      ...validWorkflow,
      steps: [validWorkflow.steps[0], validWorkflow.steps[0]],
    })).toThrow("duplicates step id 'search'");

    expect(() => validateWorkflow({ ...validWorkflow, version: "v1" })).toThrow(
      "version must be 'umt.dev/workflow/v1'",
    );
    expect(() => validateWorkflow({ ...validWorkflow, steps: [] })).toThrow(
      "steps must be an array containing at least one step",
    );
  });

  it("rejects unknown inputs and unknown or forward step references", () => {
    expect(() => validateWorkflow({
      ...validWorkflow,
      steps: [{ ...validWorkflow.steps[0], args: { query: "$inputs.missing" } }],
    })).toThrow("references unknown input 'missing'");

    expect(() => validateWorkflow({
      ...validWorkflow,
      steps: [
        { ...validWorkflow.steps[0], args: { value: "$steps.publish.output" } },
        validWorkflow.steps[1],
      ],
    })).toThrow("references step 'publish' before it has run");

    expect(() => validateWorkflow({
      ...validWorkflow,
      steps: [{ ...validWorkflow.steps[0], args: { value: "$steps.missing.output" } }],
    })).toThrow("references unknown step 'missing'");
  });

  it("rejects malformed workflow references", () => {
    expect(() => validateWorkflow({
      ...validWorkflow,
      steps: [{ ...validWorkflow.steps[0], args: { value: "$steps.search.result" } }],
    })).toThrow("contains malformed workflow reference '$steps.search.result'");
  });
});

describe("workflow reference resolution", () => {
  it("recursively replaces exact references while preserving value types", () => {
    const resolved = resolveWorkflowReferences(
      {
        nested: ["$inputs.count", { output: "$steps.first.output" }],
        literal: "prefix $inputs.count",
      },
      {
        inputs: { count: 3 },
        stepOutputs: { first: { ok: true } },
      },
    );

    expect(resolved).toEqual({
      nested: [3, { output: { ok: true } }],
      literal: "prefix $inputs.count",
    });
  });

  it("fails when a referenced runtime value is unavailable", () => {
    expect(() => resolveWorkflowReferences("$inputs.query", { inputs: {}, stepOutputs: {} })).toThrow(
      "Missing workflow input 'query'",
    );
  });
});

describe("workflow execution", () => {
  it("executes sequentially with injected bridges and returns per-step outputs", async () => {
    const calls: Array<{ server: string; tool: string; args: Record<string, unknown> }> = [];
    const disconnects: string[] = [];

    const result = await executeWorkflow(validWorkflow, { query: "mcp", limit: 5 }, {
      createBridge: (server) => ({
        connect: vi.fn(async () => undefined),
        callTool: vi.fn(async (tool, args) => {
          calls.push({ server, tool, args });
          return { output: server === "github" ? "search output" : "published" };
        }),
        disconnect: vi.fn(async () => {
          disconnects.push(server);
        }),
      }),
    });

    expect(calls).toEqual([
      {
        server: "github",
        tool: "search_repositories",
        args: { query: "mcp", options: { limit: 5 } },
      },
      {
        server: "notion",
        tool: "create-page",
        args: { content: "search output" },
      },
    ]);
    expect(disconnects).toEqual(["github", "notion"]);
    expect(result).toEqual({
      name: "search and publish",
      outputs: { search: "search output", publish: "published" },
    });
  });

  it("reuses one bridge for steps targeting the same server", async () => {
    const connect = vi.fn(async () => undefined);
    const disconnect = vi.fn(async () => undefined);
    const callTool = vi.fn(async (tool: string) => ({ output: `${tool} output` }));
    const bridge: WorkflowBridge = { connect, callTool, disconnect };
    const createBridge = vi.fn(() => bridge);
    const workflow: WorkflowDefinition = {
      ...validWorkflow,
      steps: [
        validWorkflow.steps[0]!,
        {
          id: "refine",
          server: "github",
          tool: "get_pull_request",
          args: { search: "$steps.search.output" },
        },
      ],
    };

    await expect(executeWorkflow(workflow, { query: "mcp", limit: 5 }, { createBridge })).resolves.toEqual({
      name: "search and publish",
      outputs: {
        search: "search_repositories output",
        refine: "get_pull_request output",
      },
    });
    expect(createBridge).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenNthCalledWith(2, "get_pull_request", { search: "search_repositories output" });
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("disconnects every created bridge after a later server fails", async () => {
    const githubDisconnect = vi.fn(async () => undefined);
    const notionDisconnect = vi.fn(async () => undefined);
    const createBridge = vi.fn((server: string): WorkflowBridge => ({
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(async () => (
        server === "notion" ? { output: "permission denied", error: true } : { output: "search output" }
      )),
      disconnect: server === "github" ? githubDisconnect : notionDisconnect,
    }));

    await expect(executeWorkflow(validWorkflow, { query: "mcp", limit: 5 }, { createBridge })).rejects.toThrow(
      "Step 'publish' (notion:create-page) failed: permission denied",
    );
    expect(createBridge).toHaveBeenCalledTimes(2);
    expect(githubDisconnect).toHaveBeenCalledOnce();
    expect(notionDisconnect).toHaveBeenCalledOnce();
  });

  it("does not reconnect a server after switching to another server", async () => {
    const githubConnect = vi.fn(async () => undefined);
    const githubDisconnect = vi.fn(async () => undefined);
    const githubBridge: WorkflowBridge = {
      connect: githubConnect,
      callTool: vi.fn(async () => ({ output: "github output" })),
      disconnect: githubDisconnect,
    };
    const notionBridge: WorkflowBridge = {
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({ output: "notion output" })),
      disconnect: vi.fn(async () => undefined),
    };
    const createBridge = vi.fn((server: string) => server === "github" ? githubBridge : notionBridge);
    const workflow: WorkflowDefinition = {
      ...validWorkflow,
      steps: [
        validWorkflow.steps[0]!,
        validWorkflow.steps[1]!,
        {
          id: "github-again",
          server: "github",
          tool: "get_pull_request",
          args: { page: "$steps.publish.output" },
        },
      ],
    };

    await executeWorkflow(workflow, { query: "mcp", limit: 5 }, { createBridge });

    expect(createBridge).toHaveBeenCalledTimes(2);
    expect(githubConnect).toHaveBeenCalledOnce();
    expect(githubDisconnect).toHaveBeenCalledOnce();
  });

  it("rejects error results and always disconnects", async () => {
    const disconnect = vi.fn(async () => undefined);
    const bridge: WorkflowBridge = {
      connect: vi.fn(async () => undefined),
      callTool: vi.fn(async () => ({ output: "permission denied", error: true })),
      disconnect,
    };

    await expect(executeWorkflow({
      ...validWorkflow,
      steps: [validWorkflow.steps[0]!],
    }, { query: "mcp", limit: 5 }, { createBridge: () => bridge })).rejects.toThrow(
      "Step 'search' (github:search_repositories) failed: permission denied",
    );
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("rejects unknown supplied inputs before connecting", async () => {
    const createBridge = vi.fn<() => WorkflowBridge>();

    await expect(executeWorkflow(validWorkflow, {
      query: "mcp",
      limit: 5,
      typo: true,
    }, { createBridge })).rejects.toBeInstanceOf(WorkflowExecutionError);
    expect(createBridge).not.toHaveBeenCalled();
  });
});
