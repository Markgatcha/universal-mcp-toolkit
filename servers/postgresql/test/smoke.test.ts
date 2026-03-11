import { describe, expect, it } from "vitest";

import { createServer, serverCard, type PostgreSqlClient, type PostgreSqlEnv } from "../src/index.js";

const env: PostgreSqlEnv = {
  POSTGRESQL_URL: "postgresql://localhost:5432/app",
  POSTGRESQL_SCHEMA: "public",
  POSTGRESQL_ALLOW_WRITES: false,
  POSTGRESQL_SSL: false,
  POSTGRESQL_MAX_RESULT_ROWS: 25,
  POSTGRESQL_RESOURCE_TABLE_LIMIT: 10,
};

const fakeClient: PostgreSqlClient = {
  async listTables() {
    return {
      database: "app",
      tables: [
        {
          schema: "public",
          name: "users",
          type: "BASE TABLE",
        },
      ],
    };
  },
  async describeTable() {
    return {
      database: "app",
      schema: "public",
      table: "users",
      columns: [
        {
          name: "id",
          ordinalPosition: 1,
          dataType: "uuid",
          isNullable: false,
          defaultValue: null,
          maxLength: null,
          numericPrecision: null,
          numericScale: null,
          comment: "Primary key",
        },
      ],
      constraints: [
        {
          name: "users_pkey",
          type: "PRIMARY KEY",
          columns: ["id"],
        },
      ],
    };
  },
  async runQuery() {
    return {
      rowCount: 1,
      fields: [
        {
          name: "count",
          dataType: null,
        },
      ],
      rows: [{ count: 1 }],
    };
  },
};

describe("server-postgresql smoke", () => {
  it("creates a server with tools, resources, and prompts", async () => {
    const server = createServer({ env, client: fakeClient });

    expect(server.getToolNames()).toEqual(["describe-table", "list-tables", "run-query"]);
    expect(server.getResourceNames()).toEqual(["schema-overview"]);
    expect(server.getPromptNames()).toEqual(["query-review"]);
    expect(serverCard.authentication.required).toEqual(["POSTGRESQL_URL"]);

    await expect(server.invokeTool("list-tables", {})).resolves.toMatchObject({
      tableCount: 1,
      tables: [{ name: "users" }],
    });
  });

  it("blocks write queries unless both guards are enabled", async () => {
    const server = createServer({ env, client: fakeClient });

    await expect(
      server.invokeTool("run-query", {
        sql: "insert into users(id) values('1')",
        allowWrite: true,
      }),
    ).rejects.toThrow("Mutating SQL is blocked by default");
  });
});
