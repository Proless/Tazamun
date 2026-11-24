/**
 * `commands` collection (TAB-7): messages from one device to another, record ID = random GUID.
 * The target executes the command and then deletes it (tombstone). Unused commands expire after
 * 7 days through the record's `expiresAt`.
 */
import { z } from 'zod';
import { defineCollection } from '../payload.ts';
import { browserUrl, deviceId, epochMs } from '../primitives.ts';

/** TAB-7: commands nobody picked up expire after 7 days. */
export const COMMAND_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Send tab to device. */
export const openTabCommand = z.looseObject({
  type: z.literal('open-tab'),
  url: browserUrl,
  title: z.string().optional(),
});

export const commandsData = z.looseObject({
  /** Device that should execute the command. */
  target: deviceId,
  /** Device that sent it. */
  sender: deviceId,
  sentAt: epochMs,
  /** Unknown command types from newer clients fail validation and are kept but not executed. */
  command: z.discriminatedUnion('type', [openTabCommand]),
});
export type CommandsData = z.infer<typeof commandsData>;

export const commands = defineCollection({ name: 'commands', version: 1, data: commandsData });
