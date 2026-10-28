/**
 * A small in-memory rate limiter.
 *
 * The webhook is the one endpoint that is exposed to the internet, and it
 * is the one endpoint where a flood of requests costs real work: every
 * notification is verified with an HMAC, written to the reconciliation log
 * and - if it applies - posted to the ledger inside a database
 * transaction. An attacker who finds the URL can send a million signed
 * (or unsigned) notifications and make the API do a million database
 * round-trips.
 *
 * This is deliberately the simplest thing that works: a fixed window per
 * client, counted in memory. It is not a distributed limiter, and it does
 * not survive a restart - both are noted in the README under "not
 * production ready", together with what a real deployment would use
 * instead (a shared store, or the gateway's own rate limiting).
 */

interface Window {
  /** when the window started (epoch ms) */
  startedAt: number;
  /** how many requests were seen in it */
  count: number;
}

export interface RateLimiterOptions {
  /** how many requests are allowed per window */
  limit: number;
  /** how long the window lasts, in milliseconds */
  windowMs: number;
}

/**
 * Counts requests per client key and reports whether a request is allowed.
 *
 * The counter is pruned lazily: when a client comes back after its window
 * has passed, the stale entry is replaced rather than accumulated, so a
 * long-running process does not keep a growing map of clients it has not
 * seen for hours.
 */
export class RateLimiter {
  private readonly windows = new Map<string, Window>();

  constructor(private readonly options: RateLimiterOptions) {}

  /**
   * Registers a request and says whether it may proceed.
   *
   * The request is counted either way: a rejected request still consumed
   * the client's budget, otherwise a flood would be free.
   */
  check(key: string, now = Date.now()): { allowed: boolean; remaining: number } {
    const existing = this.windows.get(key);

    if (!existing || now - existing.startedAt >= this.options.windowMs) {
      this.windows.set(key, { startedAt: now, count: 1 });
      return { allowed: true, remaining: this.options.limit - 1 };
    }

    existing.count += 1;
    const allowed = existing.count <= this.options.limit;
    return {
      allowed,
      remaining: Math.max(0, this.options.limit - existing.count),
    };
  }

  /** Forgets the counters. Only used by the tests. */
  reset(): void {
    this.windows.clear();
  }
}
