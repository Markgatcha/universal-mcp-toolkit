import { describe, expect, it } from "vitest";

import {
  createServer,
  metadata,
  serverCard,
  type DockerContainerDetail,
  type DockerContainerSummary,
  type DockerDaemonSummary,
  type DockerImageSummary,
  type DockerToolkitClient,
} from "../src/index.js";

class FakeDockerClient implements DockerToolkitClient {
  public async listContainers(): Promise<ReadonlyArray<DockerContainerSummary>> {
    return [
      {
        id: "abc123",
        name: "api",
        image: "api:latest",
        state: "running",
        status: "Up 5 minutes",
        createdAt: "2024-01-01T00:00:00.000Z",
        networks: ["bridge"],
        ports: [
          {
            privatePort: 3000,
            publicPort: 3000,
            type: "tcp",
            hostIp: "0.0.0.0",
          },
        ],
        mounts: 1,
      },
    ];
  }

  public async inspectContainer(): Promise<DockerContainerDetail> {
    return {
      id: "abc123",
      name: "api",
      image: "api:latest",
      state: "running",
      status: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      networks: ["bridge"],
      ports: [
        {
          privatePort: 3000,
          publicPort: 3000,
          type: "tcp",
          hostIp: "0.0.0.0",
        },
      ],
      mounts: 1,
      command: ["node", "server.js"],
      restartCount: 0,
      health: "healthy",
      env: ["NODE_ENV=production"],
      mountsDetail: [
        {
          source: "/data",
          destination: "/app/data",
          type: "bind",
          readOnly: false,
        },
      ],
    };
  }

  public async listImages(): Promise<ReadonlyArray<DockerImageSummary>> {
    return [
      {
        id: "img123",
        tags: ["api:latest"],
        createdAt: "2024-01-01T00:00:00.000Z",
        sizeBytes: 1024,
        containers: 1,
        labels: {
          service: "api",
        },
      },
    ];
  }

  public async getDaemonSummary(): Promise<DockerDaemonSummary> {
    return {
      id: "daemon123",
      name: "docker-desktop",
      operatingSystem: "Docker Desktop",
      serverVersion: "27.0.0",
      containers: 3,
      images: 5,
      architecture: "x86_64",
    };
  }
}

describe("docker smoke", () => {
  it("registers daemon resources and invokes core inspection tools", async () => {
    const server = await createServer({ client: new FakeDockerClient() });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const containers = await server.invokeTool<{ containers: ReadonlyArray<{ name: string }>; returned: number }>(
        "list_containers",
        { all: true, limit: 10 },
      );
      expect(containers.returned).toBe(1);
      expect(containers.containers[0]?.name).toBe("api");

      const imageList = await server.invokeTool<{ images: ReadonlyArray<{ tags: ReadonlyArray<string> }> }>(
        "list_images",
        { all: true, limit: 10 },
      );
      expect(imageList.images[0]?.tags[0]).toBe("api:latest");
    } finally {
      await server.close();
    }
  });
});
