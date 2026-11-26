# CLAUDE.md: apps/server

Read this before changing anything in `apps/server`. The repository-wide rules in the [root CLAUDE.md](../../CLAUDE.md) still apply; usage, API notes and layout are in [README.md](README.md).

## Rules for this app

1. **A record store, nothing more.** The server stores ciphertext and metadata. It never decrypts, inspects or merges payloads, and has no code for any collection: `tabs` and `history` are just names to it (rules 1 and 2, [ADR-0002](../../docs/adr/0002-end-to-end-encryption-dumb-server.md)). If a feature needs to know what's inside a record, it belongs in a client.
2. **All SQLite access goes through `src/db/database.ts`.** `node:sqlite` is a release candidate in Node 26; one module means an API change, or a switch to `better-sqlite3`, touches one place ([ADR-0004](../../docs/adr/0004-typescript-monorepo-stack.md)).
3. **Migrations are append-only.** Never edit or reorder an entry in `src/db/migrations.ts` once it has been merged; existing databases have run it. Add a new entry instead, and test the upgrade from the previous version.
4. **Wire shapes live in `packages/core`** (`schema/api.ts`, `schema/envelope.ts`), so clients validate the same schemas. Don't define request or response bodies in the server. Error codes are in `schema.ERROR_CODES` and [SRS 4.4.4](<../../docs/srs/4. External Interface Requirements.md#444-error-codes>): add codes, never rename them.
5. **Logging goes through `src/log.ts` only**, whose `LogFields` type is the allow-list. Never log bodies, headers, concrete paths (they contain account and device IDs), tokens, auth keys, device names or record IDs (ADM-7). Log `routePath(c, -1)`, the route pattern, instead of the path. A test checks that none of these values appear in logs; extend it when you add a route.
6. **Error messages never echo request values.** Validation errors name the field path and the zod issue code only (`src/http/validate.ts`). Config errors may echo non-secret values to help with typos, never secrets.
7. **Every setting is one entry in `SETTINGS`** (`src/config.ts`). Its key is the config-file key and its `env` the variable name; renaming either breaks existing deployments, so treat both as stable. The reference in `docs/guides/server-configuration.md` is generated from it. After changing a setting, run `pnpm --filter @tazamun/server config:docs`; `config.test.ts` fails otherwise (DEP-15).
8. **Inject time and services.** Routes take `now()` and other services from `Services`, and CLI commands take everything from `CliIo`, so tests control the clock, output and network. No module-level state other than what `main.ts` and `serve.ts` build.
9. **Admin commands never migrate, and never destroy data without a copy.** They open the database with `mode: 'require-current'`, so a CLI never changes the schema under a running server. Anything that deletes or replaces data (`accounts delete`, `restore`) writes a backup first (rule 6).

## Pitfalls

### SQLite and node:sqlite
- Enable WAL mode, use one connection, and make every multi-statement write a transaction (`Database#transaction`, which uses `BEGIN IMMEDIATE`). node:sqlite is synchronous, so one connection is enough and statements never interleave.
- Assign `seq` inside the write transaction (from `accounts.last_seq`), so it never has gaps or duplicates. Don't derive it from `MAX(seq)` of the records table: expired records get deleted, and `seq` must never go backwards.
- Back up online with `VACUUM INTO` (`Database#backupTo`) or the backup API, never by copying the file while it's in use. `VACUUM INTO` fails if the target exists, and can't run inside a transaction.
- `storage_bytes` is a running total kept in the same transaction as each write and each purge. Any new code that inserts or deletes records must update it too, or quotas drift.
- `ON DELETE CASCADE` needs `PRAGMA foreign_keys = ON` on every connection; `Database.open` sets it. Sessions reference devices, devices reference accounts, so deleting an account or revoking a device ends its sessions in the same statement.
- node:sqlite returns BLOBs as `Uint8Array` and integers as `number` (unless `readBigInts` is set). The row helpers in `database.ts` check types at run time; keep using them instead of casting rows.
- Tables are `STRICT`: a value of the wrong type is an error, not a silent conversion.

### Hono
- Hono has no logger; `src/log.ts` is ours. `c.req.routePath` inside a middleware is the middleware's own pattern (`/*`); use `routePath(c, -1)` from `hono/route` for the matched route.
- Throw `ApiError` from handlers and middleware; `app.onError` turns it into the SRS 4.4.1 error body. Anything else becomes a logged `500 INTERNAL`.
- `bodyLimit` runs before the handler reads the body; its `onError` throws an `ApiError` so the response has the standard shape.
- `@hono/node-server`'s `serve` returns Node's `http.Server`. On shutdown call `close()` and `closeIdleConnections()`, or idle keep-alive connections hold the server open until the grace period ends.

