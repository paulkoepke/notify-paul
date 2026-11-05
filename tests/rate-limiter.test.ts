import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/core/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows up to the limit within the window and frees slots as they expire', () => {
    let now = 0;
    const limiter = new RateLimiter(3, 60_000, () => now);

    expect([limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([true, true]);
    now = 30_000;
    expect(limiter.tryAcquire()).toBe(true);
    expect(limiter.tryAcquire()).toBe(false);

    now = 59_999;
    expect(limiter.tryAcquire()).toBe(false);
    now = 60_000; // the two hits at t=0 expire
    expect([limiter.tryAcquire(), limiter.tryAcquire(), limiter.tryAcquire()]).toEqual([
      true,
      true,
      false,
    ]);
  });

  it('does not count rejected requests', () => {
    let now = 0;
    const limiter = new RateLimiter(1, 1_000, () => now);
    expect(limiter.tryAcquire()).toBe(true);
    now = 500;
    expect(limiter.tryAcquire()).toBe(false);
    now = 1_000;
    expect(limiter.tryAcquire()).toBe(true);
  });
});
