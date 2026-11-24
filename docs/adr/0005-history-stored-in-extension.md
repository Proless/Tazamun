# 0005. Synced history lives in Tazamun, not in native browser history

- Status: Accepted
- Date: 2026-11-24

## Context

The obvious design is to write visits from other browsers into each browser's native history. It works badly:

- Chrome's `history.addUrl` accepts only a URL. It can't set the title or the visit time, so every synced visit would appear as "visited just now". Firefox's `addUrl` accepts more fields, so the two families would behave differently.
- If the user also has vendor sync turned on (Chrome Sync, Firefox Sync), injected visits get uploaded to the vendor's account, which is a privacy surprise.
- Injected visits change the browser's own suggestions, "most visited" tiles and statistics in ways users didn't ask for, and can't be cleanly told apart from real visits afterwards.
- Volume: tens of thousands of entries per browser per year.

## Decision

- Synced history is stored in the extension (IndexedDB with a search index) and the dashboard, and is searched there: popup, `tz` address-bar keyword, dashboard.
- Native history is **read** (import plus `onVisited`) but never **written**, except for deletions the user asks for (HIS-9).
- Clearing all of a browser's history doesn't wipe synced history without asking (HIS-10).

## Consequences

- Behaviour is consistent across browser families, with no leaking into vendor sync.
- Unified history search becomes a feature of its own, arguably better than native history, because it shows which browser and device each visit came from.
- Trade-off: the browser's own address-bar autocomplete doesn't suggest pages visited only in other browsers. Users get them through the `tz` keyword instead. Document this in the FAQ.
