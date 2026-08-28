import { describe, expect, it } from "vitest";

import { NotionMcpServer, metadata, serverCard } from "../src/index.js";
import type { Client } from "@notionhq/client";

function createFakeNotionClient() {
  const search = async () => ({
    object: "list",
    results: [
      {
        object: "page",
        id: "page-1",
        url: "https://www.notion.so/page-1",
        last_edited_time: "2026-01-01T00:00:00.000Z",
        archived: false,
        properties: {
          Name: { type: "title", title: [{ plain_text: "Launch plan" }] },
        },
      },
    ],
    next_cursor: null,
    has_more: false,
  });

  const client = {
    search,
    pages: {
      retrieve: async () => ({
        object: "page",
        id: "page-1",
        url: "https://www.notion.so/page-1",
        last_edited_time: "2026-01-01T00:00:00.000Z",
        archived: false,
        properties: {
          Name: { type: "title", title: [{ plain_text: "Launch plan" }] },
          Status: { type: "select", select: { name: "Ready" } },
        },
      }),
      create: async () => ({
        object: "page",
        id: "page-2",
        url: "https://www.notion.so/page-2",
        last_edited_time: "2026-01-02T00:00:00.000Z",
        archived: false,
        properties: {
          title: { type: "title", title: [{ plain_text: "New page" }] },
        },
      }),
      update: async () => ({
        object: "page",
        id: "page-1",
        url: "https://www.notion.so/page-1",
        last_edited_time: "2026-01-03T00:00:00.000Z",
        archived: true,
        properties: {
          Name: { type: "title", title: [{ plain_text: "Launch plan" }] },
        },
      }),
    },
    blocks: {
      children: {
        append: async () => ({ object: "list", results: [{}, {}], next_cursor: null, has_more: false }),
      },
    },
    databases: {
      retrieve: async () => ({
        object: "database",
        id: "db-1",
        title: [{ plain_text: "Roadmap" }],
        description: [],
        url: "https://www.notion.so/db-1",
        data_sources: [{ id: "ds-1", name: "default" }],
      }),
    },
    dataSources: {
      query: async () => ({
        object: "list",
        results: [
          {
            object: "page",
            id: "row-1",
            url: "https://www.notion.so/row-1",
            last_edited_time: "2026-01-04T00:00:00.000Z",
            archived: false,
            properties: {
              Name: { type: "title", title: [{ plain_text: "Row one" }] },
            },
          },
        ],
        next_cursor: null,
        has_more: false,
      }),
    },
  } as unknown as Client;

  return client;
}

describe("NotionMcpServer smoke", () => {
  it("registers every declared tool (count > 0)", () => {
    const server = new NotionMcpServer("test-key", createFakeNotionClient());
    try {
      expect(server.getToolNames().length).toBeGreaterThan(0);
      expect([...server.getToolNames()]).toEqual([...metadata.toolNames].sort());
      expect(serverCard.tools).toEqual(metadata.toolNames);
    } finally {
      void server.close();
    }
  });

  it("searches through the injected client", async () => {
    const server = new NotionMcpServer("test-key", createFakeNotionClient());
    try {
      const result = await server.invokeTool<{ results: Array<{ title: string }>; resultCount: number }>(
        "notion_search",
        { query: "launch" },
      );
      expect(result.resultCount).toBe(1);
      expect(result.results[0]?.title).toBe("Launch plan");
    } finally {
      await server.close();
    }
  });

  it("queries a database through its first data source", async () => {
    const server = new NotionMcpServer("test-key", createFakeNotionClient());
    try {
      const result = await server.invokeTool<{ resultCount: number }>("notion_query_database", {
        databaseId: "db-1",
      });
      expect(result.resultCount).toBe(1);
    } finally {
      await server.close();
    }
  });
});
