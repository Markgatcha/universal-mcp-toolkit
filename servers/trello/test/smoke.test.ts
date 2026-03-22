import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TrelloServer,
  createServer,
  metadata,
  serverCard,
  type TrelloBoardSummary,
  type TrelloCardSummary,
  type TrelloClient,
  type TrelloListSummary,
} from "../src/index.js";

function createFakeClient() {
  const listBoards = vi.fn<TrelloClient["listBoards"]>().mockResolvedValue([
    { id: "board1", name: "Sprint Board", description: "Main sprint tracking", closed: false, url: "https://trello.com/b/abc123" },
    { id: "board2", name: "Backlog", description: "Backlog items", closed: false, url: null },
  ]);

  const listLists = vi.fn<TrelloClient["listLists"]>().mockResolvedValue([
    { id: "list1", name: "To Do", closed: false },
    { id: "list2", name: "In Progress", closed: false },
    { id: "list3", name: "Done", closed: false },
  ]);

  const listCardsByBoard = vi.fn<TrelloClient["listCardsByBoard"]>().mockResolvedValue([
    { id: "card1", name: "Fix login bug", description: "Users cannot log in", closed: false, due: "2025-03-01T00:00:00.000Z", listId: "list1", url: "https://trello.com/c/abc" },
    { id: "card2", name: "Add dark mode", description: "", closed: false, due: null, listId: "list2", url: null },
  ]);

  const listCardsByList = vi.fn<TrelloClient["listCardsByList"]>().mockResolvedValue([
    { id: "card1", name: "Fix login bug", description: "Users cannot log in", closed: false, due: "2025-03-01T00:00:00.000Z", listId: "list1", url: "https://trello.com/c/abc" },
  ]);

  const createCard = vi.fn<TrelloClient["createCard"]>().mockResolvedValue({
    id: "card999",
    name: "New card",
    description: "A new card",
    listId: "list1",
    url: "https://trello.com/c/new",
  });

  const updateCard = vi.fn<TrelloClient["updateCard"]>().mockResolvedValue({
    id: "card1",
    name: "Fix login bug (updated)",
    description: "Users cannot log in - in progress",
    closed: false,
    listId: "list2",
  });

  const archiveCard = vi.fn<TrelloClient["archiveCard"]>().mockResolvedValue({
    id: "card1",
    name: "Fix login bug",
    closed: true,
  });

  const client: TrelloClient = {
    listBoards,
    listLists,
    listCardsByBoard,
    listCardsByList,
    createCard,
    updateCard,
    archiveCard,
  };

  return { client, listBoards, listLists, listCardsByBoard, listCardsByList, createCard, updateCard, archiveCard };
}

const servers: TrelloServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("TrelloServer", () => {
  it("registers all six tools and validates metadata", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
    expect(serverCard.tools).toEqual(metadata.toolNames);
  });

  it("list_boards returns board summaries", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ boards: TrelloBoardSummary[]; returnedCount: number }>("trello_list_boards", { filter: "open" });
    expect(result.returnedCount).toBe(2);
    expect(result.boards[0]?.name).toBe("Sprint Board");
    expect(fake.listBoards).toHaveBeenCalledWith("open");
  });

  it("list_lists returns list summaries", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ boardId: string; lists: TrelloListSummary[]; returnedCount: number }>("trello_list_lists", { boardId: "board1" });
    expect(result.returnedCount).toBe(3);
    expect(result.boardId).toBe("board1");
    expect(result.lists[0]?.name).toBe("To Do");
    expect(fake.listLists).toHaveBeenCalledWith("board1", "open");
  });

  it("list_cards with boardId lists cards by board", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ cards: TrelloCardSummary[]; sourceType: string; returnedCount: number }>("trello_list_cards", { boardId: "board1" });
    expect(result.returnedCount).toBe(2);
    expect(result.sourceType).toBe("board");
    expect(result.cards[0]?.name).toBe("Fix login bug");
    expect(fake.listCardsByBoard).toHaveBeenCalledWith("board1");
  });

  it("list_cards with listId lists cards by list", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ cards: TrelloCardSummary[]; sourceType: string; returnedCount: number }>("trello_list_cards", { listId: "list1" });
    expect(result.returnedCount).toBe(1);
    expect(result.sourceType).toBe("list");
    expect(fake.listCardsByList).toHaveBeenCalledWith("list1");
  });

  it("create_card returns the created card", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string; name: string }>("trello_create_card", { listId: "list1", name: "New card", desc: "A new card" });
    expect(result.id).toBe("card999");
    expect(result.name).toBe("New card");
    expect(fake.createCard).toHaveBeenCalledWith("list1", "New card", "A new card", undefined);
  });

  it("update_card returns the updated card", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string; name: string; closed: boolean }>("trello_update_card", { cardId: "card1", name: "Fix login bug (updated)" });
    expect(result.id).toBe("card1");
    expect(result.name).toBe("Fix login bug (updated)");
    expect(result.closed).toBe(false);
  });

  it("archive_card archives and returns confirmation", async () => {
    const fake = createFakeClient();
    const server = new TrelloServer({ client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string; name: string; closed: boolean }>("trello_archive_card", { cardId: "card1" });
    expect(result.id).toBe("card1");
    expect(result.closed).toBe(true);
    expect(fake.archiveCard).toHaveBeenCalledWith("card1");
  });

  it("createServer validates env and constructs with injected client", () => {
    const fake = createFakeClient();
    const server = createServer({
      client: fake.client,
      env: { TRELLO_API_KEY: "test-key", TRELLO_TOKEN: "test-token" },
    });
    servers.push(server);
    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
  });

  it("createServer throws on missing TRELLO_API_KEY", () => {
    expect(() => createServer({ env: { TRELLO_TOKEN: "test-token" } })).toThrow("Environment validation failed.");
  });

  it("createServer throws on missing TRELLO_TOKEN", () => {
    expect(() => createServer({ env: { TRELLO_API_KEY: "test-key" } })).toThrow("Environment validation failed.");
  });
});
