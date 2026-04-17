import {
  createServerCard,
  defineTool,
  ExternalServiceError,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const toolNames = ["get_top_stories", "search_stories", "get_item_thread"] as const;
const resourceNames = ["trends"] as const;
const promptNames = ["community-digest"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "hackernews",
  title: "Hacker News MCP Server",
  description: "Top stories, search, and thread tools for Hacker News.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-hackernews",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/hackernews",
  envVarNames: [],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  HACKERNEWS_API_BASE_URL: z.string().url().optional(),
  HACKERNEWS_SEARCH_BASE_URL: z.string().url().optional(),
};

type HackerNewsEnv = z.infer<z.ZodObject<typeof envShape>>;

const storySummarySchema = z.object({
  id: z.number().int().nonnegative(),
  title: z.string(),
  url: z.string().nullable(),
  author: z.string().nullable(),
  score: z.number().int().nonnegative().nullable(),
  commentCount: z.number().int().nonnegative().nullable(),
  publishedAt: z.string().nullable(),
  text: z.string().nullable(),
});

export type HackerNewsStorySummary = z.infer<typeof storySummarySchema>;

export interface HackerNewsThreadComment {
  id: number;
  author: string | null;
  text: string | null;
  publishedAt: string | null;
  replies: ReadonlyArray<HackerNewsThreadComment>;
}

const threadCommentSchema: z.ZodType<HackerNewsThreadComment> = z.lazy(() =>
  z.object({
    id: z.number().int().nonnegative(),
    author: z.string().nullable(),
    text: z.string().nullable(),
    publishedAt: z.string().nullable(),
    replies: z.array(threadCommentSchema),
  }),
);

const threadSchema = storySummarySchema.extend({
  replies: z.array(threadCommentSchema),
});

export type HackerNewsThread = z.infer<typeof threadSchema>;

export interface HackerNewsClient {
  getTopStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>>;
  searchStories(input: { query: string; limit: number }): Promise<ReadonlyArray<HackerNewsStorySummary>>;
  getThread(input: { itemId: number; depth: number; maxChildren: number }): Promise<HackerNewsThread>;
}

export interface CreateHackerNewsServerOptions {
  client?: HackerNewsClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface FetchHackerNewsClientOptions {
  apiBaseUrl?: string;
  searchBaseUrl?: string;
  fetch: typeof fetch;
}

const hnItemSchema = z.object({
  id: z.number().int().nonnegative(),
  type: z.string().optional(),
  title: z.string().optional(),
  url: z.string().optional(),
  by: z.string().optional(),
  score: z.number().int().nonnegative().optional(),
  descendants: z.number().int().nonnegative().optional(),
  time: z.number().int().nonnegative().optional(),
  text: z.string().optional(),
  kids: z.array(z.number().int().nonnegative()).optional(),
  deleted: z.boolean().optional(),
  dead: z.boolean().optional(),
});

const hnSearchResponseSchema = z.object({
  hits: z.array(
    z.object({
      objectID: z.string(),
      title: z.string().nullable().optional(),
      url: z.string().nullable().optional(),
      author: z.string().nullable().optional(),
      points: z.number().int().nonnegative().nullable().optional(),
      num_comments: z.number().int().nonnegative().nullable().optional(),
      created_at: z.string().nullable().optional(),
      story_text: z.string().nullable().optional(),
    }),
  ),
});

function isHnItem(value: z.infer<typeof hnItemSchema> | null): value is z.infer<typeof hnItemSchema> {
  return value !== null;
}

function resolveEnv(source: NodeJS.ProcessEnv = process.env): HackerNewsEnv {
  return loadEnv(envShape, source);
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toNullableTimestamp(value: number | undefined): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

class FetchHackerNewsClient implements HackerNewsClient {
  private readonly apiBaseUrl: string;
  private readonly searchBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FetchHackerNewsClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://hacker-news.firebaseio.com/v0").replace(/\/+$/, "");
    this.searchBaseUrl = (options.searchBaseUrl ?? "https://hn.algolia.com/api/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
  }

  public async getTopStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    const ids = await this.fetchJson(new URL(`${this.apiBaseUrl}/topstories.json`), z.array(z.number().int().nonnegative()));
    const items = await Promise.all(ids.slice(0, limit).map((id) => this.fetchItem(id)));

    return items
      .filter((item): item is z.infer<typeof hnItemSchema> => isHnItem(item) && item.type === "story")
      .map((item) => this.toStorySummary(item));
  }

  public async searchStories(input: { query: string; limit: number }): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    const url = new URL(`${this.searchBaseUrl}/search`);
    url.searchParams.set("tags", "story");
    url.searchParams.set("query", input.query);
    url.searchParams.set("hitsPerPage", String(input.limit));

    const payload = await this.fetchJson(url, hnSearchResponseSchema);

    return payload.hits.map((hit) => ({
      id: Number.parseInt(hit.objectID, 10),
      title: hit.title ?? "Untitled story",
      url: toNullableString(hit.url),
      author: toNullableString(hit.author),
      score: hit.points ?? null,
      commentCount: hit.num_comments ?? null,
      publishedAt: toNullableString(hit.created_at),
      text: toNullableString(hit.story_text),
    }));
  }

  public async getThread(input: { itemId: number; depth: number; maxChildren: number }): Promise<HackerNewsThread> {
    const root = await this.fetchItem(input.itemId);

    if (!root) {
      throw new ExternalServiceError(`Hacker News item ${input.itemId} was not found.`, { statusCode: 404 });
    }

    return {
      ...this.toStorySummary(root),
      replies: await this.fetchReplies(root.kids ?? [], input.depth, input.maxChildren),
    };
  }

  private async fetchReplies(
    ids: ReadonlyArray<number>,
    depth: number,
    maxChildren: number,
  ): Promise<ReadonlyArray<HackerNewsThreadComment>> {
    if (depth <= 0) {
      return [];
    }

    const children = await Promise.all(ids.slice(0, maxChildren).map((id) => this.fetchItem(id)));
    const comments = children.filter((item): item is z.infer<typeof hnItemSchema> => isHnItem(item) && item.type === "comment");

    return Promise.all(
      comments.map(async (comment) => ({
        id: comment.id,
        author: toNullableString(comment.by),
        text: toNullableString(comment.text),
        publishedAt: toNullableTimestamp(comment.time),
        replies: await this.fetchReplies(comment.kids ?? [], depth - 1, maxChildren),
      })),
    );
  }

  private toStorySummary(item: z.infer<typeof hnItemSchema>): HackerNewsStorySummary {
    return {
      id: item.id,
      title: item.title ?? "Untitled story",
      url: toNullableString(item.url),
      author: toNullableString(item.by),
      score: item.score ?? null,
      commentCount: item.descendants ?? null,
      publishedAt: toNullableTimestamp(item.time),
      text: toNullableString(item.text),
    };
  }

  private async fetchItem(id: number): Promise<z.infer<typeof hnItemSchema> | null> {
    const url = new URL(`${this.apiBaseUrl}/item/${id}.json`);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      throw new ExternalServiceError(`Hacker News request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: await response.text(),
      });
    }

    const payload: unknown = await response.json();
    if (payload === null) {
      return null;
    }

    const parsed = hnItemSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Hacker News item returned an unexpected response shape.", {
        details: parsed.error.flatten(),
      });
    }

    if (parsed.data.deleted || parsed.data.dead) {
      return null;
    }

    return parsed.data;
  }

  private async fetchJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: { accept: "application/json" },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalServiceError(`Hacker News request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: body,
      });
    }

    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Hacker News returned an unexpected response shape.", {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }
}

