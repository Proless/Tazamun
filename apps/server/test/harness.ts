/**
 * Test harness: an app on an in-memory database with a controllable clock and captured logs,
 * plus a tiny client that creates accounts the way the extension will (without Argon2id, which
 * is slow and already tested in packages/core: the server only ever sees its outputs).
 */
import { createHash, randomBytes } from 'node:crypto';
import { crypto as tzCrypto, schema } from '@tazamun/core';
import { createApp, type Services } from '../src/app.ts';
import { Database } from '../src/db/database.ts';
import { RateLimiter } from '../src/http/rate-limit.ts';
import { createLogger } from '../src/log.ts';
import { newToken, tokenHash } from '../src/secrets.ts';

export interface HarnessOptions {
  readonly registration?: schema.RegistrationMode;
  readonly storageQuotaBytes?: number;
  readonly rateLimitPerMinute?: number;
  readonly authRateLimitPerMinute?: number;
}

export function b64(bytes: Uint8Array): string {
  return tzCrypto.toBase64Url(bytes);
}

/** Random base64url bytes. */
export function rand(bytes: number): string {
  return b64(randomBytes(bytes));
}

/** A payload-shaped string of `bytes` random bytes (at least nonce + tag). */
export function payload(bytes = 64): string {
  return rand(bytes);
}

export interface TestAccount {
  readonly accountId: string;
  readonly username: string;
  readonly authKey: string;
  /** ACC-5: proves the recovery key; the server stores its SHA-256. */
  readonly recoveryAuthKey: string;
  readonly body: schema.CreateAccountRequest;
}

let accounts = 0;

export function sha256b64(bytes: Uint8Array): string {
  return b64(createHash('sha256').update(bytes).digest());
}

export function newAccount(invite?: string, username = `user-${String(++accounts)}`): TestAccount {
  const accountId = tzCrypto.randomId();
  const authKey = randomBytes(32);
  const recoveryAuthKey = randomBytes(32);
  const body: schema.CreateAccountRequest = {
    accountId,
    username,
    salt: rand(16),
    kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS },
    authHash: sha256b64(authKey),
    // The server can't tell a real wrapped key from random bytes of the right length.
    wrappedAccountKey: rand(60),
    recoveryAuthHash: sha256b64(recoveryAuthKey),
    recoveryWrappedAccountKey: rand(60),
    ...(invite === undefined ? {} : { invite }),
  };
  return {
    accountId,
    username,
    authKey: b64(authKey),
    recoveryAuthKey: b64(recoveryAuthKey),
    body,
  };
}

export function makeHarness(options: HarnessOptions = {}) {
  let clock = Date.parse('2026-11-24T10:00:00Z');
  const logs: string[] = [];
  const db = Database.open(':memory:');
  const now = () => clock;
  const services: Services = {
    db,
    logger: createLogger({
      level: 'debug',
      format: 'json',
      write: (line) => logs.push(line),
      now: () => new Date(clock),
    }),
    now,
    clientIp: (c) => c.req.header('x-test-ip') ?? '192.0.2.1',
    version: '0.1.0',
    minClientVersion: '0.1.0',
    registration: options.registration ?? 'open',
    storageQuotaBytes: options.storageQuotaBytes ?? 10 * 1024 * 1024,
    instanceSecret: new TextEncoder().encode('test-instance-secret-0123456789abcdef'),
    limiters: {
      account: new RateLimiter(options.rateLimitPerMinute ?? 10_000, now),
      auth: new RateLimiter(options.authRateLimitPerMinute ?? 10_000, now),
    },
  };
  const app = createApp(services);

  async function call(
    method: string,
    path: string,
    init: { body?: unknown; token?: string; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...init.headers };
    if (init.token !== undefined) headers['authorization'] = `Bearer ${init.token}`;
    let body: string | undefined;
    if (init.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
    }
    const res = await app.request(path, {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
    });
    const text = await res.text();
    const json: unknown = text === '' ? undefined : JSON.parse(text);
    return { status: res.status, headers: res.headers, json, text };
  }

  /** Create an invite directly in the database (the CLI does this in production). */
  function invite(expiresAt?: number): string {
    const token = newToken();
    db.createInvite(rand(6), tokenHash(token), clock, expiresAt);
    return token;
  }

  /** Create an account and sign one device in. */
  async function signUp(deviceId = 'dev_A') {
    const account = newAccount();
    const created = await call('POST', '/v1/accounts', { body: account.body });
    if (created.status !== 201) throw new Error(`signUp failed: ${created.text}`);
    const token = await signIn(account, deviceId);
    return { ...account, token };
  }

  async function signIn(account: TestAccount, deviceId: string): Promise<string> {
    const res = await call('POST', '/v1/sessions', {
      body: {
        accountId: account.accountId,
        authKey: account.authKey,
        device: {
          id: deviceId,
          name: `Device ${deviceId}`,
          browser: { family: 'firefox', version: '140.0' },
        },
      },
    });
    if (res.status !== 201) throw new Error(`signIn failed: ${res.text}`);
    return schema.createSessionResponse.parse(res.json).token;
  }

  return {
    app,
    db,
    services,
    logs,
    call,
    invite,
    signUp,
    signIn,
    advance: (ms: number) => {
      clock += ms;
    },
    now,
  };
}
