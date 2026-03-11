import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Request, Response } from "express";
import { parseArgs } from "node:util";

import { ConfigurationError } from "./errors.js";
import { createLogger } from "./logger.js";
import type { ToolkitRuntimeOptions, ToolkitRuntimeRegistration } from "./types.js";

const DEFAULT_OPTIONS: ToolkitRuntimeOptions = {
  transport: "stdio",
  host: "127.0.0.1",
  port: 3333,
  ssePath: "/sse",
  messagesPath: "/messages",
  wellKnownPath: "/.well-known/mcp-server.json",
  healthPath: "/healthz",
};

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigurationError(`Invalid port value '${raw}'.`);
  }

  return port;
}

export function parseRuntimeOptions(argv: readonly string[] = process.argv.slice(2)): ToolkitRuntimeOptions {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      transport: { type: "string", default: DEFAULT_OPTIONS.transport },
      host: { type: "string", default: DEFAULT_OPTIONS.host },
      port: { type: "string", default: String(DEFAULT_OPTIONS.port) },
      "sse-path": { type: "string", default: DEFAULT_OPTIONS.ssePath },
      "messages-path": { type: "string", default: DEFAULT_OPTIONS.messagesPath },
      "well-known-path": { type: "string", default: DEFAULT_OPTIONS.wellKnownPath },
      "health-path": { type: "string", default: DEFAULT_OPTIONS.healthPath },
    },
    allowPositionals: false,
  });

  const transport = parsed.values.transport;
  if (transport !== "stdio" && transport !== "sse") {
    throw new ConfigurationError(`Unsupported transport '${transport}'. Expected 'stdio' or 'sse'.`);
  }

  return {
    transport,
    host: parsed.values.host,
    port: parsePort(parsed.values.port),
    ssePath: parsed.values["sse-path"],
    messagesPath: parsed.values["messages-path"],
    wellKnownPath: parsed.values["well-known-path"],
    healthPath: parsed.values["health-path"],
  };
}

export async function runToolkitServer(
  registration: ToolkitRuntimeRegistration,
  options: ToolkitRuntimeOptions = DEFAULT_OPTIONS,
): Promise<void> {
  const runtimeLogger = createLogger({
    name: registration.serverCard.packageName,
  });

  if (options.transport === "stdio") {
    const server = await registration.createServer();
    const transport = new StdioServerTransport();
    await server.server.connect(transport);
    runtimeLogger.info("MCP server listening on stdio");
    return;
  }

  const app = createMcpExpressApp({ host: options.host });
  const sessions = new Map<string, { server: Awaited<ReturnType<typeof registration.createServer>>; transport: SSEServerTransport }>();

  app.get(options.wellKnownPath, (_request: Request, response: Response) => {
    response.json(registration.serverCard);
  });

  app.get(options.healthPath, (_request: Request, response: Response) => {
    response.json({
      status: "ok",
      name: registration.serverCard.name,
      version: registration.serverCard.version,
      transport: options.transport,
    });
  });

  app.get(options.ssePath, async (_request: Request, response: Response) => {
    try {
      const server = await registration.createServer();
      const transport = new SSEServerTransport(options.messagesPath, response);

      sessions.set(transport.sessionId, { server, transport });
      transport.onclose = () => {
        void server.close();
        sessions.delete(transport.sessionId);
      };

      await server.server.connect(transport);
    } catch (error) {
      runtimeLogger.error({ error }, "Failed to establish SSE session");
      if (!response.headersSent) {
        response.status(500).send("Failed to establish SSE session.");
      }
    }
  });

  app.post(options.messagesPath, async (request: Request, response: Response) => {
    const sessionId = typeof request.query.sessionId === "string" ? request.query.sessionId : undefined;
    if (!sessionId) {
      response.status(400).send("Missing sessionId query parameter.");
      return;
    }

    const session = sessions.get(sessionId);
    if (!session) {
      response.status(404).send("Unknown sessionId.");
      return;
    }

    try {
      await session.transport.handlePostMessage(request, response, request.body);
    } catch (error) {
      runtimeLogger.error({ error, sessionId }, "Failed to handle incoming SSE message");
      if (!response.headersSent) {
        response.status(500).send("Failed to process request.");
      }
    }
  });

  const listener = app.listen(options.port, options.host, () => {
    runtimeLogger.info(
      {
        host: options.host,
        port: options.port,
        ssePath: options.ssePath,
        messagesPath: options.messagesPath,
      },
      "MCP server listening over HTTP+SSE",
    );
  });

  const shutdown = async (): Promise<void> => {
    runtimeLogger.info("Shutting down MCP server");

    for (const [sessionId, session] of sessions.entries()) {
      runtimeLogger.info({ sessionId }, "Closing active session");
      await session.transport.close();
      await session.server.close();
      sessions.delete(sessionId);
    }

    await new Promise<void>((resolve, reject) => {
      listener.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  };

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
}
