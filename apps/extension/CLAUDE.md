# CLAUDE.md: apps/extension

Read this before changing anything in `apps/extension`. The repository-wide rules in the [root CLAUDE.md](../../CLAUDE.md) still apply (especially rules 2, 4 and 5); usage and layout are in [README.md](README.md).

## Rules for this app

1. **The manifest is `src/manifest.ts`**, a pure function per browser with tests. Never edit permissions, the CSP or the Firefox settings anywhere else, and update `manifest.test.ts` with every change. Adding a **required** permission makes Chrome disable the extension for existing users until they accept it: prefer optional permissions requested when the user turns a feature on.
2. **The CSP allows `'wasm-unsafe-eval'` and nothing else** (SRS 2.7). No `'unsafe-eval'`, no `'unsafe-inline'`, no remote sources, no remotely hosted code. A test enforces it.
3. **Never change `FIREFOX_ADDON_ID`** once the extension is on AMO. Every version, review and user is tied to it.
4. **Explicit imports, no auto-imports** (`imports: false` in `wxt.config.ts`): `import { browser } from 'wxt/browser'`, `import { defineBackground } from 'wxt/utils/define-background'`. Every file says where its names come from, and type-aware ESLint can check it.
5. **Logic lives in `.ts` files, not in `.vue` files.** ESLint doesn't parse `.vue` files yet, and pure functions are unit-tested in Node with the fake browser. Components call into `src/lib/` or later `src/engine/` and `src/modules/<type>/`.
6. **Pass `browser` in, don't import it in logic.** Functions such as `onInstalled(browser, details)` take the browser as a parameter, so tests pass `wxt/browser` (the fake browser under Vitest) and nothing reaches for globals.
7. **All UI text comes from `public/_locales/en/messages.json`** through `t()` (SRS 6.3), with a `description` for translators. Layouts use logical CSS properties (`margin-inline`, `padding-block`, `inline-size`), so right-to-left languages need no extra rules. Each page sets `lang` and `dir` through `mountPage`. Dates and times use `uiLocale()` (the `uiLocale` message, which each translation sets to its own code), never `getUILanguage()`: the browser's language differs from the loaded text whenever Tazamun has no translation for it, and the page would mix German dates into English text.
8. **Every entry point calls `startup()` first** (pages through `mountPage`, the background directly), which sets zod to jitless mode before any parse.
9. **Never store the passphrase, the recovery key, a KEK or an auth key**, not even in `storage.session`. Only the account key (where SEC-5 says) and the session token are kept, in `src/account/store.ts` only. Clear the passphrase and recovery-key fields once a flow finishes; the recovery key shown after sign-up leaves the page when the user confirms it is saved.
10. **Private and incognito windows stay out unless the user turned them on** for that module on this browser (`settings.includePrivate`, off by default, [ADR-0011](../../docs/adr/0011-private-browsing-choice-and-no-send-tab.md)). Never log URLs, titles, keys or tokens (rule 5), not even in development builds.

## Pitfalls

### WXT
- The public folder is `apps/extension/public/` (next to `package.json`), not `src/public/`, even with `srcDir: 'src'`. Files in the wrong place are silently left out of the build. Without `_locales` the extension doesn't load at all, which `web-ext lint` reports as `NO_MESSAGES_FILE`.
- `wxt prepare` generates `.wxt/` (tsconfig, types, the `_locales` key types). It runs on `pnpm install` (postinstall) and before `typecheck`. After adding a message, rerun it, or `t('newKey')` is a type error.
- WXT copies the popup's `<title>` into `action.default_title` (the toolbar tooltip), so the popup's `<title>` is `__MSG_extName__`. A `manifest.default_title` meta tag is ignored.
- The tsconfig extends the repository base **and** `.wxt/tsconfig.json`; WXT's settings (bundler resolution, DOM lib) win where they overlap.
- `fakeBrowser.reset()` leaves one blank tab open. Compare against the tabs that existed before, as `install.test.ts` does.

