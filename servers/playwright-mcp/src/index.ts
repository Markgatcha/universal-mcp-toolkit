import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
  type ZodShape,
} from "@universal-mcp-toolkit/core";
import { z } from "zod";

const toolNames = [
  "playwright_navigate",
  "playwright_screenshot",
  "playwright_click",
  "playwright_fill",
  "playwright_evaluate",
  "playwright_get_text",
  "playwright_get_links",
  "playwright_wait_for",
  "playwright_close",
] as const;

const envShape = { PLAYWRIGHT_BROWSER: z.enum(["chromium", "firefox", "webkit"]).default("chromium") };

export const metadata: ToolkitServerMetadata = {
  id: "playwright-mcp",
  title: "Playwright MCP Server",
  description: "Browser automation and web scraping.",
  version: "1.2.0",
  packageName: "@contextcore/mcp-playwright",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://playwright.dev",
  envVarNames: [],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames: [],
  promptNames: [],
};

export const serverCard = createServerCard(metadata);

export type PlaywrightBrowserName = "chromium" | "firefox" | "webkit";

/** Minimal structural surface of a Playwright Page used by this server. */
export interface PlaywrightPageLike {
  goto(url: string, options?: { waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeout?: number }): Promise<unknown>;
  screenshot(options?: { path?: string; fullPage?: boolean }): Promise<Buffer>;
  click(selector: string, options?: { timeout?: number }): Promise<void>;
  fill(selector: string, value: string, options?: { timeout?: number }): Promise<void>;
  evaluate(expression: string): Promise<unknown>;
  innerText(selector: string, options?: { timeout?: number }): Promise<string>;
  $$eval(selector: string, pageFunction: (elements: Element[]) => unknown): Promise<unknown>;
  waitForSelector(selector: string, options?: { timeout?: number; state?: "attached" | "detached" | "visible" | "hidden" }): Promise<unknown>;
  close(): Promise<void>;
}

/** Minimal structural surface of a Playwright Browser used by this server. */
export interface PlaywrightBrowserLike {
  newPage(): Promise<PlaywrightPageLike>;
  close(): Promise<void>;
}

export type PlaywrightLauncher = (browserName: PlaywrightBrowserName) => Promise<PlaywrightBrowserLike>;

async function defaultLauncher(browserName: PlaywrightBrowserName): Promise<PlaywrightBrowserLike> {
  const { chromium, firefox, webkit } = await import("playwright");
  const engine = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;
  return engine.launch({ headless: true });
}

function wrapPlaywrightError(action: string, error: unknown): never {
  if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
    throw error;
  }
  const normalized = normalizeError(error);
  throw new ExternalServiceError(`Failed to ${action}. ${normalized.toClientMessage()}`, {
    details: normalized.details,
  });
}

export interface PlaywrightMcpServerOptions {
  browserName?: PlaywrightBrowserName;
  launcher?: PlaywrightLauncher;
}

export class PlaywrightMcpServer extends ToolkitServer {
  private browser: PlaywrightBrowserLike | null = null;
  private page: PlaywrightPageLike | null = null;
  private readonly browserName: PlaywrightBrowserName;
  private readonly launcher: PlaywrightLauncher;

