import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KDF_PARAMS,
  KDF_PARAMS_LIMITS,
  generateAccountKey,
  hashAuthKey,
  randomBytes,
  randomId,
  toBase64Url,
  wrapAccountKey,
} from '../crypto/index.ts';
import {
  accountId,
  authKey,
  collectionName,
  createAccountRequest,
  createSessionRequest,
  infoResponse,
  kdfParams,
  wrappedAccountKey,
} from './api.ts';

async function registration() {
  const id = randomId();
  const kek = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
  const key = randomBytes(32);
  return {
    accountId: id,
    salt: toBase64Url(randomBytes(16)),
    kdfParams: { ...DEFAULT_KDF_PARAMS },
    authHash: toBase64Url(await hashAuthKey(key)),
    wrappedAccountKey: await wrapAccountKey(kek, generateAccountKey(), id),
  };
}

describe('createAccountRequest', () => {
  it('accepts what the crypto module produces', async () => {
    const body = await registration();
    expect(createAccountRequest.parse(body)).toEqual(body);
  });

  it('drops unknown fields instead of storing them', async () => {
    const body = { ...(await registration()), extra: 'x' };
    expect(createAccountRequest.parse(body)).not.toHaveProperty('extra');
  });

  it('rejects KDF parameters below the SEC-1 floor', async () => {
    const body = await registration();
    const weak = { ...body, kdfParams: { ...body.kdfParams, memoryKiB: 1024 } };
    expect(createAccountRequest.safeParse(weak).success).toBe(false);
  });
});

describe('fixed-length base64url fields', () => {
  it('accept exactly the right number of bytes and nothing else', () => {
    const cases = [
      { schema: accountId, bytes: 16 },
      { schema: authKey, bytes: 32 },
      { schema: wrappedAccountKey, bytes: 60 },
    ];
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 80 }), (bytes) => {
        const encoded = toBase64Url(bytes);
        for (const { schema, bytes: expected } of cases) {
          expect(schema.safeParse(encoded).success).toBe(bytes.length === expected);
        }
      }),
    );
  });
});

describe('kdfParams', () => {
  it('accepts exactly the range clients accept (ADR-0008)', () => {
    const { memoryKiB, iterations, parallelism } = KDF_PARAMS_LIMITS;
    fc.assert(
      fc.property(
        fc.integer({ min: memoryKiB.min - 10, max: memoryKiB.max + 10 }),
        fc.integer({ min: 0, max: 12 }),
        fc.integer({ min: 0, max: 6 }),
        (m, t, p) => {
          const inRange =
            m >= memoryKiB.min &&
            m <= memoryKiB.max &&
            t >= iterations.min &&
            t <= iterations.max &&
            p >= parallelism.min &&
            p <= parallelism.max;
          const params = { algorithm: 'argon2id', memoryKiB: m, iterations: t, parallelism: p };
          expect(kdfParams.safeParse(params).success).toBe(inRange);
        },
      ),
    );
  });
});

describe('collectionName', () => {
  it('accepts the known collections and rejects path tricks', () => {
    for (const name of ['tabs', 'commands', 'history', 'extensions', 'bookmarks', 'devices']) {
      expect(collectionName.safeParse(name).success).toBe(true);
    }
    for (const name of ['', 'Tabs', '../x', 'a/b', '1tabs', 'x'.repeat(33)]) {
      expect(collectionName.safeParse(name).success).toBe(false);
    }
  });
});

describe('createSessionRequest', () => {
  it('trims device names and rejects empty ones', () => {
    const base = {
      accountId: randomId(),
      authKey: toBase64Url(randomBytes(32)),
      device: { id: 'dev_1', name: '  Laptop  ', browser: { family: 'firefox', version: '140' } },
    };
    expect(createSessionRequest.parse(base).device.name).toBe('Laptop');
    const blank = { ...base, device: { ...base.device, name: '   ' } };
    expect(createSessionRequest.safeParse(blank).success).toBe(false);
  });
});

describe('infoResponse', () => {
  it('parses a signed-in response', () => {
    const info = {
      version: '0.1.0',
      minClientVersion: '0.1.0',
      registration: 'invite',
      limits: {
        maxRequestBytes: 2097152,
        maxBatchRecords: 500,
        maxPullRecords: 500,
        storageQuotaBytes: 209715200,
      },
      account: { collections: { tabs: 12 }, storageUsedBytes: 4096 },
    };
    expect(infoResponse.parse(info)).toEqual(info);
  });
});
