# 0011. Private browsing is the user's choice; send tab is removed

- Status: Accepted
- Date: 2026-11-26

## Context

**Private browsing.** Rule 7 said *never capture private or incognito browsing*. PRIV-1 and TAB-2 applied it to every module, and HIS-5 to history. That fits a shared or borrowed computer, but not someone who uses private windows on their own machines and wants those tabs in one place like any others. The browsers already make this a permission:

- Chrome and Edge keep an extension out of incognito ("InPrivate" in Edge) windows until the user turns on *Allow in Incognito* (*Allow in InPrivate*) on the extensions page.
- Firefox keeps an extension out of private windows until the user sets *Run in Private Windows* to *Allow* in the add-on's settings.

An extension can't grant itself this. It can only read it (`extension.isAllowedIncognitoAccess()`). Everything Tazamun syncs is encrypted on the device before it leaves (ADR-0002), private tabs included.

**Send tab** (TAB-7, TAB-8, UI-4, PERF-2) let a browser open a page on another one through a `commands` collection, with notifications and a context menu. It isn't needed: the popup already lists every browser's tabs (TAB-6) for opening by hand. It cost two permissions (`notifications`, `contextMenus`), a module with delivery guarantees of its own, and a second way to open tabs.

## Decision

### Private browsing

- **Rule 7 is dropped.** Capturing private browsing is a per-module choice the user makes per browser, nothing more.
- Each module that sees browsing (tabs now, history in P2) has its own **Include private windows** switch in the options page, **off by default** (PRIV-1). It takes effect only while the browser allows the extension in private windows. When the browser doesn't, the options page says so and explains where to allow it. The extension can't change it.
- Tabs from private windows are published in the same record, with the window marked `private: true` (an optional field, so the `tabs` schema stays at version 1). Other browsers label such a window *private window*; opening one of its tabs opens it in a normal window there.
- Exclusions (PRIV-3) and the scheme rules (TAB-3) apply to private windows exactly as to normal ones.
- The manifest keeps the default `incognito: "spanning"` mode. No new permission is added.

### Send tab

- TAB-7, PERF-2 and UI-4 are removed, along with *Send this tab* in UI-1 and *send to device* in DSH-3. The `commands` collection, its schema, the commands module, the context menu and notifications go too, with the `notifications` and `contextMenus` permissions. Removing a permission doesn't disable the extension for anyone.
- TAB-8 (copy a URL the browser refuses to open, and say so) stays, for opening tabs from the popup.
- An update clears the queues send tab kept in `storage.local`. `commands` records already on a server expire there within 7 days (they were written with `expiresAt`). The server needs no change: it never knew about collections.

ADR-0009 mentions send tab as an example; it is partly superseded here and otherwise stands.

## Consequences

- Someone who allows it can see their private tabs on their other browsers, and so can anyone who signs into the account. The switch is off by default and per browser, so a shared computer stays private unless someone turns it on there.
- History (P2) gets the same switch rather than a fixed rule; HIS-5 says so.
- Store reviewers may ask why private windows are read. The answer: only when the user turns the switch on and has allowed the extension in private windows.
- There is no way to push a page to another browser any more. If that is wanted again, it comes back as a new requirement and ADR, not by restoring this code.
- Two fewer permissions to justify in store listings.
