import { describe, expect, it } from "vitest";

import {
  createServer,
  metadata,
  serverCard,
  type CloudflareAccountSummary,
  type CloudflareRoute,
  type CloudflareWorkerDetail,
  type CloudflareWorkerSummary,
  type CloudflareWorkersClient,
} from "../src/index.js";

class FakeCloudflareWorkersClient implements CloudflareWorkersClient {
  public async listWorkers(): Promise<ReadonlyArray<CloudflareWorkerSummary>> {
    return [
      {
        name: "edge-cache",
        createdAt: "2024-01-01T00:00:00.000Z",
        modifiedAt: "2024-01-03T00:00:00.000Z",
        usageModel: "bundled",
        handlers: ["fetch"],
        compatibilityDate: "2024-01-15",
      },
    ];
  }

  public async getWorker(): Promise<CloudflareWorkerDetail> {
    return {
      name: "edge-cache",
      createdAt: "2024-01-01T00:00:00.000Z",
      modifiedAt: "2024-01-03T00:00:00.000Z",
      usageModel: "bundled",
      handlers: ["fetch"],
      compatibilityDate: "2024-01-15",
      bindingsCount: 2,
      placementMode: "smart",
      logpush: true,
    };
  }

  public async listRoutes(): Promise<ReadonlyArray<CloudflareRoute>> {
    return [
      {
        id: "route_123",
        pattern: "example.com/*",
        script: "edge-cache",
        zoneName: "example.com",
      },
    ];
  }

  public async getAccountSummary(): Promise<CloudflareAccountSummary> {
    return {
      id: "acc_123",
      name: "Acme",
      type: "standard",
    };
  }
}

describe("cloudflare workers smoke", () => {
  it("registers account resources and worker tools", async () => {
    const server = await createServer({ client: new FakeCloudflareWorkersClient() });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const workers = await server.invokeTool<{ workers: ReadonlyArray<{ name: string }>; returned: number }>(
        "list_workers",
        { limit: 5 },
      );
      expect(workers.returned).toBe(1);
      expect(workers.workers[0]?.name).toBe("edge-cache");

      const routes = await server.invokeTool<{ routes: ReadonlyArray<{ pattern: string }> }>("list_routes", { limit: 5 });
      expect(routes.routes[0]?.pattern).toBe("example.com/*");
    } finally {
      await server.close();
    }
  });
});
