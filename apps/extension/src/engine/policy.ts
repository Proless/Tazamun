/**
 * The engine's timing and batching rules, as pure functions (ENG-4, ENG-5, ENG-9).
 */
import type { OutboxEntry } from './store.ts';

/** ENG-4. */
export const PUSH_DEBOUNCE_MS = 2_000;
export const MAX_BATCH_RECORDS = 500;
export const MAX_BATCH_BYTES = 1_000_000;
/** ENG-5: Chrome's minimum alarm period is 30 s; Tazamun's default is 60 s. */
export const POLL_PERIOD_MINUTES = 1;
/** ENG-9: 1 s up to 15 min. */
export const BACKOFF_MIN_MS = 1_000;
export const BACKOFF_MAX_MS = 15 * 60 * 1_000;
/** ADR-0003: tombstones live 90 days, so a device away longer must reconcile fully. */
export const TOMBSTONE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
/** Reconcile fully a little before tombstones can have expired. */
export const FULL_RECONCILE_AFTER_MS = TOMBSTONE_TTL_MS - 7 * 24 * 60 * 60 * 1_000;

/**
 * ENG-9: exponential backoff with full jitter. `attempt` counts failures so far (1 = first).
 * `random` is in [0, 1). A server's `Retry-After` is a floor.
 */
export function backoffDelay(attempt: number, random: number, retryAfterSeconds?: number): number {
  const ceiling = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** Math.max(0, attempt - 1));
  // Full jitter, but never below the minimum, so a run of failures can't hammer the server.
  const delay = Math.max(BACKOFF_MIN_MS, Math.floor(ceiling * random));
  const floor = retryAfterSeconds === undefined ? 0 : retryAfterSeconds * 1_000;
  return Math.min(BACKOFF_MAX_MS, Math.max(delay, floor));
}

/** Bytes a record adds to a push body, roughly: the payload plus the envelope around it. */
function entryBytes(entry: OutboxEntry): number {
  return entry.payload.length + entry.id.length + (entry.expiresAt?.length ?? 0) + 64;
}

/**
 * ENG-4: split the outbox into push requests, one collection per request, at most 500 records and
 * about 1 MB each (the server's limit is 2 MB, so there is headroom). Oldest first. A single record
 * over the byte limit still goes alone; the server decides whether it fits.
 */
export function planBatches(entries: readonly OutboxEntry[]): OutboxEntry[][] {
  const byCollection = new Map<string, OutboxEntry[]>();
  for (const entry of [...entries].sort((a, b) => a.queuedAt - b.queuedAt)) {
    const list = byCollection.get(entry.collection) ?? [];
    list.push(entry);
    byCollection.set(entry.collection, list);
  }
  const batches: OutboxEntry[][] = [];
  for (const list of byCollection.values()) {
    let batch: OutboxEntry[] = [];
    let bytes = 0;
    for (const entry of list) {
      const size = entryBytes(entry);
      if (
        batch.length > 0 &&
        (batch.length >= MAX_BATCH_RECORDS || bytes + size > MAX_BATCH_BYTES)
      ) {
        batches.push(batch);
        batch = [];
        bytes = 0;
      }
      batch.push(entry);
      bytes += size;
    }
    if (batch.length > 0) batches.push(batch);
  }
  return batches;
}
