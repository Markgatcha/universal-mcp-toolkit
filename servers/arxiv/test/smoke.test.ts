import { describe, expect, it } from "vitest";

import { createServer, metadata, serverCard, type ArxivClient, type ArxivPaper } from "../src/index.js";

class FakeArxivClient implements ArxivClient {
  public async searchPapers(): Promise<ReadonlyArray<ArxivPaper>> {
    return [
      {
        id: "2401.00001",
        title: "Toolkit Agents for Reliable Patches",
        summary: "A paper about safe automation.",
        authors: ["Marki Example"],
        categories: ["cs.AI"],
        primaryCategory: "cs.AI",
        publishedAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
        pdfUrl: "https://arxiv.org/pdf/2401.00001.pdf",
        absUrl: "https://arxiv.org/abs/2401.00001",
      },
    ];
  }

  public async getPaper(): Promise<ArxivPaper> {
    return {
      id: "2401.00001",
      title: "Toolkit Agents for Reliable Patches",
      summary: "A paper about safe automation.",
      authors: ["Marki Example"],
      categories: ["cs.AI"],
      primaryCategory: "cs.AI",
      publishedAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-02T00:00:00.000Z",
      pdfUrl: "https://arxiv.org/pdf/2401.00001.pdf",
      absUrl: "https://arxiv.org/abs/2401.00001",
    };
  }

  public async listRecentPapers(): Promise<ReadonlyArray<ArxivPaper>> {
    return [
      {
        id: "2401.00002",
        title: "Recent Agent Benchmarks",
        summary: "Benchmarks for agents.",
        authors: ["Marki Example"],
        categories: ["cs.AI"],
        primaryCategory: "cs.AI",
        publishedAt: "2024-01-03T00:00:00.000Z",
        updatedAt: "2024-01-04T00:00:00.000Z",
        pdfUrl: null,
        absUrl: "https://arxiv.org/abs/2401.00002",
      },
    ];
  }
}

describe("arxiv smoke", () => {
  it("registers feed resources and paper tools", async () => {
    const server = await createServer({ client: new FakeArxivClient(), env: { ARXIV_DEFAULT_CATEGORY: "cs.AI" } });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const search = await server.invokeTool<{ papers: ReadonlyArray<{ id: string }>; returned: number }>(
        "search_papers",
        { query: "agents", maxResults: 5, sortBy: "relevance" },
      );
      expect(search.returned).toBe(1);
      expect(search.papers[0]?.id).toBe("2401.00001");

      const recent = await server.invokeTool<{ category: string; papers: ReadonlyArray<{ title: string }> }>(
        "list_recent_papers",
        { category: "cs.AI", maxResults: 5 },
      );
      expect(recent.category).toBe("cs.AI");
      expect(recent.papers[0]?.title).toBe("Recent Agent Benchmarks");
    } finally {
      await server.close();
    }
  });
});
