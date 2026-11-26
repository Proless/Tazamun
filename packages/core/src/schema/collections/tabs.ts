/** `tabs` collection (TAB-1…4): one record per device, record ID = device ID. */
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
  /** Tab group title, where the browser supports groups. */
  groupTitle: z.string().optional(),
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

export const tabsData = z.looseObject({
  windows: z.array(tabWindow),
});
export type TabsData = z.infer<typeof tabsData>;

export const tabs = defineCollection({ name: 'tabs', version: 1, data: tabsData });