export class HackerNewsServer extends ToolkitServer {
  private readonly client: HackerNewsClient;

  public constructor(client: HackerNewsClient) {
    super(metadata);
    this.client = client;

    this.registerTool(
      defineTool({
        name: "get_top_stories",
        title: "Get top stories",
        description:
          "Fetch the current top Hacker News stories by reading the public Firebase `topstories` feed and hydrating the first `limit` item IDs. Use this when you want HN's live ranked front page; use `search_stories` for keyword lookup and `get_item_thread` for a single item with comments. This operation is read-only, idempotent, and requires no auth; it reflects HN's live ranking algorithm, and the server adds no extra rate limiting beyond the public HN API. `limit` is validated before the request is made, and out-of-range values are rejected; the returned list may be shorter if some IDs resolve to deleted, dead, missing, or non-story items.",
        inputSchema: {
          limit: z
            .number()
            .int()
            .min(1)
            .max(30)
            .default(10)
            .describe(
              "Number of top-ranked stories to return from the live `topstories` feed. Valid range is 1-30; the default is 10 when omitted. The server fetches the first N IDs from HN, so this controls both how many item lookups happen and the maximum number of stories returned. The final array can be shorter if some fetched IDs do not resolve to visible story items.",
            ),
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ limit }, context) => {
          await context.log("info", "Fetching top Hacker News stories");
          const stories = await this.client.getTopStories(limit);
          return {
            stories: [...stories],
            returned: stories.length,
          };
        },
        renderText: ({ stories }) => stories.map((story) => `${story.title} (${story.score ?? 0} points)`).join("
"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "search_stories",
        title: "Search stories",
        description:
          "Search Hacker News stories through the public Algolia search API. Use this when you need keyword or phrase matching; use `get_top_stories` for live front-page ranking and `get_item_thread` for one item's comment tree. This operation is read-only, idempotent, and requires no auth; it reads HN's public search index, and the server adds no extra rate limiting beyond the public HN API. `query` is trimmed and must be non-empty, `limit` is validated before the request is made, and invalid values are rejected by the schema.",
        inputSchema: {
          query: z
            .string()
            .trim()
            .min(1)
            .describe(
              "Search text sent to the HN Algolia index. This field is required, and the value is trimmed before use; empty or whitespace-only queries are rejected. Use this for keyword matching across story records, not for fetching a known item ID. Results are limited by `limit`.",
            ),
          limit: z
            .number()
            .int()
            .min(1)
            .max(30)
            .default(10)
            .describe(
              "Maximum number of matching stories to return from the Algolia search response. Valid range is 1-30; the default is 10 when omitted. This is forwarded as `hitsPerPage`, so it caps the number of hits returned for the provided `query`. A smaller value reduces the result set but does not change the search semantics.",
            ),
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ query, limit }, context) => {
          await context.log("info", `Searching Hacker News for ${query}`);
          const stories = await this.client.searchStories({ query, limit });
          return {
            stories: [...stories],
            returned: stories.length,
          };
        },
        renderText: ({ stories, returned }) => {
          if (returned === 0) {
            return "No matching Hacker News stories found.";
          }
          return stories.map((story) => `${story.title} by ${story.author ?? "unknown"}`).join("
");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_item_thread",
        title: "Get item thread",
        description:
          "Fetch a Hacker News item and recursively expand its comment thread from the public Firebase item API. Use this when you already have an `itemId` and want the item plus nested replies; use `get_top_stories` or `search_stories` to discover the item first. This operation is read-only, idempotent, and requires no auth; it reads current HN item data, and the server adds no extra rate limiting beyond the public HN API. `itemId` is required and must be a non-negative integer, `depth` controls reply recursion below the root, `maxChildren` caps how many child IDs are fetched at each level, and invalid values are rejected by the schema; if the root item does not exist, the upstream API error is surfaced.",
        inputSchema: {
          itemId: z
            .number()
            .int()
            .nonnegative()
            .describe(
              "Root HN item ID to fetch. This field is required and must be a non-negative integer. The server uses it to load the item from the public Firebase API before expanding replies. If the item is missing, the tool returns the upstream not-found error for that ID.",
            ),
          depth: z
            .number()
            .int()
            .min(1)
            .max(6)
            .default(2)
            .describe(
              "Maximum reply depth to fetch below the root item. Valid range is 1-6; the default is 2 when omitted. Each recursive level decrements this value, so `1` returns only top-level replies and larger values include deeper comment branches. This interacts with `maxChildren`, which still limits how many children are fetched at each level.",
            ),
          maxChildren: z
            .number()
            .int()
            .min(1)
            .max(50)
            .default(20)
            .describe(
              "Maximum number of child IDs to fetch per node at each recursion level. Valid range is 1-50; the default is 20 when omitted. This limit applies at the root and every nested comment, so it can truncate wide branches even when `depth` allows further expansion. Use a higher value to see more replies per comment, or a lower value to reduce fetch fan-out.",
            ),
        },
        outputSchema: {
          thread: threadSchema,
        },
        handler: async ({ itemId, depth, maxChildren }, context) => {
          await context.log("info", `Fetching Hacker News thread ${itemId}`);
          return {
            thread: await this.client.getThread({ itemId, depth, maxChildren }),
          };
        },
        renderText: ({ thread }) => `${thread.title} with ${thread.replies.length} top-level replies.`,
      }),
    );

    this.registerStaticResource(
      "trends",
      "hackernews://trends/top",
      {
        title: "Top story trend resource",
        description: "A quick snapshot of current top Hacker News stories.",
        mimeType: "application/json",
      },
      async (uri) =>
        this.createJsonResource(uri.toString(), {
          generatedAt: new Date().toISOString(),
          stories: await this.client.getTopStories(10),
        }),
    );

    this.registerPrompt(
      "community-digest",
      {
        title: "Community digest prompt",
        description: "Draft a digest of noteworthy Hacker News activity.",
        argsSchema: {
          theme: z.string().trim().min(1),
          audience: z.string().trim().min(1),
          storyCount: z.number().int().min(1).max(20).default(5),
        },
      },
      async ({ theme, audience, storyCount }) =>
        this.createTextPrompt(
          [
            `Prepare a Hacker News community digest for ${audience}.`,
            `Focus on the theme "${theme}" and summarize roughly ${storyCount} stories.`,
            "Highlight debates, notable launches, practical takeaways, and unresolved questions.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(options: CreateHackerNewsServerOptions = {}): Promise<HackerNewsServer> {
  if (options.client) {
    return new HackerNewsServer(options.client);
  }

  const env = resolveEnv(options.env);
  return new HackerNewsServer(
    new FetchHackerNewsClient({
      fetch: options.fetch ?? globalThis.fetch,
      ...(env.HACKERNEWS_API_BASE_URL ? { apiBaseUrl: env.HACKERNEWS_API_BASE_URL } : {}),
      ...(env.HACKERNEWS_SEARCH_BASE_URL ? { searchBaseUrl: env.HACKERNEWS_SEARCH_BASE_URL } : {}),
    }),
  );
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && fileURLToPath(metaUrl) === resolve(entry);
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);
  await runToolkitServer(
    {
      createServer: () => createServer(),
      serverCard,
    },
    runtimeOptions,
  );
}

if (isMainModule(import.meta.url)) {
  await main();
}
