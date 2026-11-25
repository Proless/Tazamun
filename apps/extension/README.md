# @tazamun/extension

The Tazamun browser extension for Chrome, Edge and Firefox, built with [WXT](https://wxt.dev) and Vue 3. One codebase produces a Manifest V3 build per browser.

| Part | Status |
| ---- | ------ |
| Scaffold: three targets, manifest with permissions, CSP, Firefox ID and data-collection disclosure | Done |
| Background: opens onboarding on first install (UI-2) | Done |
| Popup, options and onboarding pages (placeholders, localized, right-to-left ready) | Done |
| Onboarding: create or connect an account, recovery kit, device registration (ACC-1…8, ACC-11) | Next |
| Sync engine in `src/engine/` (ENG-1…14) | P1 |
| Tabs module in `src/modules/tabs/`, send tab, context menu (TAB-1…8, UI-4) | P1 |

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

Tests run with the rest of the workspace (`pnpm test`, project `extension`), in Node against WXT's in-memory fake browser.

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

Development only: `wxt` and `@wxt-dev/module-vue` (build, dev server, fake browser for tests), `vue-tsc` (type-checks `.vue` files) and `web-ext` (Mozilla's linter).

## Layout

```text
wxt.config.ts            WXT configuration; takes the manifest from src/manifest.ts
public/_locales/en/      messages.json: every UI string and the store name and description
src/
  manifest.ts            manifest per browser: permissions, CSP, Firefox settings
  entrypoints/           one folder or file per extension entry point (WXT convention)
    background.ts        registers listeners at the top level
    popup/               toolbar popup (UI-1)
    options/             options page (UI-3)
    onboarding/          unlisted page opened on install (UI-2)
  background/            background logic, as functions that take `browser` (tested)
  lib/                   startup (jitless zod), i18n, page mounting, shared CSS
```

Planned: `src/engine/` for the sync engine and `src/modules/<type>/` for each data type ([ADR-0001](../../docs/adr/0001-one-product-module-architecture.md)).
