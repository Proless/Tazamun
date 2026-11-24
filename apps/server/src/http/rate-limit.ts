/**
 * In-memory token-bucket rate limiter (ADM-3, SEC-9). One instance per kind of limit; keys name
 * what is limited (an IP, an account). State is lost on restart, which is fine for rate limits.
 *
 * Memory stays bounded: when more than `maxKeys` buckets exist, buckets that have refilled
 * completely (and so carry no information) are dropped, then the oldest if still too many.
 */
export type TakeResult =
  { readonly ok: true } | { readonly ok: false; readonly retryAfter: number };

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  readonly #buckets = new Map<string, Bucket>();
  readonly #capacity: number;
  /** Tokens added per millisecond. */
  readonly #rate: number;
  readonly #now: () => number;
  readonly #maxKeys: number;

  constructor(perMinute: number, now: () => number = Date.now, maxKeys = 100_000) {
    if (!Number.isInteger(perMinute) || perMinute < 1)
      throw new RangeError('perMinute must be ≥ 1');
    this.#capacity = perMinute;
    this.#rate = perMinute / 60_000;
    this.#now = now;
    this.#maxKeys = maxKeys;
  }

  /** Take one token for `key`. When none is left, says how many seconds until one is. */
  take(key: string): TakeResult {
    const now = this.#now();
    let bucket = this.#buckets.get(key);
    if (bucket === undefined) {
      if (this.#buckets.size >= this.#maxKeys) this.#sweep(now);
      bucket = { tokens: this.#capacity, updatedAt: now };
      this.#buckets.set(key, bucket);
    } else {
      const elapsed = Math.max(0, now - bucket.updatedAt);
      bucket.tokens = Math.min(this.#capacity, bucket.tokens + elapsed * this.#rate);
      bucket.updatedAt = now;
    }
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true };
    }
    return {
      ok: false,
      retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) / this.#rate / 1000)),
    };
  }

  get size(): number {
    return this.#buckets.size;
  }

  #sweep(now: number): void {
    for (const [key, bucket] of this.#buckets) {
      if (bucket.tokens + (now - bucket.updatedAt) * this.#rate >= this.#capacity) {
        this.#buckets.delete(key);
      }
    }
    // Still full: drop the oldest entries (Map iterates in insertion order).
    for (const key of this.#buckets.keys()) {
      if (this.#buckets.size < this.#maxKeys) break;
      this.#buckets.delete(key);
    }
  }
}
