import { pathToFileURL } from "node:url";
import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { Client, isFullDatabase, isFullPage } from "@notionhq/client";
import { z } from "zod";

const toolNames = [
  "notion_search",
  "notion_get_page",
  "notion_create_page",
  "notion_update_page",
  "notion_append_blocks",
  "notion_get_database",
  "notion_query_database",
  "notion_create_database_entry",
] as const;

const envShape = { NOTION_API_KEY: z.string().min(1, "NOTION_API_KEY is required") };

export const metadata: ToolkitServerMetadata = {
  id: "notion-mcp",
  title: "Notion MCP Server",
  description: "Full Notion workspace integration.",
  version: "1.2.0",
  packageName: "@contextcore/mcp-notion",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://developers.notion.com/reference",
  envVarNames: ["NOTION_API_KEY"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames: [],
  promptNames: [],
};

export const serverCard = createServerCard(metadata);

const pageSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string(),
  lastEditedTime: z.string(),
  archived: z.boolean(),
});

const propertyPreviewSchema = z.object({
  name: z.string(),
  type: z.string(),
  value: z.string(),
});

const databaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  url: z.string(),
  dataSourceCount: z.number().int().nonnegative(),
  dataSources: z.array(z.object({ id: z.string(), name: z.string() })),
});

interface LooseRichText {
  plain_text?: string;
}

interface LooseProperty {
  type: string;
  title?: LooseRichText[];
  rich_text?: LooseRichText[];
  [key: string]: unknown;
}

function plainText(items: readonly LooseRichText[] | undefined): string {
  return (items ?? []).map((item) => item.plain_text ?? "").join("").trim();
}

function extractPageTitle(properties: Record<string, unknown>): string {
  for (const value of Object.values(properties)) {
    const property = value as LooseProperty;
    if (property.type === "title") {
      return plainText(property.title);
    }
  }
  return "";
}

function summarizeProperty(name: string, value: unknown): z.infer<typeof propertyPreviewSchema> {
  const property = value as LooseProperty;
  let preview = "";
  switch (property.type) {
    case "title":
      preview = plainText(property.title);
      break;
    case "rich_text":
      preview = plainText(property.rich_text);
      break;
    case "number":
      preview = typeof property.number === "number" ? String(property.number) : "";
      break;
    case "checkbox":
      preview = typeof property.checkbox === "boolean" ? String(property.checkbox) : "";
      break;
    case "url":
      preview = typeof property.url === "string" ? property.url : "";
      break;
    case "select":
      preview = ((property.select as { name?: string } | null | undefined)?.name) ?? "";
      break;
    default:
      preview = "";
  }
  return { name, type: property.type, value: preview };
}

function toPageSummary(page: { id: string; url: string; last_edited_time: string; archived?: boolean; properties: Record<string, unknown> }): z.infer<typeof pageSummarySchema> {
  return {
    id: page.id,
    title: extractPageTitle(page.properties),
    url: page.url,
    lastEditedTime: page.last_edited_time,
    archived: page.archived ?? false,
  };
}

function toParagraphBlocks(markdown: string): Array<Record<string, unknown>> {
  return markdown
    .split(/\n{2,}/)
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => ({
      object: "block",
      type: "paragraph",
      paragraph: {
        rich_text: [{ type: "text", text: { content: chunk } }],
      },
    }));
}

function wrapNotionError(action: string, error: unknown): never {
  if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
    throw error;
  }
  const normalized = normalizeError(error);
  throw new ExternalServiceError(`Failed to ${action}. ${normalized.toClientMessage()}`, {
    details: normalized.details,
  });
}

export class NotionMcpServer extends ToolkitServer {
  private client: Client;

