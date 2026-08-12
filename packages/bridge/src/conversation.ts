/**
 * Conversation runner that integrates LLM function calls with MCP tools.
 *
 * The `BridgeConversation` class manages a conversation loop where:
 * 1. The user's messages are sent to an LLM (OpenAI, Anthropic, or Ollama)
 * 2. The LLM returns function calls (tool_use)
 * 3. The bridge calls the corresponding MCP tools
 * 4. Tool results are appended back to the conversation
 * 5. The loop repeats until the LLM stops making tool calls
 *
 * This provides a complete "agent loop" that works with any MCP server
 * and any LLM provider, without writing provider-specific code.
 *
 * @module @universal-mcp-toolkit/bridge/conversation
 */

import type {
  BridgeTool,
  BridgeToolResult,
  FunctionCall,
  ProviderFormat,
} from "./types.js";
import type { MCPFunctionCallingBridge } from "./bridge.js";
import { toOpenAI, toAnthropic, toOllama } from "./serializers.js";

/**
 * A message in the conversation, in a normalized format.
 */
export interface BridgeMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Name of the tool that was called (for tool role messages). */
  toolCallId?: string;
  /** Name of the tool that produced this result. */
  name?: string;
}

/**
 * A tool call made by the LLM during conversation.
 */
export interface BridgeToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Abstract provider interface — any LLM SDK can implement this.
 *
 * The bridge only needs `chat()` from the provider. This means
 * you can plug in your existing OpenAI, Anthropic, or Ollama client
 * without changing any bridge code.
 */
export interface LLMProvider {
  /**
   * Send a conversation to the LLM and get a response.
   * The provider should return tool calls (if any) separately
   * from the text content.
   *
   * @param messages The conversation history.
   * @param tools The available tools in provider-specific format.
   * @param provider The detected provider format for this model.
   */
  chat(
    messages: BridgeMessage[],
    tools: unknown,
    provider: ProviderFormat,
  ): Promise<{
    content: string;
    toolCalls: BridgeToolCall[];
  }>;
}

/**
 * Configuration for the conversation runner.
 */
export interface ConversationConfig {
  /**
   * Maximum number of tool-call rounds before the conversation
   * is terminated. Prevents infinite loops. Defaults to 10.
   */
  maxRounds?: number;

  /**
   * System prompt to prepend to all conversations.
   * Defaults to a standard "helpful assistant" prompt.
   */
  systemPrompt?: string;

  /**
   * Callback invoked after each tool call round.
   * Useful for logging or UI updates.
   */
  onStep?: (step: { round: number; toolCalls: BridgeToolCall[]; results: BridgeToolResult[] }) => void;

  /**
   * LLM provider temperature (0-1). Lower is more deterministic.
   * Defaults to 0.7.
   */
  temperature?: number;

  /**
   * Maximum tokens for LLM responses. Optional — depends on provider.
   */
  maxTokens?: number;
}

const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_SYSTEM_PROMPT =
  "You are a helpful assistant with access to tools. Use them when needed.";

/**
 * Manages an agent conversation loop, bridging LLM function calls
 * to MCP tool execution.
 *
 * @example
 * ```ts
 * // 1. Create the bridge
 * const bridge = new MCPFunctionCallingBridge({
 *   transport: "stdio",
 *   commandOrUrl: "npx",
 *   args: ["-y", "@modelcontextprotocol/server-github"],
 * });
 * await bridge.connect();
 *
 * // 2. Get tools for your provider
 * const listing = await bridge.listTools();
 * const tools = toProvider(listing.tools, "gpt-4o"); // auto-detects OpenAI format
 *
 * // 3. Create a conversation
 * const convo = new BridgeConversation(bridge, {
 *   systemPrompt: "You are an AI assistant with GitHub tools.",
 * });
 *
 * // 4. Run a turn
 * const result = await convo.run(
 *   "List open issues in owner/repo",
 *   openaiProvider, // your LLM provider implementation
 *   "gpt-4o",       // model name for auto-serialization
 * );
 * console.log(result.content);
 * ```
 */
export class BridgeConversation {
  protected bridge: MCPFunctionCallingBridge;
  protected config: Omit<Required<Omit<ConversationConfig, "systemPrompt">>, "maxTokens"> & {
    systemPrompt: string;
    maxTokens: number | undefined;
  };
  protected messages: BridgeMessage[] = [];

