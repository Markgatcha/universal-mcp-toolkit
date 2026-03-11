import dotenv from "dotenv";
import { z } from "zod";

import { ConfigurationError } from "./errors.js";

export function loadEnv<TShape extends z.ZodRawShape>(
  shape: TShape,
  source: NodeJS.ProcessEnv = process.env,
): z.infer<z.ZodObject<TShape>> {
  dotenv.config();

  const schema = z.object(shape);
  const result = schema.safeParse(source);

  if (!result.success) {
    throw new ConfigurationError("Environment validation failed.", result.error.flatten());
  }

  return result.data;
}
