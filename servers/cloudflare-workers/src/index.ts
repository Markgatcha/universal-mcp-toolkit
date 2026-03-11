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

const toolNames = ["list_workers", "get_worker", "list_routes"] as const;
const resourceNames = ["account"] as const;
const promptNames = ["edge-rollout"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "cloudflare-workers",
  title: "Cloudflare Workers MCP Server",
  description: "Worker, route, and account tools for Cloudflare Workers.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-cloudflare-workers",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/cloudflare-workers",
  envVarNames: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  CLOUDFLARE_API_TOKEN: z.string().min(1),
  CLOUDFLARE_ACCOUNT_ID: z.string().min(1),
  CLOUDFLARE_API_BASE_URL: z.string().url().optional(),
};

type CloudflareEnv = z.infer<z.ZodObject<typeof envShape>>;

const workerSummarySchema = z.object({
  name: z.string(),
  createdAt: z.string().nullable(),
  modifiedAt: z.string().nullable(),
  usageModel: z.string().nullable(),
  handlers: z.array(z.string()),
  compatibilityDate: z.string().nullable(),
});

const workerDetailSchema = workerSummarySchema.extend({
  bindingsCount: z.number().int().nonnegative(),
  placementMode: z.string().nullable(),
  logpush: z.boolean(),
});

const routeSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  script: z.string().nullable(),
  zoneName: z.string().nullable(),
});

const accountSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable(),
});

export type CloudflareWorkerSummary = z.infer<typeof workerSummarySchema>;
export type CloudflareWorkerDetail = z.infer<typeof workerDetailSchema>;
export type CloudflareRoute = z.infer<typeof routeSchema>;
export type CloudflareAccountSummary = z.infer<typeof accountSummarySchema>;

export interface CloudflareWorkersClient {
  listWorkers(limit: number): Promise<ReadonlyArray<CloudflareWorkerSummary>>;
  getWorker(scriptName: string): Promise<CloudflareWorkerDetail>;
  listRoutes(input: { limit: number; scriptName?: string }): Promise<ReadonlyArray<CloudflareRoute>>;
  getAccountSummary(): Promise<CloudflareAccountSummary>;
}

