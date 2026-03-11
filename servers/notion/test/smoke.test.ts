import { describe, expect, it } from "vitest";

import {
  NotionServer,
  createServer,
  metadata,
  serverCard,
  type CreatePageOutput,
  type GetPageInput,
  type GetPageOutput,
  type NotionClientLike,
  type NotionCreatePageRequest,
  type NotionPageDetail,
  type NotionPageSummary,
  type NotionServerConfig,
  type NotionWorkspaceResource,
  type SearchPagesInput,
  type SearchPagesOutput,
  type SummarizeDocPromptArgs,
} from "../src/index.js";

const pageId = "12345678-1234-1234-1234-1234567890ab";
const parentPageId = "abcdefab-cdef-cdef-cdef-abcdefabcdef";

const config: NotionServerConfig = {
  token: "test-token",
  defaultParentPageId: parentPageId,
  workspaceName: "Engineering Docs",
  apiBaseUrl: "https://api.notion.com/v1",
  apiVersion: "2026-03-11",
};

const pageSummary: NotionPageSummary = {
  id: pageId,
  title: "Launch plan",
  url: "https://www.notion.so/Launch-plan-123456781234123412341234567890ab",
  publicUrl: null,
  createdTime: "2026-03-10T18:00:00.000Z",
  lastEditedTime: "2026-03-10T19:00:00.000Z",
  archived: false,
  inTrash: false,
  isLocked: false,
  parent: {
    type: "page_id",
    pageId: parentPageId,
    databaseId: null,
    dataSourceId: null,
    workspace: false,
  },
};

const pageDetail: NotionPageDetail = {
  ...pageSummary,
  properties: [
    {
      name: "Status",
      type: "status",
      valuePreview: "Ready",
    },
    {
      name: "Owner",
      type: "people",
      valuePreview: "Platform",
    },
  ],
  propertyCount: 2,
  contentBlocks: [
    {
      id: "block-1",
      type: "paragraph",
      text: "Launch on Friday.",
      hasChildren: false,
    },
    {
      id: "block-2",
      type: "bulleted_list_item",
      text: "Coordinate the rollback plan.",
      hasChildren: false,
    },
  ],
  contentPreview: "Launch on Friday.\nCoordinate the rollback plan.",
  hasMoreContent: false,
  nextCursor: null,
};

const workspaceResource: NotionWorkspaceResource = {
  workspaceName: "Engineering Docs",
  integration: {
    id: "bot-123",
    name: "Docs Bot",
    type: "bot",
    avatarUrl: null,
  },
  apiBaseUrl: "https://api.notion.com/v1",
  apiVersion: "2026-03-11",
  defaultParentPageId: parentPageId,
  recentPages: [pageSummary],
};

class FakeNotionClient implements NotionClientLike {
  public readonly searchCalls: SearchPagesInput[] = [];
  public readonly getPageCalls: GetPageInput[] = [];
  public readonly createPageCalls: NotionCreatePageRequest[] = [];
  public workspaceCalls = 0;

  public async searchPages(input: SearchPagesInput): Promise<SearchPagesOutput> {
    this.searchCalls.push(input);
    return {
      query: input.query,
      resultCount: 1,
      nextCursor: null,
      hasMore: false,
      results: [pageSummary],
    };
  }

  public async getPage(input: GetPageInput): Promise<NotionPageDetail> {
    this.getPageCalls.push(input);
    return pageDetail;
  }

  public async createPage(input: NotionCreatePageRequest): Promise<CreatePageOutput> {
    this.createPageCalls.push(input);
    return {
      page: pageSummary,
      usedParentPageId: input.parentPageId,
      contentBlockCount: 2,
    };
  }

  public async getWorkspace(): Promise<NotionWorkspaceResource> {
    this.workspaceCalls += 1;
    return workspaceResource;
  }
}

describe("NotionServer smoke", () => {
  it("keeps discovery metadata aligned with registered capabilities", async () => {
    const server = new NotionServer({
      config,
      client: new FakeNotionClient(),
    });

    try {
      expect(server.metadata).toEqual(metadata);
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(serverCard.resources).toEqual(metadata.resourceNames);
      expect(serverCard.prompts).toEqual(metadata.promptNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());
    } finally {
      await server.close();
    }
  });

  it("uses injected fake clients for tools, the workspace resource, and the summarize prompt", async () => {
    const client = new FakeNotionClient();
    const server = new NotionServer({
      config,
      client,
    });

    try {
      const searchResult = await server.invokeTool<SearchPagesOutput>("search-pages", {
        query: "launch",
        limit: 2,
      });
      expect(searchResult.results[0]?.title).toBe("Launch plan");
      expect(client.searchCalls[0]).toMatchObject({
        query: "launch",
        limit: 2,
        sortDirection: "descending",
      });

      const getResult = await server.invokeTool<GetPageOutput>("get-page", {
        pageId: "https://www.notion.so/Launch-plan-123456781234123412341234567890ab",
        contentLimit: 3,
      });
      expect(getResult.page.propertyCount).toBe(2);
      expect(client.getPageCalls[0]).toMatchObject({
        pageId,
        includeContent: true,
        contentLimit: 3,
      });

      const createResult = await server.invokeTool<CreatePageOutput>("create-page", {
        title: "Launch checklist",
        content: "First task\n\nSecond task",
      });
      expect(createResult.usedParentPageId).toBe(parentPageId);
      expect(client.createPageCalls[0]).toMatchObject({
        title: "Launch checklist",
        parentPageId,
        content: "First task\n\nSecond task",
      });

      const resource = await server.readWorkspaceResource();
      const resourceContent = resource.contents[0];
      expect(resourceContent?.mimeType).toBe("application/json");
      expect(resourceContent && "text" in resourceContent).toBe(true);
      if (!resourceContent || !("text" in resourceContent)) {
        throw new Error("Expected the Notion workspace resource to be returned as JSON text.");
      }
      const resourcePayload = JSON.parse(resourceContent.text) as NotionWorkspaceResource;
      expect(resourcePayload.integration.name).toBe("Docs Bot");
      expect(client.workspaceCalls).toBe(1);

      const prompt = await server.buildSummarizeDocPrompt({
        pageId,
        audience: "executives",
        focus: "delivery risks",
        contentLimit: 2,
      } satisfies SummarizeDocPromptArgs);
      expect(prompt.messages[0]?.content.type).toBe("text");
      if (prompt.messages[0]?.content.type === "text") {
        expect(prompt.messages[0].content.text).toContain("Launch plan");
        expect(prompt.messages[0].content.text).toContain("executives");
        expect(prompt.messages[0].content.text).toContain("delivery risks");
      }
      expect(client.getPageCalls[1]).toMatchObject({
        pageId,
        includeContent: true,
        contentLimit: 2,
      });
    } finally {
      await server.close();
    }
  });

  it("creates a server from factory options without live network access", async () => {
    const server = createServer({
      config,
      client: new FakeNotionClient(),
    });

    try {
      const searchResult = await server.invokeTool<SearchPagesOutput>("search-pages", {
        query: "",
      });
      expect(searchResult.resultCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
