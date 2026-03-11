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
import { z } from "zod";

const DEFAULT_NOTION_API_BASE_URL = "https://api.notion.com/v1";
const DEFAULT_NOTION_API_VERSION = "2026-03-11";
const WORKSPACE_RESOURCE_URI = "notion://workspace";

const notionToolNames = ["search-pages", "get-page", "create-page"] as const;
const notionResourceNames = ["workspace"] as const;
const notionPromptNames = ["summarize-doc"] as const;

const notionEnvShape = {
  NOTION_TOKEN: z.string().trim().min(1),
  NOTION_DEFAULT_PARENT_PAGE_ID: z.string().trim().min(1).optional(),
  NOTION_WORKSPACE_NAME: z.string().trim().min(1).optional(),
  NOTION_API_BASE_URL: z.string().url().default(DEFAULT_NOTION_API_BASE_URL),
  NOTION_API_VERSION: z.string().trim().min(1).default(DEFAULT_NOTION_API_VERSION),
};

const pageParentShape = {
  type: z.string(),
  pageId: z.string().nullable(),
  databaseId: z.string().nullable(),
  dataSourceId: z.string().nullable(),
  workspace: z.boolean(),
};

const pageSummaryShape = {
  id: z.string(),
  title: z.string(),
  url: z.string().url(),
  publicUrl: z.string().url().nullable(),
  createdTime: z.string(),
  lastEditedTime: z.string(),
  archived: z.boolean(),
  inTrash: z.boolean(),
  isLocked: z.boolean(),
  parent: z.object(pageParentShape),
};

const pagePropertyShape = {
  name: z.string(),
  type: z.string(),
  valuePreview: z.string().nullable(),
};

const pageContentBlockShape = {
  id: z.string(),
  type: z.string(),
  text: z.string(),
  hasChildren: z.boolean(),
};

const pageDetailShape = {
  ...pageSummaryShape,
  properties: z.array(z.object(pagePropertyShape)),
  propertyCount: z.number().int().nonnegative(),
  contentBlocks: z.array(z.object(pageContentBlockShape)),
  contentPreview: z.string(),
  hasMoreContent: z.boolean(),
  nextCursor: z.string().nullable(),
};

const workspaceResourceShape = {
  workspaceName: z.string().nullable(),
  integration: z.object({
    id: z.string(),
    name: z.string().nullable(),
    type: z.enum(["bot", "person"]),
    avatarUrl: z.string().nullable(),
  }),
  apiBaseUrl: z.string().url(),
  apiVersion: z.string(),
  defaultParentPageId: z.string().nullable(),
  recentPages: z.array(z.object(pageSummaryShape)),
};

const searchPagesInputShape = {
  query: z.string().trim().max(200).default(""),
  cursor: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(50).default(10),
  sortDirection: z.enum(["ascending", "descending"]).default("descending"),
};

const searchPagesOutputShape = {
  query: z.string(),
  resultCount: z.number().int().nonnegative(),
  nextCursor: z.string().nullable(),
  hasMore: z.boolean(),
  results: z.array(z.object(pageSummaryShape)),
};

const getPageInputShape = {
  pageId: z.string().trim().min(1).max(500),
  includeContent: z.boolean().default(true),
  contentLimit: z.number().int().min(1).max(100).default(10),
  cursor: z.string().trim().min(1).optional(),
};

const getPageOutputShape = {
  page: z.object(pageDetailShape),
};

const createPageInputShape = {
  title: z.string().trim().min(1).max(200),
  parentPageId: z.string().trim().min(1).max(500).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
};

const createPageOutputShape = {
  page: z.object(pageSummaryShape),
  usedParentPageId: z.string(),
  contentBlockCount: z.number().int().nonnegative(),
};

const summarizeDocPromptArgsShape = {
  pageId: z.string().trim().min(1).max(500),
  audience: z.string().trim().min(1).max(120).default("a general audience"),
  focus: z.string().trim().min(1).max(240).default("key ideas, decisions, action items, and risks"),
  contentLimit: z.number().int().min(1).max(20).default(8),
};

const notionRichTextSchema = z
  .object({
    plain_text: z.string().default(""),
  })
  .passthrough();

const notionDateSchema = z
  .object({
    start: z.string(),
    end: z.string().nullable().optional(),
  })
  .passthrough();

const notionParentSchema = z
  .object({
    type: z.string(),
    page_id: z.string().optional(),
    database_id: z.string().optional(),
    data_source_id: z.string().optional(),
    workspace: z.boolean().optional(),
  })
  .passthrough();

