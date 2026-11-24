import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limit.ts';

describe('RateLimiter', () => {
  it('allows a burst of the per-minute limit, then refills over time', () => {
    let now = 0;
    const limiter = new RateLimiter(6, () => now);
    for (let i = 0; i < 6; i++) expect(limiter.take('k').ok).toBe(true);
    const denied = limiter.take('k');
    expect(denied).toEqual({ ok: false, retryAfter: 10 });
    now += 10_000;
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(false);
  });

  it('keeps keys independent', () => {
    const limiter = new RateLimiter(1, () => 0);
    expect(limiter.take('a').ok).toBe(true);
    expect(limiter.take('b').ok).toBe(true);
    expect(limiter.take('a').ok).toBe(false);
  });

  it('never refills above the limit', () => {
    let now = 0;
    const limiter = new RateLimiter(2, () => now);
    limiter.take('k');
    now += 3_600_000;
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(true);
    expect(limiter.take('k').ok).toBe(false);
  });

  it('stays bounded in memory, dropping refilled buckets first', () => {
    let now = 0;
    const limiter = new RateLimiter(60, () => now, 100);
    for (let i = 0; i < 100; i++) limiter.take(`old${String(i)}`);
    now += 60_000;
    limiter.take('busy');
    expect(limiter.size).toBe(1);
    for (let i = 0; i < 500; i++) limiter.take(`new${String(i)}`);
    expect(limiter.size).toBeLessThanOrEqual(100);
  });
});