  constructor(options: PlaywrightMcpServerOptions = {}) {
    super(metadata);
    this.browserName = options.browserName ?? "chromium";
    this.launcher = options.launcher ?? defaultLauncher;

    this.registerTool(
      defineTool({
        name: "playwright_navigate",
        title: "Navigate to a URL",
        description: "Open a URL in the managed browser page.",
        inputSchema: {
          url: z.string().url(),
          waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).default("load"),
          timeoutMs: z.number().int().positive().default(30_000),
        },
        outputSchema: {
          url: z.string(),
          navigated: z.boolean(),
        },
        handler: async (input, context) => {
          await context.log("info", `Navigating to ${input.url}`);
          try {
            const page = await this.ensurePage();
            await page.goto(input.url, { waitUntil: input.waitUntil, timeout: input.timeoutMs });
            return { url: input.url, navigated: true };
          } catch (error) {
            wrapPlaywrightError("navigate to the URL", error);
          }
        },
        renderText: ({ url }) => `Navigated to ${url}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_screenshot",
        title: "Take a screenshot",
        description: "Capture a screenshot of the current page to a file.",
        inputSchema: {
          path: z.string().trim().min(1).optional(),
          fullPage: z.boolean().default(false),
        },
        outputSchema: {
          path: z.string(),
          byteCount: z.number().int().nonnegative(),
        },
        handler: async (input, context) => {
          await context.log("info", "Taking screenshot");
          try {
            const page = await this.ensurePage();
            const targetPath = input.path ?? join(tmpdir(), `playwright-mcp-${randomUUID()}.png`);
            const buffer = await page.screenshot({ path: targetPath, fullPage: input.fullPage });
            return { path: targetPath, byteCount: buffer.byteLength };
          } catch (error) {
            wrapPlaywrightError("take the screenshot", error);
          }
        },
        renderText: ({ path, byteCount }) => `Saved screenshot to ${path} (${byteCount} bytes).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_click",
        title: "Click an element",
        description: "Click an element on the current page by CSS selector.",
        inputSchema: {
          selector: z.string().trim().min(1),
          timeoutMs: z.number().int().positive().default(30_000),
        },
        outputSchema: {
          clicked: z.boolean(),
          selector: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", `Clicking ${input.selector}`);
          try {
            const page = await this.ensurePage();
            await page.click(input.selector, { timeout: input.timeoutMs });
            return { clicked: true, selector: input.selector };
          } catch (error) {
            wrapPlaywrightError("click the element", error);
          }
        },
        renderText: ({ selector }) => `Clicked ${selector}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_fill",
        title: "Fill an input",
        description: "Type a value into an input element on the current page.",
        inputSchema: {
          selector: z.string().trim().min(1),
          value: z.string(),
          timeoutMs: z.number().int().positive().default(30_000),
        },
        outputSchema: {
          filled: z.boolean(),
          selector: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", `Filling ${input.selector}`);
          try {
            const page = await this.ensurePage();
            await page.fill(input.selector, input.value, { timeout: input.timeoutMs });
            return { filled: true, selector: input.selector };
          } catch (error) {
            wrapPlaywrightError("fill the input", error);
          }
        },
        renderText: ({ selector }) => `Filled ${selector}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_evaluate",
        title: "Evaluate JavaScript",
        description: "Evaluate a JavaScript expression in the page context.",
        inputSchema: {
          expression: z.string().trim().min(1),
        },
        outputSchema: {
          resultJson: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", "Evaluating JavaScript in page");
          try {
            const page = await this.ensurePage();
            const result = await page.evaluate(input.expression);
            return { resultJson: JSON.stringify(result ?? null) };
          } catch (error) {
            wrapPlaywrightError("evaluate the expression", error);
          }
        },
        renderText: ({ resultJson }) => resultJson,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_get_text",
        title: "Get element text",
        description: "Get the visible text of an element on the current page.",
        inputSchema: {
          selector: z.string().trim().min(1),
          timeoutMs: z.number().int().positive().default(30_000),
        },
        outputSchema: {
          text: z.string(),
          selector: z.string(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", `Reading text from ${input.selector}`);
          try {
            const page = await this.ensurePage();
            const text = await page.innerText(input.selector, { timeout: input.timeoutMs });
            return { text, selector: input.selector };
          } catch (error) {
            wrapPlaywrightError("read the element text", error);
          }
        },
        renderText: ({ text }) => text,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_get_links",
        title: "Get page links",
        description: "Collect the href values of all links on the current page.",
        inputSchema: {
          limit: z.number().int().min(1).max(500).default(100),
        },
        outputSchema: {
          links: z.array(z.string()),
          linkCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", "Collecting page links");
          try {
            const page = await this.ensurePage();
            const collected = await page.$$eval("a[href]", (elements) =>
              elements.map((element) => element.getAttribute("href") ?? ""),
            );
            const links = (collected as string[]).filter((href) => href.length > 0).slice(0, input.limit);
            return { links, linkCount: links.length };
          } catch (error) {
            wrapPlaywrightError("collect the page links", error);
          }
        },
        renderText: ({ linkCount }) => `Found ${linkCount} link(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_wait_for",
        title: "Wait for a selector",
        description: "Wait until an element matching a CSS selector reaches a state.",
        inputSchema: {
          selector: z.string().trim().min(1),
          state: z.enum(["attached", "detached", "visible", "hidden"]).default("visible"),
          timeoutMs: z.number().int().positive().default(30_000),
        },
        outputSchema: {
          selector: z.string(),
          state: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", `Waiting for ${input.selector} to be ${input.state}`);
          try {
            const page = await this.ensurePage();
            await page.waitForSelector(input.selector, { state: input.state, timeout: input.timeoutMs });
            return { selector: input.selector, state: input.state };
          } catch (error) {
            wrapPlaywrightError("wait for the selector", error);
          }
        },
        renderText: ({ selector, state }) => `${selector} is now ${state}.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "playwright_close",
        title: "Close the browser",
        description: "Close the managed browser and release its resources.",
        inputSchema: z.object({}) as unknown as ZodShape,
        outputSchema: {
          closed: z.boolean(),
        },
        handler: async (_input, context) => {
          await context.log("info", "Closing the browser");
          try {
            await this.closeBrowser();
            return { closed: true };
          } catch (error) {
            wrapPlaywrightError("close the browser", error);
          }
        },
        renderText: () => "Browser closed.",
      }),
    );

    this.assertMetadataMatchesRegistrations();
  }

  private async ensurePage(): Promise<PlaywrightPageLike> {
    if (this.page) {
      return this.page;
    }
    this.browser = await this.launcher(this.browserName);
    this.page = await this.browser.newPage();
    return this.page;
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  public override async close(): Promise<void> {
    await this.closeBrowser();
    await super.close();
  }

  private assertMetadataMatchesRegistrations(): void {
    const sortNames = (names: readonly string[]) => [...names].sort();
    if (JSON.stringify(sortNames(this.getToolNames())) !== JSON.stringify(sortNames(metadata.toolNames))) {
      throw new ConfigurationError("metadata.toolNames must match the registered tool names.", {
        expected: metadata.toolNames,
        actual: this.getToolNames(),
      });
    }
  }
}

export function createServer(): PlaywrightMcpServer {
  const env = loadEnv(envShape);
  return new PlaywrightMcpServer({ browserName: env.PLAYWRIGHT_BROWSER });
}

export async function main(argv: string[]): Promise<void> {
  await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv).catch((e) => {
    console.error(normalizeError(e).toClientMessage());
    process.exit(1);
  });
}
