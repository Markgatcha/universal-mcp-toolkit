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

const toolNames = ["list_projects", "list_deployments", "get_deployment"] as const;
const resourceNames = ["account"] as const;
const promptNames = ["deployment-audit"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "vercel",
  title: "Vercel MCP Server",
  description: "Project, deployment, and account tools for Vercel.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-vercel",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/vercel",
  envVarNames: ["VERCEL_TOKEN", "VERCEL_TEAM_ID"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  VERCEL_TOKEN: z.string().min(1),
  VERCEL_TEAM_ID: z.string().min(1).optional(),
  VERCEL_API_BASE_URL: z.string().url().optional(),
};

type VercelEnv = z.infer<z.ZodObject<typeof envShape>>;

const projectSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  framework: z.string().nullable(),
  latestProductionUrl: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

const deploymentSummarySchema = z.object({
  id: z.string(),
  projectName: z.string(),
  url: z.string(),
  state: z.string(),
  target: z.string().nullable(),
  createdAt: z.string().nullable(),
  readyState: z.string().nullable(),
});

const deploymentDetailSchema = deploymentSummarySchema.extend({
  alias: z.array(z.string()),
  inspectorUrl: z.string().nullable(),
  creator: z.object({
    id: z.string().nullable(),
    username: z.string().nullable(),
    email: z.string().nullable(),
  }),
  meta: z.record(z.string(), z.string()).default({}),
});

const accountSummarySchema = z.object({
  id: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  defaultTeamId: z.string().nullable(),
});

export type VercelProjectSummary = z.infer<typeof projectSummarySchema>;
export type VercelDeploymentSummary = z.infer<typeof deploymentSummarySchema>;
export type VercelDeploymentDetail = z.infer<typeof deploymentDetailSchema>;
export type VercelAccountSummary = z.infer<typeof accountSummarySchema>;

export interface VercelClient {
  listProjects(input: { limit: number; search?: string }): Promise<ReadonlyArray<VercelProjectSummary>>;
  listDeployments(input: { limit: number; projectId?: string; target?: string }): Promise<ReadonlyArray<VercelDeploymentSummary>>;
  getDeployment(deploymentId: string): Promise<VercelDeploymentDetail>;
  getAccountSummary(): Promise<VercelAccountSummary>;
}

export interface CreateVercelServerOptions {
  client?: VercelClient;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

interface FetchVercelClientOptions {
  token: string;
  teamId?: string;
  baseUrl?: string;
  fetch: typeof fetch;
}

type QueryValue = string | number | undefined;

const listProjectsResponseSchema = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      framework: z.string().nullable().optional(),
      latestProductionUrl: z.string().nullable().optional(),
      createdAt: z.number().optional(),
      updatedAt: z.number().optional(),
    }),
  ),
});

const listDeploymentsResponseSchema = z.object({
  deployments: z.array(
    z.object({
      uid: z.string(),
      name: z.string(),
      url: z.string(),
      state: z.string(),
      target: z.string().nullable().optional(),
      created: z.number().optional(),
      readyState: z.string().nullable().optional(),
    }),
  ),
});

const deploymentResponseSchema = z.object({
  uid: z.string(),
  name: z.string(),
  url: z.string(),
  state: z.string(),
  target: z.string().nullable().optional(),
  created: z.number().optional(),
  readyState: z.string().nullable().optional(),
  alias: z.array(z.string()).optional(),
  inspectorUrl: z.string().nullable().optional(),
  creator: z
    .object({
      uid: z.string().optional(),
      username: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .optional(),
  meta: z.record(z.string(), z.string()).optional(),
});

const accountResponseSchema = z.object({
  id: z.string(),
  username: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  defaultTeamId: z.string().nullable().optional(),
});

function resolveEnv(source: NodeJS.ProcessEnv = process.env): VercelEnv {
  return loadEnv(envShape, source);
}

function buildQuery(params: Record<string, QueryValue>): string {
  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      searchParams.set(key, String(value));
    }
  }
  const query = searchParams.toString();
  return query.length > 0 ? `?${query}` : "";
}

