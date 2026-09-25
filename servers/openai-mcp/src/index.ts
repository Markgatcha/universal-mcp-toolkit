import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  ConfigurationError,
  ExternalServiceError,
  ValidationError,
  createServerCard,
  defineTool,
  loadEnv,
  normalizeError,
  parseRuntimeOptions,
  runToolkitServer,
  ToolkitServer,
  type ToolkitServerMetadata,
  type ZodShape,
} from "@universal-mcp-toolkit/core";
import OpenAI from "openai";
import { z } from "zod";

const toolNames = [
  "openai_chat",
  "openai_complete",
  "openai_embed",
  "openai_list_models",
  "openai_image_generate",
  "openai_moderate",
  "openai_transcribe",
  "openai_function_call",
] as const;

const envShape = {
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is required"),
  OPENAI_BASE_URL: z.string().url().optional(),
  OPENAI_DEFAULT_MODEL: z.string().default("gpt-4o"),
};

export const metadata: ToolkitServerMetadata = {
  id: "openai-mcp",
  title: "OpenAI MCP Server",
  description: "OpenAI/Codex API integration.",
  version: "1.2.0",
  packageName: "@contextcore/mcp-openai",
  homepage: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit#readme",
  repositoryUrl: "https://github.com/universal-mcp-toolkit/universal-mcp-toolkit",
  documentationUrl: "https://platform.openai.com/docs",
  envVarNames: ["OPENAI_API_KEY"],
  transports: ["stdio", "sse"],
  toolNames,
  resourceNames: [],
  promptNames: [],
};

export const serverCard = createServerCard(metadata);

const chatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

function wrapOpenAiError(action: string, error: unknown): never {
  if (error instanceof ConfigurationError || error instanceof ExternalServiceError || error instanceof ValidationError) {
    throw error;
  }
  const normalized = normalizeError(error);
  throw new ExternalServiceError(`Failed to ${action}. ${normalized.toClientMessage()}`, {
    details: normalized.details,
  });
}

export interface OpenAiMcpServerOptions {
  apiKey: string;
  baseUrl?: string;
  defaultModel?: string;
  client?: OpenAI;
}

export class OpenAiMcpServer extends ToolkitServer {
  private client: OpenAI;
  private defaultModel: string;

