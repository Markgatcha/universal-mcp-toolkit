import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AirtableServer,
  createServer,
  metadata,
  serverCard,
  type AirtableClient,
  type AirtableRecordSummary,
  type AirtableTableSummary,
} from "../src/index.js";

function createFakeClient() {
  const listTables = vi.fn<AirtableClient["listTables"]>().mockResolvedValue([
    { id: "tbl123", name: "Projects", fieldCount: 5 },
    { id: "tbl456", name: "Tasks", fieldCount: 8 },
  ]);

  const getRecords = vi.fn<AirtableClient["getRecords"]>().mockResolvedValue([
    { id: "rec100", fields: { Name: "Project Alpha", Status: "Active" }, createdTime: "2025-01-01T00:00:00.000Z" },
    { id: "rec101", fields: { Name: "Project Beta", Status: "Done" }, createdTime: "2025-02-01T00:00:00.000Z" },
  ]);

  const createRecord = vi.fn<AirtableClient["createRecord"]>().mockResolvedValue({
    id: "rec999",
    fields: { Name: "New Project", Status: "Pending" },
    createdTime: "2025-06-01T00:00:00.000Z",
  });

  const updateRecord = vi.fn<AirtableClient["updateRecord"]>().mockResolvedValue({
    id: "rec100",
    fields: { Name: "Project Alpha", Status: "Completed" },
  });

  const deleteRecord = vi.fn<AirtableClient["deleteRecord"]>().mockResolvedValue({
    id: "rec100",
    deleted: true,
  });

  const client: AirtableClient = { listTables, getRecords, createRecord, updateRecord, deleteRecord };
  return { client, listTables, getRecords, createRecord, updateRecord, deleteRecord };
}

const servers: AirtableServer[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("AirtableServer", () => {
  it("registers all five tools and validates metadata", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
    expect(serverCard.tools).toEqual(metadata.toolNames);
  });

  it("list_tables returns table summaries", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ tables: AirtableTableSummary[]; returnedCount: number }>("airtable_list_tables", {});
    expect(result.returnedCount).toBe(2);
    expect(result.tables[0]?.name).toBe("Projects");
    expect(fake.listTables).toHaveBeenCalledTimes(1);
  });

  it("get_records returns record summaries", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ records: AirtableRecordSummary[]; returnedCount: number }>("airtable_get_records", {
      tableName: "Projects",
      maxRecords: 10,
    });
    expect(result.returnedCount).toBe(2);
    expect(result.records[0]?.fields["Name"]).toBe("Project Alpha");
    expect(fake.getRecords).toHaveBeenCalledWith("Projects", undefined, 10);
  });

  it("create_record returns the created record", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string }>("airtable_create_record", {
      tableName: "Projects",
      fields: { Name: "New Project", Status: "Pending" },
    });
    expect(result.id).toBe("rec999");
    expect(fake.createRecord).toHaveBeenCalledWith("Projects", { Name: "New Project", Status: "Pending" });
  });

  it("update_record returns the updated record", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string; fields: Record<string, unknown> }>("airtable_update_record", {
      tableName: "Projects",
      recordId: "rec100",
      fields: { Status: "Completed" },
    });
    expect(result.id).toBe("rec100");
    expect(result.fields["Status"]).toBe("Completed");
    expect(fake.updateRecord).toHaveBeenCalledWith("Projects", "rec100", { Status: "Completed" });
  });

  it("delete_record returns deletion confirmation", async () => {
    const fake = createFakeClient();
    const server = new AirtableServer({ baseId: "appTest", client: fake.client });
    servers.push(server);

    const result = await server.invokeTool<{ id: string; deleted: boolean }>("airtable_delete_record", {
      tableName: "Projects",
      recordId: "rec100",
    });
    expect(result.id).toBe("rec100");
    expect(result.deleted).toBe(true);
    expect(fake.deleteRecord).toHaveBeenCalledWith("Projects", "rec100");
  });

  it("createServer validates env and constructs with injected client", () => {
    const fake = createFakeClient();
    const server = createServer({
      client: fake.client,
      env: { AIRTABLE_API_KEY: "test-key", AIRTABLE_BASE_ID: "appTest" },
    });
    servers.push(server);
    expect(server.getToolNames()).toEqual([...metadata.toolNames].sort());
  });

  it("createServer throws on missing AIRTABLE_API_KEY", () => {
    expect(() => createServer({ env: { AIRTABLE_BASE_ID: "appTest" } })).toThrow("Environment validation failed.");
  });

  it("createServer throws on missing AIRTABLE_BASE_ID", () => {
    expect(() => createServer({ env: { AIRTABLE_API_KEY: "test-key" } })).toThrow("Environment validation failed.");
  });
});
