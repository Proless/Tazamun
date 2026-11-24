# 0004. TypeScript monorepo; supersedes the .NET/MySQL stack

- Status: Accepted (supersedes the platform constraints of SRS revision 1)
- Date: 2026-11-24

## Context

Revision 1 required .NET for the backend, Node.js and Vue for the frontend, and MySQL. But the extension must be written in JavaScript or TypeScript anyway, and with end-to-end encryption, crypto, schemas and merge logic must run **on the client**: in the extension and in the dashboard. A .NET server would duplicate schemas in a second language for little benefit, because the server no longer does anything complex. MySQL adds a second container and administration work for a few hundred MB of data.

## Decision

TypeScript everywhere, in a single pnpm-workspace monorepo:

```text
apps/                deployable programs, each with its own src/
  extension/         WXT project → Chrome, Edge, Firefox builds
  server/            Node.js LTS HTTP API + SQLite + serves the dashboard
  dashboard/         Vue 3 SPA (Vite)
packages/            libraries shared by the apps, each with its own src/
  core/              schemas, crypto, HLC, merge functions, API client (runs in Node + browsers)
  ui/                shared Vue 3 components (popup, options, dashboard)
data/                extension-equivalents.json and other community data
deploy/              Dockerfile, Compose files, reverse-proxy and Kubernetes examples (ADR-0007)
docs/                srs/ (requirements), adr/ (decisions), guides/ (user and operator docs)
scripts/             repository maintenance scripts
.github/workflows/   CI, container build/publish, release
```

Every app and package follows the same shape: `src/` for code, unit tests next to the code as `*.test.ts`, shared fixtures and test vectors in `test/`, and its own `package.json`, `tsconfig.json` and `vitest.config.ts`. A single top-level `src/` was considered and rejected: the extension, server and dashboard are built, versioned and shipped separately, and `packages/core` must stay free of browser and server dependencies, which separate packages enforce.

- Server: Node.js LTS, Hono, SQLite through the built-in `node:sqlite` (see *Q1 resolved* below). One container with a `/data` volume.
- Vue 3 stays from revision 1, now for the extension UIs as well as the dashboard.
- Tooling: TypeScript strict mode, Vitest, Playwright, ESLint and Prettier, GitHub Actions.

## Consequences

- Contributors need to know one language and one toolchain.
- Schemas and merge code are written once and shared by the extension, dashboard and tests.
- Self-hosting is one container with no database server.
- If someone strongly wants a .NET (or Go, or Rust) server later, it's feasible: the server only implements the HTTP API in SRS [section 4.4](<../srs/4. External Interface Requirements.md#44-communications-interfaces>), which has no data-type logic. It would be a second implementation, not a replacement.

## Q1 resolved: Hono and `node:sqlite` (2026-11-24)

Open question Q1 (SRS 6.5) asked which HTTP framework and SQLite driver the server uses.

**Decision:** **Hono** (with `@hono/node-server`) and the built-in **`node:sqlite`** module.

Why Hono over Fastify:

- No dependencies (Fastify 5.12 has 15 direct ones). SEC-7 asks for few, audited dependencies, and the server's job is small: an authenticated record store with no data logic (ADR-0002).
- It's built on web-standard `Request` and `Response`. Route tests call `app.request()` in-process, with no network port.
- Validation reuses the zod schemas from `packages/core`.
- Cost: no built-in logger. The server adds a small structured JSON logger of its own, which must never log bodies or history record IDs (ADM-7).

Why `node:sqlite` over `better-sqlite3`:

- It's part of Node: no native module to compile for each architecture and C library, so the multi-arch image (ADR-0007) needs no native build step and no matching base images.
- In Node 26 it is "Stability 1.2 – Release candidate" and prints no warning. A local check on Node 26.13 confirmed everything the server needs: WAL mode, `BEGIN IMMEDIATE` transactions (50,000 inserts in about 0.25 s), the online `backup()` API and `VACUUM INTO`.
- Cost: an RC API can still change. All SQLite access goes through one small database module in `apps/server`, so a change, or a switch to `better-sqlite3` (whose synchronous API is very similar), touches one place.
