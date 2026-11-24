# 0004. TypeScript monorepo; supersedes the .NET/MySQL stack

- Status: Accepted (supersedes the platform constraints of SRS revision 1)
- Date: 2026-11-24

## Context

Revision 1 required .NET for the backend, Node.js and Vue for the frontend, and MySQL. But the extension must be written in JavaScript or TypeScript anyway, and with end-to-end encryption, crypto, schemas and merge logic must run **on the client**: in the extension and in the dashboard. A .NET server would duplicate schemas in a second language for little benefit, because the server no longer does anything complex. MySQL adds a second container and administration work for a few hundred MB of data.

## Decision

TypeScript everywhere, in a single pnpm-workspace monorepo:

```
packages/core        schemas, crypto, HLC, merge functions, API client (runs in Node + browsers)
packages/ui          shared Vue 3 components (popup, options, dashboard)
apps/extension       WXT project → Chrome, Edge, Firefox builds
apps/server          Node.js LTS HTTP API + SQLite + serves the dashboard
apps/dashboard       Vue 3 SPA (Vite)
data/                extension-equivalents.json and other community data
deploy/              Dockerfile, Compose files, reverse-proxy and Kubernetes examples (ADR-0007)
.github/workflows/   CI, container build/publish, release
```

- Server: Node.js LTS, Hono or Fastify, SQLite (`better-sqlite3`, or `node:sqlite` once stable). One container with a `/data` volume.
- Vue 3 stays from revision 1, now for the extension UIs as well as the dashboard.
- Tooling: TypeScript strict mode, Vitest, Playwright, ESLint and Prettier, GitHub Actions.

## Consequences

- Contributors need to know one language and one toolchain.
- Schemas and merge code are written once and shared by the extension, dashboard and tests.
- Self-hosting is one container with no database server.
- If someone strongly wants a .NET (or Go, or Rust) server later, it's feasible: the server only implements the HTTP API in SRS [section 4.4](<../4. External Interface Requirements.md#44-communications-interfaces>), which has no data-type logic. It would be a second implementation, not a replacement.
