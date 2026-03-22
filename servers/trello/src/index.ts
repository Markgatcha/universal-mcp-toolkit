import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExternalServiceError,
  ToolkitServer,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const TRELLO_API_BASE_URL = "https://api.trello.com/1";

const LIST_BOARDS_TOOL_NAME = "trello_list_boards";
const LIST_LISTS_TOOL_NAME = "trello_list_lists";
const LIST_CARDS_TOOL_NAME = "trello_list_cards";
const CREATE_CARD_TOOL_NAME = "trello_create_card";
const UPDATE_CARD_TOOL_NAME = "trello_update_card";
const ARCHIVE_CARD_TOOL_NAME = "trello_archive_card";

export const metadata = {
  id: "trello",
  title: "Trello MCP Server",
  description: "Board and list discovery, card CRUD, and archiving for Trello workspaces.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-trello",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit.git",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit#readme",
  envVarNames: ["TRELLO_API_KEY", "TRELLO_TOKEN"] as const,
  transports: ["stdio", "sse"] as const,
  toolNames: [
    LIST_BOARDS_TOOL_NAME,
    LIST_LISTS_TOOL_NAME,
    LIST_CARDS_TOOL_NAME,
    CREATE_CARD_TOOL_NAME,
    UPDATE_CARD_TOOL_NAME,
    ARCHIVE_CARD_TOOL_NAME,
  ] as const,
  resourceNames: [] as const,
  promptNames: [] as const,
} satisfies ToolkitServerMetadata;

export const serverCard = createServerCard(metadata);

function toNullableString(value: string | null | undefined): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function extractErrorDetails(error: unknown): unknown {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack };
  }
  return error;
}

// --- Zod schemas ---

const boardSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  desc: z.string().default(""),
  closed: z.boolean().optional(),
  url: z.string().optional(),
  shortUrl: z.string().optional(),
});

const listSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  closed: z.boolean().optional(),
  pos: z.number().optional(),
});

const cardSchema = z.object({
  id: z.string().min(1),
  name: z.string().default(""),
  desc: z.string().default(""),
  closed: z.boolean().optional(),
  due: z.string().nullable().optional(),
  dueComplete: z.boolean().optional(),
  idBoard: z.string().optional(),
  idList: z.string().optional(),
  url: z.string().optional(),
  shortUrl: z.string().optional(),
  pos: z.number().optional(),
  dateLastActivity: z.string().optional(),
});

// --- Tool shapes ---

const listBoardsInputShape = {
  filter: z.enum(["all", "closed", "members", "open", "organization", "publicStarred"]).default("open").describe("Filter boards by status."),
};

const boardSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  closed: z.boolean(),
  url: z.string().nullable(),
});

const listBoardsOutputShape = {
  boards: z.array(boardSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const listListsInputShape = {
  boardId: z.string().trim().min(1).describe("The board ID to list lists from."),
  filter: z.enum(["all", "closed", "open"]).default("open").describe("Filter lists by status."),
};

const listSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  closed: z.boolean(),
});

const listListsOutputShape = {
  boardId: z.string().min(1),
  lists: z.array(listSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const listCardsInputShape = {
  boardId: z.string().trim().min(1).optional().describe("The board ID to list cards from."),
  listId: z.string().trim().min(1).optional().describe("The list ID to list cards from."),
};

const cardSummarySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  closed: z.boolean(),
  due: z.string().nullable(),
  listId: z.string().nullable(),
  url: z.string().nullable(),
});

const listCardsOutputShape = {
  sourceId: z.string().min(1),
  sourceType: z.enum(["board", "list"]),
  cards: z.array(cardSummarySchema),
  returnedCount: z.number().int().nonnegative(),
};

const createCardInputShape = {
  listId: z.string().trim().min(1).describe("The list ID to create the card in."),
  name: z.string().trim().min(1).max(16384).describe("The name of the card."),
  desc: z.string().trim().max(16384).optional().describe("Optional description for the card."),
  due: z.string().trim().optional().describe("Optional due date in ISO 8601 format."),
};

const createCardOutputShape = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  listId: z.string().min(1),
  url: z.string().nullable(),
};

const updateCardInputShape = {
  cardId: z.string().trim().min(1).describe("The ID of the card to update."),
  name: z.string().trim().min(1).max(16384).optional().describe("New name for the card."),
  desc: z.string().trim().max(16384).optional().describe("New description for the card."),
  due: z.string().trim().nullable().optional().describe("New due date in ISO 8601 format, or null to clear."),
  closed: z.boolean().optional().describe("Set to true to archive, false to unarchive."),
  idList: z.string().trim().min(1).optional().describe("Move the card to a different list."),
};

const updateCardOutputShape = {
  id: z.string().min(1),
  name: z.string(),
  description: z.string(),
  closed: z.boolean(),
  listId: z.string().nullable(),
};

