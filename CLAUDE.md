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
| Requirements with IDs (`ACC-`, `ENG-`, `TAB-`, `HIS-`, `BMK-`, `EXT-`, `DSH-`, `UI-`, `IMP-`, `ADM-`, `DEP-`, `PERF-`, `SEC-`, `PRIV-`, `REL-`, `MOB-`) | [`docs/srs/`](docs/srs/) sections 1–6 |
| Design decisions and why | [`docs/adr/`](docs/adr/README.md) |
| HTTP API and record envelope | [SRS section 4.4](<docs/srs/4. External Interface Requirements.md#44-communications-interfaces>) |
| Self-hosting, container image, publishing pipeline | [SRS section 3.11](<docs/srs/3. Software Features.md#311-self-hosting-containers-and-image-publishing>), [ADR-0007](docs/adr/0007-container-distribution.md) |
| Crypto parameters and threat model | [SRS section 5.2](<docs/srs/5. Other Nonfunctional Requirements.md#52-security-requirements>), [ADR-0008](docs/adr/0008-crypto-implementation.md) (library and format v1 details) |
| How to use an app or package, and its own pitfalls | that folder's `README.md` and `CLAUDE.md` |
| Contributor process (setup, commits, PR checklist) | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Roadmap: phases, checklists, exit criteria | [docs/roadmap.md](docs/roadmap.md) |
| Known gaps, cross-cutting pitfalls | this file |

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

`ls` shows what exists. Not obvious from it: the extension's engine is in `apps/extension/src/engine/` and its data-type modules in `src/modules/<type>/`; `packages/core` has no browser APIs; the server serves the dashboard build from P3. Planned, not created yet: `apps/dashboard/` (P3, Vue 3 + Vite SPA), `packages/ui/` (shared Vue 3 components), `data/extension-equivalents.json` (P5), `deploy/k8s/` (P6, one replica + PVC), `.github/workflows/release.yml` (P6).

Each app and package has the same shape: `src/` for code, unit tests next to it as `*.test.ts`, shared fixtures and test vectors in `test/`, plus its own `package.json`, `tsconfig.json` and `vitest.config.ts`. Root config (`tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierrc.json`) applies to all of them. Create a folder only when it gets real content.

**Documentation lives next to the code.** Every app and package has:

- `README.md` for people: what it is, how to use it, its scripts and layout.
- `CLAUDE.md` for working in that folder: its rules and pitfalls. Claude Code loads it automatically when working there.

This root file keeps only what spans the repository: rules, layout, known gaps and cross-cutting pitfalls; the roadmap is in [docs/roadmap.md](docs/roadmap.md). Don't copy a package's details into it; link to the package instead.

Image: `ghcr.io/proless/tazamun` (`edge` from `main`; `X.Y.Z`, `X.Y`, `X`, `latest` from tags).

Node 26 and pnpm 12. Install pnpm with `npm install -g pnpm`, since Node 25+ no longer ships corepack. The root `package.json` scripts (`test`, `test:browser`, `lint`, `typecheck`, `format:check`, `licenses:check`) run across the workspace. Commands that aren't obvious from the scripts:

| Command | What it does |
| ------- | ------------ |
| `pnpm --filter @tazamun/core exec playwright install chromium firefox` | Needed once before `pnpm test:browser` |
| `pnpm --filter @tazamun/server dev` | Run the server locally (copy `apps/server/.env.example` to `.env` first) |
| `pnpm --filter @tazamun/server tazamun <command>` | Admin commands: invites, backup, restore, accounts ([apps/server/README.md](apps/server/README.md#admin-commands)) |
| `docker build -f deploy/docker/Dockerfile -t tazamun:test .` | Build the server image locally, for testing ([deploy/README.md](deploy/README.md)) |
| `pnpm --filter @tazamun/server smoke tazamun:test` | Container smoke test against a local image (DEP-29) |
| `pnpm --filter @tazamun/extension test:e2e` | End-to-end tests against the build: Chromium and Firefox, real server ([apps/extension/README.md](apps/extension/README.md#end-to-end-tests)) |

---

## Roadmap

The phases P0–P6, their checklists and **exit criteria** are in [docs/roadmap.md](docs/roadmap.md). Each phase ends with exit criteria; don't start the next phase until they're met. Every phase should leave something usable, so it can be dog-fooded.

---

## Known gaps (accepted for 1.0)

From [SRS 6.5](<docs/srs/6. Other Requirements.md#65-known-limitations-and-open-questions>). Don't "fix" these casually; each needs an ADR.

- Losing both the passphrase and the recovery key, with no signed-in device, means lost data. No server-side recovery is possible by design ([ADR-0010](docs/adr/0010-usernames-and-recovery-key.md)).
- A malicious server can withhold or roll back records, and can serve a backdoored dashboard.
- Account-key rotation is manual (export, new account, import).
- No sync for data without extension APIs: Firefox bookmark tags and keywords, passwords, settings. Tab groups aren't synced at all, by choice (TAB-1).
- Record sizes and timing aren't padded, so traffic analysis can reveal activity patterns.
- On mobile, only Firefox for Android, as a partial device: no history recording and no bookmarks there (no extension APIs), and background sync only while Android lets Firefox run ([ADR-0012](docs/adr/0012-firefox-for-android-in-1-0.md)). Chrome and Edge on Android can't run the extension.
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
- Pitfalls for the image, Compose files, proxies and the image pipeline are in [deploy/CLAUDE.md](deploy/CLAUDE.md). Read it before changing `deploy/` or `.github/workflows/image.yml`; it doesn't load automatically for the workflow.

## How to work in this repository (for Claude)

- Before implementing a feature, read its SRS section and the ADRs it references. Requirements tell you **what**; ADRs tell you **why**.
- Keep the phase checklists in [docs/roadmap.md](docs/roadmap.md) up to date: tick a step when it's merged, and update **Current status** when a phase's exit criteria are met.
- Put new pitfalls where they belong as you find them: in the folder's own `CLAUDE.md` if they concern one app or package, otherwise in the matching section above.
- When you add or change an app or package, update its `README.md` and `CLAUDE.md` in the same PR. When you create a new app or package, give it both files from the start, add it to the table in the root `README.md` and to the layout above, and move its pitfall section from this file into its own `CLAUDE.md`.
- If you change a rule, a command or the PR process, update [CONTRIBUTING.md](CONTRIBUTING.md) too.
- When a requirement turns out to be wrong or impossible, update the SRS in the same PR and explain why in the PR description. Use a new ADR if the change contradicts an existing one.
- Prefer pure functions in `packages/core` with tests over logic inside browser event handlers.
