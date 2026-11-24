import { describe, expect, it } from 'vitest';
import { schema } from '@tazamun/core';
import { makeHarness, newAccount, payload, rand } from '../test/harness.ts';

function errorCode(json: unknown): string {
  return schema.errorResponse.parse(json).error.code;
}

describe('GET /v1/health and /v1/info', () => {
  it('reports health without auth', async () => {
    const h = makeHarness();
    const res = await h.call('GET', '/v1/health');
    expect(res.status).toBe(200);
    expect(schema.healthResponse.parse(res.json)).toEqual({ status: 'ok' });
  });

  it('describes the server without auth, and adds account state when signed in', async () => {
    const h = makeHarness({ registration: 'invite' });
    const anon = schema.infoResponse.parse((await h.call('GET', '/v1/info')).json);
    expect(anon).toMatchObject({ version: '0.1.0', registration: 'invite' });
    expect(anon.account).toBeUndefined();
    expect(anon.limits.maxBatchRecords).toBe(500);

    const u = await (async () => {
      const invite = h.invite();
      const a = newAccount(invite);
      await h.call('POST', '/v1/accounts', { body: a.body });
      return { ...a, token: await h.signIn(a, 'dev_A') };
    })();
    await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [{ id: 'dev_A', payload: payload() }],
    });
    const info = schema.infoResponse.parse(
      (await h.call('GET', '/v1/info', { token: u.token })).json,
    );
    expect(info.account?.collections).toEqual({ tabs: 1 });
    expect(info.account?.storageUsedBytes).toBeGreaterThan(0);
  });

  it('keeps the polled /v1/info response small (PERF-5)', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    for (const c of ['tabs', 'commands', 'history', 'extensions', 'bookmarks']) {
      await h.call('POST', `/v1/collections/${c}`, {
        token: u.token,
        body: [{ id: 'x', payload: payload() }],
      });
    }
    const res = await h.call('GET', '/v1/info', { token: u.token });
    expect(res.text.length).toBeLessThan(2048);
  });

  it('answers 401 to a bad token on /v1/info instead of ignoring it (ENG-9)', async () => {
    const h = makeHarness();
    const res = await h.call('GET', '/v1/info', { token: rand(32) });
    expect(res.status).toBe(401);
    expect(errorCode(res.json)).toBe('UNAUTHORIZED');
    // Errors thrown by middleware still get the standard headers and an access-log line.
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(h.logs.at(-1)).toContain('"status":401');
  });
});

describe('account creation (ADM-2)', () => {
  it('open mode accepts anyone and rejects a duplicate ID', async () => {
    const h = makeHarness({ registration: 'open' });
    const a = newAccount();
    expect((await h.call('POST', '/v1/accounts', { body: a.body })).status).toBe(201);
    const again = await h.call('POST', '/v1/accounts', { body: a.body });
    expect(again.status).toBe(409);
    expect(errorCode(again.json)).toBe('ACCOUNT_EXISTS');
  });

  it('closed mode rejects everyone', async () => {
    const h = makeHarness({ registration: 'closed' });
    const res = await h.call('POST', '/v1/accounts', { body: newAccount().body });
    expect(res.status).toBe(403);
    expect(errorCode(res.json)).toBe('REGISTRATION_CLOSED');
  });

  it('invite mode needs a valid invite, and each invite works once', async () => {
    const h = makeHarness({ registration: 'invite' });
    const missing = await h.call('POST', '/v1/accounts', { body: newAccount().body });
    expect(errorCode(missing.json)).toBe('INVITE_REQUIRED');

    const bogus = await h.call('POST', '/v1/accounts', { body: newAccount(rand(32)).body });
    expect(errorCode(bogus.json)).toBe('INVITE_INVALID');

    const invite = h.invite();
    expect((await h.call('POST', '/v1/accounts', { body: newAccount(invite).body })).status).toBe(
      201,
    );
    const reused = await h.call('POST', '/v1/accounts', { body: newAccount(invite).body });
    expect(errorCode(reused.json)).toBe('INVITE_INVALID');
  });

  it('rejects expired invites', async () => {
    const h = makeHarness({ registration: 'invite' });
    const invite = h.invite(h.now() + 1000);
    h.advance(1000);
    const res = await h.call('POST', '/v1/accounts', { body: newAccount(invite).body });
    expect(errorCode(res.json)).toBe('INVITE_INVALID');
  });

  it('a failed invite check creates no account', async () => {
    const h = makeHarness({ registration: 'invite' });
    const a = newAccount(rand(32));
    await h.call('POST', '/v1/accounts', { body: a.body });
    expect(h.db.getAccount(a.accountId)).toBeUndefined();
  });

  it('rejects KDF parameters below the SEC-1 floor', async () => {
    const h = makeHarness();
    const a = newAccount();
    const body = { ...a.body, kdfParams: { ...a.body.kdfParams, iterations: 1 } };
    const res = await h.call('POST', '/v1/accounts', { body });
    expect(res.status).toBe(400);
  });
});