  constructor(options: OpenAiMcpServerOptions) {
    super(metadata);
    this.defaultModel = options.defaultModel ?? "gpt-4o";
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
      });

    this.registerTool(
      defineTool({
        name: "openai_chat",
        title: "Chat completion",
        description: "Generate a chat completion from a list of messages.",
        inputSchema: {
          messages: z.array(chatMessageSchema).min(1),
          model: z.string().optional(),
          temperature: z.number().min(0).max(2).optional(),
          maxTokens: z.number().int().positive().optional(),
        },
        outputSchema: {
          content: z.string(),
          model: z.string(),
          finishReason: z.string().nullable(),
          promptTokens: z.number().int().nonnegative(),
          completionTokens: z.number().int().nonnegative(),
        },
        handler: async (input, context) => {
          await context.log("info", `Running chat completion on ${input.model ?? this.defaultModel}`);
          try {
            const response = await this.client.chat.completions.create({
              model: input.model ?? this.defaultModel,
              messages: input.messages,
              ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
              ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
            });
            const choice = response.choices[0];
            return {
              content: choice?.message?.content ?? "",
              model: response.model,
              finishReason: choice?.finish_reason ?? null,
              promptTokens: response.usage?.prompt_tokens ?? 0,
              completionTokens: response.usage?.completion_tokens ?? 0,
            };
          } catch (error) {
            wrapOpenAiError("run the chat completion", error);
          }
        },
        renderText: ({ content }) => content,
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_complete",
        title: "Text completion",
        description: "Generate a text completion for a prompt.",
        inputSchema: {
          prompt: z.string().trim().min(1),
          model: z.string().default("gpt-3.5-turbo-instruct"),
          maxTokens: z.number().int().positive().default(256),
          temperature: z.number().min(0).max(2).optional(),
        },
        outputSchema: {
          text: z.string(),
          model: z.string(),
          finishReason: z.string().nullable(),
        },
        handler: async (input, context) => {
          await context.log("info", `Running text completion on ${input.model}`);
          try {
            const response = await this.client.completions.create({
              model: input.model,
              prompt: input.prompt,
              max_tokens: input.maxTokens,
              ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
            });
            const choice = response.choices[0];
            return {
              text: choice?.text ?? "",
              model: response.model,
              finishReason: choice?.finish_reason ?? null,
            };
          } catch (error) {
            wrapOpenAiError("run the text completion", error);
          }
        },
        renderText: ({ text }) => text,
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_embed",
        title: "Create embeddings",
        description: "Create vector embeddings for one or more input texts.",
        inputSchema: {
          input: z.array(z.string().min(1)).min(1),
          model: z.string().default("text-embedding-3-small"),
        },
        outputSchema: {
          embeddingCount: z.number().int().nonnegative(),
          dimensions: z.number().int().nonnegative(),
          totalTokens: z.number().int().nonnegative(),
          embeddings: z.array(z.array(z.number())),
        },
        handler: async (input, context) => {
          await context.log("info", `Creating embeddings with ${input.model}`);
          try {
            const response = await this.client.embeddings.create({
              model: input.model,
              input: input.input,
            });
            const embeddings = response.data.map((item) => item.embedding);
            return {
              embeddingCount: embeddings.length,
              dimensions: embeddings[0]?.length ?? 0,
              totalTokens: response.usage?.total_tokens ?? 0,
              embeddings,
            };
          } catch (error) {
            wrapOpenAiError("create embeddings", error);
          }
        },
        renderText: ({ embeddingCount, dimensions }) =>
          `Created ${embeddingCount} embedding(s) with ${dimensions} dimension(s).`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_list_models",
        title: "List models",
        description: "List the models available to the configured API key.",
        inputSchema: z.object({}) as unknown as ZodShape,
        outputSchema: {
          models: z.array(z.string()),
          modelCount: z.number().int().nonnegative(),
        },
        annotations: { readOnlyHint: true },
        handler: async (_input, context) => {
          await context.log("info", "Listing OpenAI models");
          try {
            const response = await this.client.models.list();
            const models = (response.data ?? []).map((model) => model.id).sort();
            return { models, modelCount: models.length };
          } catch (error) {
            wrapOpenAiError("list models", error);
          }
        },
        renderText: ({ modelCount }) => `${modelCount} model(s) available.`,
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_image_generate",
        title: "Generate an image",
        description: "Generate an image from a text prompt.",
        inputSchema: {
          prompt: z.string().trim().min(1),
          model: z.string().default("gpt-image-1"),
          size: z.enum(["256x256", "512x512", "1024x1024", "1024x1792", "1792x1024"]).default("1024x1024"),
          n: z.number().int().min(1).max(10).default(1),
        },
        outputSchema: {
          images: z.array(z.object({ url: z.string().nullable(), b64Json: z.string().nullable() })),
          imageCount: z.number().int().nonnegative(),
        },
        handler: async (input, context) => {
          await context.log("info", `Generating ${input.n} image(s)`);
          try {
            const response = await this.client.images.generate({
              prompt: input.prompt,
              model: input.model,
              size: input.size,
              n: input.n,
            });
            const images = (response.data ?? []).map((image) => ({
              url: image.url ?? null,
              b64Json: image.b64_json ?? null,
            }));
            return { images, imageCount: images.length };
          } catch (error) {
            wrapOpenAiError("generate the image", error);
          }
        },
        renderText: ({ imageCount, images }) =>
          imageCount === 0
            ? "No images were generated."
            : images.map((image, index) => `${index + 1}. ${image.url ?? "(base64 data)"}`).join("\n"),
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_moderate",
        title: "Moderate content",
        description: "Check text against OpenAI's moderation categories.",
        inputSchema: {
          input: z.string().min(1),
          model: z.string().default("omni-moderation-latest"),
        },
        outputSchema: {
          flagged: z.boolean(),
          categories: z.record(z.string(), z.boolean()),
          scores: z.record(z.string(), z.number()),
        },
        annotations: { readOnlyHint: true },
        handler: async (input, context) => {
          await context.log("info", "Running moderation check");
          try {
            const response = await this.client.moderations.create({
              model: input.model,
              input: input.input,
            });
            const result = response.results[0];
            return {
              flagged: result?.flagged ?? false,
              categories: (result?.categories ?? {}) as Record<string, boolean>,
              scores: (result?.category_scores ?? {}) as Record<string, number>,
            };
          } catch (error) {
            wrapOpenAiError("run moderation", error);
          }
        },
        renderText: ({ flagged }) => (flagged ? "Content was flagged by moderation." : "Content passed moderation."),
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_transcribe",
        title: "Transcribe audio",
        description: "Transcribe an audio file on disk to text.",
        inputSchema: {
          filePath: z.string().trim().min(1),
          model: z.string().default("whisper-1"),
          language: z.string().trim().min(1).optional(),
        },
        outputSchema: {
          text: z.string(),
          language: z.string().nullable(),
        },
        handler: async (input, context) => {
          await context.log("info", `Transcribing ${input.filePath}`);
          try {
            const buffer = await readFile(input.filePath);
            const fileName = input.filePath.split(/[\\/]/).pop() ?? "audio.mp3";
            const file = new File([buffer], fileName);
            const response = await this.client.audio.transcriptions.create({
              model: input.model,
              file,
              ...(input.language ? { language: input.language } : {}),
            });
            return {
              text: response.text,
              language: (response as { language?: string }).language ?? null,
            };
          } catch (error) {
            wrapOpenAiError("transcribe the audio", error);
          }
        },
        renderText: ({ text }) => text,
      }),
    );

    this.registerTool(
      defineTool({
        name: "openai_function_call",
        title: "Function call",
        description: "Run a chat completion constrained to call a single named function.",
        inputSchema: {
          messages: z.array(chatMessageSchema).min(1),
          functionName: z.string().trim().min(1),
          functionDescription: z.string().default(""),
          parametersSchema: z.record(z.string(), z.unknown()).default({}),
          model: z.string().optional(),
        },
        outputSchema: {
          called: z.boolean(),
          functionName: z.string(),
          argumentsJson: z.string(),
        },
        handler: async (input, context) => {
          await context.log("info", `Requesting function call to ${input.functionName}`);
          try {
            const response = await this.client.chat.completions.create({
              model: input.model ?? this.defaultModel,
              messages: input.messages,
              tools: [
                {
                  type: "function",
                  function: {
                    name: input.functionName,
                    description: input.functionDescription,
                    parameters: input.parametersSchema,
                  },
                },
              ],
              tool_choice: { type: "function", function: { name: input.functionName } },
            });
            const toolCall = response.choices[0]?.message?.tool_calls?.[0];
            if (!toolCall || toolCall.type !== "function") {
              return { called: false, functionName: input.functionName, argumentsJson: "{}" };
            }
            return {
              called: true,
              functionName: toolCall.function.name,
              argumentsJson: toolCall.function.arguments,
            };
          } catch (error) {
            wrapOpenAiError("run the function call", error);
          }
        },
        renderText: ({ called, functionName, argumentsJson }) =>
          called ? `${functionName}(${argumentsJson})` : `The model did not call ${functionName}.`,
      }),
    );

    this.assertMetadataMatchesRegistrations();
  }

  private assertMetadataMatchesRegistrations(): void {
    const sortNames = (names: readonly string[]) => [...names].sort();
    if (JSON.stringify(sortNames(this.getToolNames())) !== JSON.stringify(sortNames(metadata.toolNames))) {
      throw new ConfigurationError("metadata.toolNames must match the registered tool names.", {
        expected: metadata.toolNames,
        actual: this.getToolNames(),
      });
    }
  }
}

export function createServer(): OpenAiMcpServer {
  const env = loadEnv(envShape);
  return new OpenAiMcpServer({
    apiKey: env.OPENAI_API_KEY,
    ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
    defaultModel: env.OPENAI_DEFAULT_MODEL,
  });
}

export async function main(argv: string[]): Promise<void> {
  await runToolkitServer({ serverCard, createServer }, parseRuntimeOptions(argv));
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(normalizeError(e).toClientMessage());
    process.exit(1);
  });
}
