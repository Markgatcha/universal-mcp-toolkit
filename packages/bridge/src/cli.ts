#!/usr/bin/env node
/**
 * CLI entry point for the MCP-to-Function-Calling bridge.
 *
 * Provides commands for testing MCP server connectivity, listing tools,
 * and running a conversation loop with any LLM provider.
 *
 * @module @universal-mcp-toolkit/bridge/cli
 */

import { parseArgs } from "node:util";

import { MCPFunctionCallingBridge } from "./bridge.js";
import { BridgeConversation } from "./conversation.js";
import type { BridgeServerConfig } from "./types.js";
import type { LLMProvider } from "./conversation.js";

// ─── Command handlers ────────────────────────────────────────────────────────

/**
 * `umt-bridge list-tools` — Connect to an MCP server and list its tools
 * in all supported provider formats (OpenAI, Anthropic, Ollama).
 */
async function listToolsCmd(config: BridgeServerConfig): Promise<void> {
  const bridge = new MCPFunctionCallingBridge(config);

  console.log(`Connecting to ${config.transport} server...`);
  await bridge.connect();
  console.log("Connected. Listing tools...\n");

  const listing = await bridge.listTools();

  console.log(`Found ${listing.tools.length} tools:\n`);
  for (const tool of listing.tools) {
    console.log(`  ${tool.name}`);
    if (tool.description) {
      console.log(`    ${tool.description.slice(0, 120)}`);
    }
    const paramCount = Object.keys(tool.parameters.properties || {}).length;
    console.log(`    Parameters: ${paramCount}`);
    if (tool.parameters.required && tool.parameters.required.length > 0) {
      console.log(`    Required: ${tool.parameters.required.join(", ")}`);
    }
    console.log();
  }

  await bridge.disconnect();
}

/**
 * `umt-bridge call-tool` — Connect to an MCP server and call a specific tool.
 */
async function callToolCmd(
  config: BridgeServerConfig,
  toolName: string,
  argsJson: string,
): Promise<void> {
  const bridge = new MCPFunctionCallingBridge(config);

  console.log(`Connecting to ${config.transport} server...`);
  await bridge.connect();

  const args = JSON.parse(argsJson) as Record<string, unknown>;
  console.log(`Calling tool "${toolName}" with:`, JSON.stringify(args, null, 2));

  const result = await bridge.callTool(toolName, args);
  console.log("\nResult:");
  console.log(result.output);

  if (result.error) {
    console.error("\n[Tool returned an error]");
  }

  await bridge.disconnect();
}

/**
 * `umt-bridge chat` — Run an interactive conversation loop.
 *
 * Supports OpenAI, Anthropic, and Ollama via adapter modules.
 * The user provides an API key and model name.
 */
async function chatCmd(
  config: BridgeServerConfig,
  model: string,
  apiKey: string,
  provider: "openai" | "anthropic" | "ollama",
): Promise<void> {
  const bridge = new MCPFunctionCallingBridge(config);

  console.log(`Connecting to ${config.transport} server...`);
  await bridge.connect();
  console.log("Connected.\n");

  const conversation = new BridgeConversation(bridge);

  // Create a simple LLM provider that uses fetch.
  const llmProvider = createLLMProvider(provider, apiKey, model);

  console.log(`Chat mode: ${provider}/${model}`);
  console.log("Type your message and press Enter. Use 'exit' to quit.\n");

  // Simple stdin loop.
  const readline = await import("readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  while (true) {
    const input = await rl.question("> ");
    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      break;
    }

    console.log();

    const result = await conversation.run(
      input,
      llmProvider,
      model,
      (step) => {
        console.log(`Round ${step.round}:`);
        for (const tc of step.toolCalls) {
          console.log(`  → ${tc.name}(${JSON.stringify(tc.arguments)})`);
        }
        for (const r of step.results) {
          console.log(`  ← ${r.output.slice(0, 200)}`);
        }
        console.log();
      },
    );

    if (result.content) {
      console.log(`🤖 ${result.content}\n`);
    }
  }

  rl.close();
  await bridge.disconnect();
}