describe('prelogin (SEC-9)', () => {
  it('returns the stored salt and parameters for a real account', async () => {
    const h = makeHarness();
    const a = newAccount();
    await h.call('POST', '/v1/accounts', { body: a.body });
    const res = await h.call('GET', `/v1/accounts/${a.accountId}/prelogin`);
    expect(res.json).toEqual({ salt: a.body.salt, kdfParams: a.body.kdfParams });
  });

  it('returns a stable, real-looking answer for an unknown account', async () => {
    const h = makeHarness();
    const id = newAccount().accountId;
    const first = await h.call('GET', `/v1/accounts/${id}/prelogin`);
    const second = await h.call('GET', `/v1/accounts/${id}/prelogin`);
    expect(first.status).toBe(200);
    expect(first.json).toEqual(second.json);
    const parsed = schema.preloginResponse.parse(first.json);
    const other = await h.call('GET', `/v1/accounts/${newAccount().accountId}/prelogin`);
    expect(schema.preloginResponse.parse(other.json).salt).not.toBe(parsed.salt);
  });
});

describe('sessions (ACC-8)', () => {
  it('rejects a wrong auth key and an unknown account with the same error', async () => {
    const h = makeHarness();
    const a = newAccount();
    await h.call('POST', '/v1/accounts', { body: a.body });
    const device = { id: 'dev_A', name: 'A', browser: { family: 'chrome', version: '140' } };
    const wrong = await h.call('POST', '/v1/sessions', {
      body: { accountId: a.accountId, authKey: rand(32), device },
    });
    const unknown = await h.call('POST', '/v1/sessions', {
      body: { accountId: newAccount().accountId, authKey: a.authKey, device },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.json).toEqual(unknown.json);
  });

  it('gives each device one session: signing in again ends the old token', async () => {
    const h = makeHarness();
    const u = await h.signUp('dev_A');
    const second = await h.signIn(u, 'dev_A');
    expect((await h.call('GET', '/v1/devices', { token: u.token })).status).toBe(401);
    expect((await h.call('GET', '/v1/devices', { token: second })).status).toBe(200);
  });

  it('signs out the current device', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    expect((await h.call('DELETE', '/v1/sessions/current', { token: u.token })).status).toBe(204);
    expect((await h.call('GET', '/v1/devices', { token: u.token })).status).toBe(401);
  });

  it('stores only hashes of tokens and auth keys (SEC-4)', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const account = h.db.getAccount(u.accountId);
    expect(account).toBeDefined();
    expect(Buffer.from(account?.authHash ?? []).toString('base64url')).not.toBe(u.authKey);
    // The raw token isn't a valid lookup key; only its hash is.
    expect(h.db.findSession(new TextEncoder().encode(u.token))).toBeUndefined();
  });
});

