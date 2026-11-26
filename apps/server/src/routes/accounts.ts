/**
 * Accounts (ACC-3, ACC-10, ACC-13, ADM-2), prelogin (SEC-9) and the recovery key (ACC-5,
 * ADR-0010).
 */
import type { Hono } from 'hono';
import { crypto as tzCrypto, schema } from '@tazamun/core';
import type { AccountRow, RecoverySecrets } from '../db/database.ts';
import { ApiError, invalidCredentials, notFound } from '../http/errors.ts';
import { currentSession, rateLimit, session, type AppEnv, type Services } from '../http/context.ts';
import { readJson } from '../http/validate.ts';
import { fakeAccountId, fakeSalt, tokenHash, verifyAuthKey } from '../secrets.ts';

function usernameTaken(): ApiError {
  return new ApiError(409, 'USERNAME_TAKEN', 'This username is taken on this server.');
}

/**
 * ACC-5: check a recovery auth key for a username. Unknown usernames and accounts without a
 * recovery key fail the same way, after the same comparison (SEC-9).
 */
function verifyRecovery(
  s: Services,
  username: string,
  recoveryAuthKey: string,
  ip: string,
): { account: AccountRow; recovery: RecoverySecrets } {
  rateLimit(s.limiters.auth, `recovery-ip:${ip}`);
  const account = s.db.getAccountByUsername(username);
  // Per account too, so spreading guesses over many IPs doesn't help (SEC-9).
  rateLimit(s.limiters.auth, `recovery-account:${account?.id ?? username}`);
  const recovery = account?.recovery;
  if (!verifyAuthKey(recoveryAuthKey, recovery?.authHash) || recovery === undefined) {
    throw invalidCredentials();
  }
  return { account: account as AccountRow, recovery };
}

export function accountRoutes(app: Hono<AppEnv>, s: Services): void {
  app.post('/v1/accounts', async (c) => {
    rateLimit(s.limiters.auth, `register:${s.clientIp(c)}`);
    if (s.registration === 'closed') {
      throw new ApiError(403, 'REGISTRATION_CLOSED', 'This server does not accept new accounts.');
    }
    const body = await readJson(c, schema.createAccountRequest);
    let inviteHash: Uint8Array | undefined;
    if (s.registration === 'invite') {
      if (body.invite === undefined) {
        throw new ApiError(
          403,
          'INVITE_REQUIRED',
          'This server needs an invite token to create an account.',
        );
      }
      inviteHash = tokenHash(body.invite);
    }
    const result = s.db.createAccount(
      {
        id: body.accountId,
        username: body.username,
        salt: body.salt,
        kdfParams: body.kdfParams,
        authHash: tzCrypto.fromBase64Url(body.authHash),
        wrappedAccountKey: body.wrappedAccountKey,
        recovery: {
          authHash: tzCrypto.fromBase64Url(body.recoveryAuthHash),
          wrappedAccountKey: body.recoveryWrappedAccountKey,
        },
      },
      s.now(),
      inviteHash,
    );
    if (result === 'exists') {
      throw new ApiError(409, 'ACCOUNT_EXISTS', 'An account with this ID already exists.');
    }
    // Checked before the invite, so a taken username doesn't use the invite up.
    if (result === 'username-taken') throw usernameTaken();
    if (result === 'invite-invalid') {
      throw new ApiError(403, 'INVITE_INVALID', 'The invite token is unknown, used or expired.');
    }
    return c.json({ accountId: body.accountId } satisfies schema.CreateAccountResponse, 201);
  });

  app.post('/v1/prelogin', async (c) => {
    rateLimit(s.limiters.auth, `prelogin:${s.clientIp(c)}`);
    const { username } = await readJson(c, schema.preloginRequest);
    const account = s.db.getAccountByUsername(username);
    // SEC-9: unknown usernames get a stable fake account ID and salt and the default parameters,
    // like a new account.
    let body: schema.PreloginResponse;
    if (account === undefined) {
      const accountId = fakeAccountId(s.instanceSecret, username);
      body = {
        accountId,
        salt: fakeSalt(s.instanceSecret, accountId),
        kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS },
      };
    } else {
      body = { accountId: account.id, salt: account.salt, kdfParams: account.kdfParams };
    }
    return c.json(body);
  });

  app.get('/v1/accounts/me', session(s, true), (c) => {
    const account = s.db.getAccount(currentSession(c).accountId);
    if (account === undefined) throw notFound('Account');
    const body: schema.AccountResponse = {
      accountId: account.id,
      username: account.username ?? null,
      recoveryKey: account.recovery !== undefined,
    };
    return c.json(body);
  });

  app.put('/v1/accounts/me/username', session(s, true), async (c) => {
    const { accountId } = currentSession(c);
    rateLimit(s.limiters.auth, `username:${accountId}`);
    const { username } = await readJson(c, schema.updateUsernameRequest);
    if (!s.db.setUsername(accountId, username)) throw usernameTaken();
    return c.body(null, 204);
  });

  app.delete('/v1/accounts/me', session(s, true), async (c) => {
    const { accountId } = currentSession(c);
    rateLimit(s.limiters.auth, `passphrase:${accountId}`);
    const body = await readJson(c, schema.deleteAccountRequest);
    const account = s.db.getAccount(accountId);
    if (!verifyAuthKey(body.authKey, account?.authHash)) throw invalidCredentials();
    s.db.deleteAccount(accountId);
    return c.body(null, 204);
  });

  // ---- Recovery key (ACC-5) ------------------------------------------------------------------

  /** Set or replace the recovery key. Needs the passphrase again, like a passphrase change. */
  app.put('/v1/recovery', session(s, true), async (c) => {
    const { accountId } = currentSession(c);
    rateLimit(s.limiters.auth, `passphrase:${accountId}`);
    const body = await readJson(c, schema.setRecoveryRequest);
    const account = s.db.getAccount(accountId);
    if (!verifyAuthKey(body.authKey, account?.authHash)) throw invalidCredentials();
    s.db.setRecovery(accountId, {
      authHash: tzCrypto.fromBase64Url(body.recoveryAuthHash),
      wrappedAccountKey: body.recoveryWrappedAccountKey,
    });
    return c.body(null, 204);
  });

  /** Step 1 of recovery: the account key, wrapped under the recovery key. */
  app.post('/v1/recovery/key', async (c) => {
    const body = await readJson(c, schema.recoveryKeyRequest);
    const { account, recovery } = verifyRecovery(
      s,
      body.username,
      body.recoveryAuthKey,
      s.clientIp(c),
    );
    const response: schema.RecoveryKeyResponse = {
      accountId: account.id,
      wrappedAccountKey: recovery.wrappedAccountKey,
    };
    return c.json(response);
  });

  /** Step 2: a new passphrase. Every session ends, as with a passphrase change (ACC-9). */
  app.post('/v1/recovery/passphrase', async (c) => {
    const body = await readJson(c, schema.recoverPassphraseRequest);
    const { account } = verifyRecovery(s, body.username, body.recoveryAuthKey, s.clientIp(c));
    s.db.updateKeys(
      account.id,
      {
        salt: body.salt,
        kdfParams: body.kdfParams,
        authHash: tzCrypto.fromBase64Url(body.authHash),
        wrappedAccountKey: body.wrappedAccountKey,
      },
      undefined,
    );
    return c.body(null, 204);
  });
}
