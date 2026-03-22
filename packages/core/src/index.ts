export { createServerCard } from "./card.js";
export { loadEnv } from "./env.js";
export { ConfigurationError, ExternalServiceError, ToolkitError, ToolTimeoutError, ValidationError, normalizeError } from "./errors.js";
export { HttpServiceClient } from "./http.js";
export type { RetryOptions } from "./http.js";
export { createLogger } from "./logger.js";
export { RateLimiter } from "./rate-limiter.js";
export { parseRuntimeOptions, runToolkitServer } from "./runtime.js";
export { ToolkitServer } from "./server.js";
export { defineTool } from "./tool.js";
export type {
  InferShape,
  ToolkitLogLevel,
  ToolkitPromptConfig,
  ToolkitPromptHandler,
  ToolkitResourceConfig,
  ToolkitRuntimeOptions,
  ToolkitRuntimeRegistration,
  ToolkitServerCard,
  ToolkitServerMetadata,
  ToolkitStaticResourceHandler,
  ToolkitTemplateResourceHandler,
  ToolkitToolDefinition,
  ToolkitToolExecutionContext,
  ToolkitTransport,
  ZodShape,
} from "./types.js";

/**
 * @experimental - Streaming MCP tool responses are not yet widely supported by MCP clients.
 * Enable only if your host client explicitly supports streaming tool content.
 */
export function createStreamingResponse(iterable: AsyncIterable<string>): AsyncIterable<string> {
  return iterable;
}
