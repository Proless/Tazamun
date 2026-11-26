/**
 * *Tabs on other browsers* (TAB-6): other devices' tabs records from the mirror, joined with the
 * device list from the server for names and last-seen times. Pure, so the popup and later the
 * dashboard show the same thing.
 */
import type { schema } from '@tazamun/core';
import type { SyncRecord } from '../../engine/module.ts';

/** TAB-11: a device not seen for longer than this shows its tabs as "open when last seen". */
export const LIVE_WITHIN_MS = 10 * 60 * 1000;

export interface DeviceTabs {
  readonly deviceId: string;
  /** Undefined when the device list hasn't been fetched yet (offline). */
  readonly name: string | undefined;
  readonly lastSeenAt: number | undefined;
  /**
   * TAB-11: seen within LIVE_WITHIN_MS, so `windows` is what is open there now. False: what was
   * open when it was last seen. Undefined when the last-seen time isn't known.
   */
  readonly live: boolean | undefined;
  readonly windows: readonly schema.TabWindow[];
  readonly tabCount: number;
  /** TAB-10: recently closed tabs, newest first. */
  readonly recent: readonly schema.RecentTab[];
}

/**
 * Other devices first by last seen. With a device list, records of devices that aren't on it any
 * more (revoked) are hidden: their record stays on the server until someone deletes it, but it
 * isn't a browser of this account any more.
 */
export function otherDevicesTabs(
  records: readonly SyncRecord<schema.TabsData>[],
  devices: readonly schema.Device[] | undefined,
  selfId: string,
  now: number,
): DeviceTabs[] {
  const byId = new Map(devices?.map((d) => [d.id, d]));
  const result: DeviceTabs[] = [];
  for (const record of records) {
    if (record.id === selfId || record.payload.deleted) continue;
    const device = byId.get(record.id);
    if (devices !== undefined && device === undefined) continue;
    const windows = record.payload.data.windows.filter((w) => w.tabs.length > 0);
    const tabCount = windows.reduce((n, w) => n + w.tabs.length, 0);
    const recent = record.payload.data.recent ?? [];
    if (tabCount === 0 && recent.length === 0) continue;
    const lastSeenAt = device === undefined ? undefined : Date.parse(device.lastSeenAt);
    result.push({
      deviceId: record.id,
      name: device?.name,
      lastSeenAt,
      live: lastSeenAt === undefined ? undefined : now - lastSeenAt <= LIVE_WITHIN_MS,
      windows,
      tabCount,
      recent,
    });
  }
  return result.sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
}

/** "5 minutes ago", "yesterday", in the UI language. */
export function formatLastSeen(at: number, now: number, locale: string): string {
  const seconds = Math.round((at - now) / 1000);
  const format = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400],
    ['hour', 3_600],
    ['minute', 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  }
  return format.format(0, 'minute');
}

/** The host to show under a tab title, or the URL itself if it doesn't parse. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
