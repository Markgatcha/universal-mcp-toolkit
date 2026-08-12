/**
 * Serializers that convert MCP tool definitions into the function-calling
 * format expected by each LLM provider.
 *
 * All three providers (OpenAI, Anthropic, Ollama) accept a variant of
 * JSON Schema for function parameters, so the core parameter schema is
 * shared. The differences are:
 *
 * - OpenAI: wrapped in `{ type: "function", function: { name, description, parameters } }`
 * - Anthropic: flat `{ name, description, input_schema: { type, properties, required } }`
 * - Ollama: same flat format as OpenAI functions, but returned as a plain object
 *
 * @module @universal-mcp-toolkit/bridge/serializers
 */

import type { BridgeTool } from "./types.js";

// ─── Shared helpers ──────────────────────────────────────────────────────────

/**
 * Extract a clean JSON Schema object from a Zod schema or raw object.
 * MCP tools use Zod schemas (v3) or raw JSON Schema. This normalizes
 * both to plain JSON Schema that all LLM providers accept.
 */
function extractJsonSchema(mcpTool: BridgeTool["mcpTool"]): {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  additionalProperties?: boolean;
} {
  const inputSchema = mcpTool.inputSchema as
    | { type?: string; properties?: Record<string, unknown>; required?: string[]; [key: string]: unknown }
    | undefined;

  // MCP tools always use JSON Schema for inputSchema, but it may be
  // missing `type: "object"` if the schema is empty.
  const rawSchema: Record<string, unknown> = {};

  if (inputSchema && typeof inputSchema === "object") {
    Object.assign(rawSchema, inputSchema);
  }

  // Ensure `type` is set to "object" — required by all LLM providers.
  rawSchema.type = "object";

  // Ensure `properties` exists (some MCP tools have empty schemas).
  if (!rawSchema.properties || typeof rawSchema.properties !== "object") {
    rawSchema.properties = {};
  }

  // Ensure `required` is an array (or undefined).
  if (!rawSchema.required || !Array.isArray(rawSchema.required)) {
    rawSchema.required = [];
  }

  return rawSchema as {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
}

// ─── OpenAI serializer ───────────────────────────────────────────────────────

/**
 * OpenAI-compatible function definition.
 *
 * @example
 * ```ts
 * const tools = toOpenAI(serializeTools);
 * const response = await openai.chat.completions.create({
 *   model: "gpt-4o",
 *   messages,
 *   tools,
 * });
 * ```
 */
export interface OpenAITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: boolean;
    };
    strict?: boolean;
  };
}

/**
 * Convert bridge tools to OpenAI function-calling format.
 */
export function toOpenAI(tools: BridgeTool[]): OpenAITool[] {
  return tools.map((tool) => {
    const schema = extractJsonSchema(tool.mcpTool);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schema,
      },
    } satisfies OpenAITool;
  });
}

// ─── Anthropic serializer ─────────────────────────────────────────────────────

/**
 * Anthropic-compatible tool definition.
 *
 * @example
 * ```ts
 * const tools = toAnthropic(serializeTools);
 * const msg = await anthropic.messages.create({
 *   model: "claude-3-5-sonnet-20241022",
 *   messages,
 *   tools,
 * });
 * ```
 */
export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: boolean;
  };
  cache_control?: { type: "ephemeral" };
}

/**
 * Convert bridge tools to Anthropic Bedrock / Claude function-calling format.
 */
export function toAnthropic(tools: BridgeTool[]): AnthropicTool[] {
  return tools.map((tool) => {
    const schema = extractJsonSchema(tool.mcpTool);
    return {
      name: tool.name,
      description: tool.description,
      input_schema: schema,
    } satisfies AnthropicTool;
  });
}

// ─── Ollama serializer ───────────────────────────────────────────────────────

/**
 * Ollama-compatible tool definition.
 *
 * Ollama uses the same function format as OpenAI but returns tools
 * as a plain array (no `{ type: "function" }` wrapper).
 *
 * @example
 * ```ts
 * const tools = toOllama(serializeTools);
 * const response = await ollama.chat({
 *   model: "llama3.1:70b",
 *   messages,
 *   tools,
 * });
 * ```
 */
export interface OllamaTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, unknown>;
      required: string[];
      additionalProperties?: boolean;
    };
  };
}

/**
 * Convert bridge tools to Ollama tool format.
 * Note: Ollama's format is similar to OpenAI but tools are returned
 * directly without the `type: "function"` wrapper in the array.
 */
export function toOllama(tools: BridgeTool[]): OllamaTool[] {
  return tools.map((tool) => {
    const schema = extractJsonSchema(tool.mcpTool);
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: schema,
      },
    } satisfies OllamaTool;
  });
}

// ─── Batch serialization ─────────────────────────────────────────────────────

/**
 * Serialize tools for all supported providers in a single call.
 * Useful for routing to different providers dynamically.
 */
export interface SerializedToolsets {
  openai: OpenAITool[];
  anthropic: AnthropicTool[];
  ollama: OllamaTool[];
}

/**
 * Convert bridge tools to all three provider formats at once.
 * Each format is computed lazily — only the ones you access
 * incur the mapping cost.
 */
export function serializeAll(tools: BridgeTool[]): SerializedToolsets {
  const serialized = {} as SerializedToolsets;

  const defineLazyFormat = <K extends keyof SerializedToolsets>(
    format: K,
    serialize: () => SerializedToolsets[K],
  ): void => {
    Object.defineProperty(serialized, format, {
      enumerable: true,
      configurable: true,
      get(): SerializedToolsets[K] {
        const value = serialize();
        // Replace the accessor with a normal data property to memoize the
        // result while retaining the writable, enumerable public shape.
        Object.defineProperty(serialized, format, {
          value,
          writable: true,
          enumerable: true,
          configurable: true,
        });
        return value;
      },
    });
  };

  defineLazyFormat("openai", () => toOpenAI(tools));
  defineLazyFormat("anthropic", () => toAnthropic(tools));
  defineLazyFormat("ollama", () => toOllama(tools));

  return serialized;
}

// ─── Unified serializer (auto-detect provider) ───────────────────────────────

/**
 * Auto-detect the provider from the model name and serialize tools
 * accordingly. Falls back to OpenAI format for unknown providers.
 *
 * @example
 * ```ts
 * const tools = toProvider(tools, "claude-3-5-sonnet-20241022"); // → Anthropic format
 * const tools = toProvider(tools, "gpt-4o");                       // → OpenAI format
 * const tools = toProvider(tools, "llama3.1:70b");                // → Ollama format
 * ```
 */
export type ProviderFormat = "openai" | "anthropic" | "ollama";

export function detectProvider(model: string): ProviderFormat {
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return "anthropic";
  if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3"))
    return "openai";
  // Ollama models don't have a standard prefix, but if the model name
  // doesn't match any known provider, assume Ollama.
  if (lower.startsWith("llama") || lower.startsWith("mistral") || lower.startsWith("mixtral"))
    return "ollama";
  return "openai";
}

export function toProvider(tools: BridgeTool[], model: string): OpenAITool[] | AnthropicTool[] | OllamaTool[] {
  const provider = detectProvider(model);
  switch (provider) {
    case "anthropic":
      return toAnthropic(tools);
    case "ollama":
      return toOllama(tools);
    case "openai":
    default:
      return toOpenAI(tools);
  }
}
