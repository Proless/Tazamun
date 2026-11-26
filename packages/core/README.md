# @tazamun/core

The shared library of Tazamun: everything that the extension, the dashboard and the server must agree on. It runs unchanged in Node and in browsers, and contains no browser-extension or server APIs.

| Module | Status | What it does |
| ------ | ------ | ------------ |
| `hlc` | Done | Hybrid Logical Clock: orders edits across devices (ENG-7, [ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)) |
| `schema` | Done for `tabs`, `commands`, `history`, `extensions` | Wire format of the HTTP API (records, plus account, session, key, device and info bodies and the error codes), and decrypted payload schemas per collection (zod) ([SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>)). `bookmarks` follows in P4. |
| `crypto` | Done | Argon2id key derivation, account-key wrapping, the recovery key (format, HKDF derivation, its own wrap; [ADR-0010](../../docs/adr/0010-usernames-and-recovery-key.md)), HKDF collection keys, AES-GCM payload encryption with AAD, keyed history IDs ([SRS 5.2](<../../docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>), [ADR-0008](../../docs/adr/0008-crypto-implementation.md)) |
| `api` | Done | Typed client for the HTTP API: every response validated with the `schema` bodies, typed `ApiError` (stable code, `retryAfter`) and `NetworkError`; client version check against `minClientVersion` |
| `account` | Done | Create, connect, recover and unlock flows, and making a new recovery key (ACC-1…3, ACC-5, ACC-7, ACC-8, SEC-5), username rules (ACC-13), server URL rules, passphrase length and strength estimate (ACC-4) |
| `merge` | `lastWriterWins` done | Pure merge functions (rule 3, REL-6): whole-record last writer wins by HLC for records owned by one device (tabs, extensions, commands), property-tested for commutativity, associativity and idempotence; `canonicalJson` and `jsonEqual` for change detection. History's union merge (P2) and bookmarks (P4) follow. |

## Usage

Other workspace packages depend on it with `"@tazamun/core": "workspace:*"` and import modules by namespace:

```ts
import { hlc } from '@tazamun/core';

// A new device starts at zero. Persist the clock after every change.
let clock = hlc.createHlc(deviceId);

// Local edit: stamp the changed field.
clock = hlc.tick(clock, Date.now());
const stamp = hlc.serialize(clock); // "001795000000000:00000000:<deviceId>"

// After applying a remote change, move the clock past it.
try {
  clock = hlc.receive(clock, hlc.parse(remoteStamp), Date.now());
} catch (error) {
  if (!(error instanceof hlc.HlcDriftError)) throw error;
  // The remote clock is far in the future: keep our clock, warn the user.
}

// Last writer wins: the larger stamp wins.
const winner = hlc.compare(a, b) >= 0 ? a : b;
```

Crypto, from account creation to one record. Import the namespace under another name: a local `crypto` would hide the global Web Crypto `crypto` in that file.

```ts
import { crypto as tzCrypto } from '@tazamun/core';

// Account creation (ACC-1…3). Sign-in repeats deriveMasterKeys with the salt and params from
// prelogin. account.createAccount does all of this, plus the recovery key (ACC-5).
const accountId = tzCrypto.randomId();
const salt = tzCrypto.randomBytes(tzCrypto.SALT_BYTES);
const { authKey, kek } = await tzCrypto.deriveMasterKeys(passphrase, salt, tzCrypto.DEFAULT_KDF_PARAMS);
const accountKey = tzCrypto.generateAccountKey();
const wrappedAccountKey = await tzCrypto.wrapAccountKey(kek, accountKey, accountId);
// Send accountId, salt, params, wrappedAccountKey and hashAuthKey(authKey) to the server.

// Per record (SEC-3): the AAD binds the ciphertext to its account, collection and record.
const keys = await tzCrypto.deriveAccountKeys(accountKey);
const key = await keys.collectionKey('tabs');
const address = { accountId, collection: 'tabs', recordId: deviceId };
const payload = await tzCrypto.encryptPayload(key, address, schemaPayload);
const decrypted = await tzCrypto.decryptPayload(key, address, payload); // DecryptError if moved or tampered

// History record IDs (HIS-1).
const id = await tzCrypto.keyedId(await keys.historyIdKey(), normalizedUrl);
```

`deriveMasterKeys` takes about 0.5–1 s on purpose. Call it at sign-in and unlock only.

Schemas validate what comes off the wire and out of decryption:

```ts
import { hlc, schema } from '@tazamun/core';

// Server response (plaintext envelope only).
const page = schema.pullResponse.parse(await response.json());

// After decrypting one record's payload:
const result = schema.decodePayload(schema.COLLECTIONS.tabs, JSON.parse(plaintext));
switch (result.status) {
  case 'ok':
    if (!result.payload.deleted) render(result.payload.data.windows);
    break;
  case 'newer-version': // ENG-10: keep the record, don't apply it, ask the user to update
  case 'invalid': // result.issues has paths and codes only, never values
    break;
}

// Building a payload to encrypt and push:
const payload = schema.livePayload(schema.COLLECTIONS.tabs, hlc.serialize(clock), { windows });
const tombstone = schema.tombstonePayload(schema.COLLECTIONS.tabs, hlc.serialize(clock));
```

Creating, connecting and recovering an account with the API client (SRS 3.1). The passphrase, recovery key, KEKs and account key never reach the server:

```ts
import { account, api } from '@tazamun/core';

const serverUrl = account.normalizeServerUrl(input); // "sync.example.org" → "https://sync.example.org"
const client = new api.ApiClient({ baseUrl: serverUrl }); // fetch is injectable for tests

// First browser (ACC-1…3): one Argon2id run, then this device is signed in.
const device = { id: account.newDeviceId(), name: 'Firefox on Linux', browser: { family: 'firefox', version: '140' } };
const created = await account.createAccount(client, { username: 'Hasan', passphrase, device, invite });
// created: { accountId, username: 'hasan', accountKey, token, device, recoveryKey: 'ABCD-EFGH-…' }
// Show created.recoveryKey once; never store it.

// Second browser: server, username and passphrase (prelogin finds the account ID).
const connected = await account.connectAccount(client, { username, passphrase, device: otherDevice });

// Lost passphrase (ACC-5): the recovery key sets a new one; every session ends.
const recovered = await account.recoverAccount(client, { username, recoveryKey, newPassphrase, device });

// A new recovery key from a signed-in device (needs the passphrase); the old one stops working.
const next = await account.createRecoveryKey(client.withToken(token), accountId, accountKey, passphrase);

// Errors: api.ApiError has the stable `code` (INVALID_CREDENTIALS, USERNAME_TAKEN, INVITE_REQUIRED…);
// api.NetworkError has `kind` (unreachable, timeout, invalid-response).
```

Apps that parse with these schemas must call `z.config({ jitless: true })` at startup when they run under a CSP without `eval` (extension, dashboard).

The package exports its TypeScript source directly (`"exports": "./src/index.ts"`); there is no build step.

## Dependencies

| Package | Why |
| ------- | --- |
| `zod` | Schemas for the wire format and payloads |
| `hash-wasm` | Argon2id, which Web Crypto doesn't provide ([ADR-0008](../../docs/adr/0008-crypto-implementation.md)). Needs `'wasm-unsafe-eval'` in an extension CSP. |

Everything else (HKDF, AES-GCM, HMAC, SHA-256, randomness) comes from Web Crypto. Development only: `vitest`, `fast-check`, and `@vitest/browser-playwright` with `playwright` for the browser tests.

## Scripts

Run from the repository root:

| Command | What it does |
| ------- | ------------ |
| `pnpm --filter @tazamun/core typecheck` | Type-check this package |
| `pnpm test --project core` | Run this package's tests in Node |
| `pnpm test:browser` | Run them in Chromium and Firefox (first: `pnpm --filter @tazamun/core exec playwright install chromium firefox`) |
| `pnpm test:watch --project core` | Tests in watch mode |

## Layout

```text
src/
  index.ts        public API: re-exports each module as a namespace
  api/
    client.ts     ApiClient (injected fetch), ApiError, NetworkError
    version.ts    compareVersions, isClientSupported (minClientVersion)
  merge/
    lww.ts        lastWriterWins
    canonical.ts  canonicalJson, jsonEqual
  account/
    flows.ts      createAccount, connectAccount, recoverAccount, createRecoveryKey, unlockAccount
    username.ts   normalizeUsername, parseUsername (ACC-13)
    server-url.ts normalizeServerUrl, hostPermissionPattern
    passphrase.ts minimum length and strength estimate (ACC-4)
  crypto/
    encoding.ts   base64url, UTF-8, random bytes
    kdf.ts        Argon2id (hash-wasm), KDF parameter limits, authKey/KEK split
    aead.ts       AES-256-GCM in the nonce || ciphertext || tag format
    keys.ts       account key, wrapping, HKDF collection and history-ID keys
    recovery.ts   recovery key: generate, format and parse, HKDF auth key and KEK, wrap (ACC-5)
    record.ts     payload encryption with AAD accountId|collection|recordId
    ids.ts        keyed record IDs (HMAC, 128 bits)
    *.test.ts     crypto.test.ts (behaviour), vectors.test.ts (published vectors), format.test.ts (format v1),
                  recovery.test.ts (recovery key, with its format v1)
  hlc/            hlc.ts, hlc.test.ts, index.ts
  schema/
    primitives.ts record ID, device ID, HLC stamp, timestamps, base64url
    envelope.ts   HTTP API wire format for records (pull, push, errors, limits)
    api.ts        HTTP API bodies for accounts, usernames, prelogin, recovery, sessions, keys, devices,
                  info; ERROR_CODES
    payload.ts    decrypted payload {v, deleted, hlc, data}, decodePayload, versioning
    collections/  one file per collection: tabs, commands, history, extensions
test/vectors/
  argon2id-reference.json      Argon2 reference implementation, test.c
  hkdf-sha256-rfc5869.json     RFC 5869
  hmac-sha256-rfc4231.json     RFC 4231
  aes-256-gcm-wycheproof.json  Wycheproof (39 valid, 27 must-reject)
  tazamun-format-v1.json       Tazamun's own formats, pinned (see ADR-0008)
  tazamun-recovery-v1.json     the recovery key format, pinned (see ADR-0010)
vitest.config.ts          Node test project (core)
vitest.browser.config.ts  Chromium and Firefox test project (core-browser)
```

Unit tests live next to the code as `*.test.ts`. Property-based tests use [fast-check](https://fast-check.dev).
