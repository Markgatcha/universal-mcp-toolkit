import {
  createServerCard,
  defineTool,
  loadEnv,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
} from "@universal-mcp-toolkit/core";
import Docker from "dockerode";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const toolNames = ["list_containers", "inspect_container", "list_images"] as const;
const resourceNames = ["daemon"] as const;
const promptNames = ["incident-debug"] as const;

export const metadata: ToolkitServerMetadata = {
  id: "docker",
  title: "Docker MCP Server",
  description: "Container, image, and daemon inspection tools for Docker.",
  version: "0.1.0",
  packageName: "@universal-mcp-toolkit/server-docker",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit/tree/main/servers/docker",
  envVarNames: [],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames,
  promptNames,
};

export const serverCard = createServerCard(metadata);

const envShape = {
  DOCKER_HOST: z.string().min(1).optional(),
  DOCKER_SOCKET_PATH: z.string().min(1).optional(),
};

type DockerEnv = z.infer<z.ZodObject<typeof envShape>>;

const portBindingSchema = z.object({
  privatePort: z.number().int().nonnegative(),
  publicPort: z.number().int().nonnegative().nullable(),
  type: z.string(),
  hostIp: z.string().nullable(),
});

const mountSummarySchema = z.object({
  source: z.string(),
  destination: z.string(),
  type: z.string(),
  readOnly: z.boolean(),
});

const containerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  image: z.string(),
  state: z.string(),
  status: z.string(),
  createdAt: z.string().nullable(),
  networks: z.array(z.string()),
  ports: z.array(portBindingSchema),
  mounts: z.number().int().nonnegative(),
});

const containerDetailSchema = containerSummarySchema.extend({
  command: z.array(z.string()),
  restartCount: z.number().int().nonnegative(),
  health: z.string().nullable(),
  env: z.array(z.string()),
  mountsDetail: z.array(mountSummarySchema),
});

const imageSummarySchema = z.object({
  id: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string().nullable(),
  sizeBytes: z.number().nonnegative(),
  containers: z.number().int(),
  labels: z.record(z.string(), z.string()),
});

const daemonSummarySchema = z.object({
  id: z.string().nullable(),
  name: z.string().nullable(),
  operatingSystem: z.string().nullable(),
  serverVersion: z.string().nullable(),
  containers: z.number().int().nonnegative(),
  images: z.number().int().nonnegative(),
  architecture: z.string().nullable(),
});

export type DockerContainerSummary = z.infer<typeof containerSummarySchema>;
export type DockerContainerDetail = z.infer<typeof containerDetailSchema>;
export type DockerImageSummary = z.infer<typeof imageSummarySchema>;
export type DockerDaemonSummary = z.infer<typeof daemonSummarySchema>;

export interface DockerToolkitClient {
  listContainers(input: { all: boolean; limit: number }): Promise<ReadonlyArray<DockerContainerSummary>>;
  inspectContainer(containerId: string): Promise<DockerContainerDetail>;
  listImages(input: { all: boolean; limit: number }): Promise<ReadonlyArray<DockerImageSummary>>;
  getDaemonSummary(): Promise<DockerDaemonSummary>;
}

export interface CreateDockerServerOptions {
  client?: DockerToolkitClient;
  env?: NodeJS.ProcessEnv;
}

const dockerInfoSchema = z.object({
  ID: z.string().optional(),
  Name: z.string().optional(),
  OperatingSystem: z.string().optional(),
  ServerVersion: z.string().optional(),
  Containers: z.number().int().nonnegative().optional(),
  Images: z.number().int().nonnegative().optional(),
  Architecture: z.string().optional(),
});

function resolveEnv(source: NodeJS.ProcessEnv = process.env): DockerEnv {
  return loadEnv(envShape, source);
}

function toNullableString(value: string | undefined | null): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIsoTimestamp(value: number | undefined): string | null {
  return typeof value === "number" ? new Date(value * 1000).toISOString() : null;
}

