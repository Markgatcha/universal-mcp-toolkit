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
import { XMLParser } from "fast-xml-parser";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const toolNames = ["search_papers", "get_paper", "list_recent_papers"] as const;
const resourceNames = ["feed"] as const;
const promptNames = ["literature-review"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "arxiv",
  title: "arXiv MCP Server",
  description: "Paper search and feed tools for arXiv.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-arxiv",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/arxiv",
  envVarNames: [],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  ARXIV_API_BASE_URL: z.string().url().optional(),
  ARXIV_DEFAULT_CATEGORY: z.string().min(1).optional(),
};

type ArxivEnv = z.infer<z.ZodObject<typeof envShape>>;

const paperSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  authors: z.array(z.string()),
  categories: z.array(z.string()),
  primaryCategory: z.string().nullable(),
  publishedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  pdfUrl: z.string().nullable(),
  absUrl: z.string().nullable(),
});

export type ArxivPaper = z.infer<typeof paperSchema>;

export interface ArxivClient {
  searchPapers(input: { query: string; maxResults: number; sortBy: "relevance" | "submittedDate" | "lastUpdatedDate" }): Promise<ReadonlyArray<ArxivPaper>>;
  getPaper(paperId: string): Promise<ArxivPaper>;
  listRecentPapers(input: { category: string; maxResults: number }): Promise<ReadonlyArray<ArxivPaper>>;
}

export interface CreateArxivServerOptions {
  client?: ArxivClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface FetchArxivClientOptions {
  apiBaseUrl?: string;
  fetch: typeof fetch;
}

const authorNodeSchema = z.object({
  name: z.string(),
});

const linkNodeSchema = z.object({
  href: z.string().optional(),
  title: z.string().optional(),
  rel: z.string().optional(),
  type: z.string().optional(),
});

const categoryNodeSchema = z.object({
  term: z.string().optional(),
});

const entryNodeSchema = z.object({
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  published: z.string().optional(),
  updated: z.string().optional(),
  author: z.union([authorNodeSchema, z.array(authorNodeSchema)]).optional(),
  link: z.union([linkNodeSchema, z.array(linkNodeSchema)]).optional(),
  category: z.union([categoryNodeSchema, z.array(categoryNodeSchema)]).optional(),
  "arxiv:primary_category": categoryNodeSchema.optional(),
});

const feedSchema = z.object({
  feed: z.object({
    entry: z.union([entryNodeSchema, z.array(entryNodeSchema)]).optional(),
  }),
});

function resolveEnv(source: NodeJS.ProcessEnv = process.env): ArxivEnv {
  return loadEnv(envShape, source);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isReadonlyArray<T>(value: T | ReadonlyArray<T>): value is ReadonlyArray<T> {
  return Array.isArray(value);
}

function asArray<T>(value: T | ReadonlyArray<T> | undefined): Array<T> {
  if (value === undefined) {
    return [];
  }
  if (isReadonlyArray(value)) {
    return [...value];
  }
  return [value];
}

function extractPaperId(rawId: string): string {
  const match = /\/abs\/([^?]+)/.exec(rawId);
  return match?.[1] ?? rawId;
}

function getTemplateVariable(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

class FetchArxivClient implements ArxivClient {
  private readonly apiBaseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly parser: XMLParser;

  public constructor(options: FetchArxivClientOptions) {
    this.apiBaseUrl = (options.apiBaseUrl ?? "https://export.arxiv.org/api/query").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "",
      parseTagValue: false,
      trimValues: true,
    });
  }

  public async searchPapers(input: {
    query: string;
    maxResults: number;
    sortBy: "relevance" | "submittedDate" | "lastUpdatedDate";
  }): Promise<ReadonlyArray<ArxivPaper>> {
    return this.queryFeed({
      search_query: `all:${input.query}`,
      start: 0,
      max_results: input.maxResults,
      sortBy: input.sortBy,
      sortOrder: input.sortBy === "relevance" ? "descending" : "descending",
    });
  }

  public async getPaper(paperId: string): Promise<ArxivPaper> {
    const papers = await this.queryFeed({
      id_list: paperId,
      start: 0,
      max_results: 1,
    });
    const paper = papers[0];
    if (!paper) {
      throw new ExternalServiceError(`arXiv paper '${paperId}' was not found.`, {
        statusCode: 404,
      });
    }
    return paper;
  }

  public async listRecentPapers(input: { category: string; maxResults: number }): Promise<ReadonlyArray<ArxivPaper>> {
    return this.queryFeed({
      search_query: `cat:${input.category}`,
      start: 0,
      max_results: input.maxResults,
      sortBy: "submittedDate",
      sortOrder: "descending",
    });
  }

  private async queryFeed(params: Record<string, string | number>): Promise<ReadonlyArray<ArxivPaper>> {
    const url = new URL(this.apiBaseUrl);
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/atom+xml, application/xml;q=0.9, text/xml;q=0.8",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalServiceError(`arXiv request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: body,
      });
    }

    const xml = await response.text();
    const parsedXml: unknown = this.parser.parse(xml);
    const parsed = feedSchema.safeParse(parsedXml);
    if (!parsed.success) {
      throw new ExternalServiceError("arXiv returned an unexpected feed shape.", {
        details: parsed.error.flatten(),
      });
    }

    return asArray(parsed.data.feed.entry).map((entry) => this.toPaper(entry));
  }

  private toPaper(entry: z.infer<typeof entryNodeSchema>): ArxivPaper {
    const links = asArray(entry.link);
    const categories = asArray(entry.category)
      .map((category) => category.term)
      .filter((term): term is string => typeof term === "string" && term.length > 0);
    const pdfLink = links.find((link) => link.title === "pdf" || link.type === "application/pdf")?.href;
    const absLink = links.find((link) => link.rel === "alternate")?.href;

    return {
      id: extractPaperId(entry.id),
      title: normalizeWhitespace(entry.title),
      summary: normalizeWhitespace(entry.summary),
      authors: asArray(entry.author).map((author) => normalizeWhitespace(author.name)),
      categories,
      primaryCategory: toNullableString(entry["arxiv:primary_category"]?.term),
      publishedAt: toNullableString(entry.published),
      updatedAt: toNullableString(entry.updated),
      pdfUrl: toNullableString(pdfLink),
      absUrl: toNullableString(absLink ?? entry.id),
    };
  }
}

