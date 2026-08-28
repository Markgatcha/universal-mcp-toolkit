import { describe, expect, it } from "vitest";

import { SlackMcpServer, metadata, serverCard } from "../src/index.js";
import type { WebClient } from "@slack/web-api";

function createFakeSlackClient() {
  const client = {
    conversations: {
      list: async () => ({
        ok: true,
        channels: [
          {
            id: "C123",
            name: "general",
            is_private: false,
            is_archived: false,
            num_members: 12,
            topic: { value: "Company-wide announcements" },
            purpose: { value: "General discussion" },
          },
        ],
      }),
      info: async () => ({
        ok: true,
        channel: {
          id: "C123",
          name: "general",
          is_private: false,
          is_archived: false,
          num_members: 12,
          topic: { value: "" },
          purpose: { value: "" },
        },
      }),
      history: async () => ({
        ok: true,
        messages: [{ ts: "1700000000.000100", user: "U1", text: "Hello world", thread_ts: undefined }],
      }),
      replies: async () => ({
        ok: true,
        messages: [
          { ts: "1700000000.000100", user: "U1", text: "Root message" },
          { ts: "1700000001.000200", user: "U2", text: "A reply", thread_ts: "1700000000.000100" },
        ],
      }),
    },
    chat: {
      postMessage: async () => ({ ok: true, channel: "C123", ts: "1700000002.000300" }),
    },
    search: {
      messages: async () => ({
        ok: true,
        messages: {
          matches: [{ ts: "1700000000.000100", user: "U1", text: "Hello world" }],
        },
      }),
    },
    users: {
      info: async () => ({
        ok: true,
        user: { id: "U1", name: "alice", real_name: "Alice Example", is_bot: false, is_admin: true },
      }),
      list: async () => ({
        ok: true,
        members: [
          { id: "U1", name: "alice", real_name: "Alice Example", is_bot: false, is_admin: true },
          { id: "U2", name: "bob", real_name: "Bob Example", is_bot: false, is_admin: false },
        ],
      }),
    },
    filesUploadV2: async () => ({ ok: true, files: [{ id: "F1" }] }),
    reactions: {
      add: async () => ({ ok: true }),
    },
  } as unknown as WebClient;

  return client;
}

describe("SlackMcpServer smoke", () => {
  it("registers every declared tool (count > 0)", () => {
    const server = new SlackMcpServer("xoxb-test", createFakeSlackClient());
    try {
      expect(server.getToolNames().length).toBeGreaterThan(0);
      expect([...server.getToolNames()]).toEqual([...metadata.toolNames].sort());
      expect(serverCard.tools).toEqual(metadata.toolNames);
    } finally {
      void server.close();
    }
  });

  it("lists channels through the injected client", async () => {
    const server = new SlackMcpServer("xoxb-test", createFakeSlackClient());
    try {
      const result = await server.invokeTool<{ channels: Array<{ name: string }>; channelCount: number }>(
        "slack_list_channels",
        {},
      );
      expect(result.channelCount).toBe(1);
      expect(result.channels[0]?.name).toBe("general");
    } finally {
      await server.close();
    }
  });

  it("posts a message through the injected client", async () => {
    const server = new SlackMcpServer("xoxb-test", createFakeSlackClient());
    try {
      const result = await server.invokeTool<{ channel: string; ts: string }>("slack_post_message", {
        channelId: "C123",
        text: "Hello",
      });
      expect(result.channel).toBe("C123");
      expect(result.ts).toBe("1700000002.000300");
    } finally {
      await server.close();
    }
  });
});