### Configuration
- Precedence is environment variable (or `*_FILE`) > config file > default. Keep it that way: Compose files and Kubernetes manifests rely on overriding single values from the environment.
- Unknown keys in the config file are errors; unknown `TAZAMUN_*` variables only warnings, because the environment also holds other programs' variables.
- JSON values are turned into the text an environment variable would hold before validation, so each setting has one parser. A setting that needs a list or object would need a different approach for the environment anyway.

### Security
- Compare hashes with `hashesEqual` (constant time). For an unknown account, `verifyAuthKey` still hashes and compares against a dummy, so timing doesn't reveal whether the account exists.
- Rate-limit sign-in per IP **and** per account, so spreading guesses over many IPs doesn't help. Rate limits are in memory and reset on restart; that's acceptable.
- `prelogin` for unknown usernames must look exactly like a real response: the same shape, default parameters, and an account ID and salt derived from the instance secret so repeated queries agree (SEC-9).
- The recovery endpoints (`/v1/recovery/key`, `/v1/recovery/passphrase`) sign nobody in but hand out key material, so treat them like sign-in: rate-limit per IP and per account, always run the hash comparison (also for unknown usernames and accounts without a recovery key), and answer `INVALID_CREDENTIALS` for every failure.
- Usernames are plaintext metadata the operator sees (ADR-0010). Never log them: they identify people. The log test checks it.
- `createAccount` checks the username before the invite, so a taken username doesn't use the invite up. Keep that order.
- Accounts from before migration 2 have `username`, `recovery_auth_hash` and `recovery_wrapped_account_key` NULL. Every read must handle that (`AccountRow.username` and `recovery` are optional).
- With `TAZAMUN_TRUST_PROXY`, the client IP is the **last** `X-Forwarded-For` entry, the one our own proxy added. Earlier entries come from the client and can be forged.
- Never log request bodies. History record IDs in logs reveal browsing patterns over time.

### Admin CLI
- Opening a database normally switches it to WAL and checkpoints on close, which **writes to the file**. Open files that must stay untouched (a backup being verified or restored) with `readOnly: true`.
- `restore` replaces `tazamun.db` and deletes its `-wal` and `-shm` files. A leftover WAL from the old database would be replayed into the restored one.
- `restore` can only check that no server answers on the configured port; it can't see a server on another port or in another container. The docs must say to stop the server first.
- **`seq` must not go backwards after a restore.** `Database.restore` raises each account's `last_seq` to at least its value in the replaced database; otherwise devices that had pulled further would skip new records.
- Still open: after a restore, devices don't re-download records that the restore set back to older versions, because their `seq` is below what the devices have seen. The engine does a full reconcile when a collection's high-water mark is below its `lastSeq`, but `Database.restore` keeps `seq` from going backwards, so that never triggers after a restore. A data generation in `/v1/info` that changes on restore would let the engine notice (ENG-6, ADR-0003); not built yet.
- Invite tokens are printed once, at creation; the database holds only their hash. Invite IDs are hex, so an ID never starts with `-` and gets parsed as an option.
- CLI output is for people and goes to stdout and stderr directly, not through the logger. It may show account IDs (operators need them), but never content, and no token other than a newly created invite.

### Running and testing
- Node runs the TypeScript source directly (type stripping), including `@tazamun/core` through the workspace link. This works because pnpm's symlink resolves to `packages/core`, outside `node_modules`; Node refuses to strip types from files under `node_modules`. Don't enable `--preserve-symlinks`.
- `erasableSyntaxOnly` forbids constructor parameter properties and enums. Declare fields explicitly.
- `@tazamun/core` exports namespaces only: `import { schema, crypto as tzCrypto } from '@tazamun/core'`, then `schema.pushRequest`. Don't import the core `crypto` namespace as `crypto`; it would hide `node:crypto` and Web Crypto names in that file.
- Graceful shutdown on `SIGTERM` can't be tested on Windows, where a kill is always forced. Test it in the container (`docker stop` should exit 0 within about a second); the CI smoke test (DEP-29) will cover it.
- **The image runs `dist/main.js`, built by `build.ts` with esbuild.** Code must bundle: no dynamic `import()` of computed paths, no reading files relative to the source at run time (`config-docs.ts` is a dev script and isn't bundled). `version.ts` imports `package.json` with an import attribute, which esbuild inlines.
- A new runtime dependency ends up in the bundle. `build.ts` fails if a bundled package has no license file, so the license notice always ships in `THIRD-PARTY-LICENSES.txt`.
- Tests use `Database.open(':memory:')` and `app.request()`; no port, no files. Tests that need files (migrations, backups) use a temporary directory and remove it afterwards.
