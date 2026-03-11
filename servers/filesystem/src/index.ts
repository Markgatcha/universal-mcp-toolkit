import {
  ConfigurationError,
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  ValidationError,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, normalize, parse, relative, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const toolNames = ["list_files", "read_file", "write_file"] as const;
const resourceNames = ["workspace"] as const;
const promptNames = ["change-plan"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "filesystem",
  title: "FileSystem MCP Server",
  description: "Safe, allowlisted file listing, reading, and writing tools.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-filesystem",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/filesystem",
  envVarNames: ["FILESYSTEM_ROOTS"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  FILESYSTEM_ROOTS: z.string().min(1),
  FILESYSTEM_MAX_READ_BYTES: z.string().regex(/^\d+$/).optional(),
  FILESYSTEM_MAX_WRITE_BYTES: z.string().regex(/^\d+$/).optional(),
};

type FileSystemEnv = z.infer<z.ZodObject<typeof envShape>>;

type FileEncoding = "utf8" | "base64";

const encodingSchema = z.enum(["utf8", "base64"]);

const fileEntrySchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  type: z.enum(["file", "directory"]),
  sizeBytes: z.number().int().nonnegative(),
  modifiedAt: z.string().nullable(),
});

const workspaceRootSchema = z.object({
  root: z.string(),
  available: z.boolean(),
});

const workspaceSummarySchema = z.object({
  roots: z.array(workspaceRootSchema),
  maxReadBytes: z.number().int().positive(),
  maxWriteBytes: z.number().int().positive(),
  sampleEntries: z.array(fileEntrySchema),
});

const listFilesOutputSchema = z.object({
  root: z.string(),
  directory: z.string(),
  entries: z.array(fileEntrySchema),
  truncated: z.boolean(),
});

const readFileOutputSchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  encoding: encodingSchema,
  content: z.string(),
  bytes: z.number().int().nonnegative(),
});

const writeFileOutputSchema = z.object({
  path: z.string(),
  absolutePath: z.string(),
  bytesWritten: z.number().int().nonnegative(),
  created: z.boolean(),
  overwritten: z.boolean(),
});

export type FileEntry = z.infer<typeof fileEntrySchema>;
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
export type ListFilesOutput = z.infer<typeof listFilesOutputSchema>;
export type ReadFileOutput = z.infer<typeof readFileOutputSchema>;
export type WriteFileOutput = z.infer<typeof writeFileOutputSchema>;

export interface FileSystemService {
  listFiles(input: { path?: string; root?: string; recursive: boolean; maxEntries: number }): Promise<ListFilesOutput>;
  readFile(input: { path: string; root?: string; encoding: FileEncoding; maxBytes?: number }): Promise<ReadFileOutput>;
  writeFile(input: {
    path: string;
    root?: string;
    content: string;
    encoding: FileEncoding;
    overwrite: boolean;
    createDirectories: boolean;
  }): Promise<WriteFileOutput>;
  getWorkspaceSummary(): Promise<WorkspaceSummary>;
}

export interface CreateFileSystemServerOptions {
  service?: FileSystemService;
  env?: NodeJS.ProcessEnv;
}

interface RootConfig {
  root: string;
  realRoot: string;
}

function resolveEnv(source: NodeJS.ProcessEnv = process.env): FileSystemEnv {
  return loadEnv(envShape, source);
}

function parseLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ConfigurationError(`Expected a positive integer but received '${raw}'.`);
  }
  return parsed;
}

