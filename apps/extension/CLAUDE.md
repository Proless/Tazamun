# CLAUDE.md: apps/extension

Read this before changing anything in `apps/extension`. The repository-wide rules in the [root CLAUDE.md](../../CLAUDE.md) still apply (especially rules 2, 4, 5 and 7); usage and layout are in [README.md](README.md).

## Rules for this app

1. **The manifest is `src/manifest.ts`**, a pure function per browser with tests. Never edit permissions, the CSP or the Firefox settings anywhere else, and update `manifest.test.ts` with every change. Adding a **required** permission makes Chrome disable the extension for existing users until they accept it: prefer optional permissions requested when the user turns a feature on.
2. **The CSP allows `'wasm-unsafe-eval'` and nothing else** (SRS 2.7). No `'unsafe-eval'`, no `'unsafe-inline'`, no remote sources, no remotely hosted code. A test enforces it.
3. **Never change `FIREFOX_ADDON_ID`** once the extension is on AMO. Every version, review and user is tied to it.
4. **Explicit imports, no auto-imports** (`imports: false` in `wxt.config.ts`): `import { browser } from 'wxt/browser'`, `import { defineBackground } from 'wxt/utils/define-background'`. Every file says where its names come from, and type-aware ESLint can check it.
5. **Logic lives in `.ts` files, not in `.vue` files.** ESLint doesn't parse `.vue` files yet, and pure functions are unit-tested in Node with the fake browser. Components call into `src/lib/` or later `src/engine/` and `src/modules/<type>/`.
6. **Pass `browser` in, don't import it in logic.** Functions such as `onInstalled(browser, details)` take the browser as a parameter, so tests pass `wxt/browser` (the fake browser under Vitest) and nothing reaches for globals.
7. **All UI text comes from `public/_locales/en/messages.json`** through `t()` (SRS 6.3), with a `description` for translators. Layouts use logical CSS properties (`margin-inline`, `padding-block`, `inline-size`), so right-to-left languages need no extra rules. Each page sets `lang` and `dir` through `mountPage`. Dates and times use `uiLocale()` (the `uiLocale` message, which each translation sets to its own code), never `getUILanguage()`: the browser's language differs from the loaded text whenever Tazamun has no translation for it, and the page would mix German dates into English text.
8. **Every entry point calls `startup()` first** (pages through `mountPage`, the background directly), which sets zod to jitless mode before any parse.
9. **Never store the passphrase, the KEK or the auth key**, not even in `storage.session`. Only the account key (where SEC-5 says) and the session token are kept, in `src/account/store.ts` only. Clear the passphrase fields once a flow finishes.
10. **Never capture private or incognito browsing** (rule 7), and never log URLs, titles, keys or tokens (rule 5), not even in development builds.

## Pitfalls

### WXT
- The public folder is `apps/extension/public/` (next to `package.json`), not `src/public/`, even with `srcDir: 'src'`. Files in the wrong place are silently left out of the build. Without `_locales` the extension doesn't load at all, which `web-ext lint` reports as `NO_MESSAGES_FILE`.
- `wxt prepare` generates `.wxt/` (tsconfig, types, the `_locales` key types). It runs on `pnpm install` (postinstall) and before `typecheck`. After adding a message, rerun it, or `t('newKey')` is a type error.
- WXT copies the popup's `<title>` into `action.default_title` (the toolbar tooltip), so the popup's `<title>` is `__MSG_extName__`. A `manifest.default_title` meta tag is ignored.
- The tsconfig extends the repository base **and** `.wxt/tsconfig.json`; WXT's settings (bundler resolution, DOM lib) win where they overlap.
- `fakeBrowser.reset()` leaves one blank tab open. Compare against the tabs that existed before, as `install.test.ts` does.

