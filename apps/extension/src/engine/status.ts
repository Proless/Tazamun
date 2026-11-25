/**
 * The engine status as stored for the UI (ENG-13) and shown on the toolbar badge (UI-6). The
 * background writes it to `storage.local` after every run; popup and options read it and listen
 * for changes. Validated on read: a stale or corrupt value shows as "idle", never crashes a page.
 */
import { z } from 'zod';
import type { t } from '../lib/i18n.ts';
import type { EngineStatus } from './engine.ts';

export const STATUS_KEY = 'engineStatus';

const statusSchema = z.object({
  state: z.enum(['signed-out', 'locked', 'paused', 'idle', 'syncing', 'offline', 'error']),
  reason: z.string().optional(),
  updateRequired: z.boolean().optional(),
  clockWarning: z.boolean().optional(),
  lastSync: z.record(z.string(), z.number()),
  lastSuccessAt: z.number().optional(),
  retryAt: z.number().optional(),
  pending: z.number(),
  updatedAt: z.number(),
});

export function parseStatus(value: unknown): EngineStatus | undefined {
  const parsed = statusSchema.safeParse(value);
  // zod's optional fields are `T | undefined`; the stored object never has explicit undefineds.
  return parsed.success ? (parsed.data as EngineStatus) : undefined;
}

type MessageKey = Parameters<typeof t>[0];

/** The status line for popup and options. */
export function statusMessageKey(status: EngineStatus): MessageKey {
  if (status.updateRequired === true) return 'statusUpdateRequired';
  switch (status.state) {
    case 'syncing':
      return 'statusSyncing';
    case 'paused':
      return 'statusPaused';
    case 'offline':
      return 'statusOffline';
    case 'error':
      if (status.reason === 'QUOTA_EXCEEDED') return 'statusQuota';
      if (status.reason === 'RATE_LIMITED') return 'statusRateLimited';
      return 'statusError';
    case 'locked':
      return 'popupLocked';
    case 'signed-out':
      return 'popupNotConnected';
    case 'idle':
      return status.lastSuccessAt === undefined ? 'statusIdleNever' : 'statusIdle';
  }
}

/**
 * UI-6: the badge shows only states that need attention, never counts (a count of tabs or visits
 * would leak browsing activity to anyone looking at the screen).
 */
export function badgeFor(status: EngineStatus): { text: string; color: string } {
  if (status.state === 'paused') return { text: 'II', color: '#6b6b70' };
  if (status.state === 'error' || status.state === 'locked' || status.updateRequired === true) {
    return { text: '!', color: '#b3261e' };
  }
  return { text: '', color: '#6b6b70' };
}
