/**
 * Collections: incremental pull and batch push of encrypted records (ADR-0003, SRS 4.4.3).
 * The server never looks inside payloads (rule 1) and has no code for any collection (rule 2).
 */
import type { Hono } from 'hono';
import { z } from 'zod';
import { schema } from '@tazamun/core';
import { currentSession, session, type AppEnv, type Services } from '../http/context.ts';
import { ApiError } from '../http/errors.ts';
import { parse, readJson } from '../http/validate.ts';

/** Records per pull page. Same as the push batch limit, so a page fits in one request. */
export const MAX_PULL_RECORDS = schema.MAX_BATCH_RECORDS;
/** Payload bytes per pull page: the same bound as a request body. */
const MAX_PULL_BYTES = schema.MAX_REQUEST_BYTES;

const pullQuery = z.object({
  since: z.coerce.number().pipe(schema.seq).default(0),
  limit: z.coerce.number().int().min(1).max(MAX_PULL_RECORDS).default(MAX_PULL_RECORDS),
});

export function collectionRoutes(app: Hono<AppEnv>, s: Services): void {
  app.get('/v1/collections/:name', session(s, true), (c) => {
    const { accountId } = currentSession(c);
    const name = parse(schema.collectionName, c.req.param('name'));
    const query = parse(pullQuery, c.req.query());
    const page = s.db.pull(accountId, name, query.since, query.limit, MAX_PULL_BYTES, s.now());
    const response: schema.PullResponse = {
      records: page.records.map((r) => ({
        id: r.id,
        seq: r.seq,
        modifiedAt: new Date(r.modifiedAt).toISOString(),
        ...(r.expiresAt === undefined ? {} : { expiresAt: new Date(r.expiresAt).toISOString() }),
        payload: r.payload,
      })),
      nextSince: page.records.at(-1)?.seq ?? query.since,
      more: page.more,
    };
    return c.json(response);
  });

  app.post('/v1/collections/:name', session(s, true), async (c) => {
    const { accountId } = currentSession(c);
    const name = parse(schema.collectionName, c.req.param('name'));
    const body = await readJson(c, schema.pushRequest);
    const ids = new Set(body.map((r) => r.id));
    if (ids.size !== body.length) {
      throw new ApiError(
        400,
        'INVALID_REQUEST',
        'A batch must not contain the same record ID twice.',
      );
    }
    const result = s.db.push(
      accountId,
      name,
      body.map((r) => ({
        id: r.id,
        payload: r.payload,
        expiresAt: r.expiresAt === undefined ? undefined : Date.parse(r.expiresAt),
      })),
      s.now(),
      s.storageQuotaBytes,
    );
    if (!result.ok) {
      const mib = (n: number) => (n / 1024 / 1024).toFixed(1);
      throw new ApiError(
        403,
        'QUOTA_EXCEEDED',
        `This account has reached its storage limit (${mib(result.usedBytes)} of ${mib(s.storageQuotaBytes)} MiB used). Nothing from this batch was saved.`,
      );
    }
    const response: schema.PushResponse = [...result.seqs];
    return c.json(response);
  });
}
