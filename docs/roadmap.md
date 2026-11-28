# Roadmap

The phases of Tazamun 1.0, each with its checklist and exit criteria. Tick a step when it is merged. [CLAUDE.md](../CLAUDE.md) holds the current status; requirement IDs refer to the [SRS](srs/).

Rough estimates assume one developer working evenings. Each phase ends with **exit criteria**; don't start the next phase until they're met. Every phase should leave something usable, so it can be dog-fooded.

## P0: Foundations (1–2 weeks)

- [x] Set up the pnpm workspace with the layout above. TypeScript strict mode, ESLint and Prettier, Vitest.
- [x] GitHub Actions: lint, type-check, tests, dependency audit, license check on every PR.
- [x] Renovate or Dependabot configured for npm, GitHub Actions and Docker base-image digests (DEP-37).
- [x] `packages/core/crypto`: Argon2id (WASM), HKDF, AES-GCM wrap and unwrap, payload encrypt and decrypt with AAD. **Test vectors** committed. *(Library choice and format details: [ADR-0008](adr/0008-crypto-implementation.md).)*
- [x] `packages/core/hlc`: HLC with tests (monotonic, clock skew, comparison including device ID).
- [x] `packages/core/schema`: record envelope plus a payload schema per collection (zod), with schema versions. *(`bookmarks` follows in P4. No `devices` collection: names are plaintext, ADR-0009.)*
- [x] Settle Q1 (server framework and SQLite driver) and record it in ADR-0004. *(Hono and `node:sqlite`.)*
- [x] Write `CONTRIBUTING.md` and a short README "How it works" section linking the SRS.

**Exit:** CI green. Crypto round-trips and test vectors pass in Node **and** in a browser (Vitest browser mode or Playwright).

## P1: Engine, server, accounts, tabs (4–6 weeks): first usable version

