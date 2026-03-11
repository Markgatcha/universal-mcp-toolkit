import type { Logger } from "pino";
import { z } from "zod";

import { ExternalServiceError } from "./errors.js";

type QueryValue = string | number | boolean | null | undefined;

export interface HttpServiceClientOptions {
  serviceName: string;
  baseUrl: string;
  logger: Logger;
  defaultHeaders?: HeadersInit | (() => HeadersInit);
}

export interface HttpRequestOptions {
  method?: "DELETE" | "GET" | "PATCH" | "POST" | "PUT";
  headers?: HeadersInit;
  query?: Record<string, QueryValue>;
  body?: BodyInit | object;
}

export class HttpServiceClient {
  protected readonly baseUrl: string;
  protected readonly logger: Logger;
  private readonly serviceName: string;
  private readonly defaultHeaders: HeadersInit | (() => HeadersInit) | undefined;

  public constructor(options: HttpServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.logger = options.logger;
    this.serviceName = options.serviceName;
    this.defaultHeaders = options.defaultHeaders;
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

    const response = await fetch(url, requestInit);

    if (!response.ok) {
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

    return response;
  }
}
