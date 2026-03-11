import pino, { type Logger } from "pino";

export interface LoggerOptions {
  name: string;
  level?: string;
}

export function createLogger(options: LoggerOptions): Logger {
  const destination = pino.destination({
    dest: 2,
    sync: false,
  });

  return pino(
    {
      name: options.name,
      level: options.level ?? process.env.LOG_LEVEL ?? "info",
      base: null,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
