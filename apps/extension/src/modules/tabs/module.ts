/**
 * The tabs module (SRS 3.3, TAB-1…5). Each device owns one record, ID = its device ID, holding its
 * windows and tabs. Other devices only read these records, so there are no conflicts (ADR-0003,
 * "owned by one device") and nothing is ever written to the browser from them: `apply` is empty,
 * and the popup reads other devices' tabs from the mirror.
 */
import type { WxtBrowser } from 'wxt/browser';
import { merge, schema } from '@tazamun/core';
import { getSettings } from '../../account/store.ts';
import { parseExclusions } from '../../lib/exclusions.ts';
import type { DetectContext, LocalChange, SyncModule, SyncRecord } from '../../engine/module.ts';
import { buildTabsData, type BrowserWindow } from './snapshot.ts';

/** TAB-5: tab events come in bursts (a page loading fires several); wait for them to settle. */
export const TABS_DEBOUNCE_MS = 5_000;

export class TabsModule implements SyncModule<schema.TabsData> {
  readonly collection = schema.COLLECTIONS.tabs;
  readonly debounceMs = TABS_DEBOUNCE_MS;
  readonly #browser: WxtBrowser;

  constructor(browser: WxtBrowser) {
    this.#browser = browser;
  }

  /**
   * Rule 4: the browser's current state is the truth; events only say "look again". The diff
   * against this device's own record in the mirror decides whether anything changed (TAB-5).
   */
  async detectLocalChanges(
    ctx: DetectContext<schema.TabsData>,
  ): Promise<LocalChange<schema.TabsData>[]> {
    const [windows, settings] = await Promise.all([
      this.#browser.windows.getAll({ populate: true, windowTypes: ['normal'] }),
      getSettings(this.#browser),
    ]);
    const data = buildTabsData(windows as BrowserWindow[], {
      exclusions: parseExclusions(settings.exclusions),
      includePrivate: settings.includePrivate.tabs,
    });
    const current = await ctx.mirror.get(ctx.deviceId);
    if (current !== undefined && !current.payload.deleted) {
      if (merge.jsonEqual(current.payload.data, data)) return [];
    }
    return [{ id: ctx.deviceId, data }];
  }

  merge(
    local: schema.Payload<schema.TabsData> | undefined,
    remote: schema.Payload<schema.TabsData>,
  ): schema.Payload<schema.TabsData> {
    return merge.lastWriterWins(local, remote);
  }

  /** PRIV-2: turning tabs off deletes this browser's tabs record from the server. */
  async retire(ctx: DetectContext<schema.TabsData>): Promise<LocalChange<schema.TabsData>[]> {
    const current = await ctx.mirror.get(ctx.deviceId);
    return current === undefined || current.payload.deleted
      ? []
      : [{ id: ctx.deviceId, deleted: true }];
  }

  /** Other devices' tabs are shown, never opened automatically (SRS 3.3). */
  apply(_records: SyncRecord<schema.TabsData>[]): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Register the browser events that may change this device's tabs. Called synchronously at the
   * top level of the background script (MV3). Events that don't touch synced fields are ignored;
   * the diff catches anything that slips through either way.
   */
  watch(notify: () => void): void {
    const tabs = this.#browser.tabs;
    tabs.onCreated.addListener(notify);
    tabs.onRemoved.addListener(notify);
    tabs.onMoved.addListener(notify);
    tabs.onAttached.addListener(notify);
    tabs.onDetached.addListener(notify);
    tabs.onActivated.addListener(notify);
    tabs.onReplaced.addListener(notify);
    tabs.onUpdated.addListener((_id, change) => {
      if (
        change.url !== undefined ||
        change.title !== undefined ||
        change.pinned !== undefined ||
        change.favIconUrl !== undefined ||
        change.status === 'complete'
      ) {
        notify();
      }
    });
    this.#browser.windows.onCreated.addListener(notify);
    this.#browser.windows.onRemoved.addListener(notify);
    this.#browser.windows.onFocusChanged.addListener(notify);
  }
}
