# @tazamun/server

The Tazamun sync server: a deliberately simple store of encrypted records, with accounts, device sessions and incremental pulls ([ADR-0002](../../docs/adr/0002-end-to-end-encryption-dumb-server.md), [ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)). It never decrypts anything and has no code for any data type. Built on [Hono](https://hono.dev) and Node's built-in `node:sqlite` ([ADR-0004](../../docs/adr/0004-typescript-monorepo-stack.md)).

| Part | Status |
| ---- | ------ |
| HTTP API `/v1` ([SRS 4.4](<../../docs/srs/4. External Interface Requirements.md#44-communications-interfaces>)): info, health, accounts, prelogin, sessions, keys, devices, collections | Done |
| Configuration from `TAZAMUN_*` variables, validated, with `*_FILE` secrets and a generated reference (ADM-1, DEP-12…15) | Done |
| Migrations on startup with a backup first; refuses newer databases (ADM-4, DEP-24) | Done |
| Quotas, rate limits, registration modes (ADM-2, ADM-3, SEC-9) | Done |
| Structured logs without bodies, tokens or record IDs (ADM-7, DEP-8) | Done |
| Graceful shutdown with WAL checkpoint (DEP-7) | Done |
| Admin CLI: `invite`, `backup`, `restore`, `migrate --status`, `accounts`, `version`, `healthcheck` (DEP-16) | Next |
| Container image, Compose files (DEP-1…11, DEP-17…19) | Later in P1 |
| Serving the dashboard, security headers (SEC-8) | P3 |

## Running it

```sh
cp apps/server/.env.example apps/server/.env   # once; local settings for development
pnpm --filter @tazamun/server dev             # restarts on changes
```

`dev` reads `apps/server/.env` (git-ignored) and stores data in `apps/server/data-local/`. The server runs its TypeScript source directly with Node's type stripping; there is no build step yet. Every setting is listed in the [configuration reference](../../docs/guides/server-configuration.md), which is generated from [`src/config.ts`](src/config.ts).

`node src/main.ts` is the production entry point. Run node directly, not through `pnpm start`, so `SIGTERM` reaches the server and it can shut down cleanly.

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

SQLite comes from Node itself (`node:sqlite`), so the server has no native modules.

## Layout

```text
src/
  main.ts            entry point: config, database, HTTP server, expiry purge, shutdown
  app.ts             createApp(services): middleware, error mapping, info and health
  config.ts          every TAZAMUN_* setting, validation, reference renderer
  config-docs.ts     writes docs/guides/server-configuration.md
  log.ts             JSON/pretty logger whose fields can't hold bodies, tokens or IDs
  secrets.ts         hashing, constant-time compare, tokens, instance secret, fake prelogin salts
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
    accounts.ts      create, prelogin, delete
    sessions.ts      sessions, keys, devices
    collections.ts   pull and push
test/
  harness.ts         in-memory app with a fake clock and captured logs
.env.example         development settings
```

Unit tests live next to the code as `*.test.ts`. `app.test.ts` exercises the whole API in-process.