  constructor(
    bridge: MCPFunctionCallingBridge,
    config: ConversationConfig = {},
  ) {
    this.bridge = bridge;
    this.config = {
      maxRounds: config.maxRounds ?? DEFAULT_MAX_ROUNDS,
      systemPrompt: config.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
      onStep: config.onStep ?? (() => {}),
      temperature: config.temperature ?? 0.7,
      maxTokens: config.maxTokens,
    };

    // Prepend the system prompt.
    this.messages.push({
      role: "system",
      content: this.config.systemPrompt,
    });
  }

  /**
   * Run a single user message through the conversation loop.
   *
   * This method:
   * 1. Adds the user message to the conversation
   * 2. Sends the full conversation to the LLM
   * 3. If the LLM returns tool calls, executes them via the bridge
   * 4. Appends tool results and sends the updated conversation back
   * 5. Repeats up to maxRounds times
   *
   * @returns The final LLM response (with no more tool calls)
   */
  async run(
    userMessage: string,
    provider: LLMProvider,
    model: string,
    onStep?: (step: { round: number; toolCalls: BridgeToolCall[]; results: BridgeToolResult[] }) => void,
  ): Promise<{ content: string; toolCalls: BridgeToolCall[] }> {
    // Add the user message to history.
    this.messages.push({
      role: "user",
      content: userMessage,
    });

    let currentRound = 0;
    let lastToolCalls: BridgeToolCall[] = [];
    const providerFormat = this.detectProviderFormat(model);

    // Tool definitions do not change during a single run, so avoid fetching and
    // converting them again for every tool-call round.
    const tools = this.config.maxRounds > 0
      ? this.serializeTools((await this.bridge.listTools()).tools, providerFormat)
      : undefined;

    while (currentRound < this.config.maxRounds) {
      currentRound++;

      // Send conversation to LLM.
      const response = await provider.chat(
        this.messages,
        tools,
        providerFormat,
      );

      // If no tool calls, we're done.
      if (response.toolCalls.length === 0) {
        return response;
      }

      // Record tool calls.
      lastToolCalls = response.toolCalls;

      // Execute each tool call and collect results.
      const toolResults: BridgeToolResult[] = [];

      // Execute tools in parallel for speed.
      const executePromises = response.toolCalls.map(async (tc) => {
        const result = await this.bridge.callTool(tc.name, tc.arguments);
        return { ...tc, result };
      });

      const executed = await Promise.all(executePromises);

      for (const { id, name, result } of executed) {
        // Append the assistant's tool call to the conversation.
        this.messages.push({
          role: "assistant",
          content: "",
          toolCallId: id,
        });

        // Append the tool result to the conversation.
        this.messages.push({
          role: "tool",
          content: result.output,
          toolCallId: id,
          name,
        });

        toolResults.push(result);
      }

      // Fire the step callback if provided.
      const stepCallback = onStep ?? this.config.onStep;
      stepCallback({
        round: currentRound,
        toolCalls: response.toolCalls,
        results: toolResults,
      });
    }

    // Max rounds reached — return the last tool calls.
    return {
      content: "",
      toolCalls: lastToolCalls,
    };
  }

  /**
   * Get the full conversation history.
   */
  getMessages(): BridgeMessage[] {
    return [...this.messages];
  }

  /**
   * Reset the conversation (clears history, optionally changes system prompt).
   */
  reset(systemPrompt?: string): void {
    this.messages = [];
    this.messages.push({
      role: "system",
      content: systemPrompt ?? this.config.systemPrompt,
    });
  }

  /**
   * Auto-detect the provider format from the model name.
   */
  protected detectProviderFormat(model: string): ProviderFormat {
    const lower = model.toLowerCase();
    if (lower.startsWith("claude")) return "anthropic";
    if (lower.startsWith("gpt") || lower.startsWith("o1") || lower.startsWith("o3"))
      return "openai";
    if (lower.startsWith("llama") || lower.startsWith("mistral") || lower.startsWith("mixtral"))
      return "ollama";
    return "openai";
  }

  /**
   * Serialize tools to the provider-specific format.
   */
  protected serializeTools(
    tools: BridgeTool[],
    provider: ProviderFormat,
  ): unknown {
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
}
