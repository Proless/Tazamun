# @tazamun/extension

The Tazamun browser extension for Chrome, Edge and Firefox, built with [WXT](https://wxt.dev) and Vue 3. One codebase produces a Manifest V3 build per browser.

| Part | Status |
| ---- | ------ |
| Scaffold: three targets, manifest with permissions, CSP, Firefox ID and data-collection disclosure | Done |
| Background: opens onboarding on first install (UI-2) | Done |
| Onboarding: create an account (server, username, passphrase), sign in with the username, or recover with the recovery key; device name, remember-key choice, modules; the recovery key shown once (UI-2, ACC-1…8, ACC-13, [ADR-0010](../../docs/adr/0010-usernames-and-recovery-key.md)) | Done |
| Signed-out, revoked and locked states; unlock, sign out, sign in again, remove from this browser (ACC-11, SEC-5) | Done |
| Options page (UI-3, P1 part): username (set or change, ACC-13), new recovery key (ACC-5), rename this device, remember the key, sync status and pause, modules on or off with the PRIV-2 question, sites that never sync, devices with *Remove* (ACC-8), sign out | Done |
| Sync engine in `src/engine/`: module interface, outbox and mirror in IndexedDB, debounced push, alarm and popup pull, backoff, status, pause, per-module switches (ENG-1…14) | Done |
| Toolbar badge for error, locked and paused only (UI-6) | Done |
| Tabs module in `src/modules/tabs/`: windows and tabs of this device, private windows, privileged schemes and exclusions left out, favicons stripped, 5 s debounce (TAB-1…5) | Done |
| Popup: *Tabs on other browsers* by device and window, last seen, open one or all (TAB-6) | Done |
| Send tab: popup *Send this tab*, context menu *Send page/link to*, the target opens it in the background with a notification, the command is deleted after (TAB-7, TAB-8, UI-4) | Done |
| Icons (placeholder design) in `public/icons/` | Done |

## Development

```sh
pnpm --filter @tazamun/extension dev            # Chrome, with live reload
pnpm --filter @tazamun/extension dev:firefox    # Firefox
```

WXT opens a browser with the extension loaded and reloads it on changes. To load a production build by hand, run `pnpm --filter @tazamun/extension build`, then load `apps/extension/.output/<browser>-mv3/`: in Chrome or Edge with *Load unpacked* on the extensions page in developer mode; in Firefox with *Load Temporary Add-on* on `about:debugging`.

## Scripts

Run from the repository root with `pnpm --filter @tazamun/extension <script>`:

| Script | What it does |
| ------ | ------------ |
| `dev` · `dev:firefox` | Development build with live reload in Chrome · Firefox |
| `build` | Production builds for Chrome, Edge and Firefox into `.output/` |
| `build:chrome` · `build:edge` · `build:firefox` | One target |
| `zip` | Store packages for all three targets |
| `lint:firefox` | Mozilla's `web-ext lint` on the Firefox build, as AMO runs it (build first) |
| `typecheck` | `wxt prepare`, then `vue-tsc` over the TypeScript and `.vue` files |
| `test:e2e` | End-to-end suite against the built extension (build first), see below |

Tests run with the rest of the workspace (`pnpm test`, project `extension`), in Node against WXT's in-memory fake browser.

### End-to-end tests

`e2e/` drives the built extension in two real browsers against the real server (a child process with a temporary data directory) and a tiny local website, so nothing reaches the internet:

```sh
pnpm --filter @tazamun/extension build
pnpm --filter @tazamun/extension test:e2e
```

Browser A is Chromium (Playwright; once: `pnpm --filter @tazamun/extension exec playwright install chromium`). Browser B is the installed Firefox, driven through WebDriver BiDi; set `FIREFOX_BINARY` if it isn't found, or `E2E_BROWSER_B=chromium` to use a second Chromium profile instead. The scenarios share one account, in order:

| Scenario | Requirements |
| -------- | ------------ |
| Create the account on A (username, recovery key shown), sign B in with the username | SRS 3.1, ACC-1…7, ACC-13 |
| Each browser's tabs appear in the other's popup, with the device name | TAB-1, TAB-6 |
| Send a tab A → B and B → A from the popup | TAB-7, PERF-2 |
| Kill the server, change tabs, restart: the change arrives, nothing pending | REL-3 |
| A removes B; B shows the revoked state and keeps its account data | ACC-8, ACC-11 |
| B recovers with the recovery key and a new passphrase; A is signed out | ACC-5 |
| The server log holds no URLs, titles, usernames or keys | rule 5 |

CI runs it on every pull request (job *End to end*), with the runner's Firefox.

## Accounts on this device

The flows come from `@tazamun/core` (`account`, `api`); `src/account/` adds the browser around them:

| What | Where it's kept |
| ---- | --------------- |
| Server URL, account ID, username, device ID and name, session token | `storage.local` `account`. After sign-out or revocation only the token goes; the rest stays, so signing in again needs only the passphrase (ACC-11). |
| Account key | `storage.local` with *Remember the key on this device* on (the default), otherwise `storage.session`, which the browser clears when it closes; the extension is then *locked* until the passphrase is entered (SEC-5). |
| Remember-key choice and modules | `storage.local` `settings` |

The passphrase, the recovery key, the KEKs and the auth keys are never stored; the recovery key is shown once and dropped from the page when the user confirms it is saved. A browser profile holds one account (ACC-12); the welcome page warns before a profile that had an account is connected to another, and suggests a separate profile to keep both. The host permission is requested for the server's host only, when the user continues from the server step. A 401 from the server means the device was revoked, or the passphrase was changed or recovered elsewhere: the extension drops the token and key and shows the revoked state. Accounts created before usernames have none; the options page asks for one, since without it no new browser can sign in.

## Sync engine

`src/engine/` is generic: it never looks inside a record's data (rule 2). A data type is a module (`src/engine/module.ts`, ENG-1) registered in `src/modules/index.ts`:

| Module member | What it does |
| ------------- | ------------ |
| `collection` | The collection schema from `@tazamun/core`; its `version` is the module's schema version |
| `detectLocalChanges(ctx)` | Diff the browser against the mirror (`ctx.mirror`) and return what changed; nothing if nothing did |
| `merge(local, remote)` | Pure, from `@tazamun/core` `merge` |
| `apply(records)` | Bring the browser in line with records that changed through a pull; idempotent |

One run (`engine.ts`): detect, encrypt and queue local changes; push the outbox in batches; `GET /v1/info`; pull only collections whose high-water mark moved; decrypt, validate, merge, apply, then save `lastSeq`; push merge results that differ from the server. Every step is one atomic IndexedDB commit (`idb-store.ts`), so a killed service worker resumes without losing or doubling anything.

| When it syncs | How |
| ------------- | --- |
| Every minute | the `tz-poll` alarm |
| On startup, install, sign-in, unlock, resume, module switch | runtime events and storage changes |
| When the popup opens, or *Sync now* | a message from the page |
| 2 s after a module reports a change | debounce |
| After a failure | backoff with jitter, 1 s to 15 min (`tz-retry` alarm, plus a timer below 30 s) |

The status (state, error code, last sync, pending count; never content or IDs) is in `storage.local` `engineStatus` for the pages. *Remove the account from this browser* also clears the engine's IndexedDB. A sign-in to another account clears it too, before anything is merged or pushed.

## Manifest and permissions

[`src/manifest.ts`](src/manifest.ts) defines the manifest per browser ([SRS 2.7](<../../docs/srs/2. Overall Description.md#27-design-and-implementation-constraints>)):

| | Permissions | Why |
| - | ----------- | --- |
| Required | `tabs`, `storage`, `unlimitedStorage`, `alarms`, `notifications`, `contextMenus` | Tabs sync and send tab (P1), settings and the outbox, the sync poll |
| Optional, asked when a module is turned on | `history` (P2), `bookmarks` (P4), `management` (P5) | Requested only from users who use them |
| Optional host | `https://*/*`, `http://localhost/*`, `http://127.0.0.1/*` | Granted for the one server origin the user enters |

The CSP is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'`: WASM for Argon2id is the only relaxation. Firefox gets the fixed add-on ID `tazamun@proless.github.io`, a minimum version of 140, and its data-collection disclosure: tabs and history as `browsingActivity` (required), bookmarks and the extension list as optional.

## Dependencies

| Package | Why |
| ------- | --- |
| `vue` | UI for the popup, options and onboarding pages (SRS 4.3.2) |
| `zod` | Schemas from `@tazamun/core`, in jitless mode for the CSP |
| `@tazamun/core` | Crypto, HLC and schemas, shared with the server and dashboard |

Development only: `wxt` and `@wxt-dev/module-vue` (build, dev server, fake browser for tests), `vue-tsc` (type-checks `.vue` files), `web-ext` (Mozilla's linter) `fake-indexeddb` (runs the IndexedDB store's tests in Node) and `playwright` (the end-to-end tests).

## Layout

```text
wxt.config.ts            WXT configuration; takes the manifest from src/manifest.ts
vitest.e2e.config.ts     the end-to-end project (not part of pnpm test)
e2e/                     drivers (Chromium, Firefox over BiDi), server and site, flows, scenarios
public/_locales/en/      messages.json: every UI string and the store name and description
public/icons/            16, 32, 48, 128 px PNG (placeholder design)
src/
  manifest.ts            manifest per browser: permissions, CSP, Firefox settings
  entrypoints/           one folder or file per extension entry point (WXT convention)
    background.ts        registers listeners at the top level
    popup/               toolbar popup (UI-1)
    onboarding/            form validation and error messages for the onboarding page
  options/               options page logic: rename, revoke, modules (PRIV-2), exclusion list             options page (UI-3)
    onboarding/          unlisted page opened on install (UI-2)
  background/            background logic: install, sync scheduling, context menus (tested)
  engine/                sync engine: module interface, engine, IndexedDB and memory stores,
                         timing and batching policy, status; testing.ts: fake server and module
  modules/               index.ts registers the data-type modules; tabs/ (snapshot, module, view,
                         open); commands/ (send tab: module, send rules, receiving)
  account/               storage (store.ts), sign-in flows with the browser (session.ts),
                         device identity, recovery key document
  onboarding/            form validation and error messages for the onboarding page
  components/            shared Vue components (RecoveryKey.vue, SignedInSettings.vue, …)
  lib/                   startup (jitless zod), i18n, page mounting, download, shared CSS
```

Each data type gets `src/modules/<type>/` ([ADR-0001](../../docs/adr/0001-one-product-module-architecture.md)).