function toPortBindings(ports: ReadonlyArray<Docker.Port>): Array<z.infer<typeof portBindingSchema>> {
  return ports.map((port) => ({
    privatePort: port.PrivatePort,
    publicPort: typeof port.PublicPort === "number" ? port.PublicPort : null,
    type: port.Type,
    hostIp: toNullableString(port.IP),
  }));
}

function toMountSummaries(
  mounts: ReadonlyArray<{ Source: string; Destination: string; Type: string; RW: boolean }>,
): Array<z.infer<typeof mountSummarySchema>> {
  return mounts.map((mount) => ({
    source: mount.Source,
    destination: mount.Destination,
    type: mount.Type,
    readOnly: !mount.RW,
  }));
}

class DockerodeClient implements DockerToolkitClient {
  private readonly docker: Docker;

  public constructor(docker: Docker) {
    this.docker = docker;
  }

  public async listContainers(input: { all: boolean; limit: number }): Promise<ReadonlyArray<DockerContainerSummary>> {
    const containers = await this.docker.listContainers({ all: input.all });
    return containers.slice(0, input.limit).map((container) => ({
      id: container.Id,
      name: container.Names[0]?.replace(/^\//, "") ?? container.Id.slice(0, 12),
      image: container.Image,
      state: container.State,
      status: container.Status,
      createdAt: toIsoTimestamp(container.Created),
      networks: [...Object.keys(container.NetworkSettings.Networks)],
      ports: toPortBindings(container.Ports),
      mounts: container.Mounts.length,
    }));
  }

  public async inspectContainer(containerId: string): Promise<DockerContainerDetail> {
    const container = await this.docker.getContainer(containerId).inspect();
    return {
      id: container.Id,
      name: container.Name.replace(/^\//, ""),
      image: container.Config.Image,
      state: container.State.Status,
      status: container.State.Running ? "running" : "stopped",
      createdAt: toNullableString(container.Created),
      networks: [...Object.keys(container.NetworkSettings.Networks)],
      ports: Object.entries(container.NetworkSettings.Ports).flatMap<z.infer<typeof portBindingSchema>>(([name, bindings]) => {
        const [privatePortText, portType = "tcp"] = name.split("/");
        const privatePort = Number.parseInt(privatePortText ?? "0", 10);
        const safePrivatePort = Number.isFinite(privatePort) ? privatePort : 0;
        if (!bindings || bindings.length === 0) {
          return [
            {
              privatePort: safePrivatePort,
              publicPort: null,
              type: portType,
              hostIp: null,
            },
          ];
        }
        return bindings.map((binding) => ({
          privatePort: safePrivatePort,
          publicPort: binding.HostPort ? Number.parseInt(binding.HostPort, 10) : null,
          type: portType,
          hostIp: toNullableString(binding.HostIp),
        }));
      }),
      mounts: container.Mounts.length,
      command: [...(container.Config.Cmd ?? [])],
      restartCount: container.RestartCount,
      health: toNullableString(container.State.Health?.Status),
      env: [...(container.Config.Env ?? [])],
      mountsDetail: toMountSummaries(container.Mounts),
    };
  }

  public async listImages(input: { all: boolean; limit: number }): Promise<ReadonlyArray<DockerImageSummary>> {
    const images = await this.docker.listImages({ all: input.all });
    return images.slice(0, input.limit).map((image) => ({
      id: image.Id,
      tags: [...(image.RepoTags ?? [])],
      createdAt: toIsoTimestamp(image.Created),
      sizeBytes: image.Size,
      containers: image.Containers,
      labels: { ...image.Labels },
    }));
  }

  public async getDaemonSummary(): Promise<DockerDaemonSummary> {
    const raw: unknown = await this.docker.info();
    const parsed = dockerInfoSchema.parse(raw);
    return {
      id: toNullableString(parsed.ID),
      name: toNullableString(parsed.Name),
      operatingSystem: toNullableString(parsed.OperatingSystem),
      serverVersion: toNullableString(parsed.ServerVersion),
      containers: parsed.Containers ?? 0,
      images: parsed.Images ?? 0,
      architecture: toNullableString(parsed.Architecture),
    };
  }
}

function createDockerClient(env: DockerEnv): DockerToolkitClient {
  if (env.DOCKER_HOST) {
    const url = new URL(env.DOCKER_HOST);
    const port = url.port.length > 0 ? Number.parseInt(url.port, 10) : url.protocol === "https:" ? 443 : 2375;
    return new DockerodeClient(
      new Docker({
        host: url.hostname,
        port,
        protocol: url.protocol === "https:" ? "https" : "http",
      }),
    );
  }

  return new DockerodeClient(
    new Docker({
      socketPath: env.DOCKER_SOCKET_PATH ?? (process.platform === "win32" ? "//./pipe/docker_engine" : "/var/run/docker.sock"),
    }),
  );
}

export class DockerServer extends ToolkitServer {
  private readonly client: DockerToolkitClient;

  public constructor(client: DockerToolkitClient) {
    super(metadata);
    this.client = client;

    this.registerTool(
      defineTool({
        name: "list_containers",
        title: "List containers",
        description: "List Docker containers running on the current daemon.",
        inputSchema: {
          all: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(25),
        },
        outputSchema: {
          containers: z.array(containerSummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ all, limit }, context) => {
          await context.log("info", "Listing Docker containers");
          const containers = await this.client.listContainers({ all, limit });
          return {
            containers: [...containers],
            returned: containers.length,
          };
        },
        renderText: ({ containers, returned }) => {
          if (returned === 0) {
            return "No Docker containers found.";
          }
          return containers.map((container) => `${container.name}: ${container.status}`).join("\n");
        },
      }),
    );

    this.registerTool(
      defineTool({
        name: "inspect_container",
        title: "Inspect container",
        description: "Inspect an individual Docker container.",
        inputSchema: {
          containerId: z.string().trim().min(1),
        },
        outputSchema: {
          container: containerDetailSchema,
        },
        handler: async ({ containerId }, context) => {
          await context.log("info", `Inspecting Docker container ${containerId}`);
          return {
            container: await this.client.inspectContainer(containerId),
          };
        },
        renderText: ({ container }) => `${container.name} (${container.id}) is ${container.state}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "list_images",
        title: "List images",
        description: "List Docker images available on the current daemon.",
        inputSchema: {
          all: z.boolean().default(false),
          limit: z.number().int().min(1).max(100).default(25),
        },
        outputSchema: {
          images: z.array(imageSummarySchema),
          returned: z.number().int(),
        },
        handler: async ({ all, limit }, context) => {
          await context.log("info", "Listing Docker images");
          const images = await this.client.listImages({ all, limit });
          return {
            images: [...images],
            returned: images.length,
          };
        },
        renderText: ({ images, returned }) => {
          if (returned === 0) {
            return "No Docker images found.";
          }
          return images.map((image) => `${image.tags[0] ?? image.id} (${image.sizeBytes} bytes)`).join("\n");
        },
      }),
    );

    this.registerStaticResource(
      "daemon",
      "docker://daemon",
      {
        title: "Docker daemon",
        description: "Summary information about the current Docker daemon.",
        mimeType: "application/json",
      },
      async (uri) => this.createJsonResource(uri.toString(), await this.client.getDaemonSummary()),
    );

    this.registerPrompt(
      "incident-debug",
      {
        title: "Incident debug prompt",
        description: "Draft a debugging checklist for a Docker container incident.",
        argsSchema: {
          containerId: z.string().trim().min(1),
          symptoms: z.string().trim().min(1),
          impact: z.string().trim().min(1).optional(),
        },
      },
      async ({ containerId, symptoms, impact }) =>
        this.createTextPrompt(
          [
            `Investigate Docker container ${containerId}.`,
            `Observed symptoms: ${symptoms}.`,
            impact ? `Business impact: ${impact}.` : "Include blast radius, rollback, logs, metrics, and image provenance checks.",
            "Prioritize immediate mitigations before deep root-cause work.",
          ].join(" "),
        ),
    );
  }
}

export async function createServer(options: CreateDockerServerOptions = {}): Promise<DockerServer> {
  const client = options.client ?? createDockerClient(resolveEnv(options.env));
  return new DockerServer(client);
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