- [x] **Server:** accounts, prelogin, sessions, devices, collections (pull and push), `/v1/info`, `/v1/health`, quotas, rate limits, registration modes and invite CLI, migrations (ADM-1…4, ADM-7).
- [x] **Server config:** one validated schema for `TAZAMUN_*` variables, `*_FILE` secrets, the `TAZAMUN_PUBLIC_URL` HTTPS check, a config reference generated from the schema (DEP-12…15).
- [x] **Admin CLI:** `invite`, `backup`, `restore`, `migrate --status`, `accounts`, `version`, `healthcheck` (DEP-16). Automatic backup before migrating (DEP-24, DEP-25).
- [x] **Container image:** multi-stage Dockerfile, non-root UID 10001, read-only root filesystem, `/data` volume, `HEALTHCHECK`, correct signal handling, JSON logs, OCI labels, instance secret generated on first start (DEP-1…11).
- [x] **Compose files:** `docker-compose.yml` and `docker-compose.caddy.yml` with `.env.example` and resource limits. Reverse-proxy docs for Caddy, Traefik and nginx. Warning about local storage and a single instance (DEP-17…19, DEP-22).
- [x] **CI image pipeline:** build on every PR plus a container smoke test (health, API suite, SIGTERM, restart persistence); vulnerability scan; multi-arch with Buildx; publish `edge` and `sha-*` to GHCR from `main` with minimal token permissions (DEP-28…30, DEP-33, DEP-34, DEP-38).
- [x] **Extension scaffold:** WXT with three targets. Fixed Firefox add-on ID. CSP with `'wasm-unsafe-eval'`. Permissions as in SRS 2.7.
- [x] **Onboarding:** create or connect an account, recovery kit, device registration (ACC-1…8, ACC-11, UI-2). *(Since [ADR-0010](adr/0010-usernames-and-recovery-key.md): usernames for signing in and a recovery key that sets a new passphrase, instead of the recovery kit and pairing code; ACC-5, ACC-13.)*
- [x] **Engine:** outbox in IndexedDB, debounced push, alarm and popup-triggered pull, backoff, status, pause, per-module toggles (ENG-1…14). Clock warnings (ENG-15). Recovery after a server restore through a data generation (ENG-16).
- [x] **Module interface** plus an in-memory fake browser for tests. *(WXT's fake browser, plus `FakeServer` and `FakeTabsModule` in `apps/extension/src/engine/testing.ts`.)*
- [x] **Tabs module:** publish windows and tabs; incognito, scheme and exclusion filtering; strip favicons (TAB-1…6). *(Private windows are an opt-in per browser since [ADR-0011](adr/0011-private-browsing-choice-and-no-send-tab.md).)*
- [x] **Recently closed tabs and live state:** closed tabs, including a closed last window, move to a per-device list (50, 7 days); devices not seen for 10 minutes show *open when last seen* (TAB-10, TAB-11).
- [x] ~~**Send tab** through the `commands` collection, plus notifications and the context menu (TAB-7, TAB-8, UI-4).~~ *(Built, then removed by ADR-0011; TAB-8 stays for opening tabs from the popup.)*
- [x] **Popup:** status, other devices' tabs (UI-1), checked every 5 s while open (PERF-1). **Options page:** basics (UI-3).
- [x] End-to-end test: two Chromium profiles and one server in Playwright; Firefox through `web-ext run`. *(Chromium A through Playwright and the installed Firefox B through WebDriver BiDi, against the real server; `web-ext run` can't drive pages. Runs in CI.)*
- [x] Settle Q2 (encrypt device names?) and Q3 (default for remembering the key). *(Plaintext names; remember by default: [ADR-0009](adr/0009-device-names-and-key-storage.md).)*

**Exit:** you use it daily on 3 browsers for a week, **against your own instance running the published `edge` image with `docker-compose.caddy.yml`**. A fresh VPS goes from nothing to a healthy HTTPS instance in under 10 minutes by following the docs. PERF-1 is met. Killing the server or the service worker mid-sync loses nothing (REL-3). **You uninstall your current tab tool.**

## P2: History and Firefox for Android (5–7 weeks)

- [ ] **Android spike first** on a real phone: add `gecko_android.strict_min_version: 142.0`, check `web-ext lint` is clean and AMO accepts an unlisted test version; then `tabs` events, alarms in the background, private tabs, `management`, Argon2id time. Record the results in SRS 3.12 ([ADR-0012](adr/0012-firefox-for-android-in-1-0.md); MOB-1, MOB-8, MOB-10).
- [ ] Module capabilities (write, read, none), detected from the APIs present; generic handling in the engine and options page (MOB-2, MOB-6).
- [ ] Tabs without `windows`: one window from `tabs.query`, `tabs` events only, open a window's tabs one by one (MOB-3, MOB-4).
- [ ] Popup, options page and onboarding at 360 px and by touch (MOB-7). Kill and resume on Android loses nothing (MOB-9).
- [ ] History record IDs via HMAC of the normalized URL (HIS-1). Write the **URL normalization** rules down and test them (see the pitfalls below).
- [ ] Payload with capped visits and union merge, with property tests (HIS-2).
- [ ] Chunked first import with progress UI; `onVisited` capture (HIS-3, HIS-4, PERF-3).
- [ ] Filters for exclusions and schemes, and private windows only when the user turns that on (HIS-5, PRIV-1, PRIV-3).
- [ ] Retention and `expiresAt`; tombstones; propagating native deletions; the "clear all" prompt (HIS-7…10).
- [ ] Local IndexedDB index and search; popup search; `tz` address-bar keyword (HIS-11, HIS-12, UI-5).
- [ ] Read-only history on Firefox for Android: pull, index and search other browsers' history (MOB-5).
- [ ] Manual Android release checklist written down (MOB-10).

**Exit:** searching history from any browser finds pages visited in the others, **including from Firefox for Android**. 100k entries search within 200 ms. Clearing a browser's history doesn't wipe synced history. A week of daily use with a phone: its tabs show on the desktops and theirs on it. **You uninstall your current history tool, if any.**

## P3: Dashboard, "the one place" (3–4 weeks)

- [ ] Vue SPA served by the server. Sign-in with in-page key derivation; idle lock (DSH-1).
- [ ] Overview, Tabs, History pages. Decryption and indexing in a Web Worker, cached in IndexedDB (DSH-2…4).
- [ ] Settings: devices (rename, revoke), passphrase change by re-wrapping, username, new recovery key, JSON export, account deletion (DSH-7, ACC-9, ACC-10, IMP-1).
- [ ] Security headers and CSP (SEC-8). Responsive layout (DSH-8). Stale-device handling (TAB-9).

**Exit:** a fresh user goes from install to seeing a second browser's tabs and history in the dashboard in under 5 minutes, without docs.

## P4: Bookmarks (6–8 weeks): the hardest part

- [ ] Read [ADR-0006](adr/0006-bookmark-safety.md) again first.
- [ ] Node record, GUID-to-native-ID map, canonical roots, fractional positions (BMK-1…4). Settle Q5.
- [ ] Merge: last writer wins per field, edit wins over delete, cycle repair, orphan recovery. **Property-based tests with 2–3 simulated devices must converge with no cycles and no lost nodes** (BMK-5…7, REL-6).
- [ ] Reconcile by diffing against the mirror; echo suppression; the post-apply diff must be empty (BMK-9, BMK-10).
- [ ] Snapshots, restore UI, HTML export and import (BMK-12, IMP-2, IMP-3).
- [ ] Mass-deletion guard (BMK-13). Vendor-sync warning (BMK-14). Skip managed nodes (BMK-15). Separators (BMK-8).
- [ ] First-sync modes with matching heuristics (BMK-11).
- [ ] Dashboard Bookmarks page (DSH-5).
- [ ] Test on real, large, messy bookmark sets (5,000+ nodes, duplicates, deep nesting, Firefox menu folder, Edge "Favorites").

**Exit:** two weeks of daily use across Firefox and Chromium with zero data loss and zero duplicates. Restoring a snapshot works. **You uninstall floccus or your current bookmark syncer.**

## P5: Extension inventory (about 2 weeks)

- [ ] `extensions` record per device; flags for development and admin installs (EXT-1, EXT-2).
- [ ] `data/extension-equivalents.json` with a schema, CI validation, and about 50 popular extensions seeded (EXT-4).
- [ ] Table view in the dashboard and options page; store links or search fallback (EXT-3, EXT-5, DSH-6).
- [ ] "Suggest a mapping" GitHub issue template (EXT-7).

**Exit:** the table correctly shows what's missing where for your own setup.

## P6: 1.0 release hardening (2–3 weeks)

- [ ] Security review of crypto and protocol (SEC-10). Fix findings.
- [ ] Privacy policy (PRIV-5) and a template for instance operators.
- [ ] Store listings: Chrome Web Store, Edge Add-ons, AMO (with source upload, marked compatible with Firefox for Android, MOB-11). Permission justifications.
- [ ] Documentation: user quick start, FAQ, self-hosting, backup and restore (ADM-6), upgrade notes.
- [ ] Health and metrics (ADM-5). Import into an empty account (IMP-4).
- [ ] **Release workflow** on `vX.Y.Z` tags: SemVer image tags (pre-releases never move `latest`), Docker Hub mirror, keyless cosign signing, SBOM and provenance attestations, store packages and AMO source archive attached to the GitHub release, changelog (DEP-31, DEP-32, DEP-35, DEP-36, DEP-39).
- [ ] Document `cosign verify` with the expected identity and issuer (DEP-36).
- [ ] Test the deployment on Docker plus Compose v2 **and** rootless Podman. Example Kubernetes manifests. Notes for running without containers (DEP-20, DEP-21, DEP-23).
- [ ] Upgrade policy and compatibility: any 1.x to any later 1.x; server accepts the previous minor client version (DEP-26, DEP-27). Test an upgrade from the previous release's image on a populated `/data`.
- [ ] Announce: Show HN, r/selfhosted, r/firefox, r/chrome. Collect feedback to decide what comes after 1.0.

**Exit:** v1.0.0 tagged and published in all three stores, and as a signed multi-arch image on GHCR and Docker Hub that passes `cosign verify`.

## After 1.0 (backlog, in rough priority order)

Helm chart · push notifications instead of polling · key rotation · reading list / saved-for-later · WebDAV or S3 storage backends (Q6) · Arabic translation (right-to-left) · padding records to hide sizes · signed record history (detect rollbacks) · Safari (only if its extension APIs allow it).

