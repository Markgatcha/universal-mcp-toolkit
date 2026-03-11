export interface ToolkitErrorOptions {
  code: string;
  statusCode?: number;
  details?: unknown;
  exposeToClient?: boolean;
}

export class ToolkitError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
  public readonly details?: unknown;
  public readonly exposeToClient: boolean;

  public constructor(message: string, options: ToolkitErrorOptions) {
    super(message);
    this.name = "ToolkitError";
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details;
    this.exposeToClient = options.exposeToClient ?? true;
  }

  public toClientMessage(): string {
    return this.exposeToClient ? this.message : "The upstream service returned an unexpected error.";
  }
}

export class ConfigurationError extends ToolkitError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "configuration_error",
      statusCode: 500,
      details,
      exposeToClient: true,
    });
    this.name = "ConfigurationError";
  }
}

export class ValidationError extends ToolkitError {
  public constructor(message: string, details?: unknown) {
    super(message, {
      code: "validation_error",
      statusCode: 400,
      details,
      exposeToClient: true,
    });
    this.name = "ValidationError";
  }
}

export class ExternalServiceError extends ToolkitError {
  public constructor(message: string, options?: Omit<ToolkitErrorOptions, "code">) {
    super(message, {
      code: "external_service_error",
      statusCode: options?.statusCode ?? 502,
      details: options?.details,
      exposeToClient: options?.exposeToClient ?? true,
    });
    this.name = "ExternalServiceError";
  }
}

export function normalizeError(error: unknown): ToolkitError {
  if (error instanceof ToolkitError) {
    return error;
  }

  if (error instanceof Error) {
    return new ToolkitError(error.message, {
      code: "unexpected_error",
      statusCode: 500,
      details: error.stack,
      exposeToClient: true,
    });
  }

  return new ToolkitError("An unexpected non-error value was thrown.", {
    code: "unexpected_error",
    statusCode: 500,
    details: error,
    exposeToClient: false,
  });
}