describe('devices (ACC-7, ACC-8)', () => {
  it('lists, renames and revokes devices; revoking ends that device’s session', async () => {
    const h = makeHarness();
    const u = await h.signUp('dev_A');
    const tokenB = await h.signIn(u, 'dev_B');

    const list = schema.listDevicesResponse.parse(
      (await h.call('GET', '/v1/devices', { token: u.token })).json,
    );
    expect(list.devices.map((d) => [d.id, d.current])).toEqual([
      ['dev_A', true],
      ['dev_B', false],
    ]);

    const renamed = await h.call('PUT', '/v1/devices/dev_B', {
      token: u.token,
      body: { name: 'Work laptop' },
    });
    expect(schema.device.parse(renamed.json).name).toBe('Work laptop');
    // Signing in again keeps the user's name for the device.
    const tokenB2 = await h.signIn(u, 'dev_B');
    const after = schema.listDevicesResponse.parse(
      (await h.call('GET', '/v1/devices', { token: tokenB2 })).json,
    );
    expect(after.devices.find((d) => d.id === 'dev_B')?.name).toBe('Work laptop');

    expect((await h.call('DELETE', '/v1/devices/dev_B', { token: u.token })).status).toBe(204);
    expect((await h.call('GET', '/v1/info', { token: tokenB2 })).status).toBe(401);
    expect((await h.call('GET', '/v1/info', { token: tokenB })).status).toBe(401);
    expect((await h.call('DELETE', '/v1/devices/dev_B', { token: u.token })).status).toBe(404);
  });

  it("can't touch another account's devices", async () => {
    const h = makeHarness();
    const u1 = await h.signUp('dev_A');
    const u2 = await h.signUp('dev_X');
    expect((await h.call('DELETE', '/v1/devices/dev_X', { token: u1.token })).status).toBe(404);
    expect((await h.call('GET', '/v1/info', { token: u2.token })).status).toBe(200);
  });
});

describe('keys (ACC-9)', () => {
  it('returns the key bundle and re-wraps it, ending other devices’ sessions', async () => {
    const h = makeHarness();
    const u = await h.signUp('dev_A');
    const tokenB = await h.signIn(u, 'dev_B');
    const bundle = schema.keyBundle.parse(
      (await h.call('GET', '/v1/keys', { token: u.token })).json,
    );
    expect(bundle.wrappedAccountKey).toBe(u.body.wrappedAccountKey);

    const next = newAccount();
    const update = {
      authKey: u.authKey,
      salt: next.body.salt,
      kdfParams: next.body.kdfParams,
      authHash: next.body.authHash,
      wrappedAccountKey: next.body.wrappedAccountKey,
    };
    expect(
      (await h.call('PUT', '/v1/keys', { token: u.token, body: { ...update, authKey: rand(32) } }))
        .status,
    ).toBe(401);
    expect((await h.call('PUT', '/v1/keys', { token: u.token, body: update })).status).toBe(204);

    expect((await h.call('GET', '/v1/keys', { token: tokenB })).status).toBe(401);
    const after = schema.keyBundle.parse(
      (await h.call('GET', '/v1/keys', { token: u.token })).json,
    );
    expect(after.salt).toBe(next.body.salt);
    // The new passphrase signs in; the old one doesn't.
    await expect(h.signIn({ ...u, authKey: next.authKey }, 'dev_C')).resolves.toBeTypeOf('string');
    await expect(h.signIn(u, 'dev_D')).rejects.toThrow();
  });
});

