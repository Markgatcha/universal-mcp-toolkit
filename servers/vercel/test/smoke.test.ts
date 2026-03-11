import { describe, expect, it } from "vitest";

import {
  createServer,
  metadata,
  serverCard,
  type VercelAccountSummary,
  type VercelClient,
  type VercelDeploymentDetail,
  type VercelDeploymentSummary,
  type VercelProjectSummary,
} from "../src/index.js";

class FakeVercelClient implements VercelClient {
  public async listProjects(): Promise<ReadonlyArray<VercelProjectSummary>> {
    return [
      {
        id: "prj_123",
        name: "marketing-site",
        framework: "nextjs",
        latestProductionUrl: "https://marketing.example.com",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-02T00:00:00.000Z",
      },
    ];
  }

  public async listDeployments(): Promise<ReadonlyArray<VercelDeploymentSummary>> {
    return [
      {
        id: "dpl_123",
        projectName: "marketing-site",
        url: "marketing-site-git-main.vercel.app",
        state: "READY",
        target: "production",
        createdAt: "2024-01-02T00:00:00.000Z",
        readyState: "READY",
      },
    ];
  }

  public async getDeployment(): Promise<VercelDeploymentDetail> {
    return {
      id: "dpl_123",
      projectName: "marketing-site",
      url: "marketing-site-git-main.vercel.app",
      state: "READY",
      target: "production",
      createdAt: "2024-01-02T00:00:00.000Z",
      readyState: "READY",
      alias: ["marketing.example.com"],
      inspectorUrl: "https://vercel.com/acme/marketing-site/deployments/dpl_123",
      creator: {
        id: "usr_123",
        username: "marki",
        email: "marki@example.com",
      },
      meta: {
        gitBranch: "main",
      },
    };
  }

  public async getAccountSummary(): Promise<VercelAccountSummary> {
    return {
      id: "usr_123",
      username: "marki",
      email: "marki@example.com",
      name: "Marki",
      defaultTeamId: "team_123",
    };
  }
}

describe("vercel smoke", () => {
  it("registers metadata and invokes tools with an injected client", async () => {
    const server = await createServer({ client: new FakeVercelClient() });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const projects = await server.invokeTool<{ projects: ReadonlyArray<{ name: string }>; returned: number }>(
        "list_projects",
        { limit: 5 },
      );
      expect(projects.returned).toBe(1);
      expect(projects.projects[0]?.name).toBe("marketing-site");

      const deployment = await server.invokeTool<{ deployment: { state: string; alias: ReadonlyArray<string> } }>(
        "get_deployment",
        { deploymentId: "dpl_123" },
      );
      expect(deployment.deployment.state).toBe("READY");
      expect(deployment.deployment.alias).toContain("marketing.example.com");
    } finally {
      await server.close();
    }
  });
});
