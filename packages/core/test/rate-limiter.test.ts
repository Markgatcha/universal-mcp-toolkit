import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RateLimiter } from "../src/rate-limiter.js";

describe("RateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("allows the configured initial burst before pacing additional requests", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 2, burstLimit: 3 });

    await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

    let acquired = false;
    const queued = limiter.acquire().then(() => {
      acquired = true;
    });

    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(499);
    expect(acquired).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await queued;
    expect(acquired).toBe(true);
  });

  it("paces concurrent waiters according to elapsed time", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 2, burstLimit: 1 });
    await limiter.acquire();
    const startedAt = Date.now();
    const acquiredAt: number[] = [];

    const queued = [1, 2, 3].map(() => limiter.acquire().then(() => acquiredAt.push(Date.now() - startedAt)));

    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all(queued);

    expect(acquiredAt).toEqual([500, 1000, 1500]);
  });

  it("releases waiters in FIFO order", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 10, burstLimit: 1 });
    await limiter.acquire();
    const order: number[] = [];
    const queued = [1, 2, 3].map((id) => limiter.acquire().then(() => order.push(id)));

    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual([1]);

    await vi.advanceTimersByTimeAsync(100);
    expect(order).toEqual([1, 2]);

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(queued);
    expect(order).toEqual([1, 2, 3]);
  });

  it("keeps a single wake-up while queued and clears it after draining", async () => {
    const limiter = new RateLimiter({ requestsPerSecond: 5, burstLimit: 1 });
    await limiter.acquire();
    const queued = [limiter.acquire(), limiter.acquire()];

    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(queued[0]).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    await expect(queued[1]).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects invalid rate and burst options", () => {
    expect(() => new RateLimiter({ requestsPerSecond: Number.NaN, burstLimit: 1 })).toThrow(
      "requestsPerSecond must be a finite positive number.",
    );
    expect(() => new RateLimiter({ requestsPerSecond: Number.POSITIVE_INFINITY, burstLimit: 1 })).toThrow(
      "requestsPerSecond must be a finite positive number.",
    );
    expect(() => new RateLimiter({ requestsPerSecond: 1, burstLimit: 1.5 })).toThrow(
      "burstLimit must be a positive safe integer.",
    );
    expect(() => new RateLimiter({ requestsPerSecond: 1, burstLimit: 0 })).toThrow(
      "burstLimit must be a positive safe integer.",
    );
  });
});
