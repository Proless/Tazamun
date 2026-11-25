/**
 * The shared API client and account flows from @tazamun/core against the real app: what the
 * extension's onboarding does, end to end, with real Argon2id (SRS 3.1, ACC-1…3, ACC-7, ACC-8).
 */
import { describe, expect, it } from 'vitest';
import { account, api, crypto as tzCrypto } from '@tazamun/core';
import { makeHarness } from '../test/harness.ts';

const BASE = 'https://sync.example.org';

function clientFor(h: ReturnType<typeof makeHarness>): api.ApiClient {
  return new api.ApiClient({
    baseUrl: BASE,
    fetch: async (input, init) => h.app.request(input, init),
  });
}

function device(id: string) {
  return { id, name: `Firefox on Linux (${id})`, browser: { family: 'firefox', version: '140.0' } };
}

const PASSPHRASE = 'correct horse battery staple';

describe('account flows through the API client', () => {
  it('creates an account, connects a second device, unlocks, and revokes', async () => {
    const h = makeHarness({ registration: 'invite' });
    const client = clientFor(h);

    const info = await client.info();
    expect(info.registration).toBe('invite');
    expect(info.account).toBeUndefined();

    // Without an invite the server refuses, with the stable code the UI branches on.
    await expect(
      account.createAccount(client, { passphrase: PASSPHRASE, device: device('dev_A') }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'INVITE_REQUIRED' });

    const first = await account.createAccount(client, {
      passphrase: PASSPHRASE,
      device: device('dev_A'),
      invite: h.invite(),
    });
    expect(first.device).toMatchObject({ id: 'dev_A', current: true });
    expect(first.accountKey).toHaveLength(32);

    // ACC-3: the server holds no passphrase, KEK or account key.
    const stored = h.db.getAccount(first.accountId);
    expect(stored).toBeDefined();
    const storedText = JSON.stringify(stored, (_k, v: unknown) =>
      v instanceof Uint8Array ? tzCrypto.toBase64Url(v) : v,
    );
    expect(storedText).not.toContain(tzCrypto.toBase64Url(first.accountKey));
    expect(storedText).not.toContain(PASSPHRASE);

    // A second browser: same account key from the passphrase alone.
    const second = await account.connectAccount(client, {
      accountId: first.accountId,
      passphrase: PASSPHRASE,
      device: device('dev_B'),
    });
    expect(tzCrypto.toBase64Url(second.accountKey)).toBe(tzCrypto.toBase64Url(first.accountKey));
    expect(second.token).not.toBe(first.token);

    const signedIn = client.withToken(second.token);
    expect((await signedIn.info()).account).toBeDefined();
    expect((await signedIn.listDevices()).map((d) => d.id).sort()).toEqual(['dev_A', 'dev_B']);

    // SEC-5 with "don't remember": unlock again with the passphrase.
    const key = await account.unlockAccount(signedIn, first.accountId, PASSPHRASE);
    expect(tzCrypto.toBase64Url(key)).toBe(tzCrypto.toBase64Url(first.accountKey));
    await expect(
      account.unlockAccount(signedIn, first.accountId, 'wrong passphrase, long enough'),
    ).rejects.toBeInstanceOf(account.WrongPassphraseError);

    // ACC-8: revoking B ends its session immediately.
    await client.withToken(first.token).revokeDevice('dev_B');
    await expect(signedIn.keys()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
  });

  it('reports a wrong passphrase and an unknown account the same way (SEC-9)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    const created = await account.createAccount(client, {
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });

    const wrong = account.connectAccount(client, {
      accountId: created.accountId,
      passphrase: 'not the passphrase at all',
      device: device('dev_B'),
    });
    await expect(wrong).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const unknown = account.connectAccount(client, {
      accountId: tzCrypto.randomId(),
      passphrase: PASSPHRASE,
      device: device('dev_B'),
    });
    await expect(unknown).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('signs a device out (ACC-11)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    const created = await account.createAccount(client, {
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });
    const signedIn = client.withToken(created.token);
    await signedIn.deleteSession();
    await expect(signedIn.keys()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });
});
