/**
 * Sessions (ACC-7, ACC-8), keys (ACC-9) and devices.
 */
import type { Hono } from 'hono';
import { crypto as tzCrypto, schema } from '@tazamun/core';
import type { DeviceRow } from '../db/database.ts';
import { currentSession, rateLimit, session, type AppEnv, type Services } from '../http/context.ts';
import { invalidCredentials, notFound } from '../http/errors.ts';
import { parse, readJson } from '../http/validate.ts';
import { newToken, tokenHash, verifyAuthKey } from '../secrets.ts';

export function deviceJson(row: DeviceRow, currentDeviceId: string): schema.Device {
  return {
    id: row.id,
    name: row.name,
    browser: { family: row.browserFamily, version: row.browserVersion },
    createdAt: new Date(row.createdAt).toISOString(),
    lastSeenAt: new Date(row.lastSeenAt).toISOString(),
    current: row.id === currentDeviceId,
  };
}

export function sessionRoutes(app: Hono<AppEnv>, s: Services): void {
  app.post('/v1/sessions', async (c) => {
    rateLimit(s.limiters.auth, `signin-ip:${s.clientIp(c)}`);
    const body = await readJson(c, schema.createSessionRequest);
    // Also per account, so spreading guesses over many IPs doesn't help (SEC-9).
    rateLimit(s.limiters.auth, `signin-account:${body.accountId}`);
    const account = s.db.getAccount(body.accountId);
    if (!verifyAuthKey(body.authKey, account?.authHash)) throw invalidCredentials();

    const token = newToken();
    const device = s.db.createSession(
      body.accountId,
      {
        id: body.device.id,
        name: body.device.name,
        browserFamily: body.device.browser.family,
        browserVersion: body.device.browser.version,
      },
      tokenHash(token),
      s.now(),
    );
    const response: schema.CreateSessionResponse = { token, device: deviceJson(device, device.id) };
    return c.json(response, 201);
  });

  app.delete('/v1/sessions/current', session(s, true), (c) => {
    s.db.deleteSession(currentSession(c).tokenHash);
    return c.body(null, 204);
  });

  app.get('/v1/keys', session(s, true), (c) => {
    const account = s.db.getAccount(currentSession(c).accountId);
    if (account === undefined) throw notFound('Account');
    const bundle: schema.KeyBundle = {
      salt: account.salt,
      kdfParams: account.kdfParams,
      wrappedAccountKey: account.wrappedAccountKey,
    };
    return c.json(bundle);
  });

  app.put('/v1/keys', session(s, true), async (c) => {
    const current = currentSession(c);
    rateLimit(s.limiters.auth, `passphrase:${current.accountId}`);
    const body = await readJson(c, schema.updateKeysRequest);
    const account = s.db.getAccount(current.accountId);
    if (!verifyAuthKey(body.authKey, account?.authHash)) throw invalidCredentials();
    s.db.updateKeys(
      current.accountId,
      {
        salt: body.salt,
        kdfParams: body.kdfParams,
        authHash: tzCrypto.fromBase64Url(body.authHash),
        wrappedAccountKey: body.wrappedAccountKey,
      },
      current.tokenHash,
    );
    return c.body(null, 204);
  });

  app.get('/v1/devices', session(s, true), (c) => {
    const { accountId, deviceId } = currentSession(c);
    const response: schema.ListDevicesResponse = {
      devices: s.db.listDevices(accountId).map((row) => deviceJson(row, deviceId)),
    };
    return c.json(response);
  });

  app.put('/v1/devices/:id', session(s, true), async (c) => {
    const { accountId, deviceId } = currentSession(c);
    const id = parse(schema.deviceId, c.req.param('id'));
    const body = await readJson(c, schema.updateDeviceRequest);
    if (!s.db.renameDevice(accountId, id, body.name)) throw notFound('Device');
    const row = s.db.getDevice(accountId, id);
    if (row === undefined) throw notFound('Device');
    return c.json(deviceJson(row, deviceId));
  });

  /** Revoke a device (ACC-8). Revoking the current device signs it out. */
  app.delete('/v1/devices/:id', session(s, true), (c) => {
    const { accountId } = currentSession(c);
    const id = parse(schema.deviceId, c.req.param('id'));
    if (!s.db.deleteDevice(accountId, id)) throw notFound('Device');
    return c.body(null, 204);
  });
}
