import { describe, expect, it } from "vitest";

import { createServer, serverCard, type MongoDbClient, type MongoDbEnv } from "../src/index.js";

const env: MongoDbEnv = {
  MONGODB_URI: "mongodb://localhost:27017/app",
  MONGODB_DATABASE: "app",
  MONGODB_ALLOW_WRITE_PIPELINES: false,
  MONGODB_MAX_DOCUMENTS: 25,
  MONGODB_RESOURCE_COLLECTION_LIMIT: 10,
};

const fakeClient: MongoDbClient = {
  async listCollections() {
    return {
      database: "app",
      collections: [
        {
          name: "users",
          type: "collection",
          options: {},
        },
      ],
    };
  },
  async findDocuments() {
    return {
      database: "app",
      collection: "users",
      documents: [{ _id: "abc", email: "user@example.com" }],
    };
  },
  async aggregateDocuments() {
    return {
      database: "app",
      collection: "users",
      documents: [{ status: "active", count: 4 }],
    };
  },
};

describe("server-mongodb smoke", () => {
  it("creates the configured MongoDB server surface", async () => {
    const server = createServer({ env, client: fakeClient });

    expect(server.getToolNames()).toEqual(["aggregate-documents", "find-documents", "list-collections"]);
    expect(server.getResourceNames()).toEqual(["cluster-overview"]);
    expect(server.getPromptNames()).toEqual(["data-summary"]);
    expect(serverCard.authentication.required).toEqual(["MONGODB_URI"]);

    await expect(server.invokeTool("find-documents", { collection: "users" })).resolves.toMatchObject({
      returnedDocuments: 1,
      documents: [{ email: "user@example.com" }],
    });
  });

  it("blocks write aggregation stages unless explicitly enabled", async () => {
    const server = createServer({ env, client: fakeClient });

    await expect(
      server.invokeTool("aggregate-documents", {
        collection: "users",
        pipeline: [{ $out: "users_summary" }],
        allowWriteStage: true,
      }),
    ).rejects.toThrow("Aggregation pipelines with $out or $merge are blocked by default");
  });
});
