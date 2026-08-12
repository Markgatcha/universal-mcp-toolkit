export interface RateLimiterOptions {
  requestsPerSecond: number;
  burstLimit: number;
}

interface Waiter {
  resolve: () => void;
  next: Waiter | undefined;
}

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export class RateLimiter {
  private readonly intervalMs: number;
  private readonly maxTokens: number;
  private tokens: number;
  private lastRefill: number;
  private queueHead: Waiter | undefined;
  private queueTail: Waiter | undefined;
  private wakeUpTimer: ReturnType<typeof setTimeout> | undefined;

  public constructor(options: RateLimiterOptions) {
    if (!Number.isFinite(options.requestsPerSecond) || options.requestsPerSecond <= 0) {
      throw new Error("requestsPerSecond must be a finite positive number.");
    }
    if (!Number.isSafeInteger(options.burstLimit) || options.burstLimit <= 0) {
      throw new Error("burstLimit must be a positive safe integer.");
    }

    this.intervalMs = 1000 / options.requestsPerSecond;
    if (!Number.isFinite(this.intervalMs)) {
      throw new Error("requestsPerSecond is too small to represent.");
    }

    this.maxTokens = options.burstLimit;
    this.tokens = options.burstLimit;
    this.lastRefill = Date.now();
  }

  public async acquire(): Promise<void> {
    this.refill();
    this.releaseWaiters();

    if (this.queueHead === undefined && this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }

    await new Promise<void>((resolve) => {
      const waiter: Waiter = { resolve, next: undefined };
      if (this.queueTail === undefined) {
        this.queueHead = waiter;
      } else {
        this.queueTail.next = waiter;
      }
      this.queueTail = waiter;
      this.scheduleWakeUp();
    });
  }

  private refill(): void {
    const now = Date.now();
    if (now <= this.lastRefill) {
      return;
    }

    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed / this.intervalMs);
    this.lastRefill = now;
  }

  private releaseWaiters(): void {
    while (this.queueHead !== undefined && this.tokens >= 1) {
      const waiter = this.queueHead;
      this.queueHead = waiter.next;
      if (this.queueHead === undefined) {
        this.queueTail = undefined;
      }

      this.tokens -= 1;
      waiter.resolve();
    }

    if (this.queueHead === undefined && this.wakeUpTimer !== undefined) {
      clearTimeout(this.wakeUpTimer);
      this.wakeUpTimer = undefined;
    }
  }

  private scheduleWakeUp(): void {
    if (this.queueHead === undefined || this.wakeUpTimer !== undefined) {
      return;
    }

    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, Math.ceil((1 - this.tokens) * this.intervalMs)));
    this.wakeUpTimer = setTimeout(() => {
      this.wakeUpTimer = undefined;
      this.refill();
      this.releaseWaiters();
      this.scheduleWakeUp();
    }, delay);
  }
}