function normalizeForComparison(value: string): string {
  const resolved = normalize(resolvePath(value));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isPathInside(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

async function ensureDirectory(path: string): Promise<void> {
  const stat = await fs.stat(path).catch(() => undefined);
  if (!stat || !stat.isDirectory()) {
    throw new ConfigurationError(`Allowlisted root '${path}' must exist and be a directory.`);
  }
}

async function findNearestExistingAncestor(path: string): Promise<string> {
  let current = path;
  while (true) {
    const stat = await fs.lstat(current).catch(() => undefined);
    if (stat) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function toRelativePath(root: string, absolutePath: string): string {
  const relativePath = relative(root, absolutePath);
  return relativePath.length === 0 ? "." : relativePath;
}

function toTimestamp(date: Date): string {
  return date.toISOString();
}

function splitRoots(raw: string): ReadonlyArray<string> {
  return raw
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class DefaultFileSystemService implements FileSystemService {
  private readonly roots: ReadonlyArray<RootConfig>;
  private readonly maxReadBytes: number;
  private readonly maxWriteBytes: number;

  private constructor(roots: ReadonlyArray<RootConfig>, maxReadBytes: number, maxWriteBytes: number) {
    this.roots = roots;
    this.maxReadBytes = maxReadBytes;
    this.maxWriteBytes = maxWriteBytes;
  }

  public static async fromEnv(source: NodeJS.ProcessEnv = process.env): Promise<DefaultFileSystemService> {
    const env = resolveEnv(source);
    const roots = splitRoots(env.FILESYSTEM_ROOTS);
    if (roots.length === 0) {
      throw new ConfigurationError("FILESYSTEM_ROOTS must contain at least one absolute path.");
    }

    const normalizedRoots: RootConfig[] = [];
    for (const root of roots) {
      if (!isAbsolute(root)) {
        throw new ConfigurationError(`FILESYSTEM_ROOTS entry '${root}' must be an absolute path.`);
      }
      await ensureDirectory(root);
      normalizedRoots.push({
        root: resolvePath(root),
        realRoot: await fs.realpath(root),
      });
    }

    return new DefaultFileSystemService(
      normalizedRoots,
      parseLimit(env.FILESYSTEM_MAX_READ_BYTES, 1024 * 1024),
      parseLimit(env.FILESYSTEM_MAX_WRITE_BYTES, 1024 * 1024),
    );
  }

  public async listFiles(input: { path?: string; root?: string; recursive: boolean; maxEntries: number }): Promise<ListFilesOutput> {
    const resolvedPath = await this.resolveSafePath(input.path ?? ".", input.root);
    const stat = await fs.stat(resolvedPath.absolutePath).catch(() => undefined);
    if (!stat || !stat.isDirectory()) {
      throw new ValidationError(`Path '${resolvedPath.absolutePath}' is not a directory.`);
    }

    const queue = [resolvedPath.absolutePath];
    const entries: FileEntry[] = [];
    let truncated = false;

    while (queue.length > 0 && entries.length < input.maxEntries) {
      const current = queue.shift();
      if (!current) {
        break;
      }

      const children = await fs.readdir(current, { withFileTypes: true });
      for (const child of children) {
        if (child.isSymbolicLink()) {
          continue;
        }

        const childPath = join(current, child.name);
        const childStat = await fs.stat(childPath);
        const entry: FileEntry = {
          path: toRelativePath(resolvedPath.root, childPath),
          absolutePath: childPath,
          type: child.isDirectory() ? "directory" : "file",
          sizeBytes: child.isDirectory() ? 0 : childStat.size,
          modifiedAt: toTimestamp(childStat.mtime),
        };
        entries.push(entry);

        if (entries.length >= input.maxEntries) {
          truncated = true;
          break;
        }

        if (input.recursive && child.isDirectory()) {
          queue.push(childPath);
        }
      }
    }

    if (queue.length > 0) {
      truncated = true;
    }

    return {
      root: resolvedPath.root,
      directory: resolvedPath.absolutePath,
      entries,
      truncated,
    };
  }

  public async readFile(input: { path: string; root?: string; encoding: FileEncoding; maxBytes?: number }): Promise<ReadFileOutput> {
    const resolvedPath = await this.resolveSafePath(input.path, input.root);
    const stat = await fs.stat(resolvedPath.absolutePath).catch(() => undefined);
    if (!stat || !stat.isFile()) {
      throw new ValidationError(`Path '${resolvedPath.absolutePath}' is not a file.`);
    }

    const effectiveMaxBytes = input.maxBytes ?? this.maxReadBytes;
    if (stat.size > effectiveMaxBytes) {
      throw new ValidationError(`File exceeds the allowed read size of ${effectiveMaxBytes} bytes.`);
    }

    const buffer = await fs.readFile(resolvedPath.absolutePath);
    const content = input.encoding === "base64" ? buffer.toString("base64") : buffer.toString("utf8");

    return {
      path: resolvedPath.requestedPath,
      absolutePath: resolvedPath.absolutePath,
      encoding: input.encoding,
      content,
      bytes: buffer.byteLength,
    };
  }

  public async writeFile(input: {
    path: string;
    root?: string;
    content: string;
    encoding: FileEncoding;
    overwrite: boolean;
    createDirectories: boolean;
  }): Promise<WriteFileOutput> {
    const resolvedPath = await this.resolveSafePath(input.path, input.root);
    const buffer = input.encoding === "base64" ? Buffer.from(input.content, "base64") : Buffer.from(input.content, "utf8");
    if (buffer.byteLength > this.maxWriteBytes) {
      throw new ValidationError(`Content exceeds the allowed write size of ${this.maxWriteBytes} bytes.`);
    }

    const existingStat = await fs.stat(resolvedPath.absolutePath).catch(() => undefined);
    if (existingStat?.isDirectory()) {
      throw new ValidationError(`Path '${resolvedPath.absolutePath}' is a directory.`);
    }
    if (existingStat && !input.overwrite) {
      throw new ValidationError(`Path '${resolvedPath.absolutePath}' already exists and overwrite=false.`);
    }

    const parent = dirname(resolvedPath.absolutePath);
    if (input.createDirectories) {
      await fs.mkdir(parent, { recursive: true });
    } else {
      const parentStat = await fs.stat(parent).catch(() => undefined);
      if (!parentStat || !parentStat.isDirectory()) {
        throw new ValidationError(`Parent directory '${parent}' does not exist.`);
      }
    }

    await fs.writeFile(resolvedPath.absolutePath, buffer, { flag: input.overwrite ? "w" : "wx" });

    return {
      path: resolvedPath.requestedPath,
      absolutePath: resolvedPath.absolutePath,
      bytesWritten: buffer.byteLength,
      created: !existingStat,
      overwritten: Boolean(existingStat),
    };
  }

  public async getWorkspaceSummary(): Promise<WorkspaceSummary> {
    const sampleRoot = this.roots[0]?.root;
    const sampleEntries =
      sampleRoot === undefined ? [] : (await this.listFiles({ path: sampleRoot, recursive: false, maxEntries: 10 })).entries;

    return {
      roots: await Promise.all(
        this.roots.map(async (root) => ({
          root: root.root,
          available: Boolean(await fs.stat(root.root).catch(() => undefined)),
        })),
      ),
      maxReadBytes: this.maxReadBytes,
      maxWriteBytes: this.maxWriteBytes,
      sampleEntries,
    };
  }

  private async resolveSafePath(requestedPath: string, requestedRoot?: string): Promise<{
    root: string;
    absolutePath: string;
    requestedPath: string;
  }> {
    const rootConfig = this.selectRoot(requestedRoot);
    const candidate = isAbsolute(requestedPath) ? resolvePath(requestedPath) : resolvePath(rootConfig.root, requestedPath);
    const normalizedRoot = normalizeForComparison(rootConfig.root);
    const normalizedCandidate = normalizeForComparison(candidate);

    if (!isPathInside(normalizedRoot, normalizedCandidate)) {
      throw new ValidationError(`Path '${requestedPath}' resolves outside the allowlisted roots.`);
    }

    const ancestor = await findNearestExistingAncestor(candidate);
    const realAncestor = await fs.realpath(ancestor).catch(() => ancestor);
    const normalizedRealRoot = normalizeForComparison(rootConfig.realRoot);
    const normalizedRealAncestor = normalizeForComparison(realAncestor);
    if (!isPathInside(normalizedRealRoot, normalizedRealAncestor)) {
      throw new ValidationError(`Path '${requestedPath}' resolves through an unsafe symlinked location.`);
    }

    const existingTarget = await fs.lstat(candidate).catch(() => undefined);
    if (existingTarget) {
      const realTarget = await fs.realpath(candidate).catch(() => candidate);
      if (!isPathInside(normalizedRealRoot, normalizeForComparison(realTarget))) {
        throw new ValidationError(`Path '${requestedPath}' resolves outside the allowlisted roots.`);
      }
    }

    return {
      root: rootConfig.root,
      absolutePath: candidate,
      requestedPath,
    };
  }

  private selectRoot(requestedRoot?: string): RootConfig {
    if (requestedRoot === undefined || requestedRoot.trim().length === 0) {
      const fallback = this.roots[0];
      if (!fallback) {
        throw new ConfigurationError("No filesystem roots are configured.");
      }
      return fallback;
    }

    const normalizedRequested = normalizeForComparison(requestedRoot);
    const root = this.roots.find((entry) => normalizeForComparison(entry.root) === normalizedRequested);
    if (!root) {
      throw new ValidationError(`Root '${requestedRoot}' is not allowlisted.`);
    }
    return root;
  }
}

export class FileSystemServer extends ToolkitServer {
  private readonly service: FileSystemService;

  public constructor(service: FileSystemService) {
    super(metadata);
    this.service = service;

    this.registerTool(
      defineTool({
        name: "list_files",
        title: "List files",
        description: "List files under an allowlisted root directory.",
        inputSchema: {
          path: z.string().trim().min(1).optional(),
          root: z.string().trim().min(1).optional(),
          recursive: z.boolean().default(false),
          maxEntries: z.number().int().min(1).max(200).default(50),
        },
        outputSchema: {
          root: z.string(),
          directory: z.string(),
          entries: z.array(fileEntrySchema),
          truncated: z.boolean(),
        },
        handler: async ({ path, root, recursive, maxEntries }, context) => {
          await context.log("info", "Listing files from an allowlisted root");
          const request: { path?: string; root?: string; recursive: boolean; maxEntries: number } = { recursive, maxEntries };
          if (path !== undefined) {
            request.path = path;
          }
          if (root !== undefined) {
            request.root = root;
          }
          return this.service.listFiles(request);
        },
        renderText: ({ directory, entries }) => `${directory}\n${entries.map((entry) => `${entry.type}: ${entry.path}`).join("\n")}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "read_file",
        title: "Read file",
        description: "Read a file from an allowlisted root.",
        inputSchema: {
          path: z.string().trim().min(1),
          root: z.string().trim().min(1).optional(),
          encoding: encodingSchema.default("utf8"),
          maxBytes: z.number().int().min(1).max(10 * 1024 * 1024).optional(),
        },
        outputSchema: {
          path: z.string(),
          absolutePath: z.string(),
          encoding: encodingSchema,
          content: z.string(),
          bytes: z.number().int().nonnegative(),
        },
        handler: async ({ path, root, encoding, maxBytes }, context) => {
          await context.log("info", `Reading file ${path}`);
          const request: { path: string; root?: string; encoding: FileEncoding; maxBytes?: number } = { path, encoding };
          if (root !== undefined) {
            request.root = root;
          }
          if (maxBytes !== undefined) {
            request.maxBytes = maxBytes;
          }
          return this.service.readFile(request);
        },
        renderText: ({ absolutePath, content }) => `${absolutePath}\n${content}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "write_file",
        title: "Write file",
        description: "Write a file inside an allowlisted root.",
        inputSchema: {
          path: z.string().trim().min(1),
          root: z.string().trim().min(1).optional(),
          content: z.string(),
          encoding: encodingSchema.default("utf8"),
          overwrite: z.boolean().default(false),
          createDirectories: z.boolean().default(true),
        },
        outputSchema: {
          path: z.string(),
          absolutePath: z.string(),
          bytesWritten: z.number().int().nonnegative(),
          created: z.boolean(),
          overwritten: z.boolean(),
        },
        handler: async ({ path, root, content, encoding, overwrite, createDirectories }, context) => {
          await context.log("info", `Writing file ${path}`);
          const request: {
            path: string;
            root?: string;
            content: string;
            encoding: FileEncoding;
            overwrite: boolean;
            createDirectories: boolean;
          } = { path, content, encoding, overwrite, createDirectories };
          if (root !== undefined) {
            request.root = root;
          }
          return this.service.writeFile(request);
        },
        renderText: ({ absolutePath, bytesWritten }) => `Wrote ${bytesWritten} bytes to ${absolutePath}`,
      }),
    );

    this.registerStaticResource(
      "workspace",
      "filesystem://workspace",
      {
        title: "Workspace summary",
        description: "Configured allowlisted roots and a sample directory listing.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.service.getWorkspaceSummary()),
    );

    this.registerPrompt(
      "change-plan",
      {
        title: "Change plan prompt",
        description: "Draft a careful filesystem change plan before editing local files.",
        argsSchema: {
          targetPath: z.string().trim().min(1),
          goal: z.string().trim().min(1),
          constraints: z.string().trim().min(1).optional(),
        },
      },
      async ({ targetPath, goal, constraints }) =>
        this.createTextPrompt(
          [
            `Plan a safe file-system change for ${targetPath}.`,
            `Goal: ${goal}.`,
            constraints ? `Constraints: ${constraints}.` : "Include backups, validation, rollback, and scope-control steps.",
            "Keep all work within allowlisted roots and call out any irreversible operations.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(options: CreateFileSystemServerOptions = {}): Promise<FileSystemServer> {
  const service = options.service ?? (await DefaultFileSystemService.fromEnv(options.env));
  return new FileSystemServer(service);
}

function isMainModule(metaUrl: string): boolean {
  const entry = process.argv[1];
  return typeof entry === "string" && fileURLToPath(metaUrl) === resolvePath(entry);
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