describe('collections', () => {
  it('pushes and pulls with per-account, gap-free sequence numbers', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const p1 = await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [
        { id: 'a', payload: payload() },
        { id: 'b', payload: payload() },
      ],
    });
    expect(schema.pushResponse.parse(p1.json)).toEqual([
      { id: 'a', seq: 1 },
      { id: 'b', seq: 2 },
    ]);
    const p2 = await h.call('POST', '/v1/collections/history', {
      token: u.token,
      body: [{ id: 'h', payload: payload() }],
    });
    expect(p2.json).toEqual([{ id: 'h', seq: 3 }]);

    const pull = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/tabs?since=0', { token: u.token })).json,
    );
    expect(pull.records.map((r) => [r.id, r.seq])).toEqual([
      ['a', 1],
      ['b', 2],
    ]);
    expect(pull).toMatchObject({ nextSince: 2, more: false });

    // Overwriting moves the record to a new seq; the old one is gone.
    await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [{ id: 'a', payload: payload() }],
    });
    const inc = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/tabs?since=2', { token: u.token })).json,
    );
    expect(inc.records.map((r) => [r.id, r.seq])).toEqual([['a', 4]]);
  });

  it('pages through results', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const body = Array.from({ length: 7 }, (_, i) => ({ id: `r${String(i)}`, payload: payload() }));
    await h.call('POST', '/v1/collections/tabs', { token: u.token, body });
    const seen: string[] = [];
    let since = 0;
    for (;;) {
      const page = schema.pullResponse.parse(
        (
          await h.call('GET', `/v1/collections/tabs?since=${String(since)}&limit=3`, {
            token: u.token,
          })
        ).json,
      );
      seen.push(...page.records.map((r) => r.id));
      since = page.nextSince;
      if (!page.more) break;
    }
    expect(seen).toEqual(body.map((r) => r.id));
  });

  it('isolates accounts', async () => {
    const h = makeHarness();
    const u1 = await h.signUp();
    const u2 = await h.signUp();
    await h.call('POST', '/v1/collections/tabs', {
      token: u1.token,
      body: [{ id: 'a', payload: payload() }],
    });
    const pull = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/tabs', { token: u2.token })).json,
    );
    expect(pull.records).toEqual([]);
    const push = await h.call('POST', '/v1/collections/tabs', {
      token: u2.token,
      body: [{ id: 'a', payload: payload() }],
    });
    expect(push.json).toEqual([{ id: 'a', seq: 1 }]);
  });

  it('hides expired records and passes expiresAt through', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const expiresAt = new Date(h.now() + 60_000).toISOString();
    await h.call('POST', '/v1/collections/commands', {
      token: u.token,
      body: [{ id: 'c', payload: payload(), expiresAt }],
    });
    const before = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/commands', { token: u.token })).json,
    );
    expect(before.records[0]?.expiresAt).toBe(expiresAt);
    h.advance(60_000);
    const after = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/commands', { token: u.token })).json,
    );
    expect(after.records).toEqual([]);
  });

  it('rejects bad batches without storing anything', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const cases: { body: unknown; path?: string }[] = [
      { body: [] },
      {
        body: [
          { id: 'a', payload: payload() },
          { id: 'a', payload: payload() },
        ],
      },
      { body: [{ id: 'a', payload: 'short' }] },
      {
        body: Array.from({ length: 501 }, (_, i) => ({ id: `r${String(i)}`, payload: payload() })),
      },
      { body: [{ id: 'a', payload: payload() }], path: '/v1/collections/Tabs' },
      { body: 'not json' },
    ];
    for (const { body, path } of cases) {
      const res = await h.call('POST', path ?? '/v1/collections/tabs', { token: u.token, body });
      expect(res.status).toBe(400);
      expect(errorCode(res.json)).toBe('INVALID_REQUEST');
    }
    const info = schema.infoResponse.parse(
      (await h.call('GET', '/v1/info', { token: u.token })).json,
    );
    expect(info.account?.collections).toEqual({});
  });

  it('requires a session', async () => {
    const h = makeHarness();
    expect((await h.call('GET', '/v1/collections/tabs')).status).toBe(401);
    expect((await h.call('POST', '/v1/collections/tabs', { body: [] })).status).toBe(401);
  });
});

