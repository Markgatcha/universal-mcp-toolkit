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

const toolNames = ["search_packages", "get_package_metadata", "list_package_versions"] as const;
const resourceNames = ["package"] as const;
const promptNames = ["release-plan"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "npm-registry",
  title: "NPM Registry MCP Server",
  description: "Search and inspect npm registry packages, versions, and dist-tags.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-npm-registry",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/npm-registry",
  envVarNames: [],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  NPM_REGISTRY_BASE_URL: z.string().url().optional(),
  NPM_SEARCH_BASE_URL: z.string().url().optional(),
};

type NpmRegistryEnv = z.infer<z.ZodObject<typeof envShape>>;

const searchResultSchema = z.object({
  name: z.string(),
  version: z.string(),
  description: z.string().nullable(),
  keywords: z.array(z.string()),
  score: z.number(),
  homepage: z.string().nullable(),
  npmUrl: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
});

const maintainerSchema = z.object({
  name: z.string(),
  email: z.string().nullable(),
});

const versionInfoSchema = z.object({
  version: z.string(),
  publishedAt: z.string().nullable(),
  deprecated: z.boolean(),
  unpackedSize: z.number().nonnegative().nullable(),
});

const packageMetadataSchema = z.object({
  name: z.string(),
  description: z.string().nullable(),
  latestVersion: z.string().nullable(),
  homepage: z.string().nullable(),
  repositoryUrl: z.string().nullable(),
  license: z.string().nullable(),
  distTags: z.record(z.string(), z.string()),
  maintainers: z.array(maintainerSchema),
  versions: z.array(versionInfoSchema),
});

export type NpmSearchResult = z.infer<typeof searchResultSchema>;
export type NpmMaintainer = z.infer<typeof maintainerSchema>;
export type NpmVersionInfo = z.infer<typeof versionInfoSchema>;
export type NpmPackageMetadata = z.infer<typeof packageMetadataSchema>;

export interface NpmRegistryClient {
  searchPackages(input: { query: string; limit: number; from: number }): Promise<ReadonlyArray<NpmSearchResult>>;
  getPackageMetadata(packageName: string): Promise<NpmPackageMetadata>;
}