  constructor(apiKey: string, client?: Client) {
    super(metadata);
    this.client = client ?? new Client({ auth: apiKey });

    this.registerTool(
      defineTool({
        name: "notion_search",
        title: "Search Notion",
        description: "Search pages across the Notion workspace by title.",
        inputSchema: {
          query: z.string().default(""),
          pageSize: z.number().int().min(1).max(100).default(10),
          startCursor: z.string().optional(),
        },
        outputSchema: {
          results: z.array(pageSummarySchema),
          resultCount: z.number().int().nonnegative(),
          hasMore: z.boolean(),
          nextCursor: z.string().nullable(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Searching Notion for "${input.query}"`);
          try {
            const response = await this.client.search({
              query: input.query,
              page_size: input.pageSize,
              ...(input.startCursor ? { start_cursor: input.startCursor } : {}),
              filter: { property: "object", value: "page" },
            });
            const results = response.results.filter(isFullPage).map((page) =>
              toPageSummary({
                id: page.id,
                url: page.url,
                last_edited_time: page.last_edited_time,
                archived: page.archived,
                properties: page.properties as Record<string, unknown>,
              }),
            );
            return {
              results,
              resultCount: results.length,
              hasMore: response.has_more,
              nextCursor: response.next_cursor,
            };
          } catch (error) {
            wrapNotionError("search Notion", error);
          }
        },
        renderText: ({ resultCount, results }) =>
          resultCount === 0 ? "No Notion pages found." : results.map((page) => `${page.title} (${page.id})`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_get_page",
        title: "Get a Notion page",
        description: "Retrieve a Notion page's metadata and property values.",
        inputSchema: {
          pageId: z.string().trim().min(1),
        },
        outputSchema: {
          page: pageSummarySchema,
          properties: z.array(propertyPreviewSchema),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Retrieving Notion page ${input.pageId}`);
          try {
            const response = await this.client.pages.retrieve({ page_id: input.pageId });
            if (!isFullPage(response)) {
              throw new ValidationError(`Notion returned a partial page for '${input.pageId}'.`);
            }
            const properties = Object.entries(response.properties as Record<string, unknown>).map(([name, value]) =>
              summarizeProperty(name, value),
            );
            return {
              page: toPageSummary({
                id: response.id,
                url: response.url,
                last_edited_time: response.last_edited_time,
                archived: response.archived,
                properties: response.properties as Record<string, unknown>,
              }),
              properties,
            };
          } catch (error) {
            wrapNotionError("retrieve the Notion page", error);
          }
        },
        renderText: ({ page }) => `${page.title}\n${page.url}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_create_page",
        title: "Create a Notion page",
        description: "Create a new page under a parent page, optionally adding markdown content.",
        inputSchema: {
          parentPageId: z.string().trim().min(1),
          title: z.string().trim().min(1),
          contentMarkdown: z.string().optional(),
        },
        outputSchema: {
          page: pageSummarySchema,
        },
        handler: async (input, context) => {
          await context.log("info", `Creating Notion page "${input.title}"`);
          try {
            const response = await this.client.pages.create({
              parent: { type: "page_id", page_id: input.parentPageId },
              properties: {
                title: { title: [{ type: "text", text: { content: input.title } }] },
              },
              ...(input.contentMarkdown
                ? { children: toParagraphBlocks(input.contentMarkdown) as never }
                : {}),
            });
            if (!isFullPage(response)) {
              throw new ExternalServiceError("Notion returned a partial page after creation.");
            }
            return {
              page: toPageSummary({
                id: response.id,
                url: response.url,
                last_edited_time: response.last_edited_time,
                archived: response.archived,
                properties: response.properties as Record<string, unknown>,
              }),
            };
          } catch (error) {
            wrapNotionError("create the Notion page", error);
          }
        },
        renderText: ({ page }) => `Created page '${page.title}' (${page.url}).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_update_page",
        title: "Update a Notion page",
        description: "Archive, restore, or update the title of a Notion page.",
        inputSchema: {
          pageId: z.string().trim().min(1),
          title: z.string().trim().min(1).optional(),
          archived: z.boolean().optional(),
        },
        outputSchema: {
          page: pageSummarySchema,
        },
        handler: async (input, context) => {
          await context.log("info", `Updating Notion page ${input.pageId}`);
          try {
            const properties: Record<string, unknown> = {};
            if (input.title !== undefined) {
              properties.title = { title: [{ type: "text", text: { content: input.title } }] };
            }
            const response = await this.client.pages.update({
              page_id: input.pageId,
              ...(Object.keys(properties).length > 0 ? { properties: properties as never } : {}),
              ...(input.archived !== undefined ? { archived: input.archived } : {}),
            });
            if (!isFullPage(response)) {
              throw new ExternalServiceError("Notion returned a partial page after update.");
            }
            return {
              page: toPageSummary({
                id: response.id,
                url: response.url,
                last_edited_time: response.last_edited_time,
                archived: response.archived,
                properties: response.properties as Record<string, unknown>,
              }),
            };
          } catch (error) {
            wrapNotionError("update the Notion page", error);
          }
        },
        renderText: ({ page }) => `Updated page '${page.title}' (${page.url}).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_append_blocks",
        title: "Append blocks to a page",
        description: "Append markdown paragraphs as blocks to a Notion page or block.",
        inputSchema: {
          blockId: z.string().trim().min(1),
          markdown: z.string().trim().min(1),
        },
        outputSchema: {
          appendedCount: z.number().int().nonnegative(),
        },
        handler: async (input, context) => {
          await context.log("info", `Appending blocks to ${input.blockId}`);
          try {
            const children = toParagraphBlocks(input.markdown);
            const response = await this.client.blocks.children.append({
              block_id: input.blockId,
              children: children as never,
            });
            return { appendedCount: response.results.length };
          } catch (error) {
            wrapNotionError("append blocks", error);
          }
        },
        renderText: ({ appendedCount }) => `Appended ${appendedCount} block(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_get_database",
        title: "Get a Notion database",
        description: "Retrieve a Notion database's metadata and its data sources.",
        inputSchema: {
          databaseId: z.string().trim().min(1),
        },
        outputSchema: {
          database: databaseSummarySchema,
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Retrieving Notion database ${input.databaseId}`);
          try {
            const response = await this.client.databases.retrieve({ database_id: input.databaseId });
            if (!isFullDatabase(response)) {
              throw new ValidationError(`Notion returned a partial database for '${input.databaseId}'.`);
            }
            const dataSources = response.data_sources.map((dataSource) => ({
              id: dataSource.id,
              name: dataSource.name,
            }));
            return {
              database: {
                id: response.id,
                title: plainText(response.title as unknown as LooseRichText[]),
                description: plainText(response.description as unknown as LooseRichText[]),
                url: response.url,
                dataSourceCount: dataSources.length,
                dataSources,
              },
            };
          } catch (error) {
            wrapNotionError("retrieve the Notion database", error);
          }
        },
        renderText: ({ database }) => `${database.title || database.id}\n${database.url}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_query_database",
        title: "Query a Notion database",
        description: "Query rows from a Notion database via its first data source.",
        inputSchema: {
          databaseId: z.string().trim().min(1),
          pageSize: z.number().int().min(1).max(100).default(10),
          startCursor: z.string().optional(),
        },
        outputSchema: {
          results: z.array(pageSummarySchema),
          resultCount: z.number().int().nonnegative(),
          hasMore: z.boolean(),
          nextCursor: z.string().nullable(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Querying Notion database ${input.databaseId}`);
          try {
            const database = await this.client.databases.retrieve({ database_id: input.databaseId });
            if (!isFullDatabase(database) || database.data_sources.length === 0) {
              return { results: [], resultCount: 0, hasMore: false, nextCursor: null };
            }
            const dataSource = database.data_sources[0];
            if (!dataSource) {
              return { results: [], resultCount: 0, hasMore: false, nextCursor: null };
            }
            const response = await this.client.dataSources.query({
              data_source_id: dataSource.id,
              page_size: input.pageSize,
              ...(input.startCursor ? { start_cursor: input.startCursor } : {}),
            });
            const results = response.results.filter(isFullPage).map((page) =>
              toPageSummary({
                id: page.id,
                url: page.url,
                last_edited_time: page.last_edited_time,
                archived: page.archived,
                properties: page.properties as Record<string, unknown>,
              }),
            );
            return {
              results,
              resultCount: results.length,
              hasMore: response.has_more,
              nextCursor: response.next_cursor,
            };
          } catch (error) {
            wrapNotionError("query the Notion database", error);
          }
        },
        renderText: ({ resultCount }) => `Returned ${resultCount} row(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "notion_create_database_entry",
        title: "Create a database entry",
        description: "Create a new row (page) in a Notion database with a title and optional properties.",
        inputSchema: {
          databaseId: z.string().trim().min(1),
          title: z.string().trim().min(1),
          titlePropertyName: z.string().trim().min(1).default("Name"),
          properties: z.record(z.string(), z.unknown()).optional(),
        },
        outputSchema: {
          page: pageSummarySchema,
        },
        handler: async (input, context) => {
          await context.log("info", `Creating entry "${input.title}" in database ${input.databaseId}`);
          try {
            const properties: Record<string, unknown> = {
              ...(input.properties ?? {}),
              [input.titlePropertyName]: {
                title: [{ type: "text", text: { content: input.title } }],
              },
            };
            const response = await this.client.pages.create({
              parent: { type: "database_id", database_id: input.databaseId },
              properties: properties as never,
            });
            if (!isFullPage(response)) {
              throw new ExternalServiceError("Notion returned a partial page after creation.");
            }
            return {
              page: toPageSummary({
                id: response.id,
                url: response.url,
                last_edited_time: response.last_edited_time,
                archived: response.archived,
                properties: response.properties as Record<string, unknown>,
              }),
            };
          } catch (error) {
            wrapNotionError("create the database entry", error);
          }
        },
        renderText: ({ page }) => `Created entry '${page.title}' (${page.url}).`,
      }),
    );

    this.assertMetadataMatchesRegistrations();
  }

  private assertMetadataMatchesRegistrations(): void {
    const sortNames = (names: readonly string[]) => [...names].sort();
    if (JSON.stringify(sortNames(this.getToolNames())) !== JSON.stringify(sortNames(metadata.toolNames))) {
      throw new ConfigurationError("metadata.toolNames must match the registered tool names.", {
        expected: metadata.toolNames,
        actual: this.getToolNames(),
      });
    }
  }
}

export function createServer(): NotionMcpServer {
  const env = loadEnv(envShape);
  return new NotionMcpServer(env.NOTION_API_KEY);
}

export async function main(argv: string[]): Promise<void> {
  await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(normalizeError(e).toClientMessage());
    process.exit(1);
  });
}
