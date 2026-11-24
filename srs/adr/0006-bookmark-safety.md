# 0006. Bookmark safety: diff against a mirror, snapshots, mass-deletion guard

- Status: Accepted
- Date: 2026-11-24

## Context

Bookmark sync is where users get hurt: duplicated trees, folders vanishing, years of bookmarks deleted by one bad merge. Specific hazards:

- Browser events are lost while the extension is suspended or the browser is closed, and arrive in unreliable order during bulk changes.
- Tazamun's own writes fire events (echoes) that look like user changes and can cause feedback loops.
- Root folders differ between Chromium and Firefox; Chromium has no separators.
- Concurrent moves can create cycles. Concurrent delete-and-add can create orphans.
- The vendor's own bookmark sync may be changing the same tree at the same time.
- The first sync on a browser that already has bookmarks can duplicate everything.

## Decision

1. **Diff against the mirror.** The module keeps a mirror of the last synced tree. Events only *schedule* a reconcile, which reads the full native tree and diffs it against the mirror. This also catches changes made while Tazamun wasn't running.
2. **Echo suppression.** While applying remote changes, the module records the expected native changes and ignores matching events. The reconcile after applying must produce an empty diff; a non-empty diff is logged as a bug.
3. **Stable GUIDs** for records, with a local GUID-to-native-ID map. Canonical roots as listed in BMK-3.
4. **Structural rules:** fractional position keys, edit wins over delete, cycle repair, orphans go to `other/Tazamun recovered`.
5. **Safety net:** automatic snapshots (BMK-12), a mass-deletion guard that pauses sync and asks the user (BMK-13), restore from the options page, and HTML export.
6. **First sync** uses matching heuristics and lets the user choose merge, use server copy, or use this browser's copy (BMK-11).
7. Bookmarks are built **last** among the core types (phase P4), after the engine has been proven by tabs and history.

## Consequences

- Reading the full tree on each reconcile costs a bit (cheap for under 10,000 nodes; debounced).
- With snapshots and the deletion guard, bugs during development are recoverable for testers, which makes early dog-fooding realistic.
- Property-based tests on the merge (random concurrent edits on simulated devices, checking convergence and no cycles) are required before P4 is considered done.