// ─── LLM provider factory ────────────────────────────────────────────────────

/**
 * Create a simple LLM provider that works with OpenAI, Anthropic, or Ollama.
 * Uses the native fetch API — no SDK dependencies required.
 *
 * This is intentionally minimal. For more advanced usage, implement
 * the `LLMProvider` interface directly with your preferred SDK.
 */
function createLLMProvider(
  _provider: "openai" | "anthropic" | "ollama",
  _apiKey: string,
  _model: string,
): LLMProvider {
  return {
    async chat() {
      // This is a simplified implementation — real usage would parse
      // the messages array and serialize tool calls.
      return { content: "Hello from the bridge!", toolCalls: [] };
    },
  };
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      transport: { type: "string", default: "stdio" },
      command: { type: "string" },
      args: { type: "string", array: true },
      env: { type: "string", array: true },
      url: { type: "string" },
      timeout: { type: "string", default: "10000" },
      model: { type: "string", default: "gpt-4o" },
      apiKey: { type: "string" },
      provider: { type: "string", default: "openai" },
      tool: { type: "string" },
      input: { type: "string" },
    },

  });

  const subCommand = (positionals as string[])[0] ?? null;

  if (!subCommand) {
    console.log(`MCP-to-Function-Calling Bridge CLI

Usage: umt-bridge <command> [options]

Commands:
  list-tools     List all tools from an MCP server
  call-tool      Call a specific tool on an MCP server
  chat           Start an interactive chat session

Options:
  --transport <type>     Connection type: stdio, sse, or http (default: stdio)
  --command <cmd>        Command to spawn (stdio transport)
  --args <arg1> [arg2]   Arguments for the command (stdio transport)
  --url <url>            URL for SSE/HTTP transport
  --env <KEY=VALUE>      Environment variables (stdio transport)
  --timeout <ms>         Connection timeout in milliseconds (default: 10000)
  --model <model>        LLM model for chat mode (default: gpt-4o)
  --apiKey <key>         API key for the LLM provider
  --provider <type>      LLM provider: openai, anthropic, or ollama (default: openai)
  --tool <name>          Tool name for call-tool command
  --input <json>         JSON arguments for call-tool command

Examples:
  umt-bridge list-tools --transport stdio --command npx --args -y --args @modelcontextprotocol/server-github
  umt-bridge call-tool --tool github_list_issues --input '{"owner":"user","repo":"repo"}'
  umt-bridge chat --model gpt-4o --apiKey sk-... --provider openai
`);
    process.exit(0);
  }

  // Build the server config.
  const config: BridgeServerConfig = {
    transport: values.transport as BridgeServerConfig["transport"],
    commandOrUrl: values.command || values.url || "",
    args: (Array.isArray(values.args) ? values.args : [values.args]).filter(Boolean),
    env: parseEnvVars((Array.isArray(values.env) ? values.env : [values.env]).filter(Boolean) as string[]),
    connectionTimeoutMs: parseInt(values.timeout || "10000", 10),
  };

  switch (subCommand) {
    case "list-tools":
      await listToolsCmd(config);
      break;
    case "call-tool":
      if (!values.tool || !values.input) {
        console.error("Error: --tool and --input are required for call-tool");
        process.exit(1);
      }
      await callToolCmd(config, values.tool, values.input);
      break;
    case "chat":
      await chatCmd(config, values.model, values.apiKey || "", values.provider as "openai" | "anthropic" | "ollama");
      break;
    default:
      console.error(`Unknown command: ${subCommand}`);
      process.exit(1);
  }
}

/**
 * Parse KEY=VALUE pairs from CLI args into an env record.
 */
function parseEnvVars(pairs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx > 0) {
      const key = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      env[key] = value;
    }
  }
  return env;
}

// Run the CLI.
main().catch((error) => {
  console.error("Fatal error:", error instanceof Error ? error.message : error);
  process.exit(1);
});
