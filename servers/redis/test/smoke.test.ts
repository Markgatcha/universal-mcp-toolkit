import { describe, expect, it } from "vitest";

import { createServer, serverCard, type RedisClient, type RedisEnv } from "../src/index.js";

const env: RedisEnv = {
  REDIS_URL: "redis://localhost:6379",
  REDIS_ALLOW_WRITES: false,
  REDIS_DEFAULT_TTL_SECONDS: 0,
  REDIS_VALUE_SAMPLE_LIMIT: 10,
  REDIS_RESOURCE_SCAN_PATTERN: "cache:*",
  REDIS_RESOURCE_KEY_LIMIT: 5,
};

const fakeClient: RedisClient = {
  async getKey({ key }) {
    return {
      key,
      exists: true,
      keyType: "string",
      ttlSeconds: 60,
      value: "cached-response",
      preview: "cached-response",
      size: 15,
    };
  },
  async setKey({ key, ttlSeconds }) {
    return {
      key,
      stored: true,
      ttlSeconds,
    };
  },
  async inspectServerInfo() {
    return {
      section: "server",
      properties: [
        {
          name: "redis_version",
          value: "7.2.0",
        },
      ],
      raw: "redis_version:7.2.0",
    };
  },
  async listKeys() {
    return ["cache:users:1"];
  },
};

describe("server-redis smoke", () => {
  it("creates the Redis server surface", async () => {
    const server = createServer({ env, client: fakeClient });

    expect(server.getToolNames()).toEqual(["get-key", "inspect-server-info", "set-key"]);
    expect(server.getResourceNames()).toEqual(["cache-overview"]);
    expect(server.getPromptNames()).toEqual(["cache-debug"]);
    expect(serverCard.authentication.required).toEqual(["REDIS_URL"]);

    await expect(server.invokeTool("get-key", { key: "cache:users:1" })).resolves.toMatchObject({
      keyType: "string",
      ttlSeconds: 60,
    });
  });

  it("blocks writes unless both write guards are enabled", async () => {
    const server = createServer({ env, client: fakeClient });

    await expect(
      server.invokeTool("set-key", {
        key: "cache:users:1",
        value: "new-value",
        allowWrite: true,
      }),
    ).rejects.toThrow("Redis writes are disabled by default");
  });
});