const notionPropertySchema = z
  .object({
    type: z.string(),
    title: z.array(notionRichTextSchema).optional(),
    rich_text: z.array(notionRichTextSchema).optional(),
    select: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    multi_select: z
      .array(
        z
          .object({
            name: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    status: z
      .object({
        name: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    checkbox: z.boolean().optional(),
    number: z.number().nullable().optional(),
    url: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone_number: z.string().nullable().optional(),
    date: notionDateSchema.nullable().optional(),
    people: z
      .array(
        z
          .object({
            id: z.string(),
            name: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .optional(),
    relation: z
      .array(
        z
          .object({
            id: z.string(),
          })
          .passthrough(),
      )
      .optional(),
    formula: z
      .object({
        type: z.string(),
        string: z.string().nullable().optional(),
        number: z.number().nullable().optional(),
        boolean: z.boolean().nullable().optional(),
        date: notionDateSchema.nullable().optional(),
      })
      .passthrough()
      .optional(),
    created_time: z.string().optional(),
    last_edited_time: z.string().optional(),
  })
  .passthrough();

const notionPageSchema = z
  .object({
    object: z.literal("page").optional(),
    id: z.string(),
    url: z.string().url(),
    public_url: z.string().url().nullable().optional(),
    created_time: z.string(),
    last_edited_time: z.string(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    is_locked: z.boolean().optional(),
    parent: notionParentSchema,
    properties: z.record(z.string(), notionPropertySchema),
  })
  .passthrough();

const notionSearchResponseSchema = z
  .object({
    results: z.array(notionPageSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .passthrough();

const notionBlockTextSchema = z
  .object({
    rich_text: z.array(notionRichTextSchema).default([]),
  })
  .passthrough();

const notionTitleOnlyBlockSchema = z
  .object({
    title: z.string().optional(),
  })
  .passthrough();

const notionBlockSchema = z
  .object({
    id: z.string(),
    type: z.string(),
    has_children: z.boolean().optional(),
    paragraph: notionBlockTextSchema.optional(),
    heading_1: notionBlockTextSchema.optional(),
    heading_2: notionBlockTextSchema.optional(),
    heading_3: notionBlockTextSchema.optional(),
    bulleted_list_item: notionBlockTextSchema.optional(),
    numbered_list_item: notionBlockTextSchema.optional(),
    quote: notionBlockTextSchema.optional(),
    to_do: notionBlockTextSchema.optional(),
    toggle: notionBlockTextSchema.optional(),
    callout: notionBlockTextSchema.optional(),
    code: notionBlockTextSchema.optional(),
    child_page: notionTitleOnlyBlockSchema.optional(),
    child_database: notionTitleOnlyBlockSchema.optional(),
  })
  .passthrough();

const notionBlockListResponseSchema = z
  .object({
    results: z.array(notionBlockSchema),
    next_cursor: z.string().nullable(),
    has_more: z.boolean(),
  })
  .passthrough();

const notionUserSchema = z
  .object({
    id: z.string(),
    name: z.string().nullable(),
    avatar_url: z.string().nullable().optional(),
    type: z.enum(["bot", "person"]),
    bot: z
      .object({
        workspace_name: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const notionErrorResponseSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().optional(),
    request_id: z.string().optional(),
    additional_data: z.unknown().optional(),
  })
  .passthrough();

const searchPagesInputSchema = z.object(searchPagesInputShape);
const searchPagesOutputSchema = z.object(searchPagesOutputShape);
const getPageInputSchema = z.object(getPageInputShape);
const getPageOutputSchema = z.object(getPageOutputShape);
const createPageInputSchema = z.object(createPageInputShape);
const createPageOutputSchema = z.object(createPageOutputShape);
const summarizeDocPromptArgsSchema = z.object(summarizeDocPromptArgsShape);
const workspaceResourceSchema = z.object(workspaceResourceShape);
const pageDetailSchema = z.object(pageDetailShape);

export type SearchPagesInput = z.infer<typeof searchPagesInputSchema>;
export type SearchPagesOutput = z.infer<typeof searchPagesOutputSchema>;
export type GetPageInput = z.infer<typeof getPageInputSchema>;
export type GetPageOutput = z.infer<typeof getPageOutputSchema>;
export type CreatePageInput = z.infer<typeof createPageInputSchema>;
export type CreatePageOutput = z.infer<typeof createPageOutputSchema>;
export type SummarizeDocPromptArgs = z.infer<typeof summarizeDocPromptArgsSchema>;
export type NotionPageSummary = z.infer<z.ZodObject<typeof pageSummaryShape>>;
export type NotionPageDetail = z.infer<typeof pageDetailSchema>;
export type NotionWorkspaceResource = z.infer<typeof workspaceResourceSchema>;

export interface NotionServerConfig {
  token: string;
  defaultParentPageId: string | null;
  workspaceName: string | null;
  apiBaseUrl: string;
  apiVersion: string;
}

export interface NotionCreatePageRequest {
  title: string;
  parentPageId: string;
  content?: string;
}

export interface NotionClientLike {
  searchPages(input: SearchPagesInput): Promise<SearchPagesOutput>;
  getPage(input: GetPageInput): Promise<NotionPageDetail>;
  createPage(input: NotionCreatePageRequest): Promise<CreatePageOutput>;
  getWorkspace(): Promise<NotionWorkspaceResource>;
}

export interface NotionApiClientOptions {
  config: NotionServerConfig;
  fetchImplementation?: typeof fetch;
}

interface NotionRequestOptions<TResponse> {
  method: "GET" | "POST";
  path: string;
  query?: Record<string, number | string | undefined>;
  body?: unknown;
  schema: z.ZodType<TResponse>;
}

interface ParsedErrorBody {
  readonly code: string | null;
  readonly message: string | null;
  readonly requestId: string | null;
  readonly additionalData: unknown;
  readonly rawBody: string | null;
}

interface NotionTextRequest {
  type: "text";
  text: {
    content: string;
  };
}

interface NotionParagraphBlockRequest {
  object: "block";
  type: "paragraph";
  paragraph: {
    rich_text: NotionTextRequest[];
  };
}

function loadNotionConfig(source: NodeJS.ProcessEnv = process.env): NotionServerConfig {
  const env = loadEnv(notionEnvShape, source);
  return {
    token: env.NOTION_TOKEN,
    defaultParentPageId: env.NOTION_DEFAULT_PARENT_PAGE_ID ?? null,
    workspaceName: env.NOTION_WORKSPACE_NAME ?? null,
    apiBaseUrl: env.NOTION_API_BASE_URL,
    apiVersion: env.NOTION_API_VERSION,
  };
}

function ensureRegisteredNames(kind: string, expected: readonly string[], actual: readonly string[]): void {
  const expectedSorted = [...expected].sort();
  const actualSorted = [...actual].sort();

  const matches =
    expectedSorted.length === actualSorted.length &&
    expectedSorted.every((name, index) => name === actualSorted[index]);

  if (!matches) {
    throw new ConfigurationError(
      `Metadata ${kind} names do not match the registered ${kind} names.`,
      {
        expected: expectedSorted,
        actual: actualSorted,
      },
    );
  }
}

function buildCanonicalNotionId(compactHex: string): string {
  return [
    compactHex.slice(0, 8),
    compactHex.slice(8, 12),
    compactHex.slice(12, 16),
    compactHex.slice(16, 20),
    compactHex.slice(20),
  ].join("-").toLowerCase();
}

function normalizeNotionId(value: string): string {
  const trimmed = value.trim();
  let candidate = trimmed;

  try {
    candidate = decodeURIComponent(new URL(trimmed).pathname);
  } catch {
    candidate = trimmed;
  }

  const matches = candidate.match(/[0-9a-fA-F]{32}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g);
  const matchedId = matches?.at(-1);

  if (!matchedId) {
    throw new ValidationError(`Expected a Notion page ID or URL, received '${value}'.`);
  }

  const compact = matchedId.replace(/-/g, "");
  if (!/^[0-9a-fA-F]{32}$/.test(compact)) {
    throw new ValidationError(`Expected a valid Notion page ID or URL, received '${value}'.`);
  }

  return buildCanonicalNotionId(compact);
}

function richTextToPlainText(items: readonly z.infer<typeof notionRichTextSchema>[]): string {
  return items.map((item) => item.plain_text).join("").trim();
}

function formatDateValue(dateValue: z.infer<typeof notionDateSchema> | null | undefined): string | null {
  if (!dateValue) {
    return null;
  }

  return dateValue.end ? `${dateValue.start} → ${dateValue.end}` : dateValue.start;
}

function summarizeFormulaValue(formula: z.infer<NonNullable<typeof notionPropertySchema.shape.formula>> | undefined): string | null {
  if (!formula) {
    return null;
  }

  switch (formula.type) {
    case "string":
      return formula.string ?? null;
    case "number":
      return formula.number === null || formula.number === undefined ? null : String(formula.number);
    case "boolean":
      return formula.boolean === null || formula.boolean === undefined ? null : String(formula.boolean);
    case "date":
      return formatDateValue(formula.date);
    default:
      return null;
  }
}

function summarizePropertyValue(property: z.infer<typeof notionPropertySchema>): string | null {
  switch (property.type) {
    case "title":
      return richTextToPlainText(property.title ?? []) || null;
    case "rich_text":
      return richTextToPlainText(property.rich_text ?? []) || null;
    case "select":
      return property.select?.name ?? null;
    case "multi_select":
      return property.multi_select && property.multi_select.length > 0
        ? property.multi_select.map((item) => item.name).join(", ")
        : null;
    case "status":
      return property.status?.name ?? null;
    case "checkbox":
      return property.checkbox === undefined ? null : String(property.checkbox);
    case "number":
      return property.number === null || property.number === undefined ? null : String(property.number);
    case "url":
      return property.url ?? null;
    case "email":
      return property.email ?? null;
    case "phone_number":
      return property.phone_number ?? null;
    case "date":
      return formatDateValue(property.date);
    case "people":
      return property.people && property.people.length > 0
        ? property.people.map((person) => person.name ?? person.id).join(", ")
        : null;
    case "relation":
      return property.relation && property.relation.length > 0
        ? property.relation.map((item) => item.id).join(", ")
        : null;
    case "formula":
      return summarizeFormulaValue(property.formula);
    case "created_time":
      return property.created_time ?? null;
    case "last_edited_time":
      return property.last_edited_time ?? null;
    default:
      return null;
  }
}

function extractPageTitle(properties: Record<string, z.infer<typeof notionPropertySchema>>): string {
  for (const property of Object.values(properties)) {
    if (property.type !== "title") {
      continue;
    }

    const title = richTextToPlainText(property.title ?? []);
    if (title.length > 0) {
      return title;
    }
  }

  return "Untitled";
}

function normalizeParent(parent: z.infer<typeof notionParentSchema>): z.infer<z.ZodObject<typeof pageParentShape>> {
  return {
    type: parent.type,
    pageId: parent.page_id ?? null,
    databaseId: parent.database_id ?? null,
    dataSourceId: parent.data_source_id ?? null,
    workspace: parent.workspace ?? false,
  };
}

function normalizePageSummary(page: z.infer<typeof notionPageSchema>): NotionPageSummary {
  return {
    id: page.id,
    title: extractPageTitle(page.properties),
    url: page.url,
    publicUrl: page.public_url ?? null,
    createdTime: page.created_time,
    lastEditedTime: page.last_edited_time,
    archived: page.archived ?? page.in_trash ?? false,
    inTrash: page.in_trash ?? page.archived ?? false,
    isLocked: page.is_locked ?? false,
    parent: normalizeParent(page.parent),
  };
}

function extractBlockText(block: z.infer<typeof notionBlockSchema>): string {
  switch (block.type) {
    case "paragraph":
      return richTextToPlainText(block.paragraph?.rich_text ?? []);
    case "heading_1":
      return richTextToPlainText(block.heading_1?.rich_text ?? []);
    case "heading_2":
      return richTextToPlainText(block.heading_2?.rich_text ?? []);
    case "heading_3":
      return richTextToPlainText(block.heading_3?.rich_text ?? []);
    case "bulleted_list_item":
      return richTextToPlainText(block.bulleted_list_item?.rich_text ?? []);
    case "numbered_list_item":
      return richTextToPlainText(block.numbered_list_item?.rich_text ?? []);
    case "quote":
      return richTextToPlainText(block.quote?.rich_text ?? []);
    case "to_do":
      return richTextToPlainText(block.to_do?.rich_text ?? []);
    case "toggle":
      return richTextToPlainText(block.toggle?.rich_text ?? []);
    case "callout":
      return richTextToPlainText(block.callout?.rich_text ?? []);
    case "code":
      return richTextToPlainText(block.code?.rich_text ?? []);
    case "child_page":
      return block.child_page?.title ?? "";
    case "child_database":
      return block.child_database?.title ?? "";
    default:
      return "";
  }
}

function normalizeContentBlocks(blocks: readonly z.infer<typeof notionBlockSchema>[]): z.infer<
  z.ZodArray<z.ZodObject<typeof pageContentBlockShape>>
> {
  return blocks.map((block) => ({
    id: block.id,
    type: block.type,
    text: extractBlockText(block),
    hasChildren: block.has_children ?? false,
  }));
}

function buildContentPreview(
  blocks: ReadonlyArray<z.infer<z.ZodObject<typeof pageContentBlockShape>>>,
): string {
  return blocks
    .map((block) => block.text)
    .filter((text) => text.length > 0)
    .join("\n")
    .slice(0, 4_000);
}

function chunkParagraph(paragraph: string, maxLength = 1_800): string[] {
  if (paragraph.length <= maxLength) {
    return [paragraph];
  }

  const chunks: string[] = [];
  let remaining = paragraph;

  while (remaining.length > maxLength) {
    let breakIndex = remaining.lastIndexOf(" ", maxLength);
    if (breakIndex <= 0) {
      breakIndex = maxLength;
    }

    chunks.push(remaining.slice(0, breakIndex).trim());
    remaining = remaining.slice(breakIndex).trimStart();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

function buildParagraphBlocks(content: string | undefined): readonly NotionParagraphBlockRequest[] {
  if (!content) {
    return [];
  }

  const paragraphs = content
    .split(/\r?\n\s*\r?\n/g)
    .map((paragraph) => paragraph.replace(/\r?\n/g, " ").trim())
    .filter((paragraph) => paragraph.length > 0);

  const blocks: NotionParagraphBlockRequest[] = [];

  for (const paragraph of paragraphs) {
    for (const chunk of chunkParagraph(paragraph)) {
      if (blocks.length >= 100) {
        return blocks;
      }

      blocks.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: [
            {
              type: "text",
              text: {
                content: chunk,
              },
            },
          ],
        },
      });
    }
  }

  return blocks;
}

function formatSearchPagesText(output: SearchPagesOutput): string {
  if (output.results.length === 0) {
    return output.query.length > 0
      ? `No Notion pages matched '${output.query}'.`
      : "No Notion pages are currently visible to the integration.";
  }

  return [
    `Found ${output.resultCount} Notion page${output.resultCount === 1 ? "" : "s"}${output.query ? ` for '${output.query}'` : ""}.`,
    ...output.results.slice(0, 5).map((page, index) => `${index + 1}. ${page.title} (${page.id})`),
  ].join("\n");
}

function formatPageDetailText(page: NotionPageDetail): string {
  const preview = page.contentPreview.length > 0 ? `\n\nPreview:\n${page.contentPreview}` : "";
  return `${page.title}\n${page.url}${preview}`;
}

function formatCreatePageText(output: CreatePageOutput): string {
  return `Created Notion page '${output.page.title}' (${output.page.url}) under parent ${output.usedParentPageId}.`;
}

function buildOperationError(action: string, error: unknown): Error {
  if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
    return error;
  }

  const normalized = normalizeError(error);
  return new ExternalServiceError(`Failed to ${action}. ${normalized.toClientMessage()}`, {
    statusCode: normalized.statusCode,
    details: normalized.details,
  });
}

function messageWithDetails(prefix: string, details: ParsedErrorBody): string {
  return details.message ? `${prefix} ${details.message}` : prefix;
}

async function parseErrorBody(response: Response): Promise<ParsedErrorBody> {
  const rawBody = await response.text();
  if (rawBody.length === 0) {
    return {
      code: null,
      message: null,
      requestId: response.headers.get("x-request-id"),
      additionalData: null,
      rawBody: null,
    };
  }

  const parsedJson: unknown = (() => {
    try {
      return JSON.parse(rawBody);
    } catch {
      return null;
    }
  })();

  const parsed = notionErrorResponseSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      code: null,
      message: rawBody.trim() || null,
      requestId: response.headers.get("x-request-id"),
      additionalData: null,
      rawBody,
    };
  }

  return {
    code: parsed.data.code ?? null,
    message: parsed.data.message?.trim() || null,
    requestId: parsed.data.request_id ?? response.headers.get("x-request-id"),
    additionalData: parsed.data.additional_data ?? null,
    rawBody,
  };
}

async function mapHttpError(response: Response): Promise<ExternalServiceError | ValidationError> {
  const details = await parseErrorBody(response);
  const errorDetails = {
    status: response.status,
    code: details.code,
    requestId: details.requestId,
    retryAfter: response.headers.get("retry-after"),
    additionalData: details.additionalData,
    rawBody: details.rawBody,
  };

  switch (response.status) {
    case 400:
      return new ValidationError(
        messageWithDetails(
          "Notion rejected the request. Check the supplied identifiers, filters, and page payload.",
          details,
        ),
        errorDetails,
      );
    case 401:
      return new ExternalServiceError(
        messageWithDetails("Notion authentication failed. Check NOTION_TOKEN.", details),
        {
          statusCode: 401,
          details: errorDetails,
        },
      );
    case 403:
      return new ExternalServiceError(
        messageWithDetails(
          "The Notion integration does not have access to this resource. Share it with the integration and try again.",
          details,
        ),
        {
          statusCode: 403,
          details: errorDetails,
        },
      );
    case 404:
      return new ExternalServiceError(
        messageWithDetails(
          "Notion could not find the requested resource, or the integration cannot access it.",
          details,
        ),
        {
          statusCode: 404,
          details: errorDetails,
        },
      );
    case 409:
      return new ExternalServiceError(
        messageWithDetails("Notion reported a conflict while saving the request. Retry with fresh data.", details),
        {
          statusCode: 409,
          details: errorDetails,
        },
      );
    case 429:
      return new ExternalServiceError(
        messageWithDetails("Notion rate limited the request. Slow down and retry shortly.", details),
        {
          statusCode: 429,
          details: errorDetails,
        },
      );
    case 500:
    case 502:
    case 503:
    case 504:
      return new ExternalServiceError(
        messageWithDetails("Notion is temporarily unavailable. Please retry in a moment.", details),
        {
          statusCode: response.status,
          details: errorDetails,
        },
      );
    default:
      return new ExternalServiceError(
        messageWithDetails(`Notion request failed with status ${response.status}.`, details),
        {
          statusCode: response.status,
          details: errorDetails,
        },
      );
  }
}

export class NotionApiClient implements NotionClientLike {
  private readonly config: NotionServerConfig;
  private readonly fetchImplementation: typeof fetch;
  private readonly baseUrl: string;

  public constructor(options: NotionApiClientOptions) {
    this.config = options.config;
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.baseUrl = options.config.apiBaseUrl.replace(/\/+$/, "");
  }

  public async searchPages(input: SearchPagesInput): Promise<SearchPagesOutput> {
    const response = await this.requestJson({
      method: "POST",
      path: "/search",
      body: {
        query: input.query.length > 0 ? input.query : undefined,
        filter: {
          property: "object",
          value: "page",
        },
        sort: {
          timestamp: "last_edited_time",
          direction: input.sortDirection,
        },
        page_size: input.limit,
        start_cursor: input.cursor,
      },
      schema: notionSearchResponseSchema,
    });

    const results = response.results.map((page) => normalizePageSummary(page));
    return {
      query: input.query,
      resultCount: results.length,
      nextCursor: response.next_cursor,
      hasMore: response.has_more,
      results,
    };
  }

  public async getPage(input: GetPageInput): Promise<NotionPageDetail> {
    const page = await this.requestJson({
      method: "GET",
      path: `/pages/${encodeURIComponent(input.pageId)}`,
      schema: notionPageSchema,
    });

    let contentBlocks: z.infer<z.ZodArray<z.ZodObject<typeof pageContentBlockShape>>> = [];
    let hasMoreContent = false;
    let nextCursor: string | null = null;

    if (input.includeContent) {
      const blocks = await this.requestJson({
        method: "GET",
        path: `/blocks/${encodeURIComponent(input.pageId)}/children`,
        query: {
          page_size: input.contentLimit,
          start_cursor: input.cursor,
        },
        schema: notionBlockListResponseSchema,
      });

      contentBlocks = normalizeContentBlocks(blocks.results);
      hasMoreContent = blocks.has_more;
      nextCursor = blocks.next_cursor;
    }

    const properties = Object.entries(page.properties).map(([name, property]) => ({
      name,
      type: property.type,
      valuePreview: summarizePropertyValue(property),
    }));

    return {
      ...normalizePageSummary(page),
      properties,
      propertyCount: properties.length,
      contentBlocks,
      contentPreview: buildContentPreview(contentBlocks),
      hasMoreContent,
      nextCursor,
    };
  }

  public async createPage(input: NotionCreatePageRequest): Promise<CreatePageOutput> {
    const children = buildParagraphBlocks(input.content);

    const page = await this.requestJson({
      method: "POST",
      path: "/pages",
      body: {
        parent: {
          type: "page_id",
          page_id: input.parentPageId,
        },
        properties: {
          title: {
            type: "title",
            title: [
              {
                type: "text",
                text: {
                  content: input.title,
                },
              },
            ],
          },
        },
        children: children.length > 0 ? children : undefined,
      },
      schema: notionPageSchema,
    });

    return {
      page: normalizePageSummary(page),
      usedParentPageId: input.parentPageId,
      contentBlockCount: children.length,
    };
  }

  public async getWorkspace(): Promise<NotionWorkspaceResource> {
    const user = await this.requestJson({
      method: "GET",
      path: "/users/me",
      schema: notionUserSchema,
    });

    const recentPages = await this.searchPages({
      query: "",
      limit: 5,
      sortDirection: "descending",
    });

    return {
      workspaceName: this.config.workspaceName ?? user.bot?.workspace_name ?? null,
      integration: {
        id: user.id,
        name: user.name ?? null,
        type: user.type,
        avatarUrl: user.avatar_url ?? null,
      },
      apiBaseUrl: this.config.apiBaseUrl,
      apiVersion: this.config.apiVersion,
      defaultParentPageId: this.config.defaultParentPageId,
      recentPages: recentPages.results,
    };
  }

  private buildUrl(path: string, query?: Record<string, number | string | undefined>): URL {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    return url;
  }

  private async requestJson<TResponse>(options: NotionRequestOptions<TResponse>): Promise<TResponse> {
    const url = this.buildUrl(options.path, options.query);
    const headers = new Headers({
      Authorization: `Bearer ${this.config.token}`,
      Accept: "application/json",
      "Notion-Version": this.config.apiVersion,
    });

    const requestInit: RequestInit = {
      method: options.method,
      headers,
    };

    if (options.body !== undefined) {
      headers.set("content-type", "application/json");
      requestInit.body = JSON.stringify(options.body);
    }

    let response: Response;
    try {
      response = await this.fetchImplementation(url.toString(), requestInit);
    } catch (error) {
      throw new ExternalServiceError("Failed to reach the Notion API. Check connectivity and NOTION_API_BASE_URL.", {
        details: error instanceof Error ? error.message : error,
      });
    }

    if (!response.ok) {
      throw await mapHttpError(response);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new ExternalServiceError("Notion returned malformed JSON.", {
        details: error instanceof Error ? error.message : error,
      });
    }

    const parsed = options.schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Notion returned a response that failed schema validation.", {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }
}

export const metadata: ToolkitServerMetadata = {
  id: "notion",
  title: "Notion MCP Server",
  description: "Search Notion pages, inspect page metadata and content, create new pages, expose workspace context, and generate summary prompts.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-notion",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://developers.notion.com/reference/intro",
  envVarNames: ["NOTION_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames: notionToolNames,
  resourceNames: notionResourceNames,
  promptNames: notionPromptNames,
};

export const serverCard = createServerCard(metadata);

export interface NotionServerDependencies {
  config: NotionServerConfig;
  client: NotionClientLike;
}

export interface NotionServerFactoryOptions {
  config?: NotionServerConfig;
  envSource?: NodeJS.ProcessEnv;
  client?: NotionClientLike;
  fetchImplementation?: typeof fetch;
}

export class NotionServer extends ToolkitServer {
  private readonly config: NotionServerConfig;
  private readonly client: NotionClientLike;

  public constructor(dependencies: NotionServerDependencies) {
    super(metadata);
    this.config = dependencies.config;
    this.client = dependencies.client;

    this.registerTool(
      defineTool({
        name: "search-pages",
        title: "Search pages",
        description: "Search Notion pages by title and indexed content with cursor-based pagination.",
        annotations: {
          title: "Search Notion pages",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: searchPagesInputShape,
        outputSchema: searchPagesOutputShape,
        handler: async (input, context) => {
          await context.log("debug", `Searching Notion pages for '${input.query}'.`);

          try {
            return await this.client.searchPages(input);
          } catch (error) {
            throw buildOperationError(`search Notion pages for '${input.query}'`, error);
          }
        },
        renderText: formatSearchPagesText,
      }),
    );

    this.registerTool(
      defineTool({
        name: "get-page",
        title: "Get page",
        description: "Retrieve a Notion page, its properties, and an optional excerpt of top-level content blocks.",
        annotations: {
          title: "Get a Notion page",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
        inputSchema: getPageInputShape,
        outputSchema: getPageOutputShape,
        handler: async (input, context) => {
          const normalizedInput: GetPageInput = {
            ...input,
            pageId: normalizeNotionId(input.pageId),
          };

          await context.log("debug", `Fetching Notion page ${normalizedInput.pageId}.`);

          try {
            return {
              page: await this.client.getPage(normalizedInput),
            };
          } catch (error) {
            throw buildOperationError(`fetch Notion page ${normalizedInput.pageId}`, error);
          }
        },
        renderText: (output) => formatPageDetailText(output.page),
      }),
    );

    this.registerTool(
      defineTool({
        name: "create-page",
        title: "Create page",
        description: "Create a child page under a Notion parent page using env-based authentication and optional default parent fallback.",
        annotations: {
          title: "Create a Notion page",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
        inputSchema: createPageInputShape,
        outputSchema: createPageOutputShape,
        handler: async (input, context) => {
          const parentPageId = input.parentPageId
            ? normalizeNotionId(input.parentPageId)
            : this.config.defaultParentPageId;

          if (!parentPageId) {
            throw new ValidationError(
              "Provide parentPageId or configure NOTION_DEFAULT_PARENT_PAGE_ID before creating a Notion page.",
            );
          }

          await context.log("debug", `Creating Notion page '${input.title}' under ${parentPageId}.`);

          try {
            const createRequest: NotionCreatePageRequest = input.content
              ? {
                  title: input.title,
                  parentPageId,
                  content: input.content,
                }
              : {
                  title: input.title,
                  parentPageId,
                };

            return await this.client.createPage(createRequest);
          } catch (error) {
            throw buildOperationError(`create Notion page '${input.title}'`, error);
          }
        },
        renderText: formatCreatePageText,
      }),
    );

    this.registerStaticResource(
      "workspace",
      WORKSPACE_RESOURCE_URI,
      {
        title: "Notion workspace",
        description: "Workspace context, integration identity, configuration, and a sample of recent pages.",
        mimeType: "application/json",
      },
      async (uri) => this.readWorkspaceResource(uri),
    );

    this.registerPrompt(
      "summarize-doc",
      {
        title: "Summarize document",
        description: "Build a summarization prompt around a specific Notion page and its latest content excerpt.",
        argsSchema: summarizeDocPromptArgsShape,
      },
      async (args) => this.buildSummarizeDocPrompt(args),
    );

    ensureRegisteredNames("tool", metadata.toolNames, this.getToolNames());
    ensureRegisteredNames("resource", metadata.resourceNames, this.getResourceNames());
    ensureRegisteredNames("prompt", metadata.promptNames, this.getPromptNames());
  }

  public async readWorkspaceResource(uri: URL = new URL(WORKSPACE_RESOURCE_URI)) {
    try {
      const payload = workspaceResourceSchema.parse(await this.client.getWorkspace());
      return this.createJsonResource(uri.toString(), payload);
    } catch (error) {
      throw buildOperationError("load Notion workspace context", error);
    }
  }

  public async buildSummarizeDocPrompt(args: SummarizeDocPromptArgs) {
    const parsedArgs = summarizeDocPromptArgsSchema.parse(args);
    const normalizedPageId = normalizeNotionId(parsedArgs.pageId);

    try {
      const page = await this.client.getPage({
        pageId: normalizedPageId,
        includeContent: true,
        contentLimit: parsedArgs.contentLimit,
      });

      const truncationNote = page.hasMoreContent
        ? `Only the first ${page.contentBlocks.length} top-level blocks are included here. Call get-page with cursor '${page.nextCursor ?? ""}' if you need more context.`
        : "The included excerpt covers all requested top-level blocks.";

      return {
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: [
                `Summarize the following Notion document for ${parsedArgs.audience}.`,
                `Focus on: ${parsedArgs.focus}.`,
                "Use a concise executive summary followed by bullet points for notable decisions, risks, and next actions.",
                truncationNote,
                "",
                "Source document payload:",
                JSON.stringify(page, null, 2),
              ].join("\n"),
            },
          },
        ],
      };
    } catch (error) {
      throw buildOperationError(`prepare a summarize-doc prompt for page ${normalizedPageId}`, error);
    }
  }
}

export function createServer(options: NotionServerFactoryOptions = {}): NotionServer {
  const config = options.config ?? loadNotionConfig(options.envSource);
  const client =
    options.client ??
    new NotionApiClient(
      options.fetchImplementation
        ? {
            config,
            fetchImplementation: options.fetchImplementation,
          }
        : {
            config,
          },
    );

  return new NotionServer({
    config,
    client,
  });
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const runtimeOptions = parseRuntimeOptions(argv);
  await runToolkitServer(
    {
      serverCard,
      createServer,
    },
    runtimeOptions,
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  void main().catch((error) => {
    const normalized = normalizeError(error);
    console.error(normalized.toClientMessage());
    process.exitCode = 1;
  });
}
