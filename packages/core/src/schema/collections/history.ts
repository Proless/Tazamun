/**
 * `history` collection (HIS-1, HIS-2): one record per normalized URL. The record ID is an HMAC of
 * the normalized URL (computed by the crypto module), so the same page from different browsers
 * merges without the server learning the URL.
 */
import { z } from 'zod';
import { defineCollection } from '../payload.ts';
import { browserUrl, deviceId, epochMs } from '../primitives.ts';

/** HIS-2: only the most recent visits are kept per URL. */
export const MAX_VISITS = 50;

export const visit = z.looseObject({
  deviceId,
  time: epochMs,
  /**
   * The browser's transition type (`link`, `typed`, `reload`, …). Kept as a string because
   * browsers add values over time; an unknown value must not invalidate the record.
   */
  transition: z.string().min(1).max(32),
});
export type Visit = z.infer<typeof visit>;

export const historyData = z.looseObject({
  url: browserUrl,
  /** The most recent title. */
  title: z.string(),
  visits: z.array(visit).max(MAX_VISITS),
});
export type HistoryData = z.infer<typeof historyData>;

export const history = defineCollection({ name: 'history', version: 1, data: historyData });