### Accounts and permissions
- **Recovery ends every session, this browser's included.** `recoverAccount` sets the new passphrase (all sessions end, ACC-9), then signs in again. Other browsers get 401 and show the revoked state, whose text covers "removed or passphrase changed". Don't try to keep their sessions.
- During recovery, `INVALID_CREDENTIALS` means a wrong recovery key or username, not a wrong passphrase; `errorKey(err, 'recover')` maps it. Pass the mode.
- The stored `username` is optional: accounts from before ADR-0010 have none until the options page sets it (`loadAccountInfo` refreshes it from `GET /v1/accounts/me`). Code that shows or needs it must handle it missing.
- **`permissions.request` must run before the first `await` in a click handler.** Browsers grant it only during a user gesture, and an `await` ends the gesture. `submitServer` in the onboarding page parses the URL synchronously, calls `requestServerPermission`, then awaits. Keep that order.
- **Never show an editable field before its async default is set.** The onboarding page loads the default device name, *remember key* and *tabs* in `onMounted`. If it showed the device step before they arrived, a slow load would overwrite what the user typed. That happened in CI: Firefox B was named "Firefox on Linux". `submitServer` awaits `defaultsLoaded` before showing the device step.
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
- **After a server restore (ENG-16)** the engine pulls everything with mode `restored`: records the server lacks are **pushed back** (`#pushMissing`), not deleted as in `reconcile` mode (`#dropMissing`, for expired tombstones). Mixing the two up would delete data newer than the backup on every device. The generation is stored only after all modules finished, so a crash repeats the recovery. Held records (ENG-10) aren't pushed back by this client. Records with an expiry (history, P2) will need their `expiresAt` when pushed back; tombstones get the usual 90 days.
- **Clock warnings (ENG-15):** `#pullAll` compares the `time` from `/v1/info` with the middle of the request, so latency doesn't count, and sets `clockSkewMinutes` in the status (positive: this clock is ahead). `clockWarning` is the other case: a record stamped more than 24 h ahead. Popup and options show both through `clockNotice`; the badge doesn't. Set `FakeServer.time` to test it.
- Engine tests use `FakeServer` and `FakeTabsModule` from `src/engine/testing.ts`. Module tests should use them too: they speak the real wire format through `@tazamun/core`'s schemas.

### Tabs module
- `detectLocalChanges` reads `windows.getAll({ populate: true, windowTypes: ['normal'] })` every time; the events registered in `watch` only say "look again" (rule 4). Missed events during suspension are caught by the next alarm.
- Private windows are filtered twice, per window and per tab, unless `includePrivate.tabs` is on; windows left empty aren't published, so with the switch off not even the number of private windows leaks. With it on they are published with `private: true`, exclusions still apply, and other browsers label them.
- **The browser decides whether private windows are visible at all.** `windows.getAll` and the tab events include them only when the user allowed the extension there (*Allow in Incognito*, *Run in Private Windows*). The extension can read that (`extension.isAllowedIncognitoAccess()`), never change it, so the options page explains where to switch it on. WXT's fake browser has no `extension` API; tests stub it.
- **Recently closed (TAB-10) comes from the diff,** not from events or the `sessions` API: `withRecent` compares the open tabs with this device's own record in the mirror. Tabs that are gone move to `recent` with `closedAt = now`. Keep `closedAt` only for real closures, or every run would see a change and push (PERF-5). Entries ageing past 7 days cause one push each, which is fine.
- The `keep` callback re-applies exclusions and the private-window switch to `recent`, so excluding a site or turning private windows off removes its old entries too. Don't bypass it.
- The *open when last seen* label (TAB-11) uses the device list's `lastSeenAt`, which the server updates on every request. Without the device list (offline) the popup shows no label rather than guessing.
- Other devices' tabs are never written to the browser (`apply` is empty); the popup reads them from the mirror with `readMirror`. Never open them automatically (SRS 3.3).
- The popup must not load favicon URLs from tab records: that is a request to a third-party site (PRIV-4).
- WXT's fake browser doesn't populate `windows.getAll` with tabs. Tests replace `fakeBrowser.windows.getAll` with their own windows.

