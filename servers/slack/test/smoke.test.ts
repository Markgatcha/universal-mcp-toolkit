import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SlackServer,
  createServer,
  metadata,
  serverCard,
  type FetchChannelHistoryOutput,
  type ListChannelsOutput,
  type PostMessageOutput,
  type SlackClient,
} from "../src/index.js";

function createFakeClient() {
  const listChannels = vi.fn<SlackClient["listChannels"]>().mockResolvedValue({
    channels: [
      {
        id: "C123",
        name: "engineering",
        isPrivate: false,
        isArchived: false,
        isMember: true,
        memberCount: 42,
        topic: "Core platform work",
        purpose: "Share engineering updates",
      },
    ],
    nextCursor: "CURSOR-2",
  });

  const fetchChannelHistory = vi.fn<SlackClient["fetchChannelHistory"]>().mockResolvedValue({
    channelId: "C123",
    hasMore: false,
    messages: [
      {
        ts: "1700000000.000100",
        threadTs: null,
        userId: "U123",
        text: "Shipped the Slack server smoke tests.",
        messageType: "message",
        replyCount: null,
        reactionNames: ["white_check_mark"],
      },
    ],
    nextCursor: null,
  });

  const postMessage = vi.fn<SlackClient["postMessage"]>().mockResolvedValue({
    channelId: "CDEFAULT",
    messageTs: "1700000000.000200",
    threadTs: null,
    text: "Deployment is complete.",
  });

  const getWorkspaceInfo = vi.fn<SlackClient["getWorkspaceInfo"]>().mockResolvedValue({
    authenticatedUserId: "U999",
    authenticatedUserName: "slack-bot",
    botId: "B999",
    teamId: "TACTUAL",
    workspaceName: "Actual Workspace",
    workspaceUrl: "https://example.slack.com/",
  });

  const client: SlackClient = {
    fetchChannelHistory,
    getWorkspaceInfo,
    listChannels,
    postMessage,
  };

  return {
    client,
    fetchChannelHistory,
    getWorkspaceInfo,
    listChannels,
    postMessage,
  };
}

const servers: SlackServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("SlackServer", () => {
  it("registers metadata and executes tools with an injected client", async () => {
    const fake = createFakeClient();
    const server = new SlackServer({
      apiBaseUrl: "https://slack.com/api",
      client: fake.client,
      defaultChannelId: "CDEFAULT",
    });
    servers.push(server);

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
    expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
    expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());
    expect(serverCard.tools).toEqual(metadata.toolNames);
    expect(serverCard.resources).toEqual(metadata.resourceNames);
    expect(serverCard.prompts).toEqual(metadata.promptNames);

    const listResult = await server.invokeTool<ListChannelsOutput>("list_channels", {
      includeArchived: false,
      limit: 10,
      types: ["public_channel", "private_channel"],
    });
    expect(listResult.returnedCount).toBe(1);
    expect(listResult.channels[0]?.name).toBe("engineering");
    expect(fake.listChannels).toHaveBeenCalledWith({
      includeArchived: false,
      limit: 10,
      types: ["public_channel", "private_channel"],
    });

    const historyResult = await server.invokeTool<FetchChannelHistoryOutput>("fetch_channel_history", {
      channelId: "C123",
      limit: 5,
    });
    expect(historyResult.channelId).toBe("C123");
    expect(historyResult.messages[0]?.text).toContain("Slack server smoke tests");
    expect(fake.fetchChannelHistory).toHaveBeenCalledWith({
      channelId: "C123",
      inclusive: false,
      limit: 5,
    });

    const postResult = await server.invokeTool<PostMessageOutput>("post_message", {
      text: "Deployment is complete.",
    });
    expect(postResult.channelId).toBe("CDEFAULT");
    expect(postResult.usedDefaultChannel).toBe(true);
    expect(fake.postMessage).toHaveBeenCalledWith({
      channelId: "CDEFAULT",
      mrkdwn: true,
      text: "Deployment is complete.",
      unfurlLinks: false,
    });
  });

  it("builds the workspace resource and compose-update prompt from createServer", async () => {
    const fake = createFakeClient();
    const server = createServer({
      client: fake.client,
      env: {
        SLACK_BOT_TOKEN: "xoxb-test-token",
        SLACK_DEFAULT_CHANNEL_ID: "CDEFAULT",
        SLACK_TEAM_ID: "TOVERRIDE",
        SLACK_WORKSPACE_NAME: "Override Workspace",
      },
    });
    servers.push(server);

    const resource = await server.readWorkspaceResource();
    expect(resource.workspaceName).toBe("Override Workspace");
    expect(resource.teamId).toBe("TOVERRIDE");
    expect(resource.defaultChannelId).toBe("CDEFAULT");
    expect(resource.availableTools).toEqual([...metadata.toolNames]);
    expect(fake.getWorkspaceInfo).toHaveBeenCalledTimes(1);

    const prompt = server.buildComposeUpdatePrompt({
      audience: "Engineering leadership",
      channelName: "eng-updates",
      highlights: ["Completed channel list/history/post tooling", "Added fake-client smoke coverage"],
      nextStep: "Review and merge the Slack package.",
      progressSummary: "The Slack server package is ready for review.",
      risks: ["Pending maintainer approval"],
      tone: "concise",
      topic: "Slack server rollout",
    });

    expect(prompt.messages).toHaveLength(1);
    expect(prompt.messages[0]?.content.type).toBe("text");
    expect(prompt.messages[0]?.content.text).toContain("#eng-updates");
    expect(prompt.messages[0]?.content.text).toContain("Slack server rollout");
  });
});