const archiveCardInputShape = {
  cardId: z.string().trim().min(1).describe("The ID of the card to archive."),
};

const archiveCardOutputShape = {
  id: z.string().min(1),
  name: z.string(),
  closed: z.boolean(),
};

// --- Client interface ---

export interface TrelloBoardSummary {
  id: string;
  name: string;
  description: string;
  closed: boolean;
  url: string | null;
}

export interface TrelloListSummary {
  id: string;
  name: string;
  closed: boolean;
}

export interface TrelloCardSummary {
  id: string;
  name: string;
  description: string;
  closed: boolean;
  due: string | null;
  listId: string | null;
  url: string | null;
}

export interface TrelloClient {
  listBoards(filter: string): Promise<TrelloBoardSummary[]>;
  listLists(boardId: string, filter: string): Promise<TrelloListSummary[]>;
  listCardsByBoard(boardId: string): Promise<TrelloCardSummary[]>;
  listCardsByList(listId: string): Promise<TrelloCardSummary[]>;
  createCard(listId: string, name: string, desc?: string, due?: string): Promise<{ id: string; name: string; description: string; listId: string; url: string | null }>;
  updateCard(cardId: string, fields: Record<string, unknown>): Promise<{ id: string; name: string; description: string; closed: boolean; listId: string | null }>;
  archiveCard(cardId: string): Promise<{ id: string; name: string; closed: boolean }>;
}

// --- Concrete client ---

function mapCard(card: z.infer<typeof cardSchema>): TrelloCardSummary {
  return {
    id: card.id,
    name: card.name,
    description: card.desc,
    closed: card.closed ?? false,
    due: toNullableString(card.due),
    listId: toNullableString(card.idList),
    url: toNullableString(card.url ?? card.shortUrl),
  };
}

