# 0001. One product: a generic engine with pluggable data-type modules

- Status: Accepted
- Date: 2026-11-24

## Context

Tazamun exists because users don't want a separate extension, account and backend for each kind of browser data. Building four data types as four mini-apps would recreate that fragmentation inside the codebase and multiply the work: four sync loops, four retry policies, four encryption paths. All-in-one projects most often stall this way.

## Decision

One extension, one account, one server and one dashboard. Inside the extension, a **sync engine** handles everything that doesn't depend on the data type: crypto, the outbox, pull and push, scheduling, retries, HLCs, status. Each data type is a **module** that implements a small interface:

```ts
interface SyncModule<T> {
  collection: string;            // "tabs", "history", "bookmarks", "extensions", ...
  schemaVersion: number;
  detectLocalChanges(): Promise<RecordChange<T>[]>;    // diff browser vs mirror
  merge(local: Rec<T> | undefined, remote: Rec<T>): MergeResult<T>; // pure function
  apply(records: Rec<T>[]): Promise<void>;           // write to browser, with echo suppression
  snapshot?(): Promise<Snapshot>;                    // optional safety copy
}
```

The engine must not contain code specific to any data type. Modules don't talk to the network or the crypto layer directly.

## Consequences

- Adding a data type (reading list, tab groups, search engines) means writing a module and its tests, with no engine changes.
- The engine is built and hardened once, with the simplest module (tabs) as its first user.
- The dashboard reuses the same core library (schemas, crypto, merge) for reading and editing.
- The interface has to be good early. Expect to revise it once while building history (P2) and once for bookmarks (P4). Revisions are cheap before 1.0.
