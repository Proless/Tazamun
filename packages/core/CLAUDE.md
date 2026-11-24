# CLAUDE.md: packages/core

Read this before changing anything in `packages/core`. The repository-wide rules in the [root CLAUDE.md](../../CLAUDE.md) still apply; usage and layout are in [README.md](README.md).

## Rules for this package

1. **No browser-extension, DOM or server APIs.** Only what Node 26 and current browsers share: ECMAScript, Web Crypto (`globalThis.crypto`), `TextEncoder`, `URL`. Code that needs `browser.*`, IndexedDB or SQLite belongs in an app.
2. **Pure functions.** Pass in time (`now`), randomness and state; return new values. No module-level mutable state, no I/O, no logging.
3. **Everything is tested in Node.** Merge functions, schemas and the HLC get property-based tests (fast-check), not only examples. Crypto also runs in a browser (P0 exit criterion).
4. **Stored formats are versioned.** Serialized HLCs, schemas, URL normalization and crypto parameters end up in users' records. Changing one needs a schema version bump and a migration, and usually an ADR.
5. **Public API goes through `src/index.ts`**, one namespace per module (`export * as hlc from './hlc/index.ts'`). Don't make apps import from deep paths.
6. **Throw typed errors** (`class XError extends Error`) for conditions callers must handle, such as `HlcDriftError`. Use `RangeError` for invalid arguments.

## Pitfalls

### HLC
- Clock skew affects HLC ordering. The engine should warn when the local clock differs from the server's `Date` header by more than 5 minutes (`isClockSkewed`).
- `receive` throws `HlcDriftError` for a remote stamp more than 24 h in the future. The engine must catch it, keep its own clock unchanged, still apply the record, and show a warning. Never adopt the remote time, or one broken clock drags every device into the future.
- The serialized HLC format (SRS 4.4) is stored in every record and sorts as a plain string. Changing it needs a migration.

### Crypto
- Never reuse a nonce: a fresh random 96-bit nonce for every encryption, including re-pushes of the same record.
- Always bind AAD (`accountId | collection | recordId`) and **check it on decrypt**, or a malicious server can swap records.
- Don't build your own crypto primitives. Use Web Crypto plus one audited Argon2 WASM library.
- Argon2id with 64 MiB is slow on purpose (about 0.5–1 s). Expose it so callers run it only at sign-in and unlock, never per sync.
- Commit test vectors (RFC 9106 for Argon2id, RFC 5869 for HKDF, NIST for AES-GCM) under `test/vectors/`.

### Testing
- Property tests over wide ranges almost never produce equal values. To exercise tie-breaks, also run them with small domains (see `collidingHlcArb` in `hlc.test.ts`).
- `fc.pre` discards runs. If a precondition rejects most inputs, narrow the arbitrary instead.
