/**
 * Test doubles for the engine: an in-memory Tazamun server speaking the real wire format (it
 * validates with the same `@tazamun/core` schemas), and a minimal module. Used by engine tests and,
 * later, by module tests. Not bundled: only `*.test.ts` files import it.
 */
import { merge, schema, type api } from '@tazamun/core';
import type { LocalChange, SyncModule, SyncRecord } from './module.ts';

interface StoredRecord {
  id: string;
  seq: number;
  modifiedAt: string;
  expiresAt?: string;
  payload: string;
}

export class FakeServer {
  readonly records = new Map<string, Map<string, StoredRecord>>();
  seq = 0;
  /** Every request, as `METHOD /path` without the query. */
  readonly requests: string[] = [];
  minClientVersion = '0.0.0';
  /** The server clock `/v1/info` reports (ENG-15); undefined sends none, like an older server. */
  time: (() => number) | undefined = undefined;
  /** The data generation `/v1/info` reports (ENG-16); change it to simulate a restore. */
  generation: string | undefined = 'gen-1';
  /** Make every request fail as if the network were down. */
  down = false;
  /** Answer every authenticated request with 401 (device revoked). */
  revoked = false;
  /** Fail the next N pushes with 503 after storing nothing. */
  failPushes = 0;
  maxPullRecords = 1000;

  readonly fetch: api.Fetch = async (input, init) => {
    await Promise.resolve();
    if (this.down) throw new TypeError('fetch failed');
    const url = new URL(input);
    const method = init.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}`);
    if (this.revoked) return error(401, 'UNAUTHORIZED');
    if (method === 'GET' && url.pathname === '/v1/info') return this.#info();
    const match = /^\/v1\/collections\/([a-z][a-z0-9_-]*)$/.exec(url.pathname);
    if (match?.[1] !== undefined) {
      if (method === 'GET') return this.#pull(match[1], url.searchParams);
      if (method === 'POST')
        return this.#push(match[1], JSON.parse(typeof init.body === 'string' ? init.body : ''));
    }
    return error(404, 'NOT_FOUND');
  };

  collection(name: string): Map<string, StoredRecord> {
    let c = this.records.get(name);
    if (c === undefined) {
      c = new Map();
      this.records.set(name, c);
    }
    return c;
  }

  #info(): Response {
    const collections: Record<string, number> = {};
    for (const [name, c] of this.records) {
      if (c.size > 0) collections[name] = Math.max(...[...c.values()].map((r) => r.seq));
    }
    const body: schema.InfoResponse = {
      version: '0.1.0',
      minClientVersion: this.minClientVersion,
      ...(this.time === undefined ? {} : { time: new Date(this.time()).toISOString() }),
      ...(this.generation === undefined ? {} : { generation: this.generation }),
      registration: 'invite',
      limits: {
        maxRequestBytes: 2_097_152,
        maxBatchRecords: 500,
        maxPullRecords: this.maxPullRecords,
        storageQuotaBytes: 200 * 1024 * 1024,
      },
      account: { collections, storageUsedBytes: 0 },
    };
    return json(200, body);
  }

  #pull(name: string, params: URLSearchParams): Response {
    const since = Number(params.get('since') ?? '0');
    const limit = Math.min(Number(params.get('limit') ?? this.maxPullRecords), this.maxPullRecords);
    const all = [...this.collection(name).values()]
      .filter((r) => r.seq > since)
      .sort((a, b) => a.seq - b.seq);
    const page = all.slice(0, limit);
    const body: schema.PullResponse = {
      records: page.map((r) => ({ ...r })),
      nextSince: page.at(-1)?.seq ?? since,
      more: all.length > limit,
    };
    return json(200, schema.pullResponse.parse(body));
  }

  #push(name: string, body: unknown): Response {
    const records = schema.pushRequest.parse(body);
    if (this.failPushes > 0) {
      this.failPushes--;
      return error(503, 'UNAVAILABLE');
    }
    const c = this.collection(name);
    const result: schema.PushResponse = [];
    for (const r of records) {
      this.seq++;
      c.set(r.id, {
        id: r.id,
        seq: this.seq,
        modifiedAt: '2026-11-25T10:00:00Z',
        payload: r.payload,
        ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt }),
      });
      result.push({ id: r.id, seq: this.seq });
    }
    return json(200, result);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function error(status: number, code: string): Response {
  return json(status, { error: { code, message: code } });
}

type TabsData = schema.TabsData;

/**
 * A module like tabs: one record per device, ID = device ID, last writer wins. Its "browser" is a
 * plain value the test sets; `applied` records what the engine applied.
 */
export class FakeTabsModule implements SyncModule<TabsData> {
  readonly collection = schema.COLLECTIONS.tabs;
  /** The browser's current tabs, or undefined for none published. */
  browser: TabsData | undefined;
  readonly applied: SyncRecord<TabsData>[] = [];
  detectCalls = 0;

  constructor(browser?: TabsData) {
    this.browser = browser;
  }

  async detectLocalChanges(ctx: {
    mirror: { get(id: string): Promise<SyncRecord<TabsData> | undefined> };
    deviceId: string;
  }): Promise<LocalChange<TabsData>[]> {
    this.detectCalls++;
    if (this.browser === undefined) return [];
    const current = await ctx.mirror.get(ctx.deviceId);
    if (current !== undefined && !current.payload.deleted) {
      if (merge.jsonEqual(current.payload.data, this.browser)) return [];
    }
    return [{ id: ctx.deviceId, data: this.browser }];
  }

  merge(
    local: schema.Payload<TabsData> | undefined,
    remote: schema.Payload<TabsData>,
  ): schema.Payload<TabsData> {
    return merge.lastWriterWins(local, remote);
  }

  apply(records: SyncRecord<TabsData>[]): Promise<void> {
    this.applied.push(...records);
    return Promise.resolve();
  }
}

export function tabsWith(...urls: string[]): TabsData {
  return {
    windows: [
      {
        focused: true,
        tabs: urls.map((url, i) => ({
          url,
          title: `Tab ${String(i)}`,
          pinned: false,
          active: i === 0,
        })),
      },
    ],
  };
}
