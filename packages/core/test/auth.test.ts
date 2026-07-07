import { describe, expect, it, vi } from "vitest";

import { ExternalServiceError } from "../src/errors.js";
import { OAuth2TokenProvider } from "../src/auth.js";

/**
 * Builds a fetch stub whose token responses are driven by a mutable counter,
 * so tests can assert how many times the token endpoint was actually hit.
 */
function makeTokenFetch(options: {
  tokenUrl: string;
  accessToken: string;
  expiresIn: number;
  status?: number;
}) {
  const calls = vi.fn();
  const fetchImpl = vi.fn(async (url: string | URL): Promise<Response> => {
    calls();
    const urlString = typeof url === "string" ? url : url.toString();
    if (!urlString.startsWith(options.tokenUrl)) {
      throw new Error(`Unexpected fetch URL: ${urlString}`);
    }

    const body = JSON.stringify({ access_token: options.accessToken, expires_in: options.expiresIn });
    return new Response(body, {
      status: options.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const baseOptions = {
  serviceName: "Test Service",
  clientId: "test-client-id",
  clientSecret: "test-client-secret",
  refreshToken: "test-refresh-token",
  tokenUrl: "https://oauth.example.com/token",
};

describe("OAuth2TokenProvider", () => {
  it("refreshes on first access and caches the token", async () => {
    const { fetchImpl, calls } = makeTokenFetch({ ...baseOptions, accessToken: "tok-1", expiresIn: 3600 });
    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    expect(await provider.getAccessToken()).toBe("tok-1");
    expect(await provider.getAccessToken()).toBe("tok-1");
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("refreshes again once the cached token is about to expire", async () => {
    // expiresIn of 60s yields an internal expiry of Date.now() + (60 - 60)*1000 = now,
    // so the token is treated as already expired on the next call.
    const { fetchImpl, calls } = makeTokenFetch({ ...baseOptions, accessToken: "tok-short", expiresIn: 60 });
    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    await provider.getAccessToken();
    // The buffer (expires_in - 60s) makes a 60s token instantly stale.
    await provider.getAccessToken();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("invalidate() forces the next call to refresh", async () => {
    const { fetchImpl, calls } = makeTokenFetch({ ...baseOptions, accessToken: "tok-1", expiresIn: 3600 });
    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    await provider.getAccessToken();
    provider.invalidate();
    await provider.getAccessToken();
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it("shares a single in-flight refresh across concurrent callers", async () => {
    const { fetchImpl, calls } = makeTokenFetch({ ...baseOptions, accessToken: "tok-1", expiresIn: 3600 });
    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    const [a, b, c] = await Promise.all([
      provider.getAccessToken(),
      provider.getAccessToken(),
      provider.getAccessToken(),
    ]);

    expect([a, b, c]).toEqual(["tok-1", "tok-1", "tok-1"]);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("produces a Bearer authorization header", async () => {
    const { fetchImpl } = makeTokenFetch({ ...baseOptions, accessToken: "tok-1", expiresIn: 3600 });
    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    expect(await provider.getAuthorizationHeader()).toBe("Bearer tok-1");
  });

  it("throws ExternalServiceError when the token endpoint rejects", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      return new Response(JSON.stringify({ error: "invalid_grant" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(ExternalServiceError);
  });

  it("throws ExternalServiceError when the token endpoint is unreachable", async () => {
    const fetchImpl = vi.fn(async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const provider = new OAuth2TokenProvider({ ...baseOptions, fetchImpl });

    await expect(provider.getAccessToken()).rejects.toBeInstanceOf(ExternalServiceError);
  });
});