describe('limits (ADM-3, SRS 4.4.1)', () => {
  it('rejects a batch over the storage quota as a whole, and still accepts shrinking batches', async () => {
    const h = makeHarness({ storageQuotaBytes: 1000 });
    const u = await h.signUp();
    const big = await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [{ id: 'a', payload: payload(600) }],
    });
    expect(big.status).toBe(200);
    const over = await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [
        { id: 'b', payload: payload(30) },
        { id: 'c', payload: payload(300) },
      ],
    });
    expect(over.status).toBe(403);
    expect(errorCode(over.json)).toBe('QUOTA_EXCEEDED');
    const pull = schema.pullResponse.parse(
      (await h.call('GET', '/v1/collections/tabs', { token: u.token })).json,
    );
    expect(pull.records.map((r) => r.id)).toEqual(['a']);

    const shrink = await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [{ id: 'a', payload: payload(30) }],
    });
    expect(shrink.status).toBe(200);
  });

  it('rejects bodies over 2 MiB', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    const body = [{ id: 'a', payload: 'A'.repeat(2 * 1024 * 1024) }];
    const res = await h.call('POST', '/v1/collections/tabs', { token: u.token, body });
    expect(res.status).toBe(413);
    expect(errorCode(res.json)).toBe('PAYLOAD_TOO_LARGE');
  });

  it('rate-limits sign-in per IP and per account, with Retry-After', async () => {
    const h = makeHarness({ authRateLimitPerMinute: 3 });
    const a = newAccount();
    await h.call('POST', '/v1/accounts', { body: a.body });
    const attempt = (ip: string) =>
      h.call('POST', '/v1/sessions', {
        headers: { 'x-test-ip': ip },
        body: {
          accountId: a.accountId,
          authKey: rand(32),
          device: { id: 'd', name: 'd', browser: { family: 'f', version: '1' } },
        },
      });
    for (let i = 0; i < 3; i++) expect((await attempt(`198.51.100.${String(i)}`)).status).toBe(401);
    // A fresh IP is still blocked, because the account's own budget is used up.
    const blocked = await attempt('198.51.100.99');
    expect(blocked.status).toBe(429);
    expect(errorCode(blocked.json)).toBe('RATE_LIMITED');
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
    h.advance(60_000);
    expect((await attempt('198.51.100.99')).status).toBe(401);
  });

  it('rate-limits signed-in requests per account', async () => {
    const h = makeHarness({ rateLimitPerMinute: 5 });
    const u = await h.signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await h.call('GET', '/v1/info', { token: u.token })).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
  });
});

describe('DELETE /v1/accounts/me (ACC-10)', () => {
  it('needs the auth key, then deletes everything', async () => {
    const h = makeHarness();
    const u = await h.signUp();
    await h.call('POST', '/v1/collections/tabs', {
      token: u.token,
      body: [{ id: 'a', payload: payload() }],
    });
    expect(
      (await h.call('DELETE', '/v1/accounts/me', { token: u.token, body: { authKey: rand(32) } }))
        .status,
    ).toBe(401);
    expect(
      (await h.call('DELETE', '/v1/accounts/me', { token: u.token, body: { authKey: u.authKey } }))
        .status,
    ).toBe(204);
    expect(h.db.getAccount(u.accountId)).toBeUndefined();
    expect(h.db.listDevices(u.accountId)).toEqual([]);
    expect((await h.call('GET', '/v1/info', { token: u.token })).status).toBe(401);
  });
});

describe('privacy of errors and logs (rule 5, ADM-7)', () => {
  it('never echoes request values in error messages', async () => {
    const h = makeHarness();
    const secret = 'S3cretValue_DoNotEcho';
    const res = await h.call('POST', '/v1/accounts', {
      body: { accountId: secret, salt: secret, authHash: 5 },
    });
    expect(res.status).toBe(400);
    expect(res.text).not.toContain(secret);
  });

  it('logs route patterns, never tokens, account IDs, record IDs or payloads', async () => {
    const h = makeHarness();
    const u = await h.signUp('dev_Secret');
    const recordId = 'historyRecordId_0123456789';
    const body = payload();
    await h.call('POST', '/v1/collections/history', {
      token: u.token,
      body: [{ id: recordId, payload: body }],
    });
    await h.call('GET', `/v1/accounts/${u.accountId}/prelogin`);
    await h.call('PUT', '/v1/devices/dev_Secret', {
      token: u.token,
      body: { name: 'My secret name' },
    });
    const all = h.logs.join('\n');
    for (const value of [
      u.token,
      u.accountId,
      u.authKey,
      recordId,
      body,
      'dev_Secret',
      'My secret name',
    ]) {
      expect(all).not.toContain(value);
    }
    expect(all).toContain('/v1/accounts/:id/prelogin');
    expect(all).toContain('/v1/collections/:name');
  });

  it('answers unknown endpoints with a JSON error', async () => {
    const h = makeHarness();
    const res = await h.call('GET', '/v2/whatever');
    expect(res.status).toBe(404);
    expect(errorCode(res.json)).toBe('NOT_FOUND');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});