export interface CreateNpmRegistryServerOptions {
  client?: NpmRegistryClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface FetchNpmRegistryClientOptions {
  registryBaseUrl?: string;
  searchBaseUrl?: string;
  fetch: typeof fetch;
}

const searchResponseSchema = z.object({
  objects: z.array(
    z.object({
      package: z.object({
        name: z.string(),
        version: z.string(),
        description: z.string().nullable().optional(),
        keywords: z.array(z.string()).optional(),
        links: z
          .object({
            homepage: z.string().nullable().optional(),
            npm: z.string().nullable().optional(),
            repository: z.string().nullable().optional(),
          })
          .optional(),
      }),
      score: z
        .object({
          final: z.number(),
        })
        .optional(),
    }),
  ),
});

const rawVersionSchema = z.object({
  dist: z
    .object({
      unpackedSize: z.number().nonnegative().optional(),
    })
    .optional(),
  deprecated: z.string().optional(),
});

const packageResponseSchema = z.object({
  name: z.string(),
  description: z.string().nullable().optional(),
  homepage: z.string().nullable().optional(),
  license: z.string().nullable().optional(),
  repository: z
    .object({
      url: z.string().nullable().optional(),
    })
    .optional(),
  "dist-tags": z.record(z.string(), z.string()).optional(),
  maintainers: z
    .array(
      z.object({
        name: z.string(),
        email: z.string().nullable().optional(),
      }),
    )
    .optional(),
  versions: z.record(z.string(), rawVersionSchema).optional(),
  time: z.record(z.string(), z.string()).optional(),
});

function resolveEnv(source: NodeJS.ProcessEnv = process.env): NpmRegistryEnv {
  return loadEnv(envShape, source);
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function encodePackageName(packageName: string): string {
  return encodeURIComponent(packageName);
}

function getTemplateVariable(variables: Record<string, string | string[]>, name: string): string {
  const value = variables[name];
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

class FetchNpmRegistryClient implements NpmRegistryClient {
  private readonly registryBaseUrl: string;
  private readonly searchBaseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FetchNpmRegistryClientOptions) {
    this.registryBaseUrl = (options.registryBaseUrl ?? "https://registry.npmjs.org").replace(/\/+$/, "");
    this.searchBaseUrl = (options.searchBaseUrl ?? "https://registry.npmjs.org/-/v1").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
  }

  public async searchPackages(input: {
    query: string;
    limit: number;
    from: number;
  }): Promise<ReadonlyArray<NpmSearchResult>> {
    const url = new URL(`${this.searchBaseUrl}/search`);
    url.searchParams.set("text", input.query);
    url.searchParams.set("size", String(input.limit));
    url.searchParams.set("from", String(input.from));

    const payload = await this.requestJson(url, searchResponseSchema);
    return payload.objects.map((entry) => ({
      name: entry.package.name,
      version: entry.package.version,
      description: toNullableString(entry.package.description),
      keywords: entry.package.keywords ?? [],
      score: entry.score?.final ?? 0,
      homepage: toNullableString(entry.package.links?.homepage),
      npmUrl: toNullableString(entry.package.links?.npm),
      repositoryUrl: toNullableString(entry.package.links?.repository),
    }));
  }

  public async getPackageMetadata(packageName: string): Promise<NpmPackageMetadata> {
    const payload = await this.requestJson(
      new URL(`${this.registryBaseUrl}/${encodePackageName(packageName)}`),
      packageResponseSchema,
    );

    const times = payload.time ?? {};
    const versions = Object.entries(payload.versions ?? {})
      .map(([version, detail]) => ({
        version,
        publishedAt: toNullableString(times[version]),
        deprecated: typeof detail.deprecated === "string" && detail.deprecated.length > 0,
        unpackedSize: detail.dist?.unpackedSize ?? null,
      }))
      .sort((left, right) => {
        const leftTime = left.publishedAt === null ? 0 : Date.parse(left.publishedAt);
        const rightTime = right.publishedAt === null ? 0 : Date.parse(right.publishedAt);
        return rightTime - leftTime;
      });

    return {
      name: payload.name,
      description: toNullableString(payload.description),
      latestVersion: toNullableString(payload["dist-tags"]?.latest),
      homepage: toNullableString(payload.homepage),
      repositoryUrl: toNullableString(payload.repository?.url),
      license: toNullableString(payload.license),
      distTags: payload["dist-tags"] ?? {},
      maintainers: (payload.maintainers ?? []).map((maintainer) => ({
        name: maintainer.name,
        email: toNullableString(maintainer.email),
      })),
      versions,
    };
  }

  private async requestJson<T>(url: URL, schema: z.ZodType<T>): Promise<T> {
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalServiceError(`npm registry request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: body,
      });
    }

    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("npm registry returned an unexpected response shape.", {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }
}

export class NpmRegistryServer extends ToolkitServer {
  private readonly client: NpmRegistryClient;

  public constructor(client: NpmRegistryClient) {
    super(metadata);
    this.client = client;

    this.registerTool(
      defineTool({
        name: "search_packages",
        title: "Search npm packages",
        description: "Search the npm registry for packages matching a text query.",
        inputSchema: {
          query: z.string().trim().min(1),
          limit: z.number().int().min(1).max(50).default(10),
          from: z.number().int().min(0).max(500).default(0),
        },
        outputSchema: {
          results: z.array(searchResultSchema),
          returned: z.number().int(),
        },
        handler: async ({ query, limit, from }, context) => {
          await context.log("info", `Searching npm registry for ${query}`);
          const results = await this.client.searchPackages({ query, limit, from });
          return {
            results: [...results],
            returned: results.length,
          };
        },
        renderText: ({ results, returned }) => {
          if (returned === 0) {
            return "No npm packages found.";
          }
          return results.map((result) => `${result.name}@${result.version}`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_package_metadata",
        title: "Get package metadata",
        description: "Fetch npm registry metadata for a specific package.",
        inputSchema: {
          packageName: z.string().trim().min(1),
        },
        outputSchema: {
          package: packageMetadataSchema,
        },
        handler: async ({ packageName }, context) => {
          await context.log("info", `Fetching npm metadata for ${packageName}`);
          return {
            package: await this.client.getPackageMetadata(packageName),
          };
        },
        renderText: ({ package: pkg }) => `${pkg.name} latest=${pkg.latestVersion ?? "unknown"}`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list_package_versions",
        title: "List package versions",
        description: "List recent versions and dist-tags for a package in the npm registry.",
        inputSchema: {
          packageName: z.string().trim().min(1),
          limit: z.number().int().min(1).max(100).default(20),
        },
        outputSchema: {
          packageName: z.string(),
          distTags: z.record(z.string(), z.string()),
          versions: z.array(versionInfoSchema),
        },
        handler: async ({ packageName, limit }, context) => {
          await context.log("info", `Listing npm versions for ${packageName}`);
          const pkg = await this.client.getPackageMetadata(packageName);
          return {
            packageName: pkg.name,
            distTags: pkg.distTags,
            versions: pkg.versions.slice(0, limit),
          };
        },
        renderText: ({ packageName, versions }) => `${packageName}: ${versions.map((version) => version.version).join(", ")}`,
      }),
    );

    this.registerTemplateResource(
      "package",
      "npm://package/{packageName}",
      {
        title: "Package metadata",
        description: "Metadata resource for an npm package.",
        mimeType: "application/json",
      },
      async (uri, variables) => {
        const packageName = getTemplateVariable(variables, "packageName");
        const pkg = await this.client.getPackageMetadata(packageName);
        return this.createJsonResource(uri.toString(), pkg);
      },
    );

    this.registerPrompt(
      "release-plan",
      {
        title: "Release plan prompt",
        description: "Draft a release plan for publishing or promoting an npm package.",
        argsSchema: {
          packageName: z.string().trim().min(1),
          targetVersion: z.string().trim().min(1),
          currentVersion: z.string().trim().min(1).optional(),
          goal: z.string().trim().min(1),
        },
      },
      async ({ packageName, targetVersion, currentVersion, goal }) =>
        this.createTextPrompt(
          [
            `Create a release plan for ${packageName} targeting version ${targetVersion}.`,
            currentVersion ? `Current published version: ${currentVersion}.` : "Assume the current version needs verification.",
            `Primary goal: ${goal}.`,
            "Cover changelog scope, semver impact, dist-tags, validation, rollback, and communication steps.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(
  options: CreateNpmRegistryServerOptions = {},
): Promise<NpmRegistryServer> {
  if (options.client) {
    return new NpmRegistryServer(options.client);
  }

  const env = resolveEnv(options.env);
  const client = new FetchNpmRegistryClient({
    fetch: options.fetch ?? globalThis.fetch,
    ...(env.NPM_REGISTRY_BASE_URL ? { registryBaseUrl: env.NPM_REGISTRY_BASE_URL } : {}),
    ...(env.NPM_SEARCH_BASE_URL ? { searchBaseUrl: env.NPM_SEARCH_BASE_URL } : {}),
  });

  return new NpmRegistryServer(client);
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
