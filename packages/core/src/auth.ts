import { z } from "zod";

import { ExternalServiceError } from "./errors.js";

/**
 * Shape of a successful OAuth 2.0 token response, per RFC 6749 §5.1. Only the
 * fields this provider consumes are validated; `expires_in` is optional per
 * spec (defaults to 3600s below to match the RFC's recommendation).
 */
const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive().optional(),
});

/**
 * Input for {@link OAuth2TokenProvider}. Mirrors the proven refresh-token flow
 * already used by the gmail and google-sheets servers, generalized so every
 * server that takes a bare (and therefore silently-expiring) access token can
 * instead refresh it from a long-lived refresh token.
 */
export interface OAuth2TokenProviderOptions {
  /** Describes the service in error messages, e.g. "Google Drive". */
  serviceName: string;
  /** OAuth 2.0 client id. */
  clientId: string;
  /** OAuth 2.0 client secret. */
  clientSecret: string;
  /** Long-lived OAuth 2.0 refresh token issued by the provider. */
  refreshToken: string;
  /** Provider token endpoint, e.g. `https://oauth2.googleapis.com/token`. */
  tokenUrl: string;
  /** Optional fetch override (defaults to the global). Useful in tests. */
  fetchImpl?: typeof fetch;
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

/**
 * Minimal OAuth 2.0 refresh-token credential provider.
 *
 * Holds a single cached access token and refreshes it (via the
 * `refresh_token` grant) when missing or about to expire. Refresh is
 * single-flight: concurrent callers await the same in-flight refresh rather
 * than stampeding the token endpoint.
 *
 * This is the lower-level credential mechanism only — it is *not* MCP-spec
 * transport authorization (that belongs in the runtime layer for remote
 * deployments). Servers use it through {@link OAuth2TokenProvider.getAuthorizationHeader}
 * to keep a `Bearer` header fresh.
 */
export class OAuth2TokenProvider {
  private readonly fetchImpl: typeof fetch;
  private cached: CachedToken | null = null;
  private inflight: Promise<string> | null = null;

  public constructor(private readonly options: OAuth2TokenProviderOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Returns a non-expired access token, refreshing first if necessary.
   * Safe to await concurrently; a single refresh is shared.
   */
  public async getAccessToken(): Promise<string> {
    const cached = this.cached;
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
    if (this.inflight) {
      return this.inflight;
    }
    this.inflight = this.refresh();
    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** Convenience: a `Bearer <token>` string ready for an Authorization header. */
  public async getAuthorizationHeader(): Promise<string> {
    return `Bearer ${await this.getAccessToken()}`;
  }

  /**
   * Drops the cached token so the next {@link getAccessToken} call refreshes.
   * Call this when an upstream returns 401, before retrying the request once.
   */
  public invalidate(): void {
    this.cached = null;
  }

  private async refresh(): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      client_secret: this.options.clientSecret,
      refresh_token: this.options.refreshToken,
      grant_type: "refresh_token",
    });

    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          Connection: "keep-alive",
        },
        body: body.toString(),
      });
    } catch (error) {
      throw new ExternalServiceError(`Unable to reach the ${this.options.serviceName} OAuth token endpoint.`, {
        statusCode: 502,
        details: { cause: error instanceof Error ? error.message : String(error) },
      });
    }

    const rawText = await response.text();
    let payload: unknown;
    try {
      payload = rawText.length > 0 ? JSON.parse(rawText) : {};
    } catch {
      throw new ExternalServiceError(`The ${this.options.serviceName} OAuth token endpoint returned malformed JSON.`, {
        statusCode: 502,
        details: { rawText: rawText.slice(0, 1000) },
        exposeToClient: false,
      });
    }

    if (!response.ok) {
      throw new ExternalServiceError(
        `Failed to refresh the ${this.options.serviceName} access token. Verify the client id, client secret, and refresh token.`,
        { statusCode: 401, details: { statusCode: response.status, body: payload } },
      );
    }

    const parsed = tokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw new ExternalServiceError(`The ${this.options.serviceName} OAuth token endpoint returned an unexpected token shape.`, {
        statusCode: 502,
        details: parsed.error.flatten(),
      });
    }

    const expiresIn = parsed.data.expires_in ?? 3600;
    // Refresh slightly before the real expiry to avoid edge-case failures.
    // A 60s token yields a buffer of 0 (instantly stale on the next call),
    // which is what the expiry-buffer contract guarantees. Sub-60s tokens
    // clamp to a 1s floor so the cached lifetime never goes negative.
    const bufferSeconds = Math.min(60, Math.max(1, expiresIn));
    this.cached = {
      value: parsed.data.access_token,
      expiresAt: Date.now() + (expiresIn - bufferSeconds) * 1000,
    };
    return parsed.data.access_token;
  }
}
