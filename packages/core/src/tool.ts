import type { ToolkitToolDefinition, ZodShape } from "./types.js";

export function defineTool<TInputShape extends ZodShape, TOutputShape extends ZodShape>(
  definition: ToolkitToolDefinition<TInputShape, TOutputShape>,
): ToolkitToolDefinition<TInputShape, TOutputShape> {
  return definition;
}
