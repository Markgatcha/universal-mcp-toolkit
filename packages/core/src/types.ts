import type { PromptCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShapeOutput, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import type { GetPromptResult, ReadResourceResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import type { Logger } from "pino";

export type ToolkitTransport = "stdio" | "sse";

export type ToolkitLogLevel =
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export type ZodShape = ZodRawShapeCompat;

export type InferShape<TShape extends ZodShape> = ShapeOutput<TShape>;

export interface ToolkitServerMetadata {
  id: string;
  title: string;
  description: string;
  version: string;
  packageName: string;
  homepage: string;
  repositoryUrl?: string;
  documentationUrl?: string;
  envVarNames: readonly string[];
  transports: readonly ToolkitTransport[];
  toolNames: readonly string[];
  resourceNames: readonly string[];
  promptNames: readonly string[];
}

export interface ToolkitServerCard {
  name: string;
  title: string;
  description: string;
  version: string;
  packageName: string;
  homepage: string;
  repositoryUrl?: string;
  documentationUrl?: string;
  transports: readonly ToolkitTransport[];
  authentication: {
    mode: "environment-variables";
    required: readonly string[];
  };
  capabilities: {
    tools: boolean;
    resources: boolean;
    prompts: boolean;
  };
  tools: readonly string[];
  resources: readonly string[];
  prompts: readonly string[];
}

export interface ToolkitRuntimeOptions {
  transport: ToolkitTransport;
  host: string;
  port: number;
  ssePath: string;
  messagesPath: string;
  wellKnownPath: string;
  healthPath: string;
}

export interface ToolkitToolExecutionContext {
  logger: Logger;
  sessionId?: string;
  log: (level: ToolkitLogLevel, message: string) => Promise<void>;
}

export interface ToolkitToolDefinition<TInputShape extends ZodShape, TOutputShape extends ZodShape> {
  name: string;
  title?: string;
  description: string;
  inputSchema: TInputShape;
  outputSchema: TOutputShape;
  annotations?: ToolAnnotations;
  timeoutMs?: number;
  /**
   * @experimental - Streaming MCP tool responses are not yet widely supported by MCP clients.
   * Enable only if your host client explicitly supports streaming tool content.
   */
  experimental_streamingResponse?: boolean;
  handler: (
    input: InferShape<TInputShape>,
    context: ToolkitToolExecutionContext,
  ) => Promise<InferShape<TOutputShape>> | AsyncIterable<string>;
  renderText?: (output: InferShape<TOutputShape>) => string;
}

export interface ToolkitResourceConfig {
  title?: string;
  description?: string;
  mimeType?: string;
}

export interface ToolkitPromptConfig<TArgs extends ZodShape> {
  title?: string;
  description?: string;
  argsSchema: TArgs;
}

export type ToolkitPromptHandler<TArgs extends ZodShape> = PromptCallback<TArgs>;

export type ToolkitStaticResourceHandler = (uri: URL) => Promise<ReadResourceResult> | ReadResourceResult;

export type ToolkitTemplateResourceHandler = (
  uri: URL,
  params: Record<string, string | string[]>,
) => Promise<ReadResourceResult> | ReadResourceResult;

export interface ToolkitRuntimeRegistration {
  createServer: () => Promise<import("./server.js").ToolkitServer> | import("./server.js").ToolkitServer;
  serverCard: ToolkitServerCard;
}
