/** `extensions` collection (EXT-1, EXT-2): one record per device, record ID = device ID. */
import { z } from 'zod';
import { defineCollection } from '../payload.ts';

/** The `installType` values of `management.ExtensionInfo` in Chromium and Firefox. */
export const INSTALL_TYPES = ['normal', 'development', 'admin', 'sideload', 'other'] as const;

export const installedExtension = z.looseObject({
  /** Store or add-on ID as the browser reports it (Firefox reports add-on IDs, not slugs). */
  id: z.string().min(1),
  name: z.string(),
  version: z.string(),
  enabled: z.boolean(),
  kind: z.enum(['extension', 'theme']),
  /** EXT-2: `development` (unpacked) and `admin` (policy-installed) are flagged in the UI. */
  installType: z.enum(INSTALL_TYPES),
  homepageUrl: z.string().optional(),
});
export type InstalledExtension = z.infer<typeof installedExtension>;

export const extensionsData = z.looseObject({
  items: z.array(installedExtension),
});
export type ExtensionsData = z.infer<typeof extensionsData>;

export const extensions = defineCollection({
  name: 'extensions',
  version: 1,
  data: extensionsData,
});
