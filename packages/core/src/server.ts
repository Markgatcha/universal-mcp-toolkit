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

export abstract class ToolkitServer {
  public readonly metadata: ToolkitServerMetadata;
  public readonly logger: Logger;
  public readonly server: McpServer;
  private readonly tools = new Map<string, StoredTool>();
  private readonly resources = new Set<string>();
  private readonly prompts = new Set<string>();

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
    return [...this.tools.keys()].sort();
  }

  public getResourceNames(): readonly string[] {
    return [...this.resources].sort();
  }

  public getPromptNames(): readonly string[] {
    return [...this.prompts].sort();
  }

  public async invokeTool<TOutput>(name: string, input: unknown, sessionId?: string): Promise<TOutput> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Tool '${name}' is not registered.`);
    }
    return (await tool.invoke(input, sessionId)) as TOutput;
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
