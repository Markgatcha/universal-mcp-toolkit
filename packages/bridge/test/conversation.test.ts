import { describe, expect, it, vi } from "vitest";
import { MCPFunctionCallingBridge } from "../src/bridge.js";
import { BridgeConversation, type LLMProvider } from "../src/conversation.js";
import type { BridgeTool } from "../src/types.js";

const tool: BridgeTool = {
  name: "lookup",
  description: "Look up a value.",
  parameters: { type: "object", properties: {} },
  mcpTool: {
    name: "lookup",
    description: "Look up a value.",
    inputSchema: { type: "object", properties: {} },
  } as any,
};

describe("BridgeConversation", () => {
  it("lists and serializes tools once across multiple rounds", async () => {
    const bridge = {
      listTools: vi.fn().mockResolvedValue({ tools: [tool] }),
      callTool: vi.fn().mockResolvedValue({ output: "result" }),
    } as unknown as MCPFunctionCallingBridge;
    const provider: LLMProvider = {
      chat: vi.fn()
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "call-1", name: "lookup", arguments: { value: 1 } }],
        })
        .mockResolvedValueOnce({
          content: "",
          toolCalls: [{ id: "call-2", name: "lookup", arguments: { value: 2 } }],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] }),
    };
    const conversation = new BridgeConversation(bridge, { maxRounds: 3 });
    const serializeTools = vi.spyOn(
      conversation as unknown as { serializeTools(tools: BridgeTool[], provider: string): unknown },
      "serializeTools",
    );

    await expect(conversation.run("Find values", provider, "gpt-4o")).resolves.toEqual({
      content: "done",
      toolCalls: [],
    });

    expect(bridge.listTools).toHaveBeenCalledOnce();
    expect(serializeTools).toHaveBeenCalledOnce();
    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(bridge.callTool).toHaveBeenCalledTimes(2);
  });
});
