/**
 * Accounts (ACC-3, ACC-10, ADM-2) and prelogin (SEC-9).
 */
import type { Hono } from 'hono';
import { crypto as tzCrypto, schema } from '@tazamun/core';
import { ApiError, invalidCredentials } from '../http/errors.ts';
import { currentSession, rateLimit, session, type AppEnv, type Services } from '../http/context.ts';
import { parse, readJson } from '../http/validate.ts';
import { fakeSalt, tokenHash, verifyAuthKey } from '../secrets.ts';

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
        salt: body.salt,
        kdfParams: body.kdfParams,
        authHash: tzCrypto.fromBase64Url(body.authHash),
        wrappedAccountKey: body.wrappedAccountKey,
      },
      s.now(),
      inviteHash,
    );
    if (result === 'exists') {
      throw new ApiError(409, 'ACCOUNT_EXISTS', 'An account with this ID already exists.');
    }
    if (result === 'invite-invalid') {
      throw new ApiError(403, 'INVITE_INVALID', 'The invite token is unknown, used or expired.');
    }
    return c.json({ accountId: body.accountId } satisfies schema.CreateAccountResponse, 201);
  });

  app.get('/v1/accounts/:id/prelogin', (c) => {
    rateLimit(s.limiters.auth, `prelogin:${s.clientIp(c)}`);
    const id = parse(schema.accountId, c.req.param('id'));
    const account = s.db.getAccount(id);
    // SEC-9: unknown IDs get a stable fake salt and the default parameters, like a new account.
    const body: schema.PreloginResponse = account
      ? { salt: account.salt, kdfParams: account.kdfParams }
      : { salt: fakeSalt(s.instanceSecret, id), kdfParams: { ...tzCrypto.DEFAULT_KDF_PARAMS } };
    return c.json(body);
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
}
