/**
 * Failed-login throttling. In memory on purpose: there is one process, and a
 * restart resetting the counters costs an attacker nothing they did not
 * already have — the second factor is what actually stops guessing.
 */
export interface LimiterOptions {
  perIpMax: number;
  perIpWindowMs: number;
  globalMax: number;
  globalWindowMs: number;
}

export const DEFAULT_LIMITS: LimiterOptions = {
  perIpMax: 5,
  perIpWindowMs: 15 * 60_000,
  // Caps a distributed guess run. A botnet can use it to lock the login for
  // up to an hour; it can never use it to get in. That trade is the right way
  // round for a single-user vault.
  globalMax: 100,
  globalWindowMs: 60 * 60_000,
};

interface Bucket {
  count: number;
  resetAt: number;
}

export class LoginLimiter {
  private readonly byIp = new Map<string, Bucket>();
  private global: Bucket = { count: 0, resetAt: 0 };

  constructor(
    private readonly opts: LimiterOptions = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Seconds until this IP may try again, or 0 if it may try now. */
  retryAfter(ip: string): number {
    const t = this.now();
    if (this.global.resetAt > t && this.global.count >= this.opts.globalMax) {
      return Math.ceil((this.global.resetAt - t) / 1000);
    }
    const b = this.byIp.get(ip);
    if (b && b.resetAt > t && b.count >= this.opts.perIpMax) {
      return Math.ceil((b.resetAt - t) / 1000);
    }
    return 0;
  }

  fail(ip: string): void {
    const t = this.now();
    if (this.global.resetAt <= t) this.global = { count: 0, resetAt: t + this.opts.globalWindowMs };
    this.global.count++;

    let b = this.byIp.get(ip);
    if (!b || b.resetAt <= t) {
      b = { count: 0, resetAt: t + this.opts.perIpWindowMs };
      this.byIp.set(ip, b);
    }
    b.count++;

    // Keep the map from growing without bound under a spray of source IPs.
    if (this.byIp.size > 10_000) {
      for (const [key, bucket] of this.byIp) if (bucket.resetAt <= t) this.byIp.delete(key);
    }
  }

  succeed(ip: string): void {
    this.byIp.delete(ip);
  }
}
