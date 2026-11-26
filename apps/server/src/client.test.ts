/**
 * The shared API client and account flows from @tazamun/core against the real app: what the
 * extension's onboarding does, end to end, with real Argon2id (SRS 3.1, ACC-1…3, ACC-5, ACC-7, ACC-8,
 * ACC-13).
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

// Real Argon2id, up to four runs per test: slow on a busy machine.
describe('account flows through the API client', { timeout: 60_000 }, () => {
  it('creates an account, connects a second device, unlocks, and revokes', async () => {
    const h = makeHarness({ registration: 'invite' });
    const client = clientFor(h);

    const info = await client.info();
    expect(info.registration).toBe('invite');
    expect(info.account).toBeUndefined();

    // Without an invite the server refuses, with the stable code the UI branches on.
    await expect(
      account.createAccount(client, {
        username: 'hasan',
        passphrase: PASSPHRASE,
        device: device('dev_A'),
      }),
    ).rejects.toMatchObject({ name: 'ApiError', status: 403, code: 'INVITE_REQUIRED' });

    const first = await account.createAccount(client, {
      username: ' Hasan ',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
      invite: h.invite(),
    });
    expect(first.device).toMatchObject({ id: 'dev_A', current: true });
    expect(first.username).toBe('hasan');
    expect(first.recoveryKey).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){7}$/);
    expect(first.accountKey).toHaveLength(32);

    // ACC-3: the server holds no passphrase, KEK or account key.
    const stored = h.db.getAccount(first.accountId);
    expect(stored).toBeDefined();
    const storedText = JSON.stringify(stored, (_k, v: unknown) =>
      v instanceof Uint8Array ? tzCrypto.toBase64Url(v) : v,
    );
    expect(storedText).not.toContain(tzCrypto.toBase64Url(first.accountKey));
    expect(storedText).not.toContain(PASSPHRASE);
    expect(storedText).not.toContain(first.recoveryKey);

    // A second browser: same account key from the username and passphrase.
    const second = await account.connectAccount(client, {
      username: 'HASAN',
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
    await account.createAccount(client, {
      username: 'hasan',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });

    const wrong = account.connectAccount(client, {
      username: 'hasan',
      passphrase: 'not the passphrase at all',
      device: device('dev_B'),
    });
    await expect(wrong).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    const unknown = account.connectAccount(client, {
      username: 'nobody',
      passphrase: PASSPHRASE,
      device: device('dev_B'),
    });
    await expect(unknown).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('signs a device out (ACC-11)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    const created = await account.createAccount(client, {
      username: 'hasan',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });
    const signedIn = client.withToken(created.token);
    await signedIn.deleteSession();
    await expect(signedIn.keys()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('refuses a taken username, whatever its case (ACC-13)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    await account.createAccount(client, {
      username: 'hasan',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });
    await expect(
      account.createAccount(client, {
        username: 'Hasan',
        passphrase: PASSPHRASE,
        device: device('dev_B'),
      }),
    ).rejects.toMatchObject({ status: 409, code: 'USERNAME_TAKEN' });
  });

  it('renames the account; the old username stops working (ACC-13)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    const created = await account.createAccount(client, {
      username: 'hasan',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });
    const signedIn = client.withToken(created.token);
    expect(await signedIn.account()).toEqual({
      accountId: created.accountId,
      username: 'hasan',
      recoveryKey: true,
    });
    await signedIn.updateUsername('hasan.d');
    expect((await signedIn.account()).username).toBe('hasan.d');
    const again = await account.connectAccount(client, {
      username: 'hasan.d',
      passphrase: PASSPHRASE,
      device: device('dev_B'),
    });
    expect(again.accountId).toBe(created.accountId);
    await expect(
      account.connectAccount(client, {
        username: 'hasan',
        passphrase: PASSPHRASE,
        device: device('dev_C'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
  });

  it('recovers with the recovery key and a new passphrase (ACC-5)', async () => {
    const h = makeHarness();
    const client = clientFor(h);
    const created = await account.createAccount(client, {
      username: 'hasan',
      passphrase: PASSPHRASE,
      device: device('dev_A'),
    });
    const NEW = 'a brand new passphrase';

    await expect(
      account.recoverAccount(client, {
        username: 'hasan',
        recoveryKey: tzCrypto.formatRecoveryKey(tzCrypto.generateRecoveryKey()),
        newPassphrase: NEW,
        device: device('dev_B'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });

    // Typed by hand: lowercase, spaces instead of dashes.
    const typed = created.recoveryKey.toLowerCase().replaceAll('-', ' ');
    const recovered = await account.recoverAccount(client, {
      username: 'hasan',
      recoveryKey: typed,
      newPassphrase: NEW,
      device: device('dev_B'),
    });
    expect(recovered.accountId).toBe(created.accountId);
    expect(tzCrypto.toBase64Url(recovered.accountKey)).toBe(
      tzCrypto.toBase64Url(created.accountKey),
    );

    // Every earlier session ended; the old passphrase no longer signs in, the new one does.
    await expect(client.withToken(created.token).keys()).rejects.toMatchObject({ status: 401 });
    await expect(
      account.connectAccount(client, {
        username: 'hasan',
        passphrase: PASSPHRASE,
        device: device('dev_C'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const withNew = await account.connectAccount(client, {
      username: 'hasan',
      passphrase: NEW,
      device: device('dev_C'),
    });
    expect(tzCrypto.toBase64Url(withNew.accountKey)).toBe(tzCrypto.toBase64Url(created.accountKey));

    // A new recovery key replaces the old one.
    const signedIn = client.withToken(withNew.token);
    await expect(
      account.createRecoveryKey(signedIn, withNew.accountId, withNew.accountKey, PASSPHRASE),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const replacement = await account.createRecoveryKey(
      signedIn,
      withNew.accountId,
      withNew.accountKey,
      NEW,
    );
    expect(replacement).not.toBe(created.recoveryKey);
    await expect(
      account.recoverAccount(client, {
        username: 'hasan',
        recoveryKey: created.recoveryKey,
        newPassphrase: NEW,
        device: device('dev_D'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    const again = await account.recoverAccount(client, {
      username: 'hasan',
      recoveryKey: replacement,
      newPassphrase: 'yet another passphrase',
      device: device('dev_D'),
    });
    expect(again.accountId).toBe(created.accountId);
  });
});
