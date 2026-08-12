import { McpServer, ResourceTemplate, type ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getParseErrorMessage, normalizeObjectSchema, safeParseAsync } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { CallToolResult, GetPromptResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";

import { createLogger } from "./logger.js";
import { ToolTimeoutError, ValidationError, normalizeError } from "./errors.js";
import type {
  InferShape,
  ToolkitLogLevel,
  ToolkitPromptConfig,
  ToolkitPromptHandler,
  ToolkitResourceConfig,
  ToolkitServerMetadata,
  ToolkitStaticResourceHandler,
  ToolkitTemplateResourceHandler,
  ToolkitToolDefinition,
  ToolkitToolExecutionContext,
  ZodShape,
} from "./types.js";

function toText(output: unknown): string {
  return JSON.stringify(output, null, 2);
}

function mapLogLevel(level: ToolkitLogLevel): "debug" | "error" | "fatal" | "info" | "warn" {
  switch (level) {
    case "debug":
      return "debug";
    case "info":
    case "notice":
      return "info";
    case "warning":
      return "warn";
    case "error":
      return "error";
    case "critical":
    case "alert":
    case "emergency":
      return "fatal";
  }
}

interface StoredTool {
  name: string;
  renderText?: (output: unknown) => string;
  invoke: (input: unknown, sessionId?: string) => Promise<unknown>;
}

/**
 * A lazily-registered tool: the registration (handler, schemas, etc.) is
 * deferred until the tool is first called. This avoids startup cost for
 * tools that may never be used during a session.
 */
interface LazyStoredTool {
  name: string;
  definition: {
    description: string;
    title?: string | undefined;
    inputSchema: ZodShape;
    outputSchema: ZodShape;
    annotations?: NonNullable<ToolkitToolDefinition<ZodShape, ZodShape>["annotations"]> | undefined;
    timeoutMs?: number | undefined;
    experimental_streamingResponse?: boolean | undefined;
    renderText?: ((output: unknown) => string) | undefined;
  };
  loader: () => Promise<{
    handler: (input: unknown, context: ToolkitToolExecutionContext) => Promise<unknown>;
  }>;
  registered: boolean;
}

export abstract class ToolkitServer {
  public readonly metadata: ToolkitServerMetadata;
  public readonly logger: Logger;
  public readonly server: McpServer;
  private readonly tools = new Map<string, StoredTool>();
  private readonly resources = new Set<string>();
  private readonly prompts = new Set<string>();

  // Lazily-registered tools: deferred until first invocation.
  private readonly lazyTools = new Map<string, LazyStoredTool>();

  protected constructor(metadata: ToolkitServerMetadata, logger?: Logger) {
    this.metadata = metadata;
    this.logger = logger ?? createLogger({ name: metadata.packageName });
    this.server = new McpServer(
      {
        name: metadata.id,
        version: metadata.version,
        websiteUrl: metadata.homepage,
      },
      {
        capabilities: {
          logging: {},
        },
      },
    );
  }

  public async close(): Promise<void> {
    await this.server.close();
  }

  public getToolNames(): readonly string[] {
    return [...this.tools.keys(), ...this.lazyTools.keys()].sort();
  }

  public getResourceNames(): readonly string[] {
    return [...this.resources].sort();
  }

  public getPromptNames(): readonly string[] {
    return [...this.prompts].sort();
  }

  /**
   * Invoke a tool by name. If the tool was registered lazily, it is
   * fully registered on first invocation.
   */
  public async invokeTool<TOutput>(name: string, input: unknown, sessionId?: string): Promise<TOutput> {
    // Check if this is a lazy tool that hasn't been registered yet.
    const lazy = this.lazyTools.get(name);
    if (lazy && !lazy.registered) {
      await this.materializeLazyTool(lazy);
    }

    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' is not registered.`);
    }
    return (await tool.invoke(input, sessionId)) as TOutput;
  }

  /**
   * Register a tool lazily — the tool definition and handler are not
   * loaded or registered with the MCP server until the tool is first
   * invoked. This defers expensive initialization (e.g., building a
   * large Zod schema, connecting to a dependency, downloading ML
   * models) until actually needed.
   *
   * @param definition - The tool definition (name, description, schemas, etc.)
   * @param loader - An async factory that returns the handler and/or
   *                 the full definition. The loader runs at first call.
   */
  protected registerLazyTool<TInputShape extends ZodShape, TOutputShape extends ZodShape>(
    definition: {
      name: string;
      description: string;
      title?: string | undefined;
      inputSchema: TInputShape;
      outputSchema: TOutputShape;
      annotations?: NonNullable<ToolkitToolDefinition<TInputShape, TOutputShape>["annotations"]> | undefined;
      timeoutMs?: number | undefined;
      experimental_streamingResponse?: boolean | undefined;
      renderText?: ((output: unknown) => string) | undefined;
    },
    loader: () => Promise<{
      handler: (input: InferShape<TInputShape>, context: ToolkitToolExecutionContext) => Promise<unknown> | AsyncIterable<string>;
    }>,
  ): void {
    this.lazyTools.set(definition.name, {
      name: definition.name,
      definition: {
        description: definition.description,
        title: definition.title,
        inputSchema: definition.inputSchema as ZodShape,
        outputSchema: definition.outputSchema as ZodShape,
        annotations: definition.annotations,
        timeoutMs: definition.timeoutMs,
        experimental_streamingResponse: definition.experimental_streamingResponse,
        renderText: definition.renderText,
      },
      loader: loader as LazyStoredTool["loader"],
      registered: false,
    });
  }

  /**
   * Materialise a lazy tool: load the handler and register it with the
   * MCP server so subsequent calls skip the loader.
   */
  private async materializeLazyTool(lazy: LazyStoredTool): Promise<void> {
    const loaded = await lazy.loader();
    // Build the definition object incrementally, only setting optional
    // fields when they have a value. This satisfies exactOptionalPropertyTypes.
    const fullDefinition: Partial<ToolkitToolDefinition<ZodShape, ZodShape>> = {
      name: lazy.name,
      description: lazy.definition.description,
      inputSchema: lazy.definition.inputSchema,
      outputSchema: lazy.definition.outputSchema,
      handler: loaded.handler as unknown as ToolkitToolDefinition<ZodShape, ZodShape>["handler"],
    };
    if (lazy.definition.title) {
      fullDefinition.title = lazy.definition.title;
    }
    if (lazy.definition.annotations) {
      fullDefinition.annotations = lazy.definition.annotations;
    }
    if (lazy.definition.timeoutMs !== undefined) {
      fullDefinition.timeoutMs = lazy.definition.timeoutMs;
    }
    if (lazy.definition.experimental_streamingResponse !== undefined) {
      fullDefinition.experimental_streamingResponse = lazy.definition.experimental_streamingResponse;
    }
    if (lazy.definition.renderText) {
      fullDefinition.renderText = lazy.definition.renderText;
    }
    // Clear the lazy entry and register eagerly.
    this.lazyTools.delete(lazy.name);
    this.registerTool(fullDefinition as ToolkitToolDefinition<ZodShape, ZodShape>);
    lazy.registered = true;
  }

  protected registerTool<TInputShape extends ZodShape, TOutputShape extends ZodShape>(
    definition: ToolkitToolDefinition<TInputShape, TOutputShape>,
  ): void {
    const inputSchema = normalizeObjectSchema(definition.inputSchema);
    const outputSchema = normalizeObjectSchema(definition.outputSchema);

    if (!inputSchema || !outputSchema) {
      throw new ValidationError(`Tool '${definition.name}' requires both input and output schemas.`);
    }

    const timeoutMs = definition.timeoutMs ?? 30_000;
    const isStreaming = definition.experimental_streamingResponse ?? false;

    const storedTool: StoredTool = {
      name: definition.name,
      invoke: async (input, sessionId) => {
        const parsedInputResult = await safeParseAsync(inputSchema, input);
        if (!parsedInputResult.success) {
          throw new ValidationError(
            `Input validation failed for tool '${definition.name}': ${getParseErrorMessage(parsedInputResult.error)}`,
            parsedInputResult.error,
          );
        }
        const context: ToolkitToolExecutionContext = {
          logger: this.logger.child({ tool: definition.name }),
          log: async (level: ToolkitLogLevel, message: string) => {
            this.logger[mapLogLevel(level)]({ sessionId, tool: definition.name }, message);
            if (this.server.isConnected()) {
              if (sessionId === undefined) {
                await this.server.sendLoggingMessage({ level, data: message });
              } else {
                await this.server.sendLoggingMessage({ level, data: message }, sessionId);
              }
            }
          },
        };

        if (sessionId !== undefined) {
          context.sessionId = sessionId;
        }

        const controller = new AbortController();
        const timeoutPromise = new Promise<never>((_, reject) => {
          const timer = setTimeout(() => {
            reject(new ToolTimeoutError(definition.name, timeoutMs));
          }, timeoutMs);
          controller.signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
        });

        const handlerResult = await Promise.race([
          definition.handler(parsedInputResult.data, context),
          timeoutPromise,
        ]);

        controller.abort();

        if (isStreaming && handlerResult !== null && typeof handlerResult === "object" && Symbol.asyncIterator in handlerResult) {
          const chunks: string[] = [];
          for await (const chunk of handlerResult as AsyncIterable<string>) {
            chunks.push(chunk);
          }
          const combined = chunks.join("");
          const parsedOutputResult = await safeParseAsync(outputSchema, { text: combined });
          if (!parsedOutputResult.success) {
            throw new ValidationError(
              `Output validation failed for tool '${definition.name}': ${getParseErrorMessage(parsedOutputResult.error)}`,
              parsedOutputResult.error,
            );
          }
          return parsedOutputResult.data;
        }

        const output = handlerResult;
        const parsedOutputResult = await safeParseAsync(outputSchema, output);
        if (!parsedOutputResult.success) {
          throw new ValidationError(
            `Output validation failed for tool '${definition.name}': ${getParseErrorMessage(parsedOutputResult.error)}`,
            parsedOutputResult.error,
          );
        }

        return parsedOutputResult.data;
      },
    };

    const renderText = definition.renderText;
    if (renderText) {
      storedTool.renderText = (output) => renderText(output as InferShape<TOutputShape>);
    }

    this.tools.set(definition.name, storedTool);

    const toolConfig: {
      description: string;
      title?: string;
      inputSchema: TInputShape;
      outputSchema: TOutputShape;
      annotations?: NonNullable<ToolkitToolDefinition<TInputShape, TOutputShape>["annotations"]>;
    } = {
      description: definition.description,
      inputSchema: definition.inputSchema,
      outputSchema: definition.outputSchema,
    };

    if (definition.title) {
      toolConfig.title = definition.title;
    }

    if (definition.annotations) {
      toolConfig.annotations = definition.annotations;
    }

    const toolCallback = (async (
      input: InferShape<TInputShape>,
      extra,
    ): Promise<CallToolResult> => {
        try {
          const output = await this.invokeTool<InferShape<TOutputShape>>(definition.name, input, extra.sessionId);
          return {
            content: [
              {
                type: "text",
                text: definition.renderText ? definition.renderText(output) : toText(output),
              },
            ],
            structuredContent: output,
          };
        } catch (error) {
          const normalized = normalizeError(error);
          this.logger.error(
            {
              tool: definition.name,
              code: normalized.code,
              details: normalized.details,
            },
            normalized.message,
          );

          return {
            isError: true,
            content: [
              {
                type: "text",
                text: normalized.toClientMessage(),
              },
            ],
          };
        }
      }) as ToolCallback<TInputShape>;

    this.server.registerTool(definition.name, toolConfig, toolCallback);
  }

  protected registerStaticResource(
    name: string,
    uri: string,
    config: ToolkitResourceConfig,
    read: ToolkitStaticResourceHandler,
  ): void {
    this.resources.add(name);
    this.server.registerResource(name, uri, config, read);
  }

  protected registerTemplateResource(
    name: string,
    template: string,
    config: ToolkitResourceConfig,
    read: ToolkitTemplateResourceHandler,
  ): void {
    this.resources.add(name);
    this.server.registerResource(name, new ResourceTemplate(template, { list: undefined }), config, (uri, variables) =>
      read(uri, variables),
    );
  }

  protected registerPrompt<TArgs extends ZodShape>(
    name: string,
    config: ToolkitPromptConfig<TArgs>,
    handler: ToolkitPromptHandler<TArgs>,
  ): void {
    this.prompts.add(name);
    this.server.registerPrompt(name, config, handler);
  }

  protected createJsonResource(uri: string, payload: unknown): ReadResourceResult {
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  protected createTextPrompt(text: string): GetPromptResult {
    return {
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text,
          },
        },
      ],
    };
  }
}
