/**
 * How popup and options talk to the engine in the background: ask for a sync, read and watch the
 * status, pause and resume (ENG-5, ENG-12, ENG-13).
 */
import type { WxtBrowser } from 'wxt/browser';
import { getSettings, saveSettings } from '../account/store.ts';
import type { SyncMessage } from '../background/sync.ts';
import type { EngineStatus } from '../engine/engine.ts';
import { STATUS_KEY, parseStatus } from '../engine/status.ts';

/** ENG-5: sync now (popup opened, or the button). Resolves when the run finished. */
export async function requestSync(browser: WxtBrowser): Promise<EngineStatus | undefined> {
  const message: SyncMessage = { type: 'sync-now' };
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
