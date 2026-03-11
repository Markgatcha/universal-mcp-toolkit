import { describe, expect, it } from "vitest";

import {
  createServer,
  metadata,
  serverCard,
  type NpmPackageMetadata,
  type NpmRegistryClient,
  type NpmSearchResult,
} from "../src/index.js";

class FakeNpmRegistryClient implements NpmRegistryClient {
  public async searchPackages(): Promise<ReadonlyArray<NpmSearchResult>> {
    return [
      {
        name: "toolkit-demo",
        version: "1.2.3",
        description: "Demo package",
        keywords: ["demo"],
        score: 0.91,
        homepage: "https://example.com",
        npmUrl: "https://npmjs.com/package/toolkit-demo",
        repositoryUrl: "https://github.com/example/toolkit-demo",
      },
    ];
  }

  public async getPackageMetadata(): Promise<NpmPackageMetadata> {
    return {
      name: "toolkit-demo",
      description: "Demo package",
      latestVersion: "1.2.3",
      homepage: "https://example.com",
      repositoryUrl: "https://github.com/example/toolkit-demo",
      license: "MIT",
      distTags: {
        latest: "1.2.3",
      },
      maintainers: [
        {
          name: "marki",
          email: "marki@example.com",
        },
      ],
      versions: [
        {
          version: "1.2.3",
          publishedAt: "2024-01-01T00:00:00.000Z",
          deprecated: false,
          unpackedSize: 2048,
        },
      ],
    };
  }
}

describe("npm registry smoke", () => {
  it("registers package discovery tools and prompts", async () => {
    const server = await createServer({ client: new FakeNpmRegistryClient() });

    try {
      expect(serverCard.tools).toEqual(metadata.toolNames);
      expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
      expect(server.getResourceNames()).toEqual([...metadata.resourceNames].sort());
      expect(server.getPromptNames()).toEqual([...metadata.promptNames].sort());

      const results = await server.invokeTool<{ results: ReadonlyArray<{ name: string }>; returned: number }>(
        "search_packages",
        { query: "toolkit", limit: 5, from: 0 },
      );
      expect(results.returned).toBe(1);
      expect(results.results[0]?.name).toBe("toolkit-demo");

      const versions = await server.invokeTool<{ packageName: string; versions: ReadonlyArray<{ version: string }> }>(
        "list_package_versions",
        { packageName: "toolkit-demo", limit: 5 },
      );
      expect(versions.packageName).toBe("toolkit-demo");
      expect(versions.versions[0]?.version).toBe("1.2.3");
    } finally {
      await server.close();
    }
  });
});
