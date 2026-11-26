/**
 * The HTTP API (SRS 4.4). `createApp` builds a Hono app from its services and has no global
 * state, so tests call `app.request()` in-process against an in-memory database.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { routePath } from 'hono/route';
import { schema } from '@tazamun/core';
import { ApiError } from './http/errors.ts';
import { session, type AppEnv, type Services } from './http/context.ts';
import { errorFields } from './log.ts';
import { accountRoutes } from './routes/accounts.ts';
import { MAX_PULL_RECORDS, collectionRoutes } from './routes/collections.ts';
import { sessionRoutes } from './routes/sessions.ts';

export type { Services } from './http/context.ts';

function errorBody(err: ApiError): schema.ErrorResponse {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.retryAfter === undefined ? {} : { retryAfter: err.retryAfter }),
    },
  };
}

export function createApp(s: Services): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Access log: method, route pattern, status and duration only (ADM-7). Never the concrete
  // path, which holds account and device IDs, and never headers or bodies.
  app.use(async (c, next) => {
    const start = performance.now();
    await next();
    s.logger.info('request', {
      method: c.req.method,
      route: routePath(c, -1),
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  });

  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Content-Type-Options', 'nosniff');
  });

  app.use(
    '/v1/*',
    bodyLimit({
      maxSize: schema.MAX_REQUEST_BYTES,
      onError: () => {
        throw new ApiError(
          413,
          'PAYLOAD_TOO_LARGE',
          `Request bodies may be at most ${String(schema.MAX_REQUEST_BYTES / 1024 / 1024)} MiB. Send smaller batches.`,
        );
      },
    }),
  );

  app.get('/v1/health', (c) => {
    try {
      s.db.ping();
    } catch (err) {
      s.logger.error('Health check failed', errorFields(err));
      throw new ApiError(503, 'UNAVAILABLE', 'The database is not available.');
    }
    return c.json({ status: 'ok' } satisfies schema.HealthResponse);
  });

  app.get('/v1/info', session(s, false), (c) => {
    const current = c.get('session');
    const info: schema.InfoResponse = {
      version: s.version,
      time: new Date(s.now()).toISOString(),
      minClientVersion: s.minClientVersion,
      registration: s.registration,
      limits: {
        maxRequestBytes: schema.MAX_REQUEST_BYTES,
        maxBatchRecords: schema.MAX_BATCH_RECORDS,
        maxPullRecords: MAX_PULL_RECORDS,
        storageQuotaBytes: s.storageQuotaBytes,
      },
    };
    if (current !== undefined) {
      info.account = {
        collections: s.db.highWater(current.accountId),
        storageUsedBytes: s.db.getAccount(current.accountId)?.storageBytes ?? 0,
      };
    }
    return c.json(info);
  });

  accountRoutes(app, s);
  sessionRoutes(app, s);
  collectionRoutes(app, s);

  app.notFound((c) => c.json(errorBody(new ApiError(404, 'NOT_FOUND', 'No such endpoint.')), 404));

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      if (err.retryAfter !== undefined) c.header('Retry-After', String(err.retryAfter));
      return c.json(errorBody(err), err.status);
    }
    s.logger.error('Unexpected error', { route: routePath(c, -1), ...errorFields(err) });
    return c.json(
      errorBody(
        new ApiError(
          500,
          'INTERNAL',
          'The server hit an unexpected error. Your data is safe; try again later.',
        ),
      ),
      500,
    );
  });

  return app;
}
