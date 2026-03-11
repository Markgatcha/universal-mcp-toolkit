import { pathToFileURL } from "node:url";

import {
  HttpServiceClient,
  ToolkitServer,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const TOOL_NAMES = ["search-files", "get-file-metadata", "export-file"] as const;
const RESOURCE_NAMES = ["drive-overview"] as const;
const PROMPT_NAMES = ["summarize-doc"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "google-drive",
  title: "Google Drive MCP Server",
  description: "File discovery, metadata inspection, export, and summarization tools for Google Drive.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-google-drive",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  envVarNames: ["GOOGLE_DRIVE_ACCESS_TOKEN"],
  transports: ["stdio", "sse"],
  toolNames: TOOL_NAMES,
  resourceNames: RESOURCE_NAMES,
  promptNames: PROMPT_NAMES,
};

export const serverCard = createServerCard(metadata);

const nonEmptyString = z.string().trim().min(1);

const googleDriveEnvShape = {
  GOOGLE_DRIVE_ACCESS_TOKEN: nonEmptyString,
  GOOGLE_DRIVE_BASE_URL: z.string().url().default("https://www.googleapis.com/drive/v3"),
} satisfies z.ZodRawShape;

type GoogleDriveEnv = z.infer<z.ZodObject<typeof googleDriveEnvShape>>;

export interface GoogleDriveConfig {
  accessToken: string;
  baseUrl: string;
}

const driveFileShape = {
  id: z.string(),
  name: z.string(),
  mimeType: z.string(),
  description: z.string().nullable(),
  createdTime: z.string().nullable(),
  modifiedTime: z.string().nullable(),
  sizeBytes: z.string().nullable(),
  webViewLink: z.string().nullable(),
  iconLink: z.string().nullable(),
  ownerNames: z.array(z.string()),
  ownerEmails: z.array(z.string()),
  parents: z.array(z.string()),
  driveId: z.string().nullable(),
} satisfies z.ZodRawShape;

const driveFileSchema = z.object(driveFileShape);
export type GoogleDriveFile = z.infer<typeof driveFileSchema>;

const searchFilesOutputShape = {
  query: z.string().nullable(),
  pageSize: z.number().int().positive(),
  nextPageToken: z.string().nullable(),
  files: z.array(z.object(driveFileShape)),
} satisfies z.ZodRawShape;

const searchFilesOutputSchema = z.object(searchFilesOutputShape);
export type GoogleDriveSearchFilesOutput = z.infer<typeof searchFilesOutputSchema>;

const getFileMetadataOutputShape = {
  file: z.object(driveFileShape),
} satisfies z.ZodRawShape;

const getFileMetadataOutputSchema = z.object(getFileMetadataOutputShape);
export type GoogleDriveFileMetadataOutput = z.infer<typeof getFileMetadataOutputSchema>;

const exportFileOutputShape = {
  fileId: z.string(),
  fileName: z.string().nullable(),
  mimeType: z.string(),
  contentType: z.enum(["text", "base64"]),
  byteLength: z.number().int().nonnegative(),
  textContent: z.string().nullable(),
  base64Content: z.string().nullable(),
} satisfies z.ZodRawShape;

const exportFileOutputSchema = z.object(exportFileOutputShape);
export type GoogleDriveExportFileOutput = z.infer<typeof exportFileOutputSchema>;

interface GoogleDriveOverview {
  generatedAt: string;
  user: {
    displayName: string | null;
    email: string | null;
    permissionId: string | null;
  };
  storageQuota: {
    limitBytes: string | null;
    usageBytes: string | null;
    trashBytes: string | null;
  };
  importFormats: Record<string, string[]>;
  exportFormats: Record<string, string[]>;
}

export interface GoogleDriveClient {
  searchFiles(input: {
    query?: string;
    mimeType?: string;
    pageSize: number;
    pageToken?: string;
    orderBy: "modifiedTime desc" | "name_natural" | "viewedByMeTime desc";
    spaces: "drive" | "appDataFolder";
  }): Promise<GoogleDriveSearchFilesOutput>;
  getFileMetadata(fileId: string): Promise<GoogleDriveFileMetadataOutput>;
  exportFile(input: { fileId: string; mimeType: string }): Promise<GoogleDriveExportFileOutput>;
  getOverview(): Promise<GoogleDriveOverview>;
}

const rawOwnerSchema = z
  .object({
    displayName: z.string().nullable().optional(),
    emailAddress: z.string().nullable().optional(),
  })
  .passthrough();

type RawOwner = z.infer<typeof rawOwnerSchema>;

const rawFileSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    mimeType: z.string(),
    description: z.string().nullable().optional(),
    createdTime: z.string().nullable().optional(),
    modifiedTime: z.string().nullable().optional(),
    size: z.string().nullable().optional(),
    webViewLink: z.string().nullable().optional(),
    iconLink: z.string().nullable().optional(),
    owners: z.array(rawOwnerSchema).optional(),
    parents: z.array(z.string()).optional(),
    driveId: z.string().nullable().optional(),
  })
  .passthrough();

