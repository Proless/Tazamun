/**
 * How popup and options talk to the engine in the background: ask for a sync, read and watch the
 * status, pause and resume (ENG-5, ENG-12, ENG-13).
 */
import type { WxtBrowser } from 'wxt/browser';
import { getSettings, saveSettings } from '../account/store.ts';
import type { SyncMessage } from '../background/sync.ts';
import type { EngineStatus } from '../engine/engine.ts';
import { openEngineStore } from '../engine/idb-store.ts';
import type { Payload, SyncRecord } from '../engine/module.ts';
import { STATUS_KEY, parseStatus } from '../engine/status.ts';

/**
 * ENG-5: sync now (popup opened, or the button), or (`poll`) check for changes as the alarm does,
 * respecting the backoff (PERF-1). Resolves when the run finished.
 */
export async function requestSync(
  browser: WxtBrowser,
  kind: 'sync-now' | 'poll' = 'sync-now',
): Promise<EngineStatus | undefined> {
  const message: SyncMessage = { type: kind };
  try {
    return parseStatus(await browser.runtime.sendMessage(message));
  } catch {
    // The background is starting or updating; the status listener catches up.
    return undefined;
  }
}

export async function readStatus(browser: WxtBrowser): Promise<EngineStatus | undefined> {
  return parseStatus((await browser.storage.local.get(STATUS_KEY))[STATUS_KEY]);
}

/** Calls `listener` on every status change. Returns the function that stops listening. */
export function watchStatus(
  browser: WxtBrowser,
  listener: (status: EngineStatus) => void,
): () => void {
  const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
    if (area !== 'local' || !(STATUS_KEY in changes)) return;
    const status = parseStatus(changes[STATUS_KEY].newValue);
    if (status !== undefined) listener(status);
  };
  browser.storage.onChanged.addListener(onChanged);
  return () => {
    browser.storage.onChanged.removeListener(onChanged);
  };
}

/** ENG-12. The background notices the settings change and syncs (or stops). */
export async function togglePaused(browser: WxtBrowser): Promise<void> {
  const settings = await getSettings(browser);
  await saveSettings(browser, { ...settings, paused: !settings.paused });
}

/**
 * The mirror of one collection, for pages that show synced data (the popup's other tabs). Read
 * only: pages never write the engine's store. Held records (ENG-10) are left out.
 */
export async function readMirror<Data>(collection: string): Promise<SyncRecord<Data>[]> {
  const store = await openEngineStore();
  try {
    return (await store.listMirror(collection))
      .filter((e) => e.payload !== undefined)
      .map((e) => ({ id: e.id, payload: e.payload as Payload<Data> }));
  } finally {
    store.close();
  }
}
