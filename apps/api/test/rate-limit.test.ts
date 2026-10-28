import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/rate-limit.js';

/**
 * The rate limiter on the webhook.
 *
 * The limit exists to keep a flood of notifications from turning into a
 * flood of database work. The test that matters is not "does it count" -
 * it is "does it still let a legitimate burst through", because a limit
 * that is too tight rejects a real payment, and a rejected payment is a
 * buyer who paid and got nothing.
 */

describe('RateLimiter', () => {
  it('lets the first requests through and refuses the ones over the limit', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('a').allowed).toBe(true);
    // The fourth is over the limit.
    expect(limiter.check('a').allowed).toBe(false);
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('counts the clients separately', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 60_000 });

    expect(limiter.check('a').allowed).toBe(true);
    expect(limiter.check('b').allowed).toBe(true);
    // ... and 'a' is still over its own limit.
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('opens the window again once it has passed', () => {
    const limiter = new RateLimiter({ limit: 1, windowMs: 1000 });
    const now = 1_000_000;

    expect(limiter.check('a', now).allowed).toBe(true);
    expect(limiter.check('a', now + 10).allowed).toBe(false);
    // The window has passed, so the client is served again.
    expect(limiter.check('a', now + 1001).allowed).toBe(true);
  });

  it('counts a refused request against the budget', () => {
    // Otherwise a flood would be free: the attacker could keep sending
    // and every rejected request would be free work for the API.
    const limiter = new RateLimiter({ limit: 2, windowMs: 60_000 });

    limiter.check('a');
    limiter.check('a');
    expect(limiter.check('a').allowed).toBe(false);
    // Still refused - the counter did not reset.
    expect(limiter.check('a').allowed).toBe(false);
  });

  it('reports how much of the budget is left', () => {
    const limiter = new RateLimiter({ limit: 3, windowMs: 60_000 });

    expect(limiter.check('a').remaining).toBe(2);
    expect(limiter.check('a').remaining).toBe(1);
    expect(limiter.check('a').remaining).toBe(0);
    expect(limiter.check('a').remaining).toBe(0);
  });

  it('leaves room for a burst a real gateway produces', () => {
    // VNPay retries a refused notification up to 10 times, five minutes
    // apart. The limit is per minute and per address, so a legitimate
    // order can never reach it - but the number has to be far above the
    // handful of notifications a real order produces.
    const limiter = new RateLimiter({ limit: 200, windowMs: 60_000 });

    for (let i = 0; i < 20; i += 1) {
      expect(limiter.check('buyer').allowed).toBe(true);
    }
  });
});
