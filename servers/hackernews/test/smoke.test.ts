import { describe, expect, it } from "vitest";

import {
  createServer,
  metadata,
  serverCard,
  type HackerNewsClient,
  type HackerNewsStorySummary,
  type HackerNewsThread,
} from "../src/index.js";

class FakeHackerNewsClient implements HackerNewsClient {
  public async getTopStories(): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    return [
      {
        id: 1,
        title: "AI agent ships useful patch",
        url: "https://example.com/story",
        author: "marki",
        score: 120,
        commentCount: 42,
        publishedAt: "2024-01-01T00:00:00.000Z",
        text: null,
      },
    ];
  }

  public async searchStories(): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    return [
      {
        id: 2,
        title: "Search result story",
        url: null,
        author: "other",
        score: 55,
        commentCount: 10,
        publishedAt: "2024-01-02T00:00:00.000Z",
        text: "Interesting write-up",
      },
    ];
  }

  public async getThread(): Promise<HackerNewsThread> {
    return {
      id: 1,
      title: "AI agent ships useful patch",
      url: "https://example.com/story",
      author: "marki",
      score: 120,
      commentCount: 42,
      publishedAt: "2024-01-01T00:00:00.000Z",
      text: null,
      replies: [
        {
          id: 3,
          author: "commenter",
          text: "Great work",
          publishedAt: "2024-01-01T00:10:00.000Z",
          replies: [],
        },
      ],
    };
  }
}

describe("hackernews smoke", () => {
  it("registers trend resources and top story tools", async () => {
    const server = await createServer({ client: new FakeHackerNewsClient() });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const topStories = await server.invokeTool<{ stories: ReadonlyArray<{ title: string }>; returned: number }>(
        "get_top_stories",
        { limit: 5 },
      );
      expect(topStories.returned).toBe(1);
      expect(topStories.stories[0]?.title).toBe("AI agent ships useful patch");

      const thread = await server.invokeTool<{ thread: { replies: ReadonlyArray<{ author: string | null }> } }>(
        "get_item_thread",
        { itemId: 1, depth: 2, maxChildren: 10 },
      );
      expect(thread.thread.replies[0]?.author).toBe("commenter");
    } finally {
      await server.close();
    }
  });
});
