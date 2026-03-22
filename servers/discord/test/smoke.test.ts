import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DiscordServer,
  createServer,
  metadata,
  serverCard,
  type DiscordClient,
  type DiscordGuildSummary,
  type DiscordChannelSummary,
  type DiscordMessageSummary,
  type DiscordMemberSummary,
} from "../src/index.js";

function createFakeClient() {
  const listGuilds = vi.fn<DiscordClient["listGuilds"]>().mockResolvedValue([
    { id: "111", name: "Test Guild", isOwner: true, permissions: "8" },
    { id: "222", name: "Another Guild", isOwner: false, permissions: "104324161" },
  ]);

  const listChannels = vi.fn<DiscordClient["listChannels"]>().mockResolvedValue([
    { id: "C100", name: "general", type: "text", topic: "General chat", position: 0, isNsfw: false, parentId: null },
    { id: "C101", name: "announcements", type: "announcement", topic: null, position: 1, isNsfw: false, parentId: null },
  ]);

  const getMessages = vi.fn<DiscordClient["getMessages"]>().mockResolvedValue([
    { id: "M100", content: "Hello world!", authorId: "U100", authorName: "testuser", isBot: false, timestamp: "2025-01-01T00:00:00.000000+00:00", editedTimestamp: null },
    { id: "M101", content: "Bot response", authorId: "B200", authorName: "testbot", isBot: true, timestamp: "2025-01-01T00:01:00.000000+00:00", editedTimestamp: "2025-01-01T00:02:00.000000+00:00" },
  ]);

  const sendMessage = vi.fn<DiscordClient["sendMessage"]>().mockResolvedValue({
    messageId: "M999",
    channelId: "C100",
    content: "Test message",
    timestamp: "2025-01-01T00:05:00.000000+00:00",
  });

  const getGuildMembers = vi.fn<DiscordClient["getGuildMembers"]>().mockResolvedValue([
    { id: "U100", username: "testuser", nickname: "Tester", isBot: false, roles: ["R1"], joinedAt: "2024-01-01T00:00:00.000000+00:00" },
    { id: "B200", username: "testbot", nickname: null, isBot: true, roles: ["R2"], joinedAt: "2024-06-01T00:00:00.000000+00:00" },
  ]);

  const client: DiscordClient = {
    listGuilds,
    listChannels,
    getMessages,
    sendMessage,
    getGuildMembers,
  };

  return { client, listGuilds, listChannels, getMessages, sendMessage, getGuildMembers };
}

const servers: DiscordServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("DiscordServer", () => {
  it("registers all five tools and validates metadata", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
    expect(serverCard.tools).toEqual(metadata.toolNames);
  });

  it("list_guilds returns guild summaries", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ guilds: DiscordGuildSummary[]; returnedCount: number }>("discord_list_guilds", { limit: 50 });
    expect(result.returnedCount).toBe(2);
    expect(result.guilds[0]?.name).toBe("Test Guild");
    expect(result.guilds[0]?.isOwner).toBe(true);
    expect(fake.listGuilds).toHaveBeenCalledWith(50);
  });

  it("list_channels returns channel summaries", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ guildId: string; channels: DiscordChannelSummary[]; returnedCount: number }>("discord_list_channels", { guildId: "111" });
    expect(result.returnedCount).toBe(2);
    expect(result.guildId).toBe("111");
    expect(result.channels[0]?.name).toBe("general");
    expect(fake.listChannels).toHaveBeenCalledWith("111");
  });

  it("get_messages returns message summaries", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ channelId: string; messages: DiscordMessageSummary[]; returnedCount: number }>("discord_get_messages", { channelId: "C100", limit: 10 });
    expect(result.returnedCount).toBe(2);
    expect(result.messages[0]?.content).toBe("Hello world!");
    expect(result.messages[1]?.isBot).toBe(true);
    expect(fake.getMessages).toHaveBeenCalledWith("C100", 10);
  });

  it("send_message posts and returns confirmation", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ messageId: string; channelId: string; content: string }>("discord_send_message", { channelId: "C100", content: "Test message" });
    expect(result.messageId).toBe("M999");
    expect(result.channelId).toBe("C100");
    expect(fake.sendMessage).toHaveBeenCalledWith("C100", "Test message");
  });

  it("get_guild_members returns member summaries", async () => {
    const fake = createFakeClient();
    const server = new DiscordServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ guildId: string; members: DiscordMemberSummary[]; returnedCount: number }>("discord_get_guild_members", { guildId: "111", limit: 50 });
    expect(result.returnedCount).toBe(2);
    expect(result.members[0]?.username).toBe("testuser");
    expect(result.members[1]?.isBot).toBe(true);
    expect(fake.getGuildMembers).toHaveBeenCalledWith("111", 50);
  });

  it("createServer validates env and constructs with injected client", () => {
    const fake = createFakeClient();
    const server = createServer({
      client: fake.client,
      env: { DISCORD_BOT_TOKEN: "test-token" },
    });
    servers.push(server);

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
  });

  it("createServer throws on missing DISCORD_BOT_TOKEN", () => {
    expect(() => createServer({ env: {} })).toThrow("Environment validation failed.");
  });
});
