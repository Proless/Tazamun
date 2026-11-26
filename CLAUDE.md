# CLAUDE.md: Tazamun

Guidance for Claude working in this repository: what the project is, where it stands, the roadmap by phase, and the pitfalls already known. Human contributors start with [CONTRIBUTING.md](CONTRIBUTING.md), which repeats the rules below; keep the two in sync.

## What Tazamun is

**One extension, one account, and one place for your browser data across Chrome, Edge and Firefox. End-to-end encrypted and self-hostable.**

The goal is consolidation: replace a separate bookmark syncer, tab manager and history tool (each with its own account) with one product. Data types for 1.0: **tabs, history, bookmarks, extension inventory**. Passwords, cookies and browser settings are permanently out of scope (see [SRS 1.2](<docs/srs/1. Introduction.md#12-product-vision>)).

## Current status

- **Phase:** P1 (engine, server, accounts, tabs). P0's exit criteria are met: workspace, tooling and CI are set up, and `packages/core` has the HLC, the record schemas and the crypto, tested in Node, Chromium and Firefox. Q1 is decided: Hono and `node:sqlite`.
- **What exists:** `packages/core`, `apps/server` (HTTP API, config, database and migrations, admin CLI; see [apps/server/README.md](apps/server/README.md)), `deploy/` (Dockerfile, Compose files, proxy examples; see [deploy/README.md](deploy/README.md)), `scripts/`, `docs/`, `.github/`. The image pipeline builds, smoke-tests and scans every PR and publishes `edge` from `main`. `apps/extension` has the WXT scaffold for three targets and onboarding: create an account, sign in with username and passphrase, recover with the recovery key, lock, sign-out and revoked states (see [apps/extension/README.md](apps/extension/README.md)); `packages/core` has the API client and account flows they use. The sync engine runs in the extension's background (outbox and mirror in IndexedDB, alarm and popup pulls, backoff, status, pause), and the tabs module publishes each browser's tabs; the popup lists other browsers' tabs (open now or when last seen, and recently closed) and checks for changes every 5 s while open; private windows sync only when the user turns that on; the options page has the P1 settings; an end-to-end suite runs Chromium and Firefox against the real server in CI. All P1 items are done; what remains for P1 is its exit criteria (a week of daily use on the `edge` image).
- The SRS was rewritten on 2026-11-24 (revision 2). Diagrams are Mermaid blocks inside the SRS ([section 2.2](<docs/srs/2. Overall Description.md#22-architecture>), [2.3](<docs/srs/2. Overall Description.md#23-sync-model>)). The revision-1 PNG diagrams were deleted.
- `docs/srs/System Feature Template.md` is the empty IEEE template, kept for reference only.

## Sources of truth

| What | Where |
| ---- | ----- |
| Requirements with IDs (`ACC-`, `ENG-`, `TAB-`, `HIS-`, `BMK-`, `EXT-`, `DSH-`, `UI-`, `IMP-`, `ADM-`, `DEP-`, `PERF-`, `SEC-`, `PRIV-`, `REL-`) | [`docs/srs/`](docs/srs/) sections 1–6 |
| Design decisions and why | [`docs/adr/`](docs/adr/README.md) |
| HTTP API and record envelope | [SRS section 4.4](<docs/srs/4. External Interface Requirements.md#44-communications-interfaces>) |
| Self-hosting, container image, publishing pipeline | [SRS section 3.11](<docs/srs/3. Software Features.md#311-self-hosting-containers-and-image-publishing>), [ADR-0007](docs/adr/0007-container-distribution.md) |
| Crypto parameters and threat model | [SRS section 5.2](<docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>), [ADR-0008](docs/adr/0008-crypto-implementation.md) (library and format v1 details) |
| How to use an app or package, and its own pitfalls | that folder's `README.md` and `CLAUDE.md` |
| Contributor process (setup, commits, PR checklist) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Roadmap, gaps, pitfalls | this file |

If the code and the SRS disagree, fix one of them in the same pull request. Don't leave them out of sync.

## Rules that never change

1. **The server never sees plaintext.** No feature may require it ([ADR-0002](docs/adr/0002-end-to-end-encryption-dumb-server.md)). That includes "just for search", "just for the dashboard", and "just for debugging".
2. **The engine contains no code specific to a data type.** Data types are modules ([ADR-0001](docs/adr/0001-one-product-module-architecture.md)).
3. **Merge functions are pure** and live in `packages/core`. They're tested in Node, never only in a browser.
4. **Never trust browser events as the source of truth.** Events trigger a diff against the mirror.
5. **Never log plaintext,** URLs, titles, keys, tokens, passphrases or history record IDs. Not on the client, not on the server.
6. **Never destroy user data without a recoverable copy** (snapshots, tombstones, deletion guard).
7. Every hard-to-reverse decision gets an ADR. Reference requirement IDs in commits and PRs (e.g. `feat(tabs): include private windows on request (TAB-2)`).

## Repository layout ([ADR-0004](docs/adr/0004-typescript-monorepo-stack.md))

Folders marked *(planned)* don't exist yet.

```text
apps/
  extension/         WXT + Vue 3, Chrome/Edge/Firefox; engine in src/engine/, modules in src/modules/<type>/
  server/            Node.js LTS + Hono + node:sqlite: HTTP API, config, migrations; serves the dashboard build from P3
  dashboard/         (planned, P3) Vue 3 + Vite SPA
packages/
  core/              HLC, schemas (zod), crypto, API client, account flows, merge functions; no browser APIs
  ui/                (planned) shared Vue 3 components
data/                (planned, P5) extension-equivalents.json
deploy/              see deploy/README.md
  docker/            Dockerfile (multi-stage), Dockerfile.dockerignore
  compose/           docker-compose.yml, docker-compose.caddy.yml, .env.example
  proxy/             Caddy / Traefik / nginx examples
  k8s/               (planned, P6) example manifests (one replica + PVC)
docs/
  srs/               requirements (sections 1–6)
  adr/               architecture decision records (0001–0011)
  guides/            self-hosting.md, server-configuration.md (generated); user and contributor docs follow
scripts/             repository maintenance scripts (license check)
.github/
  workflows/ci.yml   lint, type-check, Node tests, browser tests, extension builds + web-ext lint,
                     end-to-end tests (Chromium + Firefox), dependency audit, license check
  workflows/image.yml  image build for amd64 and arm64, smoke test, scan; publishes edge from main
                     (release.yml follows in P6)
  dependabot.yml     npm, GitHub Actions, Docker base image
```

Each app and package has the same shape: `src/` for code, unit tests next to it as `*.test.ts`, shared fixtures and test vectors in `test/`, plus its own `package.json`, `tsconfig.json` and `vitest.config.ts`. Root config (`tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`) applies to all of them. Create a folder only when it gets real content.

**Documentation lives next to the code.** Every app and package has:

- `README.md` for people: what it is, how to use it, its scripts and layout.
- `CLAUDE.md` for working in that folder: its rules and pitfalls. Claude Code loads it automatically when working there.

This root file keeps only what spans the repository: rules, layout, roadmap, known gaps and cross-cutting pitfalls. Don't copy a package's details into it; link to the package instead.

Image: `ghcr.io/proless/tazamun` (`edge` from `main`; `X.Y.Z`, `X.Y`, `X`, `latest` from tags).

Commands (Node 26, pnpm 12; install pnpm with `npm install -g pnpm`, since Node 25+ no longer ships corepack):

| Command | What it does |
| ------- | ------------ |
| `pnpm install` | Install all workspace dependencies |
| `pnpm test` | Run every package's Vitest project in Node |
| `pnpm test:browser` | Run the browser projects in Chromium and Firefox (first run `pnpm --filter @tazamun/core exec playwright install chromium firefox`) |
| `pnpm lint` | ESLint (type-aware) over the whole repo |
| `pnpm typecheck` | `tsc --noEmit` in every package and in `scripts/` |
| `pnpm format` / `pnpm format:check` | Prettier write / check |
| `pnpm licenses:check` | Dependency license policy ([scripts/README.md](scripts/README.md)) |
| `pnpm --filter @tazamun/server dev` | Run the server locally (copy `apps/server/.env.example` to `.env` first) |
| `pnpm --filter @tazamun/server tazamun <command>` | Admin commands: invites, backup, restore, accounts ([apps/server/README.md](apps/server/README.md#admin-commands)) |
| `docker build -f deploy/docker/Dockerfile -t tazamun:test .` | Build the server image locally, for testing ([deploy/README.md](deploy/README.md)) |
| `pnpm --filter @tazamun/server smoke tazamun:test` | Container smoke test against a local image (DEP-29) |
| `pnpm --filter @tazamun/extension dev` | Run the extension in Chrome with live reload (`dev:firefox` for Firefox) |
| `pnpm --filter @tazamun/extension build` | Production builds for Chrome, Edge and Firefox in `apps/extension/.output/` |
| `pnpm --filter @tazamun/extension test:e2e` | End-to-end tests against the build: Chromium and Firefox, real server ([apps/extension/README.md](apps/extension/README.md#end-to-end-tests)) |

---

## Roadmap

Rough estimates assume one developer working evenings. Each phase ends with **exit criteria**; don't start the next phase until they're met. Every phase should leave something usable, so it can be dog-fooded.

### P0: Foundations (1–2 weeks)

- [x] Set up the pnpm workspace with the layout above. TypeScript strict mode, ESLint and Prettier, Vitest.
- [x] GitHub Actions: lint, type-check, tests, dependency audit, license check on every PR.
- [x] Renovate or Dependabot configured for npm, GitHub Actions and Docker base-image digests (DEP-37).
- [x] `packages/core/crypto`: Argon2id (WASM), HKDF, AES-GCM wrap and unwrap, payload encrypt and decrypt with AAD. **Test vectors** committed. *(Library choice and format details: [ADR-0008](docs/adr/0008-crypto-implementation.md).)*
- [x] `packages/core/hlc`: HLC with tests (monotonic, clock skew, comparison including device ID).
- [x] `packages/core/schema`: record envelope plus a payload schema per collection (zod), with schema versions. *(`bookmarks` follows in P4. No `devices` collection: names are plaintext, ADR-0009.)*
- [x] Settle Q1 (server framework and SQLite driver) and record it in ADR-0004. *(Hono and `node:sqlite`.)*
- [x] Write `CONTRIBUTING.md` and a short README "How it works" section linking the SRS.

**Exit:** CI green. Crypto round-trips and test vectors pass in Node **and** in a browser (Vitest browser mode or Playwright).

### P1: Engine, server, accounts, tabs (4–6 weeks): first usable version

- [x] **Server:** accounts, prelogin, sessions, devices, collections (pull and push), `/v1/info`, `/v1/health`, quotas, rate limits, registration modes and invite CLI, migrations (ADM-1…4, ADM-7).
- [x] **Server config:** one validated schema for `TAZAMUN_*` variables, `*_FILE` secrets, the `TAZAMUN_PUBLIC_URL` HTTPS check, a config reference generated from the schema (DEP-12…15).
- [x] **Admin CLI:** `invite`, `backup`, `restore`, `migrate --status`, `accounts`, `version`, `healthcheck` (DEP-16). Automatic backup before migrating (DEP-24, DEP-25).
- [x] **Container image:** multi-stage Dockerfile, non-root UID 10001, read-only root filesystem, `/data` volume, `HEALTHCHECK`, correct signal handling, JSON logs, OCI labels, instance secret generated on first start (DEP-1…11).
- [x] **Compose files:** `docker-compose.yml` and `docker-compose.caddy.yml` with `.env.example` and resource limits. Reverse-proxy docs for Caddy, Traefik and nginx. Warning about local storage and a single instance (DEP-17…19, DEP-22).
- [x] **CI image pipeline:** build on every PR plus a container smoke test (health, API suite, SIGTERM, restart persistence); vulnerability scan; multi-arch with Buildx; publish `edge` and `sha-*` to GHCR from `main` with minimal token permissions (DEP-28…30, DEP-33, DEP-34, DEP-38).
- [x] **Extension scaffold:** WXT with three targets. Fixed Firefox add-on ID. CSP with `'wasm-unsafe-eval'`. Permissions as in SRS 2.7.
- [x] **Onboarding:** create or connect an account, recovery kit, device registration (ACC-1…8, ACC-11, UI-2). *(Since [ADR-0010](docs/adr/0010-usernames-and-recovery-key.md): usernames for signing in and a recovery key that sets a new passphrase, instead of the recovery kit and pairing code; ACC-5, ACC-13.)*
- [x] **Engine:** outbox in IndexedDB, debounced push, alarm and popup-triggered pull, backoff, status, pause, per-module toggles (ENG-1…14). Clock warnings (ENG-15). Recovery after a server restore through a data generation (ENG-16).
- [x] **Module interface** plus an in-memory fake browser for tests. *(WXT's fake browser, plus `FakeServer` and `FakeTabsModule` in `apps/extension/src/engine/testing.ts`.)*
- [x] **Tabs module:** publish windows and tabs; incognito, scheme and exclusion filtering; strip favicons (TAB-1…6). *(Private windows are an opt-in per browser since [ADR-0011](docs/adr/0011-private-browsing-choice-and-no-send-tab.md).)*
- [x] **Recently closed tabs and live state:** closed tabs, including a closed last window, move to a per-device list (50, 7 days); devices not seen for 10 minutes show *open when last seen* (TAB-10, TAB-11).
- [x] ~~**Send tab** through the `commands` collection, plus notifications and the context menu (TAB-7, TAB-8, UI-4).~~ *(Built, then removed by ADR-0011; TAB-8 stays for opening tabs from the popup.)*
- [x] **Popup:** status, other devices' tabs (UI-1), checked every 5 s while open (PERF-1). **Options page:** basics (UI-3).
- [x] End-to-end test: two Chromium profiles and one server in Playwright; Firefox through `web-ext run`. *(Chromium A through Playwright and the installed Firefox B through WebDriver BiDi, against the real server; `web-ext run` can't drive pages. Runs in CI.)*
- [x] Settle Q2 (encrypt device names?) and Q3 (default for remembering the key). *(Plaintext names; remember by default: [ADR-0009](docs/adr/0009-device-names-and-key-storage.md).)*

**Exit:** you use it daily on 3 browsers for a week, **against your own instance running the published `edge` image with `docker-compose.caddy.yml`**. A fresh VPS goes from nothing to a healthy HTTPS instance in under 10 minutes by following the docs. PERF-1 is met. Killing the server or the service worker mid-sync loses nothing (REL-3). **You uninstall your current tab tool.**

### P2: History (3–4 weeks)

- [ ] History record IDs via HMAC of the normalized URL (HIS-1). Write the **URL normalization** rules down and test them (see the pitfalls below).
- [ ] Payload with capped visits and union merge, with property tests (HIS-2).
- [ ] Chunked first import with progress UI; `onVisited` capture (HIS-3, HIS-4, PERF-3).
- [ ] Filters for exclusions and schemes, and private windows only when the user turns that on (HIS-5, PRIV-1, PRIV-3).
- [ ] Retention and `expiresAt`; tombstones; propagating native deletions; the "clear all" prompt (HIS-7…10).
- [ ] Local IndexedDB index and search; popup search; `tz` address-bar keyword (HIS-11, HIS-12, UI-5).

**Exit:** searching history from any browser finds pages visited in the others. 100k entries search within 200 ms. Clearing a browser's history doesn't wipe synced history. **You uninstall your current history tool, if any.**

### P3: Dashboard, "the one place" (3–4 weeks)

- [ ] Vue SPA served by the server. Sign-in with in-page key derivation; idle lock (DSH-1).
- [ ] Overview, Tabs, History pages. Decryption and indexing in a Web Worker, cached in IndexedDB (DSH-2…4).
- [ ] Settings: devices (rename, revoke), passphrase change by re-wrapping, username, new recovery key, JSON export, account deletion (DSH-7, ACC-9, ACC-10, IMP-1).
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

Firefox for Android · Helm chart · push notifications instead of polling · key rotation · reading list / saved-for-later · WebDAV or S3 storage backends (Q6) · Arabic translation (right-to-left) · padding records to hide sizes · signed record history (detect rollbacks) · Safari (only if its extension APIs allow it).

---

## Known gaps (accepted for 1.0)

From [SRS 6.5](<docs/srs/6. Other Requirements.md#65-known-limitations-and-open-questions>). Don't "fix" these casually; each needs an ADR.

- Losing both the passphrase and the recovery key, with no signed-in device, means lost data. No server-side recovery is possible by design ([ADR-0010](docs/adr/0010-usernames-and-recovery-key.md)).
- A malicious server can withhold or roll back records, and can serve a backdoored dashboard.
- Account-key rotation is manual (export, new account, import).
- No sync for data without extension APIs: Firefox bookmark tags and keywords, passwords, settings. Tab groups aren't synced at all, by choice (TAB-1).
- Record sizes and timing aren't padded, so traffic analysis can reveal activity patterns.
- Desktop only. Chrome and Edge on Android can't run the extension.
- One account per browser profile (ACC-12). A server hosts many accounts; one browser profile connects to one of them. Several accounts in one browser means one profile each.
- One server instance per `/data`, on local storage only (SQLite). No horizontal scaling and no high availability in 1.0 ([ADR-0007](docs/adr/0007-container-distribution.md)).
- The browser's own address-bar autocomplete won't suggest pages visited only in other browsers (use `tz`) ([ADR-0005](docs/adr/0005-history-stored-in-extension.md)).
- Open questions Q4–Q6 in SRS 6.5 are still to be decided (Q1–Q3 are decided).

## Pitfalls (read before working in each area)

Pitfalls for one app or package live in that folder's `CLAUDE.md`. The sections below cover areas that span several folders, or whose folder doesn't exist yet. When you create an app, move its section into the new `CLAUDE.md`.

### Tooling
- **typescript-eslint supports TypeScript only below 6.1.** TypeScript 7 (the native port) is out, but stay on `typescript ~6.0` until typescript-eslint supports it.
- Scripts that call pnpm from Node must use `process.env.npm_execpath`. It can be a JS file (run it with `node`) or a native binary (run it directly); spawning `pnpm` by name fails on Windows, where it's `pnpm.cmd`.
- Node 25+ no longer bundles corepack, so `packageManager` in `package.json` isn't enforced automatically. CI uses `pnpm/action-setup`, which reads it.
- Vitest 5: `passWithNoTests` is a root-only option; per-project configs (`defineProject`) reject it.
- `erasableSyntaxOnly` (base tsconfig) forbids constructor parameter properties (`constructor(readonly x: T)`) and enums, because Node's type stripping can't run them. Declare fields explicitly.
- Workspace packages export their TypeScript source (`"exports": "./src/index.ts"`). Bundlers and Vitest handle this directly, and the base tsconfig uses `erasableSyntaxOnly`, so Node 26 can run the source with built-in type stripping. Revisit if a package is ever published to npm.

### Extension (MV3, cross-browser, stores)
- MV3 lifecycle, cross-browser differences and store publishing pitfalls are in [apps/extension/CLAUDE.md](apps/extension/CLAUDE.md).

### Sync and merge
- **Echo loops:** applying a remote change fires a local event, which looks like a new change, which gets pushed… Always suppress echoes and verify the post-apply diff is empty.
- **Events are not truth:** events are lost while the extension is asleep or the browser is closed, and vendor sync can change bookmarks behind your back. Diff against the mirror.
- Save the last `seq` only **after** applying the batch, or a crash will skip records forever.
- HLC pitfalls (clock skew, `HlcDriftError`, the stored format) are in [packages/core/CLAUDE.md](packages/core/CLAUDE.md#hlc).
- Tombstones expire after 90 days, so a device offline longer than that must do a full reconcile, not an incremental pull.
- Don't put the merge in the server "for performance". See rule 1.

### History
- **URL normalization decides whether history merges correctly.** Decide and test: lowercase scheme and host, drop the default port, keep the path's case, drop `#fragment`, and keep the query (don't strip tracking parameters in v1, as that's lossy). Once records exist, changing these rules changes every ID, so treat them as a versioned format.
- `history.search` with an empty `text` and `startTime: 0` caps results through `maxResults`. Page through by time windows for the import.
- Never call `getVisits` for every URL during import; it's far too slow.
- `onVisitRemoved` with `allHistory: true` means the user cleared everything. **Don't** forward that as 50,000 deletions (HIS-10).
- Users visit sensitive sites. Exclusions, and leaving private windows out unless the user turned them on (off by default, ADR-0011), are Must requirements, not polish.

### Bookmarks
- The first sync on a browser that already has bookmarks is where duplicates come from. Match before uploading (BMK-11) and snapshot first.
- Vendor bookmark sync (Chrome Sync or Firefox Sync) running alongside Tazamun can re-create deleted nodes or duplicate moved ones. Warn the user (BMK-14) and expect bug reports caused by it.
- Bulk operations (import, "sort by name", deleting a big folder) fire bursts of events in no guaranteed order. Debounce and reconcile.
- Enterprise-managed bookmarks are read-only; skip them.

### Crypto and security
- Pitfalls for the crypto code itself (nonces, AAD, primitives, test vectors) are in [packages/core/CLAUDE.md](packages/core/CLAUDE.md#crypto).
- Compare hashes in constant time on the server. Rate-limit sign-in.
- The dashboard is served by the server, so a compromised server compromises the dashboard. Don't market the dashboard as "zero-trust".

### Server and operations
- Server pitfalls (SQLite, `seq`, Hono, logging, rate limits) are in [apps/server/CLAUDE.md](apps/server/CLAUDE.md).

### Containers, self-hosting and publishing
- **The image runs a bundle, not the TypeScript source.** `pnpm deploy` or a production install would copy `@tazamun/core` into `node_modules`, where Node refuses to strip types. `apps/server/build.ts` bundles everything into `dist/main.js` with esbuild instead.
- **The build stage runs on `$BUILDPLATFORM`.** Its output is plain JavaScript, so arm64 images build without emulation. Only the small runtime `RUN` (user, directories) runs under QEMU. Keep anything heavy out of the runtime stage.
- **The build context is an allow-list** in `deploy/docker/Dockerfile.dockerignore` (BuildKit reads `<Dockerfile>.dockerignore`). A new file the build needs must be added there.
- **`ENTRYPOINT` is `tazamun`.** `docker compose exec tazamun tazamun <cmd>` (exec ignores the entrypoint) but `docker compose run --rm tazamun <cmd>` (run uses it). Mixing them up gives `Unknown command "tazamun"`.
- **`restore` from `docker compose run`** runs in a new container with its own network namespace, so its "is the server running?" check can't see the real server. Always stop the server first.
- **Git Bash on Windows rewrites container paths** (`/data` → `C:/...`) in `docker` arguments. Set `MSYS_NO_PATHCONV=1`.
- **Native modules:** the server uses the built-in `node:sqlite` (Q1), so the image needs no native builds. Keep it that way. A native dependency must be built in the same base image family (glibc vs musl) and architecture as the runtime stage, or its binaries won't load.
- **arm64 under QEMU** is very slow, and native compiles can time out. Prefer native arm64 runners, and cache dependency layers.
- **PID 1 and signals:** `CMD ["npm", "start"]` doesn't forward `SIGTERM` properly. Run `node` directly (or use a minimal init), or `docker stop` will kill the server without checkpointing the WAL.
- **Non-root plus bind mounts:** a host directory owned by root won't be writable by UID 10001. Document `chown 10001:10001`, prefer named volumes, and make the server fail with a clear message when `/data` isn't writable.
- **SQLite files:** the `-wal` and `-shm` files must stay next to the database on the same volume. Never put `/data` on NFS or SMB, and never run two containers on one `/data`. Corruption follows.
- **HEALTHCHECK without curl:** distroless or slim images don't include it. Use the built-in `tazamun healthcheck` subcommand.
- **Tags:** never move `latest` for a pre-release. Never re-push an existing `X.Y.Z` tag. Users pin to versions, and replacing one silently breaks trust and signatures.
- **GHCR visibility:** a newly created package on GHCR is private by default. Make it public once, and link it to the repository.
- **Docker Hub limits:** anonymous pulls are rate-limited. Default the docs to GHCR.
- **Pin third-party actions by commit SHA**, with the version in a comment (`uses: docker/build-push-action@<sha> # v7.4.0`). Tags can be moved; `trivy-action`'s were hijacked in 2026. Dependabot updates SHA pins. Pick releases at least two weeks old, as `minimumReleaseAge` does for npm.
- **The repository and `ghcr.io/proless/tazamun` are public** (since 2026-11-25). Making the repository public did **not** change the existing package: its visibility is set separately in the package settings, and until then an anonymous pull fails with `unauthorized`. `image.yml` uploads SARIF to code scanning only while the repository is public (`!github.event.repository.private`); keep that guard, since a private repository needs GitHub Advanced Security for it. The upload needs `security-events: write` on the `test` job. Without it, pull requests still pass but every push to `main` fails at "Upload to code scanning" ("Resource not accessible by integration"), and `publish` is skipped, so `edge` silently stops updating. That happened from 2026-11-25 until the job got the permission. A stale `docker login ghcr.io` also gives `unauthorized` for a public image: `docker logout ghcr.io`.
- **The smoke test** (`apps/server/test/smoke.ts`) runs on the runner, talks to the container over a random loopback port, and uses `@tazamun/core` like a real client (Argon2id included). Run it locally with `pnpm --filter @tazamun/server smoke <image>`.
- **The arm64 smoke test runs under QEMU and has failed once on a PR that didn't touch the server:** the container logged "Listening" and exited, and the re-run passed. If it fails, read the exit code, OOMKilled flag and stderr it prints (132 or 139 point at emulation, 137 with OOMKilled at the memory limit), re-run once, and investigate if it repeats.
- **Token scope:** don't give the workflow `write-all`. Use `packages: write`, `id-token: write` and `security-events: write` only on the jobs that need them, and keep the Docker Hub token out of PR workflows from forks.
- **Reverse proxies:** nginx's default `client_max_body_size` (1 MB) is below the API's 2 MB batch limit, and missing `X-Forwarded-Proto` breaks the public-URL check. Both belong in the proxy examples.

## How to work in this repository (for Claude)

- Before implementing a feature, read its SRS section and the ADRs it references. Requirements tell you **what**; ADRs tell you **why**.
- Keep the phase checklists above up to date: tick a step when it's merged, and update **Current status** when a phase's exit criteria are met.
- Put new pitfalls where they belong as you find them: in the folder's own `CLAUDE.md` if they concern one app or package, otherwise in the matching section above.
- When you add or change an app or package, update its `README.md` and `CLAUDE.md` in the same PR. When you create a new app or package, give it both files from the start, add it to the table in the root `README.md` and to the layout above, and move its pitfall section from this file into its own `CLAUDE.md`.
- If you change a rule, a command or the PR process, update [CONTRIBUTING.md](CONTRIBUTING.md) too.
- When a requirement turns out to be wrong or impossible, update the SRS in the same PR and explain why in the PR description. Use a new ADR if the change contradicts an existing one.
- Prefer pure functions in `packages/core` with tests over logic inside browser event handlers.