export interface CreateCloudflareWorkersServerOptions {
  client?: CloudflareWorkersClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface FetchCloudflareWorkersClientOptions {
  apiToken: string;
  accountId: string;
  baseUrl?: string;
  fetch: typeof fetch;
}

const cloudflareResponseSchema = <T extends z.ZodTypeAny>(resultSchema: T) =>
  z.object({
    success: z.boolean().optional(),
    result: resultSchema,
  });

const workerListResponseSchema = cloudflareResponseSchema(
  z.array(
    z.object({
      id: z.string(),
      created_on: z.string().nullable().optional(),
      modified_on: z.string().nullable().optional(),
      usage_model: z.string().nullable().optional(),
      handlers: z.array(z.string()).optional(),
      compatibility_date: z.string().nullable().optional(),
    }),
  ),
);

const workerSettingsResponseSchema = cloudflareResponseSchema(
  z.object({
    compatibility_date: z.string().nullable().optional(),
    usage_model: z.string().nullable().optional(),
    bindings: z.array(z.unknown()).optional(),
    placement_mode: z.string().nullable().optional(),
    logpush: z.boolean().optional(),
  }),
);

const routesResponseSchema = cloudflareResponseSchema(
  z.array(
    z.object({
      id: z.string(),
      pattern: z.string(),
      script: z.string().nullable().optional(),
      zone_name: z.string().nullable().optional(),
    }),
  ),
);

const accountResponseSchema = cloudflareResponseSchema(
  z.object({
    id: z.string(),
    name: z.string(),
    type: z.string().nullable().optional(),
  }),
);

function resolveEnv(source: NodeJS.ProcessEnv = process.env): CloudflareEnv {
  return loadEnv(envShape, source);
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

class FetchCloudflareWorkersClient implements CloudflareWorkersClient {
  private readonly accountId: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly headers: HeadersInit;

  public constructor(options: FetchCloudflareWorkersClientOptions) {
    this.accountId = options.accountId;
    this.baseUrl = (options.baseUrl ?? "https://api.cloudflare.com/client/v4").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
    this.headers = {
      authorization: `Bearer ${options.apiToken}`,
      accept: "application/json",
    };
  }

  public async listWorkers(limit: number): Promise<ReadonlyArray<CloudflareWorkerSummary>> {
    const payload = await this.requestJson(
      `/accounts/${this.accountId}/workers/scripts`,
      workerListResponseSchema,
    );

    return payload.result.slice(0, limit).map((worker) => ({
      name: worker.id,
      createdAt: toNullableString(worker.created_on),
      modifiedAt: toNullableString(worker.modified_on),
      usageModel: toNullableString(worker.usage_model),
      handlers: worker.handlers ?? [],
      compatibilityDate: toNullableString(worker.compatibility_date),
    }));
  }

  public async getWorker(scriptName: string): Promise<CloudflareWorkerDetail> {
    const [summary, settings] = await Promise.all([
      this.listWorkers(Number.MAX_SAFE_INTEGER),
      this.requestJson(
        `/accounts/${this.accountId}/workers/scripts/${encodeURIComponent(scriptName)}/settings`,
        workerSettingsResponseSchema,
      ),
    ]);

    const worker = summary.find((entry) => entry.name === scriptName);
    if (!worker) {
      throw new ExternalServiceError(`Cloudflare worker '${scriptName}' was not found.`, {
        statusCode: 404,
      });
    }

    return {
      ...worker,
      bindingsCount: settings.result.bindings?.length ?? 0,
      placementMode: toNullableString(settings.result.placement_mode),
      logpush: settings.result.logpush ?? false,
    };
  }

  public async listRoutes(input: { limit: number; scriptName?: string }): Promise<ReadonlyArray<CloudflareRoute>> {
    const payload = await this.requestJson(`/accounts/${this.accountId}/workers/routes`, routesResponseSchema);
    const filtered = payload.result
      .filter((route) => input.scriptName === undefined || route.script === input.scriptName)
      .slice(0, input.limit);

    return filtered.map((route) => ({
      id: route.id,
      pattern: route.pattern,
      script: toNullableString(route.script),
      zoneName: toNullableString(route.zone_name),
    }));
  }

  public async getAccountSummary(): Promise<CloudflareAccountSummary> {
    const payload = await this.requestJson(`/accounts/${this.accountId}`, accountResponseSchema);
    return {
      id: payload.result.id,
      name: payload.result.name,
      type: toNullableString(payload.result.type),
    };
  }

  private async requestJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: this.headers,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalServiceError(`Cloudflare request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: body,
      });
    }

    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Cloudflare returned an unexpected response shape.", {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }
}

export class CloudflareWorkersServer extends ToolkitServer {
  private readonly client: CloudflareWorkersClient;

  public constructor(client: CloudflareWorkersClient) {
    super(metadata);
    this.client = client;

    this.registerTool(
      defineTool({
        name: "list_workers",
        title: "List Workers",
        description: "List worker scripts in the configured Cloudflare account.",
        inputSchema: {
          limit: z.number().int().min(1).max(100).default(20),
        },
        outputSchema: {
          workers: z.array(workerSummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ limit }, context) => {
          await context.log("info", "Listing Cloudflare workers");
          const workers = await this.client.listWorkers(limit);
          return {
            workers: [...workers],
            returned: workers.length,
          };
        },
        renderText: ({ workers, returned }) => {
          if (returned === 0) {
            return "No Cloudflare workers found.";
          }
          return workers.map((worker) => `${worker.name} (${worker.usageModel ?? "standard"})`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_worker",
        title: "Get worker",
        description: "Fetch Cloudflare Worker settings for a specific script.",
        inputSchema: {
          scriptName: z.string().trim().min(1),
        },
        outputSchema: {
          worker: workerDetailSchema,
        },
        handler: async ({ scriptName }, context) => {
          await context.log("info", `Fetching Cloudflare worker ${scriptName}`);
          return {
            worker: await this.client.getWorker(scriptName),
          };
        },
        renderText: ({ worker }) => `${worker.name} uses ${worker.bindingsCount} bindings and ${worker.usageModel ?? "default"} mode.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list_routes",
        title: "List worker routes",
        description: "List routes attached to Cloudflare Workers in the account.",
        inputSchema: {
          limit: z.number().int().min(1).max(200).default(50),
          scriptName: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          routes: z.array(routeSchema),
          returned: z.number().int(),
        },
        handler: async ({ limit, scriptName }, context) => {
          await context.log("info", "Listing Cloudflare worker routes");
          const request: { limit: number; scriptName?: string } = { limit };
          if (scriptName !== undefined) {
            request.scriptName = scriptName;
          }
          const routes = await this.client.listRoutes(request);
          return {
            routes: [...routes],
            returned: routes.length,
          };
        },
        renderText: ({ routes, returned }) => {
          if (returned === 0) {
            return "No matching worker routes found.";
          }
          return routes.map((route) => `${route.pattern} -> ${route.script ?? "unbound"}`).join("\n");
        },
      }),
    );

    this.registerStaticResource(
      "account",
      "cloudflare://account",
      {
        title: "Cloudflare account",
        description: "Cloudflare account summary for the configured Workers account.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.client.getAccountSummary()),
    );

    this.registerPrompt(
      "edge-rollout",
      {
        title: "Edge rollout prompt",
        description: "Create a rollout checklist for deploying or expanding a Worker.",
        argsSchema: {
          scriptName: z.string().trim().min(1),
          routePattern: z.string().trim().min(1).optional(),
          rolloutGoal: z.string().trim().min(1),
        },
      },
      async ({ scriptName, routePattern, rolloutGoal }) =>
        this.createTextPrompt(
          [
            `Plan a Cloudflare Workers rollout for \"${scriptName}\" with the goal: ${rolloutGoal}.`,
            routePattern ? `Include route coverage for ${routePattern}.` : "Include route validation, traffic ramp-up, and rollback checks.",
            "Call out caching, bindings, observability, and regional blast-radius considerations.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(
  options: CreateCloudflareWorkersServerOptions = {},
): Promise<CloudflareWorkersServer> {
  if (options.client) {
    return new CloudflareWorkersServer(options.client);
  }

  const env = resolveEnv(options.env);
  return new CloudflareWorkersServer(
    new FetchCloudflareWorkersClient({
      apiToken: env.CLOUDFLARE_API_TOKEN,
      accountId: env.CLOUDFLARE_ACCOUNT_ID,
      fetch: options.fetch ?? globalThis.fetch,
      ...(env.CLOUDFLARE_API_BASE_URL ? { baseUrl: env.CLOUDFLARE_API_BASE_URL } : {}),
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
