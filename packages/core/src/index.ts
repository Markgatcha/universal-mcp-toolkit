export { OAuth2TokenProvider } from "./auth.js";
export type { OAuth2TokenProviderOptions } from "./auth.js";
export { createServerCard } from "./card.js";
export { loadEnv } from "./env.js";
export { ConfigurationError, ExternalServiceError, ToolkitError, ToolTimeoutError, ValidationError, normalizeError } from "./errors.js";
export { HttpServiceClient, stripTrailingSlashes } from "./http.js";
export type { RetryOptions } from "./http.js";
export {
  UMT_INTEGRATION_SCHEMA_VERSION,
  integrationConformanceSchema,
  integrationMaintainershipSchema,
  integrationManifestSchema,
  integrationMaturitySchema,
  integrationToolSchema,
  integrationTransportSchema,
  summarizeIntegrationReadiness,
  validateIntegrationManifest,
  type IntegrationConformance,
  type IntegrationMaintainership,
  type IntegrationManifest,
  type IntegrationMaturity,
  type IntegrationReadinessRequirement,
  type IntegrationReadinessSummary,
  type IntegrationTool,
  type IntegrationTransport,
} from "./integration-manifest.js";
export { createLogger } from "./logger.js";
export { RateLimiter } from "./rate-limiter.js";
export { parseRuntimeOptions, runToolkitServer } from "./runtime.js";
export { ToolkitServer } from "./server.js";
export { defineTool } from "./tool.js";
export {
  ToolResultCache,
  compressOutput,
  estimateTokens,
  executeToolsInParallel,
  executeWithFallback,
  orderTools,
  processToolResult,
  summarizeToolResult,
  truncateToTokenBudget,
  type CacheOptions,
} from "./token-efficient.js";
export {
  TokenBudgetManager,
  computeToolResultBudget,
  getTokenInfo,
  type BudgetOptions,
  type ModelTokenInfo,
} from "./token-manager.js";
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

export {
  CURRENT_SPEC_REVISION,
  DEFAULT_OBSERVATION_WINDOW_MS,
  DEFAULT_VET_TIMEOUT_MS,
  KNOWN_PROTOCOL_VERSIONS,
  SseVetChannel,
  StdioVetChannel,
  StreamableHttpVetChannel,
  classifyToolRisk,
  detectHttpTransport,
  probeProtocolVersion,
  scanToolPoisoning,
  summarizeRiskProfile,
  toScannableTool,
  vetExitCode,
  vetServer,
  type HttpVetTarget,
  type JsonRpcErrorShape,
  type ObservedServerRequest,
  type ProtocolProbe,
  type RiskProfile,
  type ScannableTool,
  type StdioVetTarget,
  type ToolRisk,
  type ToolRiskTier,
  type TransportDetection,
  type VetChannel,
  type VetChannelFactory,
  type VetFinding,
  type VetOptions,
  type VetReport,
  type VetRequestResult,
  type VetSeverity,
  type VetTarget,
  type VetTransportKind,
} from "./vet.js";
