export const DEFAULT_MCP_REGISTRY_URL = "https://registry.modelcontextprotocol.io/v0.1/servers";

export interface MCPRegistryServer {
  server: {
    name: string;
    description?: string;
    [key: string]: unknown;
  };
  _meta?: unknown;
  [key: string]: unknown;
}

interface MCPRegistryPage {
  servers: unknown[];
  metadata?: {
    nextCursor?: unknown;
  };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseRegistryPage(value: unknown, url: string): { servers: MCPRegistryServer[]; nextCursor?: string } {
  if (!isObject(value) || !Array.isArray(value.servers)) {
    throw new Error(`Registry response from ${url} must contain a 'servers' array.`);
  }

  const servers: MCPRegistryServer[] = [];
  for (const entry of value.servers) {
    if (
      isObject(entry) &&
      isObject(entry.server) &&
      typeof entry.server.name === "string" &&
      entry.server.name.length > 0
    ) {
      servers.push(entry as unknown as MCPRegistryServer);
    }
  }

  const page = value as unknown as MCPRegistryPage;
  const nextCursor = isObject(page.metadata) && typeof page.metadata.nextCursor === "string"
    ? page.metadata.nextCursor
    : undefined;

  return nextCursor ? { servers, nextCursor } : { servers };
}

export async function fetchRegistryServers(
  endpoint: string,
  fetcher: typeof fetch = fetch,
): Promise<MCPRegistryServer[]> {
  let baseUrl: URL;
  try {
    baseUrl = new URL(endpoint);
  } catch {
    throw new Error(`Invalid MCP Registry URL '${endpoint}'.`);
  }

  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error(`MCP Registry URL must use HTTP or HTTPS: ${endpoint}`);
  }

  if (!baseUrl.searchParams.has("limit")) {
    baseUrl.searchParams.set("limit", "100");
  }

  const allServers: MCPRegistryServer[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const pageUrl = new URL(baseUrl);
    if (cursor) pageUrl.searchParams.set("cursor", cursor);

    let response: Response;
    try {
      response = await fetcher(pageUrl, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Unable to fetch MCP Registry at ${pageUrl}: ${detail}`);
    }

    if (!response.ok) {
      throw new Error(`MCP Registry request to ${pageUrl} failed with HTTP ${response.status}.`);
    }

    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`MCP Registry at ${pageUrl} returned invalid JSON: ${detail}`);
    }

    const page = parseRegistryPage(body, pageUrl.toString());
    allServers.push(...page.servers);
    if (!page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`MCP Registry at ${endpoint} returned a repeated pagination cursor.`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  return allServers;
}
