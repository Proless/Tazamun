/**
 * `tabs` collection (TAB-1…4, TAB-10): one record per device, record ID = device ID. `windows` is
 * what is open now; `recent` the tabs that were open and closed since (TAB-10).
 */
import { z } from 'zod';
import { defineCollection } from '../payload.ts';
import { browserUrl, epochMs } from '../primitives.ts';

/** TAB-4: favicon URLs longer than this are dropped. */
export const MAX_FAVICON_URL_LENGTH = 512;

export const favIconUrl = z
  .string()
  .max(MAX_FAVICON_URL_LENGTH)
  .refine((url) => !url.toLowerCase().startsWith('data:'), 'data: favicons must be stripped');

export const tab = z.looseObject({
  url: browserUrl,
  title: z.string(),
  pinned: z.boolean(),
  active: z.boolean(),
  lastAccessed: epochMs.optional(),
  favIconUrl: favIconUrl.optional(),
});
export type Tab = z.infer<typeof tab>;

export const tabWindow = z.looseObject({
  focused: z.boolean(),
  /**
   * A private or incognito window, published only when the user turned that on for this browser
   * (TAB-2). Absent means a normal window; older clients ignore the field.
   */
  private: z.boolean().optional(),
  tabs: z.array(tab),
});
export type TabWindow = z.infer<typeof tabWindow>;

/** TAB-10: how many recently closed tabs a device keeps, and for how long. */
export const RECENT_TABS_MAX = 50;
export const RECENT_TABS_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** A tab that was open on the device and was closed (TAB-10). */
export const recentTab = z.looseObject({
  url: browserUrl,
  title: z.string(),
  closedAt: epochMs,
  /** It was in a private window (TAB-2). */
  private: z.boolean().optional(),
});
export type RecentTab = z.infer<typeof recentTab>;

export const tabsData = z.looseObject({
  windows: z.array(tabWindow),
  /**
   * Newest first. Clients keep at most RECENT_TABS_MAX; the schema doesn't enforce it, so a later
   * client may keep more without making its records invalid here. Absent from older clients.
   */
  recent: z.array(recentTab).optional(),
});
export type TabsData = z.infer<typeof tabsData>;

export const tabs = defineCollection({ name: 'tabs', version: 1, data: tabsData });