function toIsoTimestamp(value: number | undefined): string | null {
  return typeof value === "number" ? new Date(value).toISOString() : null;
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

class FetchVercelClient implements VercelClient {
  private readonly token: string;
  private readonly teamId: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: FetchVercelClientOptions) {
    this.token = options.token;
    this.teamId = options.teamId;
    this.baseUrl = (options.baseUrl ?? "https://api.vercel.com").replace(/\/+$/, "");
    this.fetchImpl = options.fetch;
  }

  public async listProjects(input: { limit: number; search?: string }): Promise<ReadonlyArray<VercelProjectSummary>> {
    const payload = await this.requestJson(
      `/v9/projects${buildQuery({ limit: input.limit, search: input.search })}`,
      listProjectsResponseSchema,
    );

    return payload.projects.map((project) => ({
      id: project.id,
      name: project.name,
      framework: toNullableString(project.framework),
      latestProductionUrl: toNullableString(project.latestProductionUrl),
      createdAt: toIsoTimestamp(project.createdAt),
      updatedAt: toIsoTimestamp(project.updatedAt),
    }));
  }

  public async listDeployments(input: {
    limit: number;
    projectId?: string;
    target?: string;
  }): Promise<ReadonlyArray<VercelDeploymentSummary>> {
    const payload = await this.requestJson(
      `/v6/deployments${buildQuery({ limit: input.limit, projectId: input.projectId, target: input.target })}`,
      listDeploymentsResponseSchema,
    );

    return payload.deployments.map((deployment) => ({
      id: deployment.uid,
      projectName: deployment.name,
      url: deployment.url,
      state: deployment.state,
      target: toNullableString(deployment.target),
      createdAt: toIsoTimestamp(deployment.created),
      readyState: toNullableString(deployment.readyState),
    }));
  }

  public async getDeployment(deploymentId: string): Promise<VercelDeploymentDetail> {
    const payload = await this.requestJson(`/v13/deployments/${encodeURIComponent(deploymentId)}`, deploymentResponseSchema);

    return {
      id: payload.uid,
      projectName: payload.name,
      url: payload.url,
      state: payload.state,
      target: toNullableString(payload.target),
      createdAt: toIsoTimestamp(payload.created),
      readyState: toNullableString(payload.readyState),
      alias: payload.alias ?? [],
      inspectorUrl: toNullableString(payload.inspectorUrl),
      creator: {
        id: payload.creator?.uid ?? null,
        username: toNullableString(payload.creator?.username),
        email: toNullableString(payload.creator?.email),
      },
      meta: payload.meta ?? {},
    };
  }

  public async getAccountSummary(): Promise<VercelAccountSummary> {
    const payload = await this.requestJson("/v2/user", accountResponseSchema);

    return {
      id: payload.id,
      username: toNullableString(payload.username),
      email: toNullableString(payload.email),
      name: toNullableString(payload.name),
      defaultTeamId: toNullableString(payload.defaultTeamId),
    };
  }

  private async requestJson<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const url = new URL(path, this.baseUrl);
    if (this.teamId) {
      url.searchParams.set("teamId", this.teamId);
    }

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new ExternalServiceError(`Vercel request failed with status ${response.status}.`, {
        statusCode: response.status,
        details: body,
      });
    }

    const payload: unknown = await response.json();
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError("Vercel returned an unexpected response shape.", {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }
}

export class VercelServer extends ToolkitServer {
  private readonly client: VercelClient;

  public constructor(client: VercelClient) {
    super(metadata);
    this.client = client;

    this.registerTool(
      defineTool({
        name: "list_projects",
        title: "List Vercel projects",
        description: "List Vercel projects that the current token can access.",
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(20),
          search: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          projects: z.array(projectSummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ limit, search }, context) => {
          await context.log("info", "Listing Vercel projects");
          const request: { limit: number; search?: string } = { limit };
          if (search !== undefined) {
            request.search = search;
          }
          const projects = await this.client.listProjects(request);
          return {
            projects: [...projects],
            returned: projects.length,
          };
        },
        renderText: ({ projects, returned }) => {
          if (returned === 0) {
            return "No Vercel projects found.";
          }
          return projects.map((project) => `${project.name} (${project.id})`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "list_deployments",
        title: "List deployments",
        description: "List recent Vercel deployments, optionally scoped to a project.",
        inputSchema: {
          limit: z.number().int().min(1).max(50).default(10),
          projectId: z.string().trim().min(1).optional(),
          target: z.enum(["production", "preview"]).optional(),
        },
        outputSchema: {
          deployments: z.array(deploymentSummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ limit, projectId, target }, context) => {
          await context.log("info", "Listing Vercel deployments");
          const request: { limit: number; projectId?: string; target?: string } = { limit };
          if (projectId !== undefined) {
            request.projectId = projectId;
          }
          if (target !== undefined) {
            request.target = target;
          }
          const deployments = await this.client.listDeployments(request);
          return {
            deployments: [...deployments],
            returned: deployments.length,
          };
        },
        renderText: ({ deployments, returned }) => {
          if (returned === 0) {
            return "No deployments found.";
          }
          return deployments.map((deployment) => `${deployment.projectName}: ${deployment.state} (${deployment.id})`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "get_deployment",
        title: "Get deployment",
        description: "Fetch details for a specific Vercel deployment.",
        inputSchema: {
          deploymentId: z.string().trim().min(1),
        },
        outputSchema: {
          deployment: deploymentDetailSchema,
        },
        handler: async ({ deploymentId }, context) => {
          await context.log("info", `Fetching deployment ${deploymentId}`);
          return {
            deployment: await this.client.getDeployment(deploymentId),
          };
        },
        renderText: ({ deployment }) => `${deployment.projectName} deployment ${deployment.id} is ${deployment.state}`,
      }),
    );

    this.registerStaticResource(
      "account",
      "vercel://account",
      {
        title: "Vercel account",
        description: "Authenticated Vercel account summary.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.client.getAccountSummary()),
    );

    this.registerPrompt(
      "deployment-audit",
      {
        title: "Deployment audit",
        description: "Draft an audit plan for a Vercel deployment or project.",
        argsSchema: {
          target: z.string().trim().min(1),
          deploymentId: z.string().trim().min(1).optional(),
          focus: z.string().trim().min(1).optional(),
        },
      },
      async ({ target, deploymentId, focus }) =>
        this.createTextPrompt(
          [
            `Audit the Vercel target \"${target}\"${deploymentId ? ` using deployment ${deploymentId}` : ""}.`,
            "Check deployment state, aliases, runtime configuration, rollback readiness, and production impact.",
            focus ? `Pay extra attention to: ${focus}.` : "Highlight the highest-risk operational gaps first.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(options: CreateVercelServerOptions = {}): Promise<VercelServer> {
  if (options.client) {
    return new VercelServer(options.client);
  }

  const env = resolveEnv(options.env);
  const client = new FetchVercelClient({
    token: env.VERCEL_TOKEN,
    fetch: options.fetch ?? globalThis.fetch,
    ...(env.VERCEL_TEAM_ID ? { teamId: env.VERCEL_TEAM_ID } : {}),
    ...(env.VERCEL_API_BASE_URL ? { baseUrl: env.VERCEL_API_BASE_URL } : {}),
  });

  return new VercelServer(client);
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