class RestTrelloClient implements TrelloClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly token: string;

  public constructor(apiKey: string, token: string, baseUrl: string, fetchImpl: typeof fetch = fetch) {
    this.apiKey = apiKey;
    this.token = token;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetchImpl = fetchImpl;
  }

  public async listBoards(filter: string): Promise<TrelloBoardSummary[]> {
    const payload = await this.request("GET", `/members/me/boards?filter=${filter}`);
    const parsed = z.array(boardSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected board list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.desc,
      closed: b.closed ?? false,
      url: toNullableString(b.url ?? b.shortUrl),
    }));
  }

  public async listLists(boardId: string, filter: string): Promise<TrelloListSummary[]> {
    const payload = await this.request("GET", `/boards/${boardId}/lists?filter=${filter}`);
    const parsed = z.array(listSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map((l) => ({
      id: l.id,
      name: l.name,
      closed: l.closed ?? false,
    }));
  }

  public async listCardsByBoard(boardId: string): Promise<TrelloCardSummary[]> {
    const payload = await this.request("GET", `/boards/${boardId}/cards`);
    const parsed = z.array(cardSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected card list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map(mapCard);
  }

  public async listCardsByList(listId: string): Promise<TrelloCardSummary[]> {
    const payload = await this.request("GET", `/lists/${listId}/cards`);
    const parsed = z.array(cardSchema).safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected card list.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return parsed.data.map(mapCard);
  }

  public async createCard(
    listId: string,
    name: string,
    desc?: string,
    due?: string,
  ): Promise<{ id: string; name: string; description: string; listId: string; url: string | null }> {
    const body: Record<string, string> = { idList: listId, name };
    if (desc) {
      body.desc = desc;
    }
    if (due) {
      body.due = due;
    }
    const payload = await this.request("POST", "/cards", body);
    const parsed = cardSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected create response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.desc,
      listId: parsed.data.idList ?? listId,
      url: toNullableString(parsed.data.url ?? parsed.data.shortUrl),
    };
  }

  public async updateCard(
    cardId: string,
    fields: Record<string, unknown>,
  ): Promise<{ id: string; name: string; description: string; closed: boolean; listId: string | null }> {
    const payload = await this.request("PUT", `/cards/${cardId}`, fields);
    const parsed = cardSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected update response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      id: parsed.data.id,
      name: parsed.data.name,
      description: parsed.data.desc,
      closed: parsed.data.closed ?? false,
      listId: toNullableString(parsed.data.idList),
    };
  }

  public async archiveCard(cardId: string): Promise<{ id: string; name: string; closed: boolean }> {
    const payload = await this.request("PUT", `/cards/${cardId}`, { closed: true });
    const parsed = cardSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Trello returned an unexpected archive response.", {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }
    return {
      id: parsed.data.id,
      name: parsed.data.name,
      closed: parsed.data.closed ?? true,
    };
  }

  private async request(method: "GET" | "POST" | "PUT", path: string, body?: object): Promise<unknown> {
    const separator = path.includes("?") ? "&" : "?";
    const url = `${this.baseUrl}${path}${separator}key=${this.apiKey}&token=${this.token}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };

    const requestInit: RequestInit = {
      method,
      headers,
    };

    if (body) {
      headers["Content-Type"] = "application/json";
      requestInit.body = JSON.stringify(body);
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, requestInit);
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach Trello API at '${path}'.`, {
        statusCode: 502,
        details: { path, cause: extractErrorDetails(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? (JSON.parse(rawText) as unknown) : {};
    } catch {
      throw new ExternalServiceError(`Trello API at '${path}' returned malformed JSON.`, {
        statusCode: 502,
        details: { path, rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      const details = { path, statusCode: response.status, body: payload };
      if (response.status === 401) {
        throw new ExternalServiceError("Trello authentication failed. Verify TRELLO_API_KEY and TRELLO_TOKEN.", {
          statusCode: 401,
          details,
        });
      }
      if (response.status === 403) {
        throw new ExternalServiceError(`Trello denied access to '${path}'. The token may lack required permissions.`, {
          statusCode: 403,
          details,
        });
      }
      if (response.status === 404) {
        throw new ExternalServiceError(`Trello resource at '${path}' was not found. Verify the ID.`, {
          statusCode: 404,
          details,
        });
      }
      if (response.status === 429) {
        throw new ExternalServiceError(`Trello rate limited request to '${path}'.`, {
          statusCode: 429,
          details,
        });
      }
      throw new ExternalServiceError(`Trello API request to '${path}' failed with status ${response.status}.`, {
        statusCode: response.status >= 400 ? response.status : 502,
        details,
      });
    }

    return payload;
  }
}

// --- Render helpers ---

function renderBoards(boards: TrelloBoardSummary[]): string {
  if (boards.length === 0) {
    return "No boards found.";
  }
  const lines = boards.map((b) => `- ${b.name} (${b.id})${b.closed ? " [closed]" : ""}`);
  return [`Found ${boards.length} board(s).`, ...lines].join("\n");
}

function renderLists(lists: TrelloListSummary[]): string {
  if (lists.length === 0) {
    return "No lists found on this board.";
  }
  const lines = lists.map((l) => `- ${l.name} (${l.id})${l.closed ? " [closed]" : ""}`);
  return [`Found ${lists.length} list(s).`, ...lines].join("\n");
}

function renderCards(cards: TrelloCardSummary[]): string {
  if (cards.length === 0) {
    return "No cards found.";
  }
  const lines = cards.slice(0, 15).map((c) => {
    const due = c.due ? ` (due: ${c.due})` : "";
    return `- ${c.name} (${c.id})${due}`;
  });
  if (cards.length > 15) {
    lines.push(`- ${cards.length - 15} additional card(s) omitted.`);
  }
  return [`Found ${cards.length} card(s).`, ...lines].join("\n");
}

function renderCreatedCard(id: string, name: string): string {
  return `Created card "${name}" (${id}).`;
}

function renderUpdatedCard(id: string, name: string): string {
  return `Updated card "${name}" (${id}).`;
}

function renderArchivedCard(id: string, name: string): string {
  return `Archived card "${name}" (${id}).`;
}

// --- Server ---

export interface TrelloServerOptions {
  client: TrelloClient;
}

export class TrelloServer extends ToolkitServer {
  private readonly client: TrelloClient;

  public constructor(options: TrelloServerOptions) {
    super(metadata);
    this.client = options.client;

    this.registerTool(
      defineTool({
        name: LIST_BOARDS_TOOL_NAME,
        title: "List Trello boards",
        description: "List all boards for the authenticated Trello user.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listBoardsInputShape,
        outputSchema: listBoardsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Listing Trello boards (filter: ${input.filter}).`);
          try {
            const boards = await this.client.listBoards(input.filter);
            return { boards, returnedCount: boards.length };
          } catch (error) {
            throw this.mapOperationError(LIST_BOARDS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderBoards(output.boards),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_LISTS_TOOL_NAME,
        title: "List Trello lists",
        description: "List all lists on a Trello board.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listListsInputShape,
        outputSchema: listListsOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Listing lists on board ${input.boardId}.`);
          try {
            const lists = await this.client.listLists(input.boardId, input.filter);
            return { boardId: input.boardId, lists, returnedCount: lists.length };
          } catch (error) {
            throw this.mapOperationError(LIST_LISTS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderLists(output.lists),
      }),
    );

    this.registerTool(
      defineTool({
        name: LIST_CARDS_TOOL_NAME,
        title: "List Trello cards",
        description: "List cards on a Trello board or list.",
        annotations: {
          idempotentHint: true,
          openWorldHint: true,
          readOnlyHint: true,
        },
        inputSchema: listCardsInputShape,
        outputSchema: listCardsOutputShape,
        handler: async (input, context) => {
          if (!input.boardId && !input.listId) {
            throw new ValidationError("Either boardId or listId must be provided.");
          }
          try {
            if (input.listId) {
              await context.log("info", `Listing cards on list ${input.listId}.`);
              const cards = await this.client.listCardsByList(input.listId);
              return { sourceId: input.listId, sourceType: "list" as const, cards, returnedCount: cards.length };
            }
            await context.log("info", `Listing cards on board ${input.boardId}.`);
            const cards = await this.client.listCardsByBoard(input.boardId!);
            return { sourceId: input.boardId!, sourceType: "board" as const, cards, returnedCount: cards.length };
          } catch (error) {
            throw this.mapOperationError(LIST_CARDS_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderCards(output.cards),
      }),
    );

    this.registerTool(
      defineTool({
        name: CREATE_CARD_TOOL_NAME,
        title: "Create Trello card",
        description: "Create a new card in a Trello list.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: createCardInputShape,
        outputSchema: createCardOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Creating card "${input.name}" in list ${input.listId}.`);
          try {
            const result = await this.client.createCard(input.listId, input.name, input.desc, input.due);
            return {
              id: result.id,
              name: result.name,
              description: result.description,
              listId: result.listId,
              url: result.url,
            };
          } catch (error) {
            throw this.mapOperationError(CREATE_CARD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderCreatedCard(output.id, output.name),
      }),
    );

    this.registerTool(
      defineTool({
        name: UPDATE_CARD_TOOL_NAME,
        title: "Update Trello card",
        description: "Update a Trello card's name, description, due date, closed state, or list.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: updateCardInputShape,
        outputSchema: updateCardOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Updating card ${input.cardId}.`);
          try {
            const fields: Record<string, unknown> = {};
            if (input.name !== undefined) fields.name = input.name;
            if (input.desc !== undefined) fields.desc = input.desc;
            if (input.due !== undefined) fields.due = input.due;
            if (input.closed !== undefined) fields.closed = input.closed;
            if (input.idList !== undefined) fields.idList = input.idList;

            const result = await this.client.updateCard(input.cardId, fields);
            return {
              id: result.id,
              name: result.name,
              description: result.description,
              closed: result.closed,
              listId: result.listId,
            };
          } catch (error) {
            throw this.mapOperationError(UPDATE_CARD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderUpdatedCard(output.id, output.name),
      }),
    );

    this.registerTool(
      defineTool({
        name: ARCHIVE_CARD_TOOL_NAME,
        title: "Archive Trello card",
        description: "Archive (close) a Trello card by ID.",
        annotations: {
          openWorldHint: true,
        },
        inputSchema: archiveCardInputShape,
        outputSchema: archiveCardOutputShape,
        handler: async (input, context) => {
          await context.log("info", `Archiving card ${input.cardId}.`);
          try {
            const result = await this.client.archiveCard(input.cardId);
            return { id: result.id, name: result.name, closed: result.closed };
          } catch (error) {
            throw this.mapOperationError(ARCHIVE_CARD_TOOL_NAME, error);
          }
        },
        renderText: (output) => renderArchivedCard(output.id, output.name),
      }),
    );
  }

  private mapOperationError(operation: string, error: unknown): ExternalServiceError | ValidationError {
    if (error instanceof ExternalServiceError || error instanceof ValidationError) {
      return error;
    }
    return new ExternalServiceError(`Trello operation '${operation}' failed unexpectedly.`, {
      details: { operation, cause: extractErrorDetails(error) },
      exposeToClient: true,
    });
  }
}

export interface CreateTrelloServerOptions {
  client?: TrelloClient;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
}

const envShape = {
  TRELLO_API_KEY: z.string().trim().min(1, "TRELLO_API_KEY is required."),
  TRELLO_TOKEN: z.string().trim().min(1, "TRELLO_TOKEN is required."),
  TRELLO_API_BASE_URL: z.string().trim().url().default(TRELLO_API_BASE_URL),
};

export function createServer(options: CreateTrelloServerOptions = {}): TrelloServer {
  const env = loadEnv(envShape, options.env);
  const client =
    options.client ?? new RestTrelloClient(env.TRELLO_API_KEY, env.TRELLO_TOKEN, env.TRELLO_API_BASE_URL, options.fetchImpl);
  return new TrelloServer({ client });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  await runToolkitServer(
    {
      createServer,
      serverCard,
    },
    parseRuntimeOptions(argv),
  );
}

const isDirectExecution =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectExecution) {
  void main().catch((error) => {
    const normalized = normalizeError(error);
    process.stderr.write(`${normalized.toClientMessage()}\n`);
    process.exitCode = 1;
  });
}
