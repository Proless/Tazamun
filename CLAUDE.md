# CLAUDE.md: Tazamun

Guidance for Claude (and human contributors) working in this repository: what the project is, where it stands, the roadmap by phase, and the pitfalls already known.

## What Tazamun is

**One extension, one account, and one place for your browser data across Chrome, Edge and Firefox. End-to-end encrypted and self-hostable.**

The goal is consolidation: replace a separate bookmark syncer, tab manager and history tool (each with its own account) with one product. Data types for 1.0: **tabs, history, bookmarks, extension inventory**. Passwords, cookies and browser settings are permanently out of scope (see [SRS 1.2](<docs/srs/1. Introduction.md#12-product-vision>)).

## Current status

- **Phase:** P0 (foundations). The pnpm workspace, tooling and CI are set up; `packages/core` exists but is still empty.
- The SRS was rewritten on 2026-11-24 (revision 2). Diagrams are Mermaid blocks inside the SRS ([section 2.2](<docs/srs/2. Overall Description.md#22-architecture>), [2.3](<docs/srs/2. Overall Description.md#23-sync-model>)). The revision-1 PNG diagrams were deleted.
- `docs/srs/System Feature Template.md` is the empty IEEE template, kept for reference only.

## Sources of truth

| What | Where |
| ---- | ----- |
| Requirements with IDs (`ACC-`, `ENG-`, `TAB-`, `HIS-`, `BMK-`, `EXT-`, `DSH-`, `UI-`, `IMP-`, `ADM-`, `DEP-`, `PERF-`, `SEC-`, `PRIV-`, `REL-`) | [`docs/srs/`](docs/srs/) sections 1–6 |
| Design decisions and why | [`docs/adr/`](docs/adr/README.md) |
| HTTP API and record envelope | [SRS section 4.4](<docs/srs/4. External Interface Requirements.md#44-communications-interfaces>) |
| Self-hosting, container image, publishing pipeline | [SRS section 3.11](<docs/srs/3. Software Features.md#311-self-hosting-containers-and-image-publishing>), [ADR-0007](docs/adr/0007-container-distribution.md) |
| Crypto parameters and threat model | [SRS section 5.2](<docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>) |
| Roadmap, gaps, pitfalls | this file |

If the code and the SRS disagree, fix one of them in the same pull request. Don't leave them out of sync.

## Rules that never change

1. **The server never sees plaintext.** No feature may require it ([ADR-0002](docs/adr/0002-end-to-end-encryption-dumb-server.md)). That includes "just for search", "just for the dashboard", and "just for debugging".
2. **The engine contains no code specific to a data type.** Data types are modules ([ADR-0001](docs/adr/0001-one-product-module-architecture.md)).
3. **Merge functions are pure** and live in `packages/core`. They're tested in Node, never only in a browser.
4. **Never trust browser events as the source of truth.** Events trigger a diff against the mirror.
5. **Never log plaintext,** URLs, titles, keys, tokens, passphrases or history record IDs. Not on the client, not on the server.
6. **Never destroy user data without a recoverable copy** (snapshots, tombstones, deletion guard).
7. **Never capture private or incognito browsing.**
8. Every hard-to-reverse decision gets an ADR. Reference requirement IDs in commits and PRs (e.g. `feat(tabs): send tab to device (TAB-7)`).

## Planned repository layout ([ADR-0004](docs/adr/0004-typescript-monorepo-stack.md))

```text
apps/
  extension/         WXT; engine in src/engine/, modules in src/modules/<type>/
  server/            Node.js LTS + Hono/Fastify + SQLite; serves the dashboard build
  dashboard/         Vue 3 + Vite SPA
packages/
  core/              schemas (zod), crypto, HLC, merge functions, API client; no browser APIs
  ui/                shared Vue 3 components
data/                extension-equivalents.json
deploy/
  docker/            Dockerfile (multi-stage), .dockerignore
  compose/           docker-compose.yml, docker-compose.caddy.yml, .env.example
  proxy/             Caddy / Traefik / nginx examples
  k8s/               example manifests (one replica + PVC)
docs/
  srs/               requirements (sections 1–6)
  adr/               architecture decision records
  guides/            user, self-hosting and contributor docs (from P1)
scripts/             repository maintenance scripts
.github/workflows/   ci.yml (lint, test, image build + smoke test), publish-edge.yml, release.yml
```

Each app and package has the same shape: `src/` for code, unit tests next to it as `*.test.ts`, shared fixtures and test vectors in `test/`, plus its own `package.json`, `tsconfig.json` and `vitest.config.ts`. Root config (`tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`) applies to all of them. Create a folder only when it gets real content.

Image: `ghcr.io/proless/tazamun` (`edge` from `main`; `X.Y.Z`, `X.Y`, `X`, `latest` from tags).

Commands (Node 26, pnpm 12; install pnpm with `npm install -g pnpm`, since Node 25+ no longer ships corepack):

| Command | What it does |
| ------- | ------------ |
| `pnpm install` | Install all workspace dependencies |
| `pnpm test` | Run every package's Vitest project |
| `pnpm lint` | ESLint (type-aware) over the whole repo |
| `pnpm typecheck` | `tsc --noEmit` in every package |
| `pnpm format` / `pnpm format:check` | Prettier write / check |

Still to come: `pnpm --filter extension dev`, `pnpm --filter server dev`, `docker compose up`.

---

## Roadmap

Rough estimates assume one developer working evenings. Each phase ends with **exit criteria**; don't start the next phase until they're met. Every phase should leave something usable, so it can be dog-fooded.

### P0: Foundations (1–2 weeks)

- [x] Set up the pnpm workspace with the layout above. TypeScript strict mode, ESLint and Prettier, Vitest.
- [ ] GitHub Actions: lint, type-check, tests, dependency audit, license check on every PR. *(All but the license check are in `ci.yml`.)*
- [ ] Renovate or Dependabot configured for npm, GitHub Actions and Docker base-image digests (DEP-37). *(npm and Actions done; add Docker when the Dockerfile lands.)*
- [ ] `packages/core/crypto`: Argon2id (WASM), HKDF, AES-GCM wrap and unwrap, payload encrypt and decrypt with AAD. **Test vectors** committed.
- [x] `packages/core/hlc`: HLC with tests (monotonic, clock skew, comparison including device ID).
- [ ] `packages/core/schema`: record envelope plus a payload schema per collection (zod), with schema versions.
- [ ] Settle Q1 (server framework and SQLite driver) and record it in ADR-0004.
- [ ] Write `CONTRIBUTING.md` and a short README "How it works" section linking the SRS.

**Exit:** CI green. Crypto round-trips and test vectors pass in Node **and** in a browser (Vitest browser mode or Playwright).

### P1: Engine, server, accounts, tabs (4–6 weeks): first usable version

- [ ] **Server:** accounts, prelogin, sessions, devices, collections (pull and push), `/v1/info`, `/v1/health`, quotas, rate limits, registration modes and invite CLI, migrations (ADM-1…4, ADM-7).
- [ ] **Server config:** one validated schema for `TAZAMUN_*` variables, `*_FILE` secrets, the `TAZAMUN_PUBLIC_URL` HTTPS check, a config reference generated from the schema (DEP-12…15).
- [ ] **Admin CLI:** `invite`, `backup`, `restore`, `migrate --status`, `accounts`, `version`, `healthcheck` (DEP-16). Automatic backup before migrating (DEP-24, DEP-25).
- [ ] **Container image:** multi-stage Dockerfile, non-root UID 10001, read-only root filesystem, `/data` volume, `HEALTHCHECK`, correct signal handling, JSON logs, OCI labels, instance secret generated on first start (DEP-1…11).
- [ ] **Compose files:** `docker-compose.yml` and `docker-compose.caddy.yml` with `.env.example` and resource limits. Reverse-proxy docs for Caddy, Traefik and nginx. Warning about local storage and a single instance (DEP-17…19, DEP-22).
- [ ] **CI image pipeline:** build on every PR plus a container smoke test (health, API suite, SIGTERM, restart persistence); vulnerability scan; multi-arch with Buildx; publish `edge` and `sha-*` to GHCR from `main` with minimal token permissions (DEP-28…30, DEP-33, DEP-34, DEP-38).
- [ ] **Extension scaffold:** WXT with three targets. Fixed Firefox add-on ID. CSP with `'wasm-unsafe-eval'`. Permissions as in SRS 2.7.
- [ ] **Onboarding:** create or connect an account, recovery kit, device registration (ACC-1…8, ACC-11, UI-2).
- [ ] **Engine:** outbox in IndexedDB, debounced push, alarm and popup-triggered pull, backoff, status, pause, per-module toggles (ENG-1…14).
- [ ] **Module interface** plus an in-memory fake browser for tests.
- [ ] **Tabs module:** publish windows and tabs; incognito, scheme and exclusion filtering; strip favicons (TAB-1…6).
- [ ] **Send tab** through the `commands` collection, plus notifications and the context menu (TAB-7, TAB-8, UI-4).
- [ ] **Popup:** status, other devices' tabs, send tab (UI-1). **Options page:** basics (UI-3).
- [ ] End-to-end test: two Chromium profiles and one server in Playwright; Firefox through `web-ext run`.
- [ ] Settle Q2 (encrypt device names?) and Q3 (default for remembering the key).

**Exit:** you use it daily on 3 browsers for a week, **against your own instance running the published `edge` image with `docker-compose.caddy.yml`**. A fresh VPS goes from nothing to a healthy HTTPS instance in under 10 minutes by following the docs. PERF-1 and PERF-2 are met. Killing the server or the service worker mid-sync loses nothing (REL-3). **You uninstall your current tab tool.**

### P2: History (3–4 weeks)

- [ ] History record IDs via HMAC of the normalized URL (HIS-1). Write the **URL normalization** rules down and test them (see the pitfalls below).
- [ ] Payload with capped visits and union merge, with property tests (HIS-2).
- [ ] Chunked first import with progress UI; `onVisited` capture (HIS-3, HIS-4, PERF-3).
- [ ] Filters for incognito, exclusions and schemes (HIS-5, PRIV-1, PRIV-3).
- [ ] Retention and `expiresAt`; tombstones; propagating native deletions; the "clear all" prompt (HIS-7…10).
- [ ] Local IndexedDB index and search; popup search; `tz` address-bar keyword (HIS-11, HIS-12, UI-5).

**Exit:** searching history from any browser finds pages visited in the others. 100k entries search within 200 ms. Clearing a browser's history doesn't wipe synced history. **You uninstall your current history tool, if any.**

### P3: Dashboard, "the one place" (3–4 weeks)

- [ ] Vue SPA served by the server. Sign-in with in-page key derivation; idle lock (DSH-1).
- [ ] Overview, Tabs, History pages. Decryption and indexing in a Web Worker, cached in IndexedDB (DSH-2…4).
- [ ] Settings: devices (rename, revoke), passphrase change by re-wrapping, recovery kit, JSON export, account deletion (DSH-7, ACC-9, ACC-10, IMP-1).
- [ ] Security headers and CSP (SEC-8). Responsive layout (DSH-8). Stale-device handling (TAB-9).

**Exit:** a fresh user goes from install to seeing a second browser's tabs and history in the dashboard in under 5 minutes, without docs.

### P4: Bookmarks (6–8 weeks): the hardest part

- [ ] Read [ADR-0006](docs/adr/0006-bookmark-safety.md) again first.
- [ ] Node record, GUID-to-native-ID map, canonical roots, fractional positions (BMK-1…4). Settle Q5.
- [ ] Merge: last writer wins per field, edit wins over delete, cycle repair, orphan recovery. **Property-based tests with 2–3 simulated devices must converge with no cycles and no lost nodes** (BMK-5…7, REL-6).
- [ ] Reconcile by diffing against the mirror; echo suppression; the post-apply diff must be empty (BMK-9, BMK-10).
- [ ] Snapshots, restore UI, HTML export and import (BMK-12, IMP-2, IMP-3).
- [ ] Mass-deletion guard (BMK-13). Vendor-sync warning (BMK-14). Skip managed nodes (BMK-15). Separators (BMK-8).
- [ ] First-sync modes with matching heuristics (BMK-11).
- [ ] Dashboard Bookmarks page (DSH-5).
- [ ] Test on real, large, messy bookmark sets (5,000+ nodes, duplicates, deep nesting, Firefox menu folder, Edge "Favorites").

**Exit:** two weeks of daily use across Firefox and Chromium with zero data loss and zero duplicates. Restoring a snapshot works. **You uninstall floccus or your current bookmark syncer.**

### P5: Extension inventory (about 2 weeks)

- [ ] `extensions` record per device; flags for development and admin installs (EXT-1, EXT-2).
- [ ] `data/extension-equivalents.json` with a schema, CI validation, and about 50 popular extensions seeded (EXT-4).
- [ ] Table view in the dashboard and options page; store links or search fallback (EXT-3, EXT-5, DSH-6).
- [ ] "Suggest a mapping" GitHub issue template (EXT-7).

**Exit:** the table correctly shows what's missing where for your own setup.

### P6: 1.0 release hardening (2–3 weeks)

- [ ] Security review of crypto and protocol (SEC-10). Fix findings.
- [ ] Privacy policy (PRIV-5) and a template for instance operators.
- [ ] Store listings: Chrome Web Store, Edge Add-ons, AMO (with source upload). Permission justifications.
- [ ] Documentation: user quick start, FAQ, self-hosting, backup and restore (ADM-6), upgrade notes.
- [ ] Health and metrics (ADM-5). Import into an empty account (IMP-4).
- [ ] **Release workflow** on `vX.Y.Z` tags: SemVer image tags (pre-releases never move `latest`), Docker Hub mirror, keyless cosign signing, SBOM and provenance attestations, store packages and AMO source archive attached to the GitHub release, changelog (DEP-31, DEP-32, DEP-35, DEP-36, DEP-39).
- [ ] Document `cosign verify` with the expected identity and issuer (DEP-36).
- [ ] Test the deployment on Docker plus Compose v2 **and** rootless Podman. Example Kubernetes manifests. Notes for running without containers (DEP-20, DEP-21, DEP-23).
- [ ] Upgrade policy and compatibility: any 1.x to any later 1.x; server accepts the previous minor client version (DEP-26, DEP-27). Test an upgrade from the previous release's image on a populated `/data`.
- [ ] Announce: Show HN, r/selfhosted, r/firefox, r/chrome. Collect feedback to decide what comes after 1.0.

**Exit:** v1.0.0 tagged and published in all three stores, and as a signed multi-arch image on GHCR and Docker Hub that passes `cosign verify`.

### After 1.0 (backlog, in rough priority order)

Firefox for Android · Helm chart · push notifications instead of polling · key rotation · tab groups · reading list / saved-for-later · WebDAV or S3 storage backends (Q6) · Arabic translation (right-to-left) · padding records to hide sizes · signed record history (detect rollbacks) · Safari (only if its extension APIs allow it).

---

## Known gaps (accepted for 1.0)

From [SRS 6.5](<docs/srs/6. Other Requirements.md#65-known-limitations-and-open-questions>). Don't "fix" these casually; each needs an ADR.

- A lost passphrase with no signed-in device means lost data. No server-side recovery is possible by design.
- A malicious server can withhold or roll back records, and can serve a backdoored dashboard.
- Account-key rotation is manual (export, new account, import).
- No sync for data without extension APIs: Firefox bookmark tags and keywords, tab group colours, passwords, settings.
- Record sizes and timing aren't padded, so traffic analysis can reveal activity patterns.
- Desktop only. Chrome and Edge on Android can't run the extension.
- One server instance per `/data`, on local storage only (SQLite). No horizontal scaling and no high availability in 1.0 ([ADR-0007](docs/adr/0007-container-distribution.md)).
- The browser's own address-bar autocomplete won't suggest pages visited only in other browsers (use `tz`) ([ADR-0005](docs/adr/0005-history-stored-in-extension.md)).
- Open questions Q1–Q6 in SRS 6.5 are still to be decided.

## Pitfalls (read before working in each area)

### Tooling
- **typescript-eslint supports TypeScript only below 6.1.** TypeScript 7 (the native port) is out, but stay on `typescript ~6.0` until typescript-eslint supports it.
- Node 25+ no longer bundles corepack, so `packageManager` in `package.json` isn't enforced automatically. CI uses `pnpm/action-setup`, which reads it.
- Vitest 5: `passWithNoTests` is a root-only option; per-project configs (`defineProject`) reject it.
- Property tests (fast-check) over wide ranges almost never produce equal values. To exercise tie-breaks, also run them with small domains (see `collidingHlcArb` in the HLC tests).
- Workspace packages export their TypeScript source (`"exports": "./src/index.ts"`). Bundlers and Vitest handle this directly, and the base tsconfig uses `erasableSyntaxOnly`, so Node 26 can run the source with built-in type stripping. Revisit if a package is ever published to npm.

### MV3 and extension lifecycle
- The Chrome service worker is **killed after about 30 s idle**; Firefox uses an event page. Any state in a module-level variable can vanish. Persist to IndexedDB or `storage`, and design every step to be resumable and idempotent.
- `setTimeout`/`setInterval` don't survive suspension. Use `chrome.alarms` (Chrome minimum 30 s; Tazamun's default is 60 s).
- Register event listeners **synchronously at top level** of the background script, or events that wake the worker will be missed.
- No WebSockets or SSE that need to stay open. Polling `/v1/info` is the design ([ADR-0003](docs/adr/0003-sync-protocol-records-hlc.md)).
- `storage.local` is 10 MB without `unlimitedStorage`. Put history and snapshots in IndexedDB.
- WASM (Argon2id) needs `'wasm-unsafe-eval'` in the extension CSP. Add it from day one.
- Argon2id with 64 MiB is slow on purpose (about 0.5–1 s). Never run it on every sync, only at sign-in and unlock.

### Cross-browser differences
- `browser.*` (promise-based) vs `chrome.*`: use WXT's `browser` everywhere.
- Different bookmark root IDs; roots are read-only; Chromium has no separators; Edge calls bookmarks "Favorites". See BMK-3.
- Firefox refuses `tabs.create` for privileged URLs (`about:config` and others) and restricts `file:`. Fall back to copying the URL (TAB-8).
- Firefox's `management.getAll()` returns add-on IDs, not store slugs.
- Chrome's `history.addUrl` can't set title or time. That's one reason history isn't written back ([ADR-0005](docs/adr/0005-history-stored-in-extension.md)).
- `contextMenus` (Chromium) vs `menus` (Firefox); tab group APIs differ.
- Test **every** change on Firefox too. The Chromium end-to-end setup is easier to automate, so Firefox regressions slip through.

### Sync and merge
- **Echo loops:** applying a remote change fires a local event, which looks like a new change, which gets pushed… Always suppress echoes and verify the post-apply diff is empty.
- **Events are not truth:** events are lost while the extension is asleep or the browser is closed, and vendor sync can change bookmarks behind your back. Diff against the mirror.
- Save the last `seq` only **after** applying the batch, or a crash will skip records forever.
- Clock skew affects HLC ordering. Warn when the local clock differs from the server's `Date` header by more than 5 minutes.
- `hlc.receive` throws `HlcDriftError` for a remote stamp more than 24 h in the future. The engine must catch it, keep its own clock unchanged, still apply the record, and show a warning. Never adopt the remote time, or one broken clock drags every device into the future.
- The serialized HLC format (SRS 4.4) is stored in every record. Changing it needs a migration, like the URL normalization rules.
- Tombstones expire after 90 days, so a device offline longer than that must do a full reconcile, not an incremental pull.
- Don't put the merge in the server "for performance". See rule 1.

### History
- **URL normalization decides whether history merges correctly.** Decide and test: lowercase scheme and host, drop the default port, keep the path's case, drop `#fragment`, and keep the query (don't strip tracking parameters in v1, as that's lossy). Once records exist, changing these rules changes every ID, so treat them as a versioned format.
- `history.search` with an empty `text` and `startTime: 0` caps results through `maxResults`. Page through by time windows for the import.
- Never call `getVisits` for every URL during import; it's far too slow.
- `onVisitRemoved` with `allHistory: true` means the user cleared everything. **Don't** forward that as 50,000 deletions (HIS-10).
- Users visit sensitive sites. Exclusions and incognito filtering are Must requirements, not polish.

### Bookmarks
- The first sync on a browser that already has bookmarks is where duplicates come from. Match before uploading (BMK-11) and snapshot first.
- Vendor bookmark sync (Chrome Sync or Firefox Sync) running alongside Tazamun can re-create deleted nodes or duplicate moved ones. Warn the user (BMK-14) and expect bug reports caused by it.
- Bulk operations (import, "sort by name", deleting a big folder) fire bursts of events in no guaranteed order. Debounce and reconcile.
- Enterprise-managed bookmarks are read-only; skip them.

### Crypto and security
- Never reuse a nonce: a fresh random 96-bit nonce for every encryption, including re-pushes of the same record.
- Always bind AAD (`accountId | collection | recordId`) and **check it on decrypt**, or a malicious server can swap records.
- Compare hashes in constant time on the server. Rate-limit sign-in.
- Don't build your own crypto primitives. Use Web Crypto plus one audited Argon2 WASM library.
- The dashboard is served by the server, so a compromised server compromises the dashboard. Don't market the dashboard as "zero-trust".

### Server and operations
- SQLite: enable WAL mode, use one writer connection, and make every batch insert a transaction. Back up online with `VACUUM INTO` or the backup API, never by copying the file while it's in use.
- Assign `seq` inside the write transaction so it never has gaps or duplicates.
- Never log request bodies. History record IDs in logs reveal browsing patterns over time.

### Containers, self-hosting and publishing
- **Native modules:** `better-sqlite3` compiles native code. Build it in the same base image family (glibc vs musl) and architecture as the runtime stage, or prebuilt binaries won't load. This is a strong argument for `node:sqlite` (Q1).
- **arm64 under QEMU** is very slow, and native compiles can time out. Prefer native arm64 runners, and cache dependency layers.
- **PID 1 and signals:** `CMD ["npm", "start"]` doesn't forward `SIGTERM` properly. Run `node` directly (or use a minimal init), or `docker stop` will kill the server without checkpointing the WAL.
- **Non-root plus bind mounts:** a host directory owned by root won't be writable by UID 10001. Document `chown 10001:10001`, prefer named volumes, and make the server fail with a clear message when `/data` isn't writable.
- **SQLite files:** the `-wal` and `-shm` files must stay next to the database on the same volume. Never put `/data` on NFS or SMB, and never run two containers on one `/data`. Corruption follows.
- **HEALTHCHECK without curl:** distroless or slim images don't include it. Use the built-in `tazamun healthcheck` subcommand.
- **Tags:** never move `latest` for a pre-release. Never re-push an existing `X.Y.Z` tag. Users pin to versions, and replacing one silently breaks trust and signatures.
- **GHCR visibility:** a newly created package on GHCR is private by default. Make it public once, and link it to the repository.
- **Docker Hub limits:** anonymous pulls are rate-limited. Default the docs to GHCR.
- **Token scope:** don't give the workflow `write-all`. Use `packages: write` and `id-token: write` only where needed, and keep the Docker Hub token out of PR workflows from forks.
- **Reverse proxies:** nginx's default `client_max_body_size` (1 MB) is below the API's 2 MB batch limit, and missing `X-Forwarded-Proto` breaks the public-URL check. Both belong in the proxy examples.

### Store publishing
- AMO requires source code and build instructions for bundled code. Keep builds reproducible from the start.
- Store reviewers will question `history`, `tabs`, `management` and `bookmarks`. Keep the justifications ready, and request host permission only for the user's server URL.
- Extension updates reach users over days. The server must stay compatible with at least the previous client version (`minClientVersion`).

## How to work in this repository (for Claude)

- Before implementing a feature, read its SRS section and the ADRs it references. Requirements tell you **what**; ADRs tell you **why**.
- Keep the phase checklists above up to date: tick a step when it's merged, and update **Current status** when a phase's exit criteria are met.
- Put new pitfalls in the matching section above as you find them. That's what this file is for.
- When a requirement turns out to be wrong or impossible, update the SRS in the same PR and explain why in the PR description. Use a new ADR if the change contradicts an existing one.
- Prefer pure functions in `packages/core` with tests over logic inside browser event handlers.