type RawFile = z.infer<typeof rawFileSchema>;

const rawSearchFilesResponseSchema = z
  .object({
    files: z.array(rawFileSchema).optional().default([]),
    nextPageToken: z.string().optional(),
  })
  .passthrough();

const rawDriveOverviewSchema = z
  .object({
    user: z
      .object({
        displayName: z.string().nullable().optional(),
        emailAddress: z.string().nullable().optional(),
        permissionId: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    storageQuota: z
      .object({
        limit: z.string().nullable().optional(),
        usage: z.string().nullable().optional(),
        usageInDriveTrash: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    importFormats: z.record(z.string(), z.array(z.string())).optional(),
    exportFormats: z.record(z.string(), z.array(z.string())).optional(),
  })
  .passthrough();

function toGoogleDriveConfig(env: GoogleDriveEnv): GoogleDriveConfig {
  return {
    accessToken: env.GOOGLE_DRIVE_ACCESS_TOKEN,
    baseUrl: env.GOOGLE_DRIVE_BASE_URL,
  };
}

function loadGoogleDriveConfig(source: NodeJS.ProcessEnv = process.env): GoogleDriveConfig {
  return toGoogleDriveConfig(loadEnv(googleDriveEnvShape, source));
}

function mapDriveFile(raw: RawFile): GoogleDriveFile {
  return {
    id: raw.id,
    name: raw.name,
    mimeType: raw.mimeType,
    description: raw.description ?? null,
    createdTime: raw.createdTime ?? null,
    modifiedTime: raw.modifiedTime ?? null,
    sizeBytes: raw.size ?? null,
    webViewLink: raw.webViewLink ?? null,
    iconLink: raw.iconLink ?? null,
    ownerNames: (raw.owners ?? []).map((owner: RawOwner) => owner.displayName ?? "unknown"),
    ownerEmails: (raw.owners ?? []).map((owner: RawOwner) => owner.emailAddress ?? "unknown"),
    parents: raw.parents ?? [],
    driveId: raw.driveId ?? null,
  };
}

function escapeDriveQueryValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n...[truncated]`;
}

function isTextualContentType(contentType: string | null): boolean {
  if (!contentType) {
    return false;
  }

  return (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript")
  );
}

function renderSearchResults(output: GoogleDriveSearchFilesOutput): string {
  if (output.files.length === 0) {
    return "No files matched the Drive search.";
  }

  return output.files
    .map((file: GoogleDriveFile) => `- ${file.name} (${file.id}) [${file.mimeType}]`)
    .join("\n");
}

function renderMetadata(output: GoogleDriveFileMetadataOutput): string {
  const { file } = output;
  return `File '${file.name}' (${file.id})\nType: ${file.mimeType}\nModified: ${file.modifiedTime ?? "unknown"}`;
}

function renderExport(output: GoogleDriveExportFileOutput): string {
  const name = output.fileName ?? output.fileId;
  return `Exported '${name}' as ${output.mimeType} (${output.contentType}, ${output.byteLength} bytes).`;
}

class GoogleDriveHttpClient extends HttpServiceClient implements GoogleDriveClient {
  public constructor(config: GoogleDriveConfig, logger: ToolkitServer["logger"]) {
    super({
      serviceName: "google-drive",
      baseUrl: config.baseUrl,
      logger,
      defaultHeaders: () => ({
        authorization: `Bearer ${config.accessToken}`,
        accept: "application/json",
      }),
    });
  }

  public async searchFiles(input: {
    query?: string;
    mimeType?: string;
    pageSize: number;
    pageToken?: string;
    orderBy: "modifiedTime desc" | "name_natural" | "viewedByMeTime desc";
    spaces: "drive" | "appDataFolder";
  }): Promise<GoogleDriveSearchFilesOutput> {
    const filters = ["trashed = false"];

    if (input.query) {
      const escaped = escapeDriveQueryValue(input.query);
      filters.push(`(name contains '${escaped}' or fullText contains '${escaped}')`);
    }

    if (input.mimeType) {
      filters.push(`mimeType = '${escapeDriveQueryValue(input.mimeType)}'`);
    }

    const response = await this.getJson<z.infer<typeof rawSearchFilesResponseSchema>>("/files", rawSearchFilesResponseSchema, {
      query: {
        q: filters.join(" and "),
        pageSize: input.pageSize,
        pageToken: input.pageToken,
        orderBy: input.orderBy,
        spaces: input.spaces,
        fields:
          "nextPageToken,files(id,name,mimeType,description,createdTime,modifiedTime,size,webViewLink,iconLink,parents,driveId,owners(displayName,emailAddress))",
      },
    });

    return {
      query: input.query ?? null,
      pageSize: input.pageSize,
      nextPageToken: response.nextPageToken ?? null,
      files: response.files.map(mapDriveFile),
    };
  }

  public async getFileMetadata(fileId: string): Promise<GoogleDriveFileMetadataOutput> {
    const response = await this.getJson<z.infer<typeof rawFileSchema>>(
      `/files/${encodeURIComponent(fileId)}`,
      rawFileSchema,
      {
        query: {
          fields:
            "id,name,mimeType,description,createdTime,modifiedTime,size,webViewLink,iconLink,parents,driveId,owners(displayName,emailAddress)",
        },
      },
    );

    return {
      file: mapDriveFile(response),
    };
  }

  public async exportFile(input: { fileId: string; mimeType: string }): Promise<GoogleDriveExportFileOutput> {
    const metadata = await this.getFileMetadata(input.fileId);
    const response = await this.fetch(`/files/${encodeURIComponent(input.fileId)}/export`, {
      query: {
        mimeType: input.mimeType,
      },
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    const contentTypeHeader = response.headers.get("content-type");

    if (isTextualContentType(contentTypeHeader)) {
      return {
        fileId: input.fileId,
        fileName: metadata.file.name,
        mimeType: input.mimeType,
        contentType: "text",
        byteLength: buffer.byteLength,
        textContent: buffer.toString("utf8"),
        base64Content: null,
      };
    }

    return {
      fileId: input.fileId,
      fileName: metadata.file.name,
      mimeType: input.mimeType,
      contentType: "base64",
      byteLength: buffer.byteLength,
      textContent: null,
      base64Content: buffer.toString("base64"),
    };
  }

  public async getOverview(): Promise<GoogleDriveOverview> {
    const response = await this.getJson<z.infer<typeof rawDriveOverviewSchema>>(
      "/about",
      rawDriveOverviewSchema,
      {
        query: {
          fields:
            "user(displayName,emailAddress,permissionId),storageQuota(limit,usage,usageInDriveTrash),importFormats,exportFormats",
        },
      },
    );

    return {
      generatedAt: new Date().toISOString(),
      user: {
        displayName: response.user?.displayName ?? null,
        email: response.user?.emailAddress ?? null,
        permissionId: response.user?.permissionId ?? null,
      },
      storageQuota: {
        limitBytes: response.storageQuota?.limit ?? null,
        usageBytes: response.storageQuota?.usage ?? null,
        trashBytes: response.storageQuota?.usageInDriveTrash ?? null,
      },
      importFormats: response.importFormats ?? {},
      exportFormats: response.exportFormats ?? {},
    };
  }
}

export interface GoogleDriveServerOptions {
  config?: GoogleDriveConfig;
  client?: GoogleDriveClient;
  env?: NodeJS.ProcessEnv;
}

export class GoogleDriveServer extends ToolkitServer {
  private readonly client: GoogleDriveClient;

  public constructor(options: { config: GoogleDriveConfig; client?: GoogleDriveClient }) {
    super(metadata);

    this.client = options.client ?? new GoogleDriveHttpClient(options.config, this.logger);

    this.registerTool(
      defineTool({
        name: "search-files",
        title: "Search files",
        description: "Search Google Drive files by text query and optional MIME type.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          query: nonEmptyString.optional(),
          mimeType: nonEmptyString.optional(),
          pageSize: z.number().int().positive().max(100).default(10),
          pageToken: nonEmptyString.optional(),
          orderBy: z.enum(["modifiedTime desc", "name_natural", "viewedByMeTime desc"]).default("modifiedTime desc"),
          spaces: z.enum(["drive", "appDataFolder"]).default("drive"),
        },
        outputSchema: searchFilesOutputShape,
        handler: async ({ query, mimeType, pageSize, pageToken, orderBy, spaces }) => {
          const request = {
            pageSize,
            orderBy,
            spaces,
            ...(query ? { query } : {}),
            ...(mimeType ? { mimeType } : {}),
            ...(pageToken ? { pageToken } : {}),
          };

          return this.client.searchFiles(request);
        },
        renderText: renderSearchResults,
      }),
    );

    this.registerTool(
      defineTool({
        name: "get-file-metadata",
        title: "Get file metadata",
        description: "Fetch metadata, ownership, and links for a specific Google Drive file.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          fileId: nonEmptyString,
        },
        outputSchema: getFileMetadataOutputShape,
        handler: async ({ fileId }) => this.client.getFileMetadata(fileId),
        renderText: renderMetadata,
      }),
    );

    this.registerTool(
      defineTool({
        name: "export-file",
        title: "Export file",
        description: "Export a Google Workspace document to text or another target MIME type.",
        annotations: {
          readOnlyHint: true,
        },
        inputSchema: {
          fileId: nonEmptyString,
          mimeType: nonEmptyString.default("text/plain"),
        },
        outputSchema: exportFileOutputShape,
        handler: async ({ fileId, mimeType }) => this.client.exportFile({ fileId, mimeType }),
        renderText: renderExport,
      }),
    );

    this.registerStaticResource(
      "drive-overview",
      "google-drive://overview",
      {
        title: "Drive Overview",
        description: "A JSON summary of Google Drive account usage and supported import/export formats.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.client.getOverview()),
    );

    this.registerPrompt(
      "summarize-doc",
      {
        title: "Summarize Document",
        description: "Prepare a document summary prompt using Drive metadata and exported text.",
        argsSchema: {
          fileId: nonEmptyString,
          exportMimeType: nonEmptyString.default("text/plain"),
          audience: nonEmptyString.optional(),
          focus: nonEmptyString.optional(),
        },
      },
      async ({ fileId, exportMimeType, audience, focus }) => {
        const promptInput = {
          fileId,
          exportMimeType,
          ...(audience ? { audience } : {}),
          ...(focus ? { focus } : {}),
        };

        return this.createTextPrompt(await this.buildSummaryPrompt(promptInput));
      },
    );
  }

  private async buildSummaryPrompt(input: {
    fileId: string;
    exportMimeType: string;
    audience?: string;
    focus?: string;
  }): Promise<string> {
    const metadataResult = await this.client.getFileMetadata(input.fileId);
    const exportResult = await this.client.exportFile({
      fileId: input.fileId,
      mimeType: input.exportMimeType,
    });

    const contentBlock =
      exportResult.contentType === "text" && exportResult.textContent
        ? truncateText(exportResult.textContent, 6000)
        : "[Binary export omitted. Use the metadata and any separate OCR/text extraction you have available.]";

    return [
      "Summarize the following Google Drive document.",
      `File: ${metadataResult.file.name} (${metadataResult.file.id})`,
      `Type: ${metadataResult.file.mimeType}`,
      `Modified: ${metadataResult.file.modifiedTime ?? "unknown"}`,
      input.audience ? `Audience: ${input.audience}` : "Audience: general stakeholders",
      input.focus ? `Focus: ${input.focus}` : "Focus: key decisions, action items, and risks",
      "",
      "Document content:",
      contentBlock,
      "",
      "Return:",
      "1. A concise summary.",
      "2. Key points grouped by theme.",
      "3. Action items or follow-up questions.",
    ].join("\n");
  }
}

export function createServer(options: GoogleDriveServerOptions = {}): GoogleDriveServer {
  const config = options.config ?? loadGoogleDriveConfig(options.env);

  return options.client
    ? new GoogleDriveServer({
        config,
        client: options.client,
      })
    : new GoogleDriveServer({
        config,
      });
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

function isMainModule(moduleUrl: string): boolean {
  const entryPoint = process.argv[1];
  return typeof entryPoint === "string" && pathToFileURL(entryPoint).href === moduleUrl;
}

if (isMainModule(import.meta.url)) {
  void main();
}
