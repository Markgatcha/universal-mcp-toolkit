import { describe, expect, it } from "vitest";

import { createServer, serverCard, type SupabaseClient, type SupabaseEnv } from "../src/index.js";

const env: SupabaseEnv = {
  SUPABASE_URL: "https://demo.supabase.co",
  SUPABASE_KEY: "service-role-key",
  SUPABASE_SCHEMA: "public",
  SUPABASE_MAX_ROWS: 25,
  SUPABASE_BUCKET_LIMIT: 10,
};

const fakeClient: SupabaseClient = {
  async listTables({ schema }) {
    return {
      schema,
      tables: [
        {
          schema,
          name: "profiles",
          type: "BASE TABLE",
        },
      ],
    };
  },
  async queryTable({ schema, table }) {
    return {
      schema,
      table,
      rows: [{ id: "user-1", email: "user@example.com" }],
    };
  },
  async listStorageBuckets() {
    return [
      {
        id: "avatars",
        name: "avatars",
        public: true,
        fileSizeLimit: 1000000,
        allowedMimeTypes: ["image/png"],
        createdAt: "2024-01-01T00:00:00.000Z",
      },
    ];
  },
};

describe("server-supabase smoke", () => {
  it("creates the Supabase server surface", async () => {
    const server = createServer({ env, client: fakeClient });

    expect(server.getToolNames()).toEqual(["list-storage-buckets", "list-tables", "query-table"]);
    expect(server.getResourceNames()).toEqual(["project-overview"]);
    expect(server.getPromptNames()).toEqual(["incident-response"]);
    expect(serverCard.authentication.required).toEqual(["SUPABASE_URL", "SUPABASE_KEY"]);

    await expect(server.invokeTool("query-table", { table: "profiles" })).resolves.toMatchObject({
      rowCount: 1,
      rows: [{ email: "user@example.com" }],
    });
  });

  it("returns storage buckets through the injected client", async () => {
    const server = createServer({ env, client: fakeClient });

    await expect(server.invokeTool("list-storage-buckets", {})).resolves.toMatchObject({
      bucketCount: 1,
      buckets: [{ name: "avatars", public: true }],
    });
  });
});
