import type { Logger } from "pino";
import { z } from "zod";

import { ExternalServiceError } from "./errors.js";

type QueryValue = string | number | boolean | null | undefined;

export interface RetryOptions {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  retryOn: number[];
}

export interface HttpServiceClientOptions {
  serviceName: string;
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: HeadersInit | (() => HeadersInit);
  retryOptions?: Partial<RetryOptions>;
  rateLimiter?: import("./rate-limiter.js").RateLimiter;
}

export interface HttpRequestOptions {
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  headers?: HeadersInit;
  query?: Record<string, QueryValue>;
  body?: BodyInit | object;
}

const DEFAULT_RETRY_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 10_000,
  retryOn: [429, 500, 502, 503, 504],
};

function parseRetryAfter(headerValue: string | null): number | null {
  if (!headerValue) return null;

  const seconds = Number(headerValue);
  if (!Number.isNaN(seconds)) {
    return seconds * 1000;
  }

  const dateMs = Date.parse(headerValue);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }

  return null;
}

function computeBackoffDelay(attempt: number, options: RetryOptions, retryAfterHeader: string | null): number {
  const retryAfter = parseRetryAfter(retryAfterHeader);
  if (retryAfter !== null) {
    return Math.min(retryAfter, options.maxDelayMs);
  }

  const exponential = options.baseDelayMs * Math.pow(2, attempt);
  const jitter = Math.random() * options.baseDelayMs;
  return Math.min(exponential + jitter, options.maxDelayMs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class HttpServiceClient {
  protected readonly baseUrl: string;
  protected readonly logger: Logger;
  private readonly serviceName: string;
  private readonly defaultHeaders: HeadersInit | (() => HeadersInit) | undefined;
  private readonly retryOptions: RetryOptions;
  private readonly rateLimiter: import("./rate-limiter.js").RateLimiter | undefined;

  public constructor(options: HttpServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.serviceName = options.serviceName;
    this.defaultHeaders = options.defaultHeaders;
    this.rateLimiter = options.rateLimiter;
    this.retryOptions = {
      ...DEFAULT_RETRY_OPTIONS,
      ...options.retryOptions,
    };
  }

  public async getJson<T>(path: string, schema: z.ZodType<T>, options: Omit<HttpRequestOptions, "method"> = {}): Promise<T> {
    return this.requestJson(path, schema, {
      ...options,
      method: "GET",
    });
  }

  public async postJson<T>(path: string, schema: z.ZodType<T>, options: Omit<HttpRequestOptions, "method"> = {}): Promise<T> {
    return this.requestJson(path, schema, {
      ...options,
      method: "POST",
    });
  }

  public async requestJson<T>(path: string, schema: z.ZodType<T>, options: HttpRequestOptions = {}): Promise<T> {
    const response = await this.fetch(path, options);
    const payload = (await response.json()) as unknown;
    const parsed = schema.safeParse(payload);

    if (!parsed.success) {
      throw new ExternalServiceError(`${this.serviceName} returned a response that failed schema validation.`, {
        details: parsed.error.flatten(),
      });
    }

    return parsed.data;
  }

  public async requestText(path: string, options: HttpRequestOptions = {}): Promise<string> {
    const response = await this.fetch(path, options);
    return response.text();
  }

  protected async fetch(path: string, options: HttpRequestOptions = {}): Promise<Response> {
    const url = new URL(path.startsWith("http") ? path : `${this.baseUrl}${path.startsWith("/") ? path : `/${path}`}`);

    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }

    const headers = new Headers();
    const resolvedDefaultHeaders =
      typeof this.defaultHeaders === "function" ? this.defaultHeaders() : (this.defaultHeaders ?? {});

    new Headers(resolvedDefaultHeaders).forEach((value, key) => headers.set(key, value));
    new Headers(options.headers).forEach((value, key) => headers.set(key, value));

    let body: BodyInit | undefined;
    if (options.body instanceof URLSearchParams || typeof options.body === "string" || options.body instanceof ArrayBuffer || options.body instanceof Blob || options.body instanceof FormData) {
      body = options.body;
    } else if (options.body !== undefined) {
      headers.set("content-type", headers.get("content-type") ?? "application/json");
      body = JSON.stringify(options.body);
    }

    const requestInit: RequestInit = {
      method: options.method ?? "GET",
      headers,
    };

    if (body !== undefined) {
      requestInit.body = body;
    }

    if (this.rateLimiter) {
      await this.rateLimiter.acquire();
    }

    let lastResponse: Response | undefined;
    for (let attempt = 0; attempt <= this.retryOptions.maxRetries; attempt++) {
      if (attempt > 0 && this.rateLimiter) {
        await this.rateLimiter.acquire();
      }

      lastResponse = await fetch(url, requestInit);

      if (lastResponse.ok) {
        return lastResponse;
      }

      const shouldRetry = this.retryOptions.retryOn.includes(lastResponse.status);
      if (!shouldRetry || attempt >= this.retryOptions.maxRetries) {
        break;
      }

      const retryAfterHeader = lastResponse.headers.get("retry-after");
      const delay = computeBackoffDelay(attempt, this.retryOptions, retryAfterHeader);

      this.logger.warn(
        {
          service: this.serviceName,
          status: lastResponse.status,
          url: url.toString(),
          attempt: attempt + 1,
          maxRetries: this.retryOptions.maxRetries,
          delayMs: Math.round(delay),
        },
        "Retrying failed upstream request",
      );

      // drain the body so the connection can be reused
      await lastResponse.text().catch(() => undefined);

      await sleep(delay);
    }

    // we exhausted retries or hit a non-retryable error
    const response = lastResponse!;
    const text = await response.text();
    this.logger.error(
      {
        service: this.serviceName,
        status: response.status,
        url: url.toString(),
        body: text,
      },
      "Upstream request failed",
    );
    throw new ExternalServiceError(`${this.serviceName} request failed with status ${response.status}.`, {
      statusCode: response.status,
      details: text,
    });
  }
}
