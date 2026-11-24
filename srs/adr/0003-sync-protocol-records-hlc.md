# 0003. Sync protocol: encrypted records, server sequence numbers, merging on the client

- Status: Accepted
- Date: 2026-11-24

## Context

Under [ADR-0002](0002-end-to-end-encryption-dumb-server.md) the server can't merge, so clients must converge on their own. We need a protocol that is simple enough to implement and debug, tolerates offline devices and MV3 background suspension, and works for very different data types.

## Decision

1. **Records.** Each item is a record `{id, seq, modifiedAt, expiresAt?, payload}`. Only `payload` is encrypted. `seq` is a per-account counter that the server assigns on every write.
2. **Pull.** `GET /v1/collections/{c}?since=<seq>`. The client saves the highest `seq` it has processed per collection only **after** applying the batch.
3. **Push.** Batched upserts from a durable outbox. The server overwrites by ID and assigns a new `seq`. It doesn't check versions; the server stays simple and clients handle races.
4. **Ordering edits.** Each device keeps a **Hybrid Logical Clock**. Every changed field carries the HLC of its last edit. HLCs are compared as (physical time, counter, device ID), which gives a total order that tolerates clock drift.
5. **Merging** is a pure function per module. Three strategies cover the current types:
   - *Owned by one device* (tabs, extension inventory): only the owning device writes it, so no conflicts.
   - *Set union* (history visits): merge by union, then trim to the cap.
   - *Last writer wins per field* (bookmarks, device settings), plus structural rules for trees ([ADR-0006](0006-bookmark-safety.md)).
6. **Convergence.** If the merge result differs from the server copy, the client pushes the result. A later write from a device with an older HLC is overridden by the next device that sees it. All devices converge as soon as each has synced once after the last edit.
7. **Deletions** are encrypted tombstones with a 90-day expiry. A device offline for longer than that does a **full reconcile** (fetch everything, compare with the mirror) instead of an incremental pull.
8. **Change notification** is by polling `/v1/info` (one small request per alarm), plus immediate checks when a UI is opened. Push channels (SSE or WebSocket) don't fit MV3 service workers and are left for after 1.0.

## Consequences

- The server stays small and free of logic about the data. All of the clever parts are pure functions in `packages/core` and can be tested exhaustively in Node.
- Races cause extra pushes rather than lost updates. This is acceptable at the volume of personal browser data.
- HLCs rely on clocks being roughly correct. A device whose clock is far ahead could win conflicts unfairly; clients should warn when their clock differs from the server's `Date` header by more than 5 minutes.
- No CRDT library is needed for 1.0. If bookmark tree merging proves too fragile, a move-aware tree CRDT can replace the bookmark merge function without changing the protocol.
