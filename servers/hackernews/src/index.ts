import {
  createServerCard,
  defineTool,
  ExternalServiceError,
  loadEnv,
  parseRuntimeOptions,
  RateLimiter,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const toolNames = ["get_top_stories", "get_new_stories", "get_best_stories", "search_stories", "get_item_thread"] as const;
const resourceNames = ["trends"] as const;
const promptNames = ["community-digest"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "hackernews",
  title: "Hacker News MCP Server",
  description: "Read-only Hacker News tools for ranked story lists, keyword search, and discussion threads.",
  version: "0.2.0",
  packageName: "@universal-mcp-toolkit/server-hackernews",
  homepage: "https://github.com/Markgatcha/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/Markgatcha/universal-mcp-toolkit",
  documentationUrl: "https://github.com/Markgatcha/universal-mcp-toolkit/tree/main/servers/hackernews",
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
  getNewStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>>;
  getBestStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>>;
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
const hnNullableItemSchema = hnItemSchema.nullable();

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

const storyLimitSchema = z.number().int().min(1).max(30).default(10).describe(
  "Maximum number of stories to return. Defaults to 10; valid range is 1 to 30.",
);
const searchQuerySchema = z.string().trim().min(1).describe(
  "Keyword query for Algolia HN search (token-based matching, not exact phrase).",
);
const itemIdSchema = z.number().int().nonnegative().describe(
  "Hacker News item ID to fetch. Must be a nonnegative integer from HN item URLs or prior tool results.",
);
const depthSchema = z.number().int().min(1).max(6).default(2).describe(
  "Maximum reply nesting depth to expand. Defaults to 2; valid range is 1 to 6.",
);
const maxChildrenSchema = z.number().int().min(1).max(50).default(20).describe(
  "Maximum number of child comments fetched per item at each depth. Defaults to 20; valid range is 1 to 50.",
);

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
  private readonly rateLimiter = new RateLimiter({ requestsPerSecond: 10, burstLimit: 20 });
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly cacheTtlMs = 60_000;

  public constructor(options: FetchHackerNewsClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://hacker-news.firebaseio.com/v0").replace(/\/+$/, "");
    this.searchBaseUrl = (options.searchBaseUrl ?? "https://hn.algolia.com/api/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
  }

  public async getTopStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    return this.getStoryList("topstories", limit);
  }

  public async getNewStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    return this.getStoryList("newstories", limit);
  }

  public async getBestStories(limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    return this.getStoryList("beststories", limit);
  }

  private async getStoryList(endpoint: "topstories" | "newstories" | "beststories", limit: number): Promise<ReadonlyArray<HackerNewsStorySummary>> {
    const ids = await this.fetchJson(new URL(`${this.apiBaseUrl}/${endpoint}.json`), z.array(z.number().int().nonnegative()));
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
      throw new ExternalServiceError(`Hacker News item ${input.itemId} was not found.`, {
        statusCode: 404,
      });
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
  ): Promise<Array<HackerNewsThreadComment>> {
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
    const payload = await this.fetchJson(url, hnNullableItemSchema);
    if (payload === null) {
      return null;
    }

    if (payload.deleted || payload.dead) {
      return null;
    }

    return payload;
  }

  private async fetchJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    const cacheKey = url.toString();
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return schema.parse(cached.value);
    }

    await this.rateLimiter.acquire();

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
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

    this.cache.set(cacheKey, {
      expiresAt: Date.now() + this.cacheTtlMs,
      value: parsed.data,
    });

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
        description: `Hacker News front-page ranking: current top stories with summaries. Newest: get_new_stories. Best ranking: get_best_stories. Keyword lookup: search_stories. Comments on a known item: get_item_thread.`,
        inputSchema: {
          limit: storyLimitSchema,
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        annotations: { readOnlyHint: true },
        handler: async ({ limit }, context) => {
          await context.log("info", "Fetching top Hacker News stories");
          const stories = await this.client.getTopStories(limit);
          return {
            stories: [...stories],
            returned: stories.length,
          };
        },
        renderText: ({ stories }) => stories.map((story) => `${story.title} (${story.score ?? 0} points)`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_new_stories",
        title: "Get new stories",
        description: `Hacker News newest submissions in chronological order, with summaries. For the front-page ranking use get_top_stories, for the best ranking get_best_stories, for keyword lookup search_stories.`,
        inputSchema: {
          limit: storyLimitSchema,
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        annotations: { readOnlyHint: true },
        handler: async ({ limit }, context) => {
          await context.log("info", "Fetching new Hacker News stories");
          const stories = await this.client.getNewStories(limit);
          return {
            stories: [...stories],
            returned: stories.length,
          };
        },
        renderText: ({ stories }) => stories.map((story) => `${story.title} by ${story.author ?? "unknown"}`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_best_stories",
        title: "Get best stories",
        description: `Hacker News best-stories ranking with summaries. Front-page ranking: get_top_stories. Newest: get_new_stories. Keyword lookup: search_stories. Comments on a known item: get_item_thread.`,
        inputSchema: {
          limit: storyLimitSchema,
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        annotations: { readOnlyHint: true },
        handler: async ({ limit }, context) => {
          await context.log("info", "Fetching best Hacker News stories");
          const stories = await this.client.getBestStories(limit);
          return {
            stories: [...stories],
            returned: stories.length,
          };
        },
        renderText: ({ stories }) => stories.map((story) => `${story.title} (${story.score ?? 0} points)`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "search_stories",
        title: "Search stories",
        description: `Keyword search across Hacker News stories via Algolia (token-based matching, not exact phrase). For top/newest/best rankings use the story-list tools; for comments on a known item use get_item_thread.`,
        inputSchema: {
          query: searchQuerySchema,
          limit: storyLimitSchema,
        },
        outputSchema: {
          stories: z.array(storySummarySchema),
          returned: z.number().int(),
        },
        annotations: { readOnlyHint: true },
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
          return stories.map((story) => `${story.title} by ${story.author ?? "unknown"}`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_item_thread",
        title: "Get item thread",
        description: `Fetch one Hacker News item by numeric item ID with its nested comment tree. Requires a known item ID; for story lists use the ranking tools, for keyword lookup use search_stories.`,
        inputSchema: {
          itemId: itemIdSchema,
          depth: depthSchema,
          maxChildren: maxChildrenSchema,
        },
        outputSchema: {
          thread: threadSchema,
        },
        annotations: { readOnlyHint: true },
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
            `Focus on the theme \"${theme}\" and summarize roughly ${storyCount} stories.`,
            "Highlight debates, notable launches, practical takeaways, and unresolved questions.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(
  options: CreateHackerNewsServerOptions = {},
): Promise<HackerNewsServer> {
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
