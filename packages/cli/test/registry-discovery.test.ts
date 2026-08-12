import { describe, expect, it, vi } from "vitest";

import { fetchRegistryServers } from "../src/registry-discovery.js";

describe("MCP Registry discovery", () => {
  it("follows opaque cursor pagination and returns registry server entries", async () => {
    const requestedUrls: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      requestedUrls.push(url.toString());
      const cursor = url.searchParams.get("cursor");

      return new Response(JSON.stringify(cursor
        ? {
            servers: [{ server: { name: "com.example/second", version: "2.0.0" } }],
            metadata: { count: 1 },
          }
        : {
            servers: [{ server: { name: "com.example/first", version: "1.0.0" } }],
            metadata: { count: 1, nextCursor: "opaque/cursor:value" },
          }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    const servers = await fetchRegistryServers(
      "https://registry.example.test/v0.1/servers",
      fetcher as typeof fetch,
    );

    expect(servers.map((entry) => entry.server.name)).toEqual([
      "com.example/first",
      "com.example/second",
    ]);
    expect(requestedUrls).toHaveLength(2);
    expect(new URL(requestedUrls[0]!).searchParams.get("limit")).toBe("100");
    expect(new URL(requestedUrls[1]!).searchParams.get("cursor")).toBe("opaque/cursor:value");
  });

  it("reports incompatible registry responses", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ results: [] }), { status: 200 }));

    await expect(fetchRegistryServers(
      "https://registry.example.test/v0.1/servers",
      fetcher as typeof fetch,
    )).rejects.toThrow("must contain a 'servers' array");
  });
});
