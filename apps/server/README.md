# @tazamun/server

The Tazamun sync server: a deliberately simple store of encrypted records, with accounts, device sessions and incremental pulls ([ADR-0002](../../docs/adr/0002-end-to-end-encryption-dumb-server.md), [ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)). It never decrypts anything and has no code for any data type. Built on [Hono](https://hono.dev) and Node's built-in `node:sqlite` ([ADR-0004](../../docs/adr/0004-typescript-monorepo-stack.md)).

| Part | Status |
| ---- | ------ |
| HTTP API `/v1` ([SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>)): info, health, accounts, usernames, prelogin, recovery key, sessions, keys, devices, collections | Done |
| Configuration from `TAZAMUN_*` variables and an optional JSON file, validated, with `*_FILE` secrets and a generated reference (ADM-1, DEP-12…15) | Done |
| Migrations on startup with a backup first; refuses newer databases (ADM-4, DEP-24) | Done |
| Quotas, rate limits, registration modes (ADM-2, ADM-3, SEC-9) | Done |
| Structured logs without bodies, tokens or record IDs (ADM-7, DEP-8) | Done |
| Graceful shutdown with WAL checkpoint (DEP-7) | Done |
| Admin CLI: `invite`, `backup`, `restore`, `migrate --status`, `accounts`, `version`, `healthcheck` (DEP-16, DEP-25) | Done |
| Container image, Compose files (DEP-1…11, DEP-17…19) | Done, in [deploy/](../../deploy/README.md) |
| Serving the dashboard, security headers (SEC-8) | P3 |

## Running it

```sh
cp apps/server/.env.example apps/server/.env   # once; local settings for development
pnpm --filter @tazamun/server dev             # restarts on changes
```

`dev` reads `apps/server/.env` (git-ignored) and stores data in `apps/server/data-local/`. In development the server runs its TypeScript source directly with Node's type stripping. The container image runs a bundle instead (`pnpm --filter @tazamun/server build`). Settings can also come from a JSON file named by `TAZAMUN_CONFIG_FILE`; environment variables override it. Every setting, its file key and the precedence rules are in the [configuration reference](../../docs/guides/server-configuration.md), which is generated from [`src/config.ts`](src/config.ts).

`node src/main.ts` is the production entry point. Run node directly, not through `pnpm start`, so `SIGTERM` reaches the server and it can shut down cleanly.

## Admin commands

`node src/main.ts <command>` is the `tazamun` command (DEP-16); without a command it runs the server. In development, `pnpm --filter @tazamun/server tazamun <command>` reads `.env` first. In the container image it will be `docker compose exec tazamun tazamun <command>`. Commands read the same configuration as the server.

| Command | What it does |
| ------- | ------------ |
| `serve` | Run the server (the default) |
| `invite create [--expires 12h\|7d\|never]` | Create a one-time invite token (default: expires in 7 days). The token is printed once; only its hash is stored. |
| `invite list` · `invite revoke <id>` | List invites (ID, created, expires, and whether unused, used or expired) · delete an invite |
| `backup <file>` | Write a consistent copy with `VACUUM INTO`, also while the server runs, then check it with `integrity_check` |
| `restore <file>` | Replace the database with a backup. Refuses while a server answers on the configured port, and refuses backups that fail `integrity_check` or are newer than this version. Saves the current database to `backups/pre-restore-<time>.db` first. |
| `migrate --status` | Show the schema version and pending migrations. Migrations themselves run when the server starts. |
| `accounts list` | ID, created, last seen, device count and storage per account. Never content. |
| `accounts delete <id> --yes` | Delete an account with all its data, after a backup to `backups/pre-delete-<time>.db` (the last 3 are kept) |
| `version` · `healthcheck` | Print the version · exit 0 if `/v1/health` answers on `127.0.0.1:<port>` (for the image's `HEALTHCHECK`) |

Exit codes: 0 success, 1 failure (the message says what to fix), 2 wrong usage. Admin commands never create or migrate the database: start the server once first, and after an upgrade let the server migrate before running them.

## API notes

The endpoints, the record envelope and the error codes are specified in [SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>). Request and response bodies are zod schemas in [`packages/core/src/schema`](../../packages/core/src/schema/) (`api.ts`, `envelope.ts`), shared with the clients. Behaviour worth knowing as a client:

- `seq` is one counter per account, shared by all collections. It never goes backwards and has no gaps within a push.
- A push is all or nothing (REL-4). A batch that contains the same record ID twice is rejected.
- A push that would take the account over its storage quota is rejected as a whole with `QUOTA_EXCEEDED`. Pushes that shrink storage are always accepted, so a full account can still write tombstones.
- Pull pages hold at most 500 records and about 2 MiB of payload, but always at least one record if any is left. Page until `more` is `false`.
- Expired records disappear from pulls at once, and are deleted within an hour.
- `/v1/info` without a token describes the server; with a valid token it adds the high-water `seq` per collection and the storage used. An invalid token is a `401`, never silently ignored, so a revoked device learns it's signed out.
- Each device has one session. Signing in again from the same device ID ends its old token. Revoking a device ends its session immediately.
- CORS: the dashboard is served from the same origin, and extensions reach the server through host permissions, so the server sends no CORS headers.

## Scripts

Run from the repository root:

| Command | What it does |
| ------- | ------------ |
| `pnpm --filter @tazamun/server dev` | Start the server with `.env`, restarting on changes |
| `pnpm --filter @tazamun/server tazamun <command>` | Run an admin command with `.env` |
| `pnpm --filter @tazamun/server build` | Bundle into `dist/main.js` with `dist/THIRD-PARTY-LICENSES.txt`, as the image runs it |
| `pnpm --filter @tazamun/server smoke <image>` | Container smoke test against a built image (DEP-29; see [deploy/README.md](../../deploy/README.md#ci-pipeline)) |
| `pnpm --filter @tazamun/server typecheck` | Type-check this package |
| `pnpm --filter @tazamun/server config:docs` | Regenerate [`docs/guides/server-configuration.md`](../../docs/guides/server-configuration.md). A test fails if it's out of date. |
| `pnpm test --project server` | Run this package's tests |

## Dependencies

| Package | Why |
| ------- | --- |
| `hono` | HTTP routing on web-standard `Request`/`Response`; tests call `app.request()` with no network ([ADR-0004](../../docs/adr/0004-typescript-monorepo-stack.md)) |
| `@hono/node-server` | Runs the Hono app on Node's `http` server |
| `zod` | Validating configuration and request bodies, with the schemas from `@tazamun/core` |
| `@tazamun/core` | Shared wire schemas and constants |

Development only: `esbuild`, which bundles the server for the image. Its install script is denied in `pnpm-workspace.yaml` (`allowBuilds`); the platform binary comes as an optional dependency.

SQLite comes from Node itself (`node:sqlite`), so the server has no native modules.

## Layout

```text
src/
  main.ts            entry point of the tazamun command; wires real I/O into cli.ts
  cli.ts             command parsing and the admin commands
  serve.ts           tazamun serve: database, HTTP server, expiry purge, shutdown
  app.ts             createApp(services): middleware, error mapping, info and health
  config.ts          every TAZAMUN_* setting, validation, reference renderer
  config-docs.ts     writes docs/guides/server-configuration.md
  log.ts             JSON/pretty logger whose fields can't hold bodies, tokens or IDs
  secrets.ts         hashing, constant-time compare, tokens, instance secret, fake prelogin account IDs
                     and salts
  version.ts         server version and minClientVersion
  db/
    database.ts      the only module that touches node:sqlite
    migrations.ts    append-only schema migrations
  http/
    context.ts       services, session middleware, rate-limit helper
    errors.ts        ApiError and common errors
    rate-limit.ts    in-memory token buckets
    validate.ts      body and parameter validation that never echoes values
  routes/
    accounts.ts      create, prelogin by username, account info, username, delete, recovery key
    sessions.ts      sessions, keys, devices
    collections.ts   pull and push
test/
  harness.ts         in-memory app with a fake clock and captured logs
  smoke.ts           container smoke test: runs a built image and drives it like a client
.env.example         development settings
build.ts             production bundle and third-party license file (dist/)
```

Unit tests live next to the code as `*.test.ts`. `app.test.ts` exercises the whole API in-process.