### Options page
- Turning a module off asks first (PRIV-2): *Turn off and delete* sends a `retire` message; the engine asks the module's `retire()` for the deletions and publishes them even though the module is now skipped. The question is inline, not `window.confirm`, because it has three answers.
- Revoking another device is possible here because the dashboard comes only in P3. Never offer it for this device; signing out is the way.
- Renaming updates the server first, then the stored name and the device cache, so the popup's device names pick it up.

### Popup
- **PERF-1:** while open, the popup sends a `poll` message every 5 s. The background runs it like the alarm (`sync('alarm')`): it respects the backoff, unlike `sync-now`, so an open popup doesn't hammer a server that is down. With TAB-5's 5 s debounce on the other side, a change shows within about 12 s. Keep the interval short only in the popup; the background can't go below the 30 s alarm minimum.

### End-to-end tests
- **Firefox runs as the installed release over WebDriver BiDi**, not Playwright's Firefox (it can't load extensions) and not `web-ext run` (it can't drive pages). `webExtension.install` loads the build; the profile's `extensions.webextensions.uuids` pref fixes the `moz-extension://` origin.
- BiDi can't navigate to `moz-extension://` URLs, and can't run script in extension pages unless Firefox starts with `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`. Extension pages are opened with `tabs.create` from an extension context (the onboarding tab that `onInstalled` opens).
- **Clicks are real input** (`input.performActions` in Firefox, Playwright's `click` in Chromium). Firefox grants `permissions.request` only while handling user input; a scripted `button.click()` is refused.
- The popup is opened as a tab, which makes it the active tab. Its extension URL is never synced (TAB-3), so it doesn't show up in the other browser's list.
- Every failed sync backs off further (ENG-9). A test that polls a device while the server is down pushes its next automatic retry minutes away; open the popup (as a user would) to sync through the backoff.
- Read popup text only after the section you need has rendered: the popup loads tabs from IndexedDB and the device list from the server separately.

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
- Tab groups aren't synced (TAB-1). Don't add the `tabGroups` permission for them; the APIs differ between Chromium and Firefox.
- Test **every** change on Firefox too. The Chromium end-to-end setup is easier to automate, so Firefox regressions slip through.

### Store publishing
- AMO requires source code and build instructions for bundled code. Keep builds reproducible from the start (lockfile, `pnpm --filter @tazamun/extension build`).
- **Firefox data-collection consent:** new add-ons must declare `data_collection_permissions` (Firefox 140+, hence `strict_min_version: 140.0`). Sending data to the user's own server counts as collection even though it is encrypted, so tabs and history are declared as `browsingActivity`. Re-check the categories against Mozilla's policy before every AMO submission. Firefox for Android supports the key only from 142, and `web-ext lint` warns as long as the manifest allows older Android versions. Since [ADR-0012](../../docs/adr/0012-firefox-for-android-in-1-0.md) the manifest sets `browser_specific_settings.gecko_android.strict_min_version: 142.0` (`FIREFOX_ANDROID_MIN_VERSION`, MOB-1); never lower it, and keep `web-ext lint` free of that warning.
- `web-ext lint` warns about an `innerHTML` assignment inside Vue's runtime. That's Vue's own code, not ours; reviewers know it. Never write `innerHTML` (or `v-html`) in our code.
- `web-ext lint` also reports `DANGEROUS_EVAL` for zod's `allowsEval` probe (`Function('')` inside a `try`). With `z.config({ jitless: true })` the probe returns before reaching it, so it never runs and the CSP stays quiet. Mention both in the AMO reviewer notes.
- Store reviewers will question `history`, `tabs`, `management` and `bookmarks`. Keep the justifications ready (the comments in `src/manifest.ts` are the start), and request host permission only for the user's server URL.
- Extension updates reach users over days. The server must stay compatible with at least the previous client version (`minClientVersion`).
