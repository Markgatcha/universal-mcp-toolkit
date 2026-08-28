import { describe, expect, it } from "vitest";

import {
  PlaywrightMcpServer,
  metadata,
  serverCard,
  type PlaywrightBrowserLike,
  type PlaywrightPageLike,
} from "../src/index.js";

function createFakePage(): PlaywrightPageLike & { navigatedUrls: string[] } {
  const navigatedUrls: string[] = [];
  const page = {
    navigatedUrls,
    goto: async (url: string) => {
      navigatedUrls.push(url);
      return null;
    },
    screenshot: async () => Buffer.from("fake-png"),
    click: async () => {},
    fill: async () => {},
    evaluate: async (expression: string) => `evaluated:${expression}`,
    innerText: async () => "Element text",
    $$eval: async () => ["https://example.com/a", "https://example.com/b"],
    waitForSelector: async () => null,
    close: async () => {},
  };
  return page;
}

function createFakeLauncher(page: PlaywrightPageLike) {
  let launched = 0;
  const browser: PlaywrightBrowserLike = {
    newPage: async () => page,
    close: async () => {},
  };
  const launcher = async () => {
    launched += 1;
    return browser;
  };
  return { launcher, getLaunchedCount: () => launched };
}

describe("PlaywrightMcpServer smoke", () => {
  it("registers every declared tool (count > 0)", () => {
    const page = createFakePage();
    const { launcher } = createFakeLauncher(page);
    const server = new PlaywrightMcpServer({ launcher });
    try {
      expect(server.getToolNames().length).toBeGreaterThan(0);
      expect([...server.getToolNames()]).toEqual([...metadata.toolNames].sort());
      expect(serverCard.tools).toEqual(metadata.toolNames);
    } finally {
      void server.close();
    }
  });

  it("navigates lazily through the injected launcher", async () => {
    const page = createFakePage();
    const { launcher, getLaunchedCount } = createFakeLauncher(page);
    const server = new PlaywrightMcpServer({ launcher });
    try {
      expect(getLaunchedCount()).toBe(0);
      const result = await server.invokeTool<{ url: string; navigated: boolean }>("playwright_navigate", {
        url: "https://example.com",
      });
      expect(result.navigated).toBe(true);
      expect(page.navigatedUrls).toEqual(["https://example.com"]);
      expect(getLaunchedCount()).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("reads element text and collects links through the fake page", async () => {
    const page = createFakePage();
    const { launcher } = createFakeLauncher(page);
    const server = new PlaywrightMcpServer({ launcher });
    try {
      const text = await server.invokeTool<{ text: string }>("playwright_get_text", { selector: "h1" });
      expect(text.text).toBe("Element text");

      const links = await server.invokeTool<{ links: string[]; linkCount: number }>("playwright_get_links", {});
      expect(links.linkCount).toBe(2);
    } finally {
      await server.close();
    }
  });
});
