import type { Context, MiddlewareHandler } from 'hono';
import { schema } from '@tazamun/core';
import type { Database } from '../db/database.ts';
import type { Logger } from '../log.ts';
import { tokenHash } from '../secrets.ts';
import { ApiError, unauthorized } from './errors.ts';
import type { RateLimiter } from './rate-limit.ts';

export interface Session {
  readonly accountId: string;
  readonly deviceId: string;
  readonly tokenHash: Uint8Array;
}

export interface AppEnv {
  Variables: { session: Session | undefined };
}

export type AppContext = Context<AppEnv>;

/** Everything the routes need. Built once in main.ts; tests build their own. */
export interface Services {
  readonly db: Database;
  readonly logger: Logger;
  readonly now: () => number;
  /** The client IP for rate limiting (DEP-5: from X-Forwarded-For only when trusted). */
  readonly clientIp: (c: Context) => string;
  readonly version: string;
  readonly minClientVersion: string;
  readonly registration: schema.RegistrationMode;
  readonly storageQuotaBytes: number;
  readonly instanceSecret: Uint8Array;
  readonly limiters: {
    /** Per account, every signed-in request. */
    readonly account: RateLimiter;
    /** Sign-in, registration, prelogin and passphrase checks; keyed by kind and IP or account. */
    readonly auth: RateLimiter;
  };
}

/** Don't write last-seen times more often than this, to keep polling cheap (PERF-5). */
const TOUCH_INTERVAL_MS = 60_000;

/** Throw RATE_LIMITED (429) when `key` has no tokens left. */
export function rateLimit(limiter: RateLimiter, key: string): void {
  const result = limiter.take(key);
  if (!result.ok) {
    throw new ApiError(
      429,
      'RATE_LIMITED',
      `Too many requests. Try again in ${String(result.retryAfter)} s.`,
      result.retryAfter,
    );
  }
}

function bearer(c: Context): string | undefined {
  const header = c.req.header('authorization');
  if (header === undefined) return undefined;
  const match = /^Bearer (\S+)$/.exec(header);
  return match?.[1] ?? '';
}

/**
 * Resolve the session from `Authorization: Bearer <token>`. With `required`, a missing header is
 * 401; without it, a missing header means "not signed in", but a bad token is still 401, so a
 * revoked device learns it's signed out (ENG-9).
 */
export function session(services: Services, required: boolean): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const token = bearer(c);
    if (token === undefined) {
      if (required) throw unauthorized();
      c.set('session', undefined);
      await next();
      return;
    }
    if (!schema.sessionToken.safeParse(token).success) throw unauthorized();
    const hash = tokenHash(token);
    const found = services.db.findSession(hash);
    if (found === undefined) throw unauthorized();
    rateLimit(services.limiters.account, found.accountId);
    const now = services.now();
    if (now - found.lastUsedAt >= TOUCH_INTERVAL_MS) services.db.touchSession(hash, found, now);
    c.set('session', { accountId: found.accountId, deviceId: found.deviceId, tokenHash: hash });
    await next();
  };
}

/** The current session; only call behind `session(services, true)`. */
export function currentSession(c: AppContext): Session {
  const s = c.get('session');
  if (s === undefined) throw unauthorized();
  return s;
}
