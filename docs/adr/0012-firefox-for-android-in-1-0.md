# 0012. Firefox for Android is a 1.0 target, as a partial device

- Status: Accepted
- Date: 2026-11-26

## Context

Revision 2 of the SRS made 1.0 desktop only and listed Firefox for Android as the first target after 1.0 (SRS 1.2, 6.5). Phones are where people most often want "the tab I had open on my laptop", so a 1.0 without one leaves out an obvious use. Chrome and Edge on Android can't run extensions, and Safari is out of scope. Firefox for Android is the only mobile browser Tazamun can reach.

Firefox for Android runs WebExtensions, but not all of them. According to Mozilla's [desktop and Android differences](https://extensionworkshop.com/documentation/develop/differences-between-desktop-and-android-extensions/) page:

- **Missing:** `bookmarks`, `history`, `sessions`, `windows`, `omnibox`, `menus`, `commands`, and the managed storage area. Android has one browser "window", and extensions can't create or change windows.
- **Limited:** `tabs` works for most purposes, apart from zoom, selecting and moving tabs, and language and mute detection.
- **Different:** the toolbar popup opens as an overlay that covers the page. Android kills idle processes, extension background scripts included, so extensions have to recover after being killed. Event pages are the recommended background.
- **Storage:** `local` and `session` are supported.

Some facts still need checking before the requirements depend on them. These go in the first implementation task, not this ADR: the exact `tabs` events and their behaviour, `alarms` while Firefox is in the background, `action.setBadgeText`, `management`, optional permissions and optional host permissions, `extension.isAllowedIncognitoAccess` and private tabs.

**Data-collection consent.** AMO requires new add-ons to declare `data_collection_permissions` (SRS 6.2), and `web-ext lint` warns that Firefox for Android can't use the key. According to Mozilla's [built-in consent](https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/) page, the key is supported on desktop from Firefox 140 and on Android from Firefox 142 ([bug 1964999](https://bugzilla.mozilla.org/show_bug.cgi?id=1964999) added the Android prompt). The warning appears because the manifest doesn't set a minimum Android version, so lint checks it against Android versions older than 142.

Two parts of Tazamun don't depend on those APIs:

- Synced history is stored in the extension, not in the browser's own history ([ADR-0005](0005-history-stored-in-extension.md)). A device without the `history` API can still pull, decrypt and search what other browsers recorded.
- The dashboard (P3) is a web page, and it already has to work on screens 360 px wide (DSH-8). A phone can see bookmarks and the extension inventory there.

## Decision

1. **Firefox for Android is a supported browser in 1.0** (MOB-1). It uses the same Firefox build, add-on ID and data-collection declaration as desktop. The manifest adds `browser_specific_settings.gecko_android.strict_min_version: "142.0"`, the first Android version with the consent prompt. Desktop stays at 140. With that, `web-ext lint` passes, and one AMO package covers both. There is no fourth build target and no Android-only manifest.
2. **It is a partial device.** What it can do on Android:

   | Data type | On Firefox for Android |
   | --------- | ---------------------- |
   | Tabs | Full: publishes its tabs and shows and opens other browsers' tabs (MOB-3, MOB-4). |
   | History | Read only: pulls and searches other browsers' history in the popup. It records no visits of its own, because there is no `history` API (MOB-5). |
   | Bookmarks | Not synced; seen in the dashboard (MOB-6). |
   | Extension inventory | Published if the spike finds `management.getAll()` working on Android, otherwise left out (MOB-6). |

3. **Modules say what they can do on the current browser; the engine doesn't know about Android.** Each module reports whether it can *write* (capture this browser's data), *read* (pull and show other browsers' data), or neither, by checking for the browser APIs it needs, never by user-agent or platform name (MOB-2). The engine and the options page handle "not available on this browser" and "read only here" generically. This keeps [ADR-0001](0001-one-product-module-architecture.md) and rule 2: no Android branches in the engine.
4. **Tabs without windows.** Where `windows` is missing, the tabs module builds its record from `tabs.query` as a single window, listens only to `tabs` events, and opens "all tabs of a window" as separate tabs. The `tabs` record schema doesn't change, so desktop devices need no update to show a phone's tabs (MOB-3, MOB-4).
5. **Crypto parameters don't change for phones.** SEC-1 stays at m = 64 MiB, t = 3, p = 1, and clients still refuse lower values. Phones get a time budget for key derivation instead (MOB-8). Key derivation runs at sign-in, recovery and unlock, not on every sync, and the key is remembered by default ([ADR-0009](0009-device-names-and-key-storage.md)). If a reference phone misses the budget, the fix is a faster implementation or a clearer progress screen, never weaker parameters for everyone.
6. **Sync on Android is best effort while Firefox is in the background.** PERF-1's 90 s applies only while Firefox is in the foreground. Opening the popup or bringing Firefox to the front triggers a pull. REL-3 (nothing lost if sync is interrupted) applies without exception, because Android killing the process is the normal case there, not a failure (MOB-9).
7. **The extension's pages work on a phone.** The popup, options page and onboarding work at 360 px wide and by touch. They don't depend on hover, keyboard shortcuts or the toolbar badge, because status shows in the popup (MOB-7).
8. **Work starts in P2.** Android work runs alongside the desktop modules, not after them, so it is never a 1.0 blocker found late. The first task is a short spike on a real phone that settles the facts listed above and records them in the SRS (MOB-10). The spike's first step is to upload an unlisted test version with the Android minimum to AMO and confirm it's accepted and installs on Android. P1's exit criteria are unchanged. Store work is part of P6.

## Consequences

- 1.0 covers four browsers instead of three, and every later module states what it does on Android. If the spike contradicts a fact this decision relies on, a new ADR supersedes the affected part; this one isn't rewritten.
- Users on Firefox for Android older than 142 can't install Tazamun. Firefox for Android updates through the Play Store, so this should affect few people.
- The module interface gets a capability (write, read or none) that every module implements. On desktop, tabs, history and bookmarks are always *write*.
- A phone can't add history or bookmarks. Users have to be told this plainly, in the options page and in the store listing.
- No `tz` address-bar keyword on Android (no `omnibox`). History search is in the popup there.
- If Firefox for Android adds `history` or `bookmarks` later, the module's capability check picks them up. Bookmarks on a phone would still need the full ADR-0006 safety work and testing on Android before being turned on there.
- Testing costs more: an Android emulator or a real phone through `web-ext run -t firefox-android` and adb. Unit tests cover capability detection and the tabs fallback with a fake browser without `windows`. An automated end-to-end run on Android is a Could; a manual release checklist is a Must (MOB-10).
- Several places in the SRS, roadmap and pitfalls that said "desktop only" are updated in the same pull request.
