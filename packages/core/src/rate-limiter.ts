export interface RateLimiterOptions {
  requestsPerSecond: number;
  burstLimit: number;
}

export class RateLimiter {
  private readonly intervalMs: number;
  private readonly maxTokens: number;
  private tokens: number;
  private lastRefill: number;
  private readonly waitQueue: Array<{ resolve: () => void }> = [];

  public constructor(options: RateLimiterOptions) {
    if (options.requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be positive.");
    }
    if (options.burstLimit <= 0) {
      throw new Error("burstLimit must be positive.");
    }

    this.intervalMs = 1000 / options.requestsPerSecond;
    this.maxTokens = options.burstLimit;
    this.tokens = options.burstLimit;
    this.lastRefill = Date.now();
  }

  public async acquire(): Promise<void> {
    this.refill();

    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    const waitMs = this.intervalMs;
    await new Promise<void>((resolve) => {
      const entry = { resolve };
      this.waitQueue.push(entry);
      setTimeout(() => {
        const index = this.waitQueue.indexOf(entry);
        if (index !== -1) {
          this.waitQueue.splice(index, 1);
        }
        this.refill();
        this.tokens = Math.max(0, this.tokens - 1);
        resolve();
      }, waitMs);
    });
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const tokensToAdd = elapsed / this.intervalMs;
    this.tokens = Math.min(this.maxTokens, this.tokens + tokensToAdd);
    this.lastRefill = now;
  }
}