### Accounts and permissions
- **`permissions.request` must run before the first `await` in a click handler.** Browsers grant it only during a user gesture, and an `await` ends the gesture. `submitServer` in the onboarding page parses the URL synchronously, calls `requestServerPermission`, then awaits. Keep that order.
- Match patterns have no port, and Firefox rejects one: request `http://localhost/*`, not `http://localhost:8080/*` (`account.hostPermissionPattern`).
- Headless Chromium can't click the permission prompt. For an end-to-end run, load a copy of the build whose manifest already grants `http://localhost/*`; Chrome then answers `permissions.request` without a prompt.
- `/v1/info` with a revoked token is a 401, not an anonymous answer. `refreshAccountState` treats both as signed out, and treats network errors as *still signed in* (offline isn't signed out).
- Keep the device ID across sign-outs: tabs and extension records use it as their record ID, so a new ID would leave the old records behind as a ghost device.
- WXT's fake browser doesn't implement `i18n`, `permissions` or `runtime.getPlatformInfo`. Tests that reach them assign a stub (`fakeBrowser.i18n.getMessage = …`) or keep those calls out of the tested function.

### Sync engine
- **The engine is generic** (rule 2). If a change to `src/engine/` mentions tabs, URLs or any field of `data`, it belongs in a module instead.
- **One atomic commit per step.** Mirror, outbox and `lastSeq` for a pulled page go into one `store.commit`, after `module.apply`. Saving `lastSeq` earlier skips records forever after a crash; applying after the commit loses them.
- **Nothing may `await` inside an IndexedDB transaction**; it commits as soon as no request is pending. Encrypt first, then commit. A `put` can also throw synchronously (a value that can't be cloned): `IdbStore.commit` then aborts the transaction, or the other writes would commit alone. A test covers it.
- **Outbox entries carry a `rev`.** A push confirmation deletes an entry only if `rev` still matches, so a change queued while that record's push was in flight survives.
- `detectLocalChanges` must return nothing when nothing changed. Re-stamping an unchanged record pushes on every alarm and breaks PERF-5 (one `GET /v1/info` per idle period; a test checks it).
- A different account or server in the session clears the store first (`meta.owner`). Outbox entries are encrypted for one account and must never reach another.
- `alarms.create` with an existing name resets that alarm's schedule. Create the poll only if `alarms.get` finds none, or every worker wake-up postpones it.
- `runtime.onMessage` in Chrome needs `sendResponse` plus `return true`. WXT uses the plain `chrome` API there, without a promise polyfill, so a returned promise doesn't reach the page.
- The background listens to `storage.onChanged` for `account`, `accountKey` and `settings`. The engine writes only `engineStatus`, so it never triggers itself; keep it that way.
- Engine tests use `FakeServer` and `FakeTabsModule` from `src/engine/testing.ts`. Module tests should use them too: they speak the real wire format through `@tazamun/core`'s schemas.

### Tabs module
- `detectLocalChanges` reads `windows.getAll({ populate: true, windowTypes: ['normal'] })` every time; the events registered in `watch` only say "look again" (rule 4). Missed events during suspension are caught by the next alarm.
- Incognito is filtered twice, per window and per tab (rule 7), and windows left empty aren't published, so not even the number of private windows leaks.
- Other devices' tabs are never written to the browser (`apply` is empty); the popup reads them from the mirror with `readMirror`. Never open them automatically (SRS 3.3).
- The popup must not load favicon URLs from tab records: that is a request to a third-party site (PRIV-4).
- WXT's fake browser doesn't populate `windows.getAll` with tabs. Tests replace `fakeBrowser.windows.getAll` with their own windows.

### Options page
- Turning a module off asks first (PRIV-2): *Turn off and delete* sends a `retire` message; the engine asks the module's `retire()` for the deletions and publishes them even though the module is now skipped. The question is inline, not `window.confirm`, because it has three answers.
- Revoking another device is possible here because the dashboard comes only in P3. Never offer it for this device; signing out is the way.
- Renaming updates the server first, then the stored name and the device cache, so the context menu and notifications pick it up.

### Send tab (commands module)
- Sending goes through the background (`send-tab` message, `BackgroundSync.sendTab`), which queues the command in `storage.local`. `detectLocalChanges` publishes queued commands and drops a queue entry only once the record is in the mirror (committed), so a crash publishes it again rather than losing it. Deletions after opening use the same pattern.
- `apply` opens each command for this device at most once (`commandsDone`), because a page is applied again after a crash (REL-2). Never move the "done" write before the open: a crash would then lose the tab.
- Validate the URL in the background too, not only in the popup: messages are input. Only `http:` and `https:` pages are sent, never from incognito tabs (rule 7).
- The service worker has no clipboard (Chrome would need an offscreen document), so the receiving side shows a refused URL in the notification instead of copying it.
- `contextMenus.create` reports errors through its callback and `runtime.lastError`; read it there, or Chrome logs "Unchecked runtime.lastError". Rebuild menus with `removeAll` first: items persist across service-worker restarts, and creating an existing ID fails.
- Chrome requires `iconUrl` for notifications; it uses `ICONS` from `src/manifest.ts`. A test checks every icon file exists.

### MV3 and extension lifecycle
- The Chrome service worker is **killed after about 30 s idle**; Firefox uses an event page (WXT builds `background.scripts` for Firefox and `background.service_worker` for Chromium). Any state in a module-level variable can vanish. Persist to IndexedDB or `storage`, and design every step to be resumable and idempotent.
- `setTimeout`/`setInterval` don't survive suspension. Use `browser.alarms` (Chrome minimum 30 s; Tazamun's default is 60 s).
- Register event listeners **synchronously at top level** of the background script, or events that wake the worker are missed. Await inside the listener, never before `addListener`.
- No WebSockets or SSE that need to stay open. Polling `/v1/info` is the design ([ADR-0003](../../docs/adr/0003-sync-protocol-records-hlc.md)).
- `storage.local` is 10 MB without `unlimitedStorage`. Put history and snapshots in IndexedDB.
- WASM (Argon2id) needs `'wasm-unsafe-eval'` in the CSP; it's there from day one.
- zod compiles parsers with `new Function` unless `z.config({ jitless: true })` runs first; `startup()` does it. Without it, every parse logs a CSP violation ([packages/core/CLAUDE.md](../../packages/core/CLAUDE.md#schemas)).
- Argon2id with 64 MiB is slow on purpose (about 0.5–1 s). Run it only at sign-in and unlock, never per sync.

### Cross-browser differences
- `browser.*` (promise-based) vs `chrome.*`: use WXT's `browser` everywhere.
- Different bookmark root IDs; roots are read-only; Chromium has no separators; Edge calls bookmarks "Favorites". See BMK-3.
- Firefox refuses `tabs.create` for privileged URLs (`about:config` and others) and restricts `file:`. Fall back to copying the URL (TAB-8).
- Firefox's `management.getAll()` returns add-on IDs, not store slugs.
- Chrome's `history.addUrl` can't set title or time. That's one reason history isn't written back ([ADR-0005](../../docs/adr/0005-history-stored-in-extension.md)).
- The manifest asks for `contextMenus` on all browsers; Firefox accepts it as an alias of `menus`. Tab group APIs differ.
- Test **every** change on Firefox too. The Chromium end-to-end setup is easier to automate, so Firefox regressions slip through.

### Store publishing
- AMO requires source code and build instructions for bundled code. Keep builds reproducible from the start (lockfile, `pnpm --filter @tazamun/extension build`).
- **Firefox data-collection consent:** new add-ons must declare `data_collection_permissions` (Firefox 140+, hence `strict_min_version: 140.0`). Sending data to the user's own server counts as collection even though it is encrypted, so tabs and history are declared as `browsingActivity`. Re-check the categories against Mozilla's policy before every AMO submission. `web-ext lint` warns that Firefox for Android can't use the key; the extension is desktop-only.
- `web-ext lint` warns about an `innerHTML` assignment inside Vue's runtime. That's Vue's own code, not ours; reviewers know it. Never write `innerHTML` (or `v-html`) in our code.
- `web-ext lint` also reports `DANGEROUS_EVAL` for zod's `allowsEval` probe (`Function('')` inside a `try`). With `z.config({ jitless: true })` the probe returns before reaching it, so it never runs and the CSP stays quiet. Mention both in the AMO reviewer notes.
- Store reviewers will question `history`, `tabs`, `management` and `bookmarks`. Keep the justifications ready (the comments in `src/manifest.ts` are the start), and request host permission only for the user's server URL.
- Extension updates reach users over days. The server must stay compatible with at least the previous client version (`minClientVersion`).
