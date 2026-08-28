import { describe, expect, it } from "vitest";

import { OpenAiMcpServer, metadata, serverCard } from "../src/index.js";
import type OpenAI from "openai";

function createFakeOpenAiClient() {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          model: "gpt-4o",
          choices: [
            {
              message: { content: "Hello from the model" },
              finish_reason: "stop",
              tool_calls: undefined,
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 7 },
        }),
      },
    },
    completions: {
      create: async () => ({
        model: "gpt-3.5-turbo-instruct",
        choices: [{ text: "Completed text", finish_reason: "stop" }],
      }),
    },
    embeddings: {
      create: async () => ({
        data: [{ embedding: [0.1, 0.2, 0.3] }],
        usage: { total_tokens: 4 },
      }),
    },
    models: {
      list: async () => ({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    },
    images: {
      generate: async () => ({ data: [{ url: "https://example.com/image.png", b64_json: null }] }),
    },
    moderations: {
      create: async () => ({
        results: [{ flagged: false, categories: { hate: false }, category_scores: { hate: 0.01 } }],
      }),
    },
    audio: {
      transcriptions: {
        create: async () => ({ text: "Transcribed audio", language: "en" }),
      },
    },
  } as unknown as OpenAI;

  return client;
}

describe("OpenAiMcpServer smoke", () => {
  it("registers every declared tool (count > 0)", () => {
    const server = new OpenAiMcpServer({ apiKey: "sk-test", client: createFakeOpenAiClient() });
    try {
      expect(server.getToolNames().length).toBeGreaterThan(0);
      expect([...server.getToolNames()]).toEqual([...metadata.toolNames].sort());
      expect(serverCard.tools).toEqual(metadata.toolNames);
    } finally {
      void server.close();
    }
  });

  it("runs a chat completion through the injected client", async () => {
    const server = new OpenAiMcpServer({ apiKey: "sk-test", client: createFakeOpenAiClient() });
    try {
      const result = await server.invokeTool<{ content: string; completionTokens: number }>("openai_chat", {
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(result.content).toBe("Hello from the model");
      expect(result.completionTokens).toBe(7);
    } finally {
      await server.close();
    }
  });

  it("lists models through the injected client", async () => {
    const server = new OpenAiMcpServer({ apiKey: "sk-test", client: createFakeOpenAiClient() });
    try {
      const result = await server.invokeTool<{ models: string[]; modelCount: number }>("openai_list_models", {});
      expect(result.modelCount).toBe(2);
      expect(result.models).toContain("gpt-4o");
    } finally {
      await server.close();
    }
  });
});
