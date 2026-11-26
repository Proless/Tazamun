# CLAUDE.md: packages/core

Read this before changing anything in `packages/core`. The repository-wide rules in the [root CLAUDE.md](../../CLAUDE.md) still apply; usage and layout are in [README.md](README.md).

## Rules for this package

1. **No browser-extension, DOM or server APIs.** Only what Node 26 and current browsers share: ECMAScript, Web Crypto (`globalThis.crypto`), `TextEncoder`, `URL`. Code that needs `browser.*`, IndexedDB or SQLite belongs in an app.
2. **Pure functions.** Pass in time (`now`) and state; return new values. No module-level mutable state, no I/O, no logging. The only exception is randomness in `crypto`: `seal` draws its own nonce, and `randomBytes`, `randomId` and `generateAccountKey` exist to create secrets. Callers must never supply nonces or keys from their own randomness. The second exception is `api`, the HTTP client, and the `account` flows that call it: they do network I/O, but only through a `fetch` the caller injects (tests pass a fake or the server's Hono app), and they keep no state between calls.
3. **Everything is tested in Node and in browsers.** Every test runs in Node and in Chromium and Firefox. Merge functions, schemas and the HLC get property-based tests (fast-check), not only examples.
4. **Stored formats are versioned.** Serialized HLCs, schemas, URL normalization and crypto parameters end up in users' records. Changing one needs a schema version bump and a migration, and usually an ADR.
5. **Public API goes through `src/index.ts`**, one namespace per module (`export * as hlc from './hlc/index.ts'`). Don't make apps import from deep paths.
6. **Throw typed errors** (`class XError extends Error`) for conditions callers must handle, such as `HlcDriftError` and `DecryptError`. Use `RangeError` for invalid arguments.
7. **Few dependencies.** Runtime dependencies are `zod` and `hash-wasm` only. A new one needs a reason in the PR (SEC-7), must pass `pnpm licenses:check`, and must run in Node, browsers and an MV3 service worker. List it in the README's Dependencies table.

## Pitfalls

### HLC
- Clock skew affects HLC ordering. The engine should warn when the local clock differs from the server's `Date` header by more than 5 minutes (`isClockSkewed`).
- `receive` throws `HlcDriftError` for a remote stamp more than 24 h in the future. The engine must catch it, keep its own clock unchanged, still apply the record, and show a warning. Never adopt the remote time, or one broken clock drags every device into the future.
- The serialized HLC format (SRS 4.4) is stored in every record and sorts as a plain string. Changing it needs a migration.

### Schemas
- **Use `z.looseObject` for every object inside a payload**, never `z.object` (which strips unknown keys). A client that drops fields it doesn't know destroys data written by newer clients when it re-pushes after a merge. A test checks this for tabs; add the same check for each new collection.
- `v` is a **major** version. Bump it only for breaking changes, and add a migration in `decodePayload` for the old version at the same time. Adding an optional field doesn't bump it.
- Accept values browsers add over time (history transition types) as strings, not enums, or one new browser release makes records invalid. Use enums only for values Tazamun controls or that are stable (extension `kind`, `installType`).
- `decodePayload` must never throw on input from the network, and its issues must hold paths and codes only, never values (rule 5). Both are tested; keep them that way.
- **zod 4 compiles parsers with `new Function`** unless told not to. Extension pages and the dashboard (SEC-8 CSP) forbid `eval`, so each app must call `z.config({ jitless: true })` at startup, before any parse. Otherwise every page logs CSP violations.
- Wire objects in `envelope.ts` use plain `z.object` on purpose: unknown fields from the server are dropped, and a client can't set `seq` or `modifiedAt` in a push.

### Crypto
- Never reuse a nonce: a fresh random 96-bit nonce for every encryption, including re-pushes of the same record.
- Always bind AAD (`accountId | collection | recordId`) and **check it on decrypt**, or a malicious server can swap records.
- Don't build your own crypto primitives. Use Web Crypto, plus `hash-wasm` for Argon2id only. No audited WASM Argon2id existed when it was chosen ([ADR-0008](../../docs/adr/0008-crypto-implementation.md)); it's held to the reference vectors instead.
- The details in ADR-0008 (NFC passphrases, KDF parameter floor, wrap AAD, empty HKDF salt, 16-byte keyed IDs) are format v1. `test/vectors/tazamun-format-v1.json` pins them. If a format test fails, you changed stored data: revert, or plan a migration and a new ADR.
- **Copy test vectors from their source, never from memory.** One RFC 4231 MAC typed from memory was wrong. Each vector file names its source URL.
- Only `seal` may create nonces. `sealWithNonce` exists for vectors; never call it in app code.
- Decryption errors are a bare `DecryptError` on purpose. Don't add detail (which check failed, which key): it helps an attacker and can leak data into logs.
- Argon2id with 64 MiB is slow on purpose (about 0.5–1 s). Expose it so callers run it only at sign-in and unlock, never per sync.
- Test vectors live in `test/vectors/`: Argon2id from the reference implementation's `test.c` (RFC 9106's own vector needs associated data, which `hash-wasm` doesn't support), HKDF from RFC 5869, HMAC from RFC 4231, AES-GCM from Wycheproof.

### API client and account flows
- **Validate every response** with the `schema` body, also on success. A hostile or broken server must not hand the extension malformed data; the client throws `NetworkError` (`kind: 'invalid-response'`) with field paths only, never values.
- Errors carry the HTTP status, the stable `code` and the server's message. Never put request or response bodies, tokens or keys into an error (rule 5).
- Branch on `ApiError.code` and `NetworkError.kind`, never on message text. Unknown codes from a newer server must fall through to a generic message, not crash.
- The flows zero the auth key after use and never return the KEK. Keep it that way: only the account key and the session token leave a flow.
- **Stored formats people keep:** the recovery key text (`ABCD-EFGH-…`, Crockford base32) is printed and stored by users, and its derivation (`tazamun/v1/recovery/*` HKDF infos, the `recovery-account-key` AAD) opens their account. `test/vectors/tazamun-recovery-v1.json` pins both; a failing test means existing recovery keys would stop working. Usernames (`parseUsername`) are compared by the server in normalized form, so changing normalization would lock people out. Treat all three, and `normalizeServerUrl`, as stored formats (rule 4).
- The recovery key never goes to the server, and isn't stored by any flow: `createAccount` and `createRecoveryKey` return it formatted, to show once. Only the recovery auth key (to prove it) and its SHA-256 (at creation) are sent.
- The account ID stays the identifier in AAD and on the server. Usernames are only a lookup handle (prelogin); never bind a username into AAD or a key, or renaming would break every record.
- The strength estimate is deliberately simple and informs only; it never rejects a passphrase of 12+ characters. Don't grow it into a dictionary (hundreds of kilobytes) without an ADR.

### TypeScript and Web Crypto
- The public namespace `crypto` hides the global Web Crypto `crypto` in any file that imports it under that name. Import it as `import { crypto as tzCrypto } from '@tazamun/core'`. Inside this package, the `crypto` module's own files use the global `crypto` and never import the namespace.
- The base tsconfig has no DOM lib, so names like `AesKeyGenParams` or `KeyUsage` don't exist. Take types from the API itself: `Parameters<typeof crypto.subtle.deriveKey>[2]`.
- Web Crypto wants `Uint8Array<ArrayBuffer>`, not plain `Uint8Array` (which may be backed by a `SharedArrayBuffer`). Return `Uint8Array<ArrayBuffer>` from helpers that produce bytes for Web Crypto.

### Testing
- Every test runs twice: in Node (`pnpm test`) and in Chromium and Firefox (`pnpm test:browser`, through `vitest.browser.config.ts`). Don't use Node-only APIs (`Buffer`, `node:*`) in tests either.
- Property tests over wide ranges almost never produce equal values. To exercise tie-breaks, also run them with small domains (see `collidingHlcArb` in `hlc.test.ts`).
- `fc.pre` discards runs. If a precondition rejects most inputs, narrow the arbitrary instead.