export class ArxivServer extends ToolkitServer {
  private readonly client: ArxivClient;
  private readonly defaultCategory: string;

  public constructor(client: ArxivClient, defaultCategory: string) {
    super(metadata);
    this.client = client;
    this.defaultCategory = defaultCategory;

    this.registerTool(
      defineTool({
        name: "search_papers",
        title: "Search arXiv papers",
        description: "Search arXiv papers by keyword or phrase.",
        inputSchema: {
          query: z.string().trim().min(1),
          maxResults: z.number().int().min(1).max(25).default(5),
          sortBy: z.enum(["relevance", "submittedDate", "lastUpdatedDate"]).default("relevance"),
        },
        outputSchema: {
          papers: z.array(paperSchema),
          returned: z.number().int(),
        },
        handler: async ({ query, maxResults, sortBy }, context) => {
          await context.log("info", `Searching arXiv for ${query}`);
          const papers = await this.client.searchPapers({ query, maxResults, sortBy });
          return {
            papers: [...papers],
            returned: papers.length,
          };
        },
        renderText: ({ papers, returned }) => {
          if (returned === 0) {
            return "No arXiv papers found.";
          }
          return papers.map((paper) => `${paper.id}: ${paper.title}`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_paper",
        title: "Get paper",
        description: "Fetch a specific arXiv paper by identifier.",
        inputSchema: {
          paperId: z.string().trim().min(1),
        },
        outputSchema: {
          paper: paperSchema,
        },
        handler: async ({ paperId }, context) => {
          await context.log("info", `Fetching arXiv paper ${paperId}`);
          return {
            paper: await this.client.getPaper(paperId),
          };
        },
        renderText: ({ paper }) => `${paper.id}: ${paper.title}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list_recent_papers",
        title: "List recent papers",
        description: "List the most recent papers for an arXiv category.",
        inputSchema: {
          category: z.string().trim().min(1).default(this.defaultCategory),
          maxResults: z.number().int().min(1).max(25).default(5),
        },
        outputSchema: {
          category: z.string(),
          papers: z.array(paperSchema),
          returned: z.number().int(),
        },
        handler: async ({ category, maxResults }, context) => {
          await context.log("info", `Listing recent arXiv papers for ${category}`);
          const papers = await this.client.listRecentPapers({ category, maxResults });
          return {
            category,
            papers: [...papers],
            returned: papers.length,
          };
        },
        renderText: ({ category, papers }) => `${category}: ${papers.map((paper) => paper.id).join(", ")}`,
      }),
    );

    this.registerTemplateResource(
      "feed",
      "arxiv://feed/{category}",
      {
        title: "arXiv feed",
        description: "Recent papers for an arXiv category.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const category = getTemplateVariable(variables, "category");
        return this.createJsonResource(uri.toString(), {
          category,
          papers: await this.client.listRecentPapers({ category, maxResults: 10 }),
        });
      },
    );

    this.registerPrompt(
      "literature-review",
      {
        title: "Literature review prompt",
        description: "Draft a literature review brief for an arXiv topic.",
        argsSchema: {
          topic: z.string().trim().min(1),
          category: z.string().trim().min(1).default(this.defaultCategory),
          focus: z.string().trim().min(1).optional(),
        },
      },
      async ({ topic, category, focus }) =>
        this.createTextPrompt(
          [
            `Prepare a literature review on \"${topic}\" using recent work from arXiv category ${category}.`,
            focus ? `Pay special attention to ${focus}.` : "Synthesize methods, datasets, evaluation gaps, and open questions.",
            "Separate foundational papers from the newest trends and identify promising follow-up reading.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(options: CreateArxivServerOptions = {}): Promise<ArxivServer> {
  if (options.client) {
    return new ArxivServer(options.client, resolveEnv(options.env).ARXIV_DEFAULT_CATEGORY ?? "cs.AI");
  }

  const env = resolveEnv(options.env);
  const client = new FetchArxivClient({
    fetch: options.fetch ?? globalThis.fetch,
    ...(env.ARXIV_API_BASE_URL ? { apiBaseUrl: env.ARXIV_API_BASE_URL } : {}),
  });

  return new ArxivServer(client, env.ARXIV_DEFAULT_CATEGORY ?? "cs.AI");
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
