/**
 * Container smoke test (DEP-29). Starts the image with a fresh /data and the hardened settings
 * from the Compose files, then:
 *
 *   1. waits until the container's HEALTHCHECK reports healthy,
 *   2. creates an invite with the admin CLI inside the container,
 *   3. runs an API suite the way a client does (real Argon2id, a wrapped account key, encrypted
 *      records): create account, prelogin, sign in two devices, push, pull and decrypt, revoke,
 *   4. stops the container with SIGTERM and checks it shut down cleanly (exit 0, DEP-7),
 *   5. starts it again on the same /data and checks the data and sessions survived.
 *
 * Usage (from the repository root): node apps/server/test/smoke.ts <image>
 * Always removes its container and volume, also on failure.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { crypto as tzCrypto, hlc, schema } from '@tazamun/core';

const imageArg = process.argv[2];
if (imageArg === undefined) {
  process.stderr.write('Usage: node apps/server/test/smoke.ts <image>\n');
  process.exit(2);
}
const image: string = imageArg;

const suffix = randomBytes(4).toString('hex');
const container = `tazamun-smoke-${suffix}`;
const volume = `tazamun-smoke-${suffix}`;

function docker(...args: string[]): string {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function step(text: string): void {
  process.stdout.write(`- ${text}\n`);
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitHealthy(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const status = docker('inspect', '--format', '{{.State.Health.Status}}', container);
    if (status === 'healthy') return;
    const running = docker('inspect', '--format', '{{.State.Running}}', container);
    if (running !== 'true') {
      // Exit code 137 with OOMKilled means the memory limit; 132/139 under QEMU, an emulation crash.
      const state = docker(
        'inspect',
        '--format',
        'exit code {{.State.ExitCode}}, OOMKilled {{.State.OOMKilled}}, error "{{.State.Error}}"',
        container,
      );
      throw new Error(`The container exited before it became healthy (${state})`);
    }
    check(
      Date.now() < deadline,
      `Not healthy after ${String(timeoutMs / 1000)} s (status: ${status})`,
    );
    await sleep(1000);
  }
}

function baseUrl(): string {
  // `docker port` prints e.g. "127.0.0.1:49153"; the host port changes on every start.
  const mapping = docker('port', container, '8080/tcp').split('\n')[0] ?? '';
  return `http://${mapping}`;
}

async function api(
  method: string,
  path: string,
  options: { token?: string; body?: unknown } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text === '' ? undefined : (JSON.parse(text) as unknown) };
}

function start(): void {
  docker('start', container);
}

async function run(): Promise<void> {
  step(`image ${image}`);
  docker('volume', 'create', volume);
  docker(
    'run', '--detach', '--name', container,
    '--publish', '127.0.0.1::8080',
    '--volume', `${volume}:/data`,
    '--read-only', '--tmpfs', '/tmp',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true',
    '--memory', '256m',
    '--env', 'TAZAMUN_PUBLIC_URL=http://localhost',
    // The suite signs in several times in a row from one IP.
    '--env', 'TAZAMUN_AUTH_RATE_LIMIT_PER_MINUTE=100',
    image,
  ); // prettier-ignore
  await waitHealthy();
  step('healthy');

  const user = docker('exec', container, 'id', '-u');
  check(user === '10001', `Runs as UID ${user}, expected 10001`);

  const inviteOutput = docker('exec', container, 'tazamun', 'invite', 'create');
  const invite = /^([A-Za-z0-9_-]{43})$/m.exec(inviteOutput)?.[1];
  check(invite !== undefined, 'tazamun invite create printed no token');
  step('invite created with the admin CLI');

  const info = schema.infoResponse.parse((await api('GET', '/v1/info')).json);
  check(info.registration === 'invite', 'Default registration mode is not invite');

  // Account creation exactly as a client does it (ACC-1…3).
  const accountId = tzCrypto.randomId();
  const passphrase = 'correct horse battery staple';
  const salt = tzCrypto.randomBytes(tzCrypto.SALT_BYTES);
  const { authKey, kek } = await tzCrypto.deriveMasterKeys(
    passphrase,
    salt,
    tzCrypto.DEFAULT_KDF_PARAMS,
  );
  const accountKey = tzCrypto.generateAccountKey();
  const created = await api('POST', '/v1/accounts', {
    body: {
      accountId,
      salt: tzCrypto.toBase64Url(salt),
      kdfParams: tzCrypto.DEFAULT_KDF_PARAMS,
      authHash: tzCrypto.toBase64Url(await tzCrypto.hashAuthKey(authKey)),
      wrappedAccountKey: await tzCrypto.wrapAccountKey(kek, accountKey, accountId),
      invite,
    } satisfies schema.CreateAccountRequest,
  });
  check(created.status === 201, `Create account: HTTP ${String(created.status)}`);
  // A second, otherwise valid account with the same invite. The server can't tell these random
  // bytes from real key material, so no second Argon2id run is needed.
  const random = (bytes: number) => tzCrypto.toBase64Url(tzCrypto.randomBytes(bytes));
  const reused = await api('POST', '/v1/accounts', {
    body: {
      accountId: tzCrypto.randomId(),
      salt: random(16),
      kdfParams: tzCrypto.DEFAULT_KDF_PARAMS,
      authHash: random(32),
      wrappedAccountKey: random(60),
      invite,
    } satisfies schema.CreateAccountRequest,
  });
  check(
    reused.status === 403 &&
      schema.errorResponse.parse(reused.json).error.code === 'INVITE_INVALID',
    `A used invite was not refused (HTTP ${String(reused.status)})`,
  );
  step('account created; the invite works only once');

  // Sign in as a second browser would: prelogin, derive, unwrap (ACC-2, step 2 of SRS 3.1).
  const prelogin = schema.preloginResponse.parse(
    (await api('GET', `/v1/accounts/${accountId}/prelogin`)).json,
  );
  const derived = await tzCrypto.deriveMasterKeys(
    passphrase,
    tzCrypto.fromBase64Url(prelogin.salt),
    prelogin.kdfParams,
  );
  const signIn = async (id: string) => {
    const res = await api('POST', '/v1/sessions', {
      body: {
        accountId,
        authKey: tzCrypto.toBase64Url(derived.authKey),
        device: { id, name: `Smoke ${id}`, browser: { family: 'smoke', version: '1' } },
      } satisfies schema.CreateSessionRequest,
    });
    check(res.status === 201, `Sign in ${id}: HTTP ${String(res.status)}`);
    return schema.createSessionResponse.parse(res.json).token;
  };
  const tokenA = await signIn('dev_A');
  const tokenB = await signIn('dev_B');
  const bundle = schema.keyBundle.parse((await api('GET', '/v1/keys', { token: tokenB })).json);
  const unwrapped = await tzCrypto.unwrapAccountKey(
    derived.kek,
    bundle.wrappedAccountKey,
    accountId,
  );
  check(
    tzCrypto.toBase64Url(unwrapped) === tzCrypto.toBase64Url(accountKey),
    'The second device unwrapped a different account key',
  );
  step('two devices signed in; the account key unwraps');

  // Push from A, pull and decrypt on B.
  const keys = await tzCrypto.deriveAccountKeys(accountKey);
  const tabsKey = await keys.collectionKey('tabs');
  const stamp = hlc.serialize(hlc.tick(hlc.createHlc('dev_A'), Date.now()));
  const address = { accountId, collection: 'tabs', recordId: 'dev_A' };
  const payload = await tzCrypto.encryptPayload(
    tabsKey,
    address,
    schema.tombstonePayload(schema.COLLECTIONS.tabs, stamp),
  );
  const push = await api('POST', '/v1/collections/tabs', {
    token: tokenA,
    body: [{ id: 'dev_A', payload }],
  });
  check(push.status === 200, `Push: HTTP ${String(push.status)}`);
  const pulled = async (token: string) => {
    const res = await api('GET', '/v1/collections/tabs?since=0', { token });
    check(res.status === 200, `Pull: HTTP ${String(res.status)}`);
    return schema.pullResponse.parse(res.json);
  };
  const page = await pulled(tokenB);
  const record = page.records[0];
  check(page.records.length === 1 && record !== undefined, 'Pull did not return the pushed record');
  const decrypted = await tzCrypto.decryptPayload(tabsKey, address, record.payload);
  check(
    (decrypted as { hlc?: string }).hlc === stamp,
    'The pulled record decrypted to a different payload',
  );
  step('pushed on one device, pulled and decrypted on the other');

  // Revoke B (ACC-8).
  check((await api('DELETE', '/v1/devices/dev_B', { token: tokenA })).status === 204, 'Revoke B');
  check((await api('GET', '/v1/info', { token: tokenB })).status === 401, 'B still signed in');
  step('revoked device is signed out');

  // Graceful stop (DEP-7): SIGTERM, then exit code 0 and a clean "Stopped" log line.
  const started = Date.now();
  docker('stop', '--time', '20', container);
  const stopSeconds = (Date.now() - started) / 1000;
  const exitCode = docker('inspect', '--format', '{{.State.ExitCode}}', container);
  check(exitCode === '0', `Exit code after SIGTERM: ${exitCode}`);
  const logs = execFileSync('docker', ['logs', container], { encoding: 'utf8', stdio: 'pipe' });
  check(logs.includes('"msg":"Stopped"'), 'No "Stopped" log line: shutdown was not clean');
  check(stopSeconds < 15, `Stopping took ${stopSeconds.toFixed(1)} s`);
  step(`stopped cleanly with SIGTERM in ${stopSeconds.toFixed(1)} s`);

  // Restart on the same /data: data and sessions persist.
  start();
  await waitHealthy();
  const after = await pulled(tokenA);
  check(after.records.length === 1, 'The record is gone after a restart');
  check((await api('GET', '/v1/info', { token: tokenB })).status === 401, 'B came back');
  const migrations = (docker('logs', container).match(/Database migrated/g) ?? []).length;
  check(migrations <= 1, 'The database was migrated again after a restart');
  step('restarted on the same /data; data and sessions persist');
}

let failed = false;
try {
  await run();
  process.stdout.write('Smoke test passed.\n');
} catch (err) {
  failed = true;
  process.stderr.write(`Smoke test FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  try {
    // The server writes warnings and errors to stderr, so show both streams.
    const logs = spawnSync('docker', ['logs', container], { encoding: 'utf8' });
    process.stderr.write(`--- container stdout ---\n${logs.stdout}\n`);
    process.stderr.write(`--- container stderr ---\n${logs.stderr}\n`);
  } catch {
    // No container to show logs from.
  }
} finally {
  try {
    docker('rm', '--force', container);
  } catch {
    // Already gone.
  }
  try {
    docker('volume', 'rm', '--force', volume);
  } catch {
    // Already gone.
  }
}
process.exitCode = failed ? 1 : 0;
