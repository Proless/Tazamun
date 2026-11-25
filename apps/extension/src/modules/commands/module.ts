/**
 * The `commands` module (TAB-7): *Send tab to device*.
 *
 * Sending: the background queues the command in `storage.local` (`send`), and the next sync
 * publishes it as a new record (random ID) with `expiresAt` = 7 days. The queue entry is dropped
 * once the record is in the mirror, i.e. after the engine committed it, so a crash in between
 * publishes it again rather than losing it.
 *
 * Receiving: `apply` gets every command pulled from the server. Those addressed to this device are
 * opened, announced with a notification, and then deleted (a tombstone, queued the same way).
 * Opened IDs are remembered for a while, so a re-applied page (after a crash, REL-2) doesn't open a
 * tab twice.
 */
import type { WxtBrowser } from 'wxt/browser';
import { z } from 'zod';
import { crypto as tzCrypto, merge, schema } from '@tazamun/core';
import type { DetectContext, LocalChange, SyncModule, SyncRecord } from '../../engine/module.ts';

const OUTGOING_KEY = 'commandsOutgoing';
const DELETE_KEY = 'commandsToDelete';
const DONE_KEY = 'commandsDone';

/** Opened IDs are kept a day longer than a command can live on the server. */
const DONE_TTL_MS = schema.COMMAND_TTL_MS + 24 * 60 * 60 * 1000;

const outgoing = z.array(
  z.object({ id: schema.recordId, data: schema.commandsData, expiresAt: z.string() }),
);
const idList = z.array(schema.recordId);
const doneMap = z.record(z.string(), z.number());

export interface SentTab {
  readonly url: string;
  readonly title?: string;
}

/** What happens on the receiving side; injected so tests don't need real tabs or notifications. */
export interface Receiver {
  /** Open the tab; resolve false if the browser refused it (TAB-8). */
  open(tab: SentTab, sender: string): Promise<boolean>;
}

export class CommandsModule implements SyncModule<schema.CommandsData> {
  readonly collection = schema.COLLECTIONS.commands;
  /** Sending should feel immediate; there are no bursts to wait out. */
  readonly debounceMs = 0;
  readonly #browser: WxtBrowser;
  readonly #receiver: Receiver;
  readonly #deviceId: () => Promise<string | undefined>;
  readonly #now: () => number;
  #notify: (() => void) | undefined;

  constructor(
    browser: WxtBrowser,
    options: {
      receiver: Receiver;
      deviceId: () => Promise<string | undefined>;
      now?: () => number;
    },
  ) {
    this.#browser = browser;
    this.#receiver = options.receiver;
    this.#deviceId = options.deviceId;
    this.#now = options.now ?? (() => Date.now());
  }

  /** TAB-7: queue a tab for another device. The caller then triggers a sync. */
  async send(target: string, sender: string, tab: SentTab): Promise<void> {
    const sentAt = this.#now();
    const data = schema.commandsData.parse({
      target,
      sender,
      sentAt,
      command: {
        type: 'open-tab',
        url: tab.url,
        ...(tab.title === undefined ? {} : { title: tab.title }),
      },
    });
    const entry = {
      id: tzCrypto.randomId(),
      data,
      expiresAt: isoSeconds(sentAt + schema.COMMAND_TTL_MS),
    };
    await this.#write(OUTGOING_KEY, [...(await this.#read(OUTGOING_KEY, outgoing, [])), entry]);
  }

  async detectLocalChanges(
    ctx: DetectContext<schema.CommandsData>,
  ): Promise<LocalChange<schema.CommandsData>[]> {
    const changes: LocalChange<schema.CommandsData>[] = [];

    const queued = await this.#read(OUTGOING_KEY, outgoing, []);
    const stillQueued = [];
    for (const entry of queued) {
      // In the mirror means the engine committed it to the outbox: done here.
      if ((await ctx.mirror.get(entry.id)) !== undefined) continue;
      stillQueued.push(entry);
      changes.push({ id: entry.id, data: entry.data, expiresAt: entry.expiresAt });
    }
    if (stillQueued.length !== queued.length) await this.#write(OUTGOING_KEY, stillQueued);

    const toDelete = await this.#read(DELETE_KEY, idList, []);
    const stillToDelete = [];
    for (const id of toDelete) {
      const current = await ctx.mirror.get(id);
      if (current === undefined || current.payload.deleted) continue;
      stillToDelete.push(id);
      changes.push({ id, deleted: true });
    }
    if (stillToDelete.length !== toDelete.length) await this.#write(DELETE_KEY, stillToDelete);

    return changes;
  }

  merge(
    local: schema.Payload<schema.CommandsData> | undefined,
    remote: schema.Payload<schema.CommandsData>,
  ): schema.Payload<schema.CommandsData> {
    return merge.lastWriterWins(local, remote);
  }

  async apply(records: SyncRecord<schema.CommandsData>[]): Promise<void> {
    const self = await this.#deviceId();
    if (self === undefined) return;
    const now = this.#now();
    const done = await this.#read(DONE_KEY, doneMap, {});
    const toDelete = new Set(await this.#read(DELETE_KEY, idList, []));
    let changed = false;
    for (const record of records) {
      const { payload } = record;
      if (payload.deleted || payload.data.target !== self) continue;
      toDelete.add(record.id);
      changed = true;
      if (record.id in done) continue;
      done[record.id] = now;
      // Nobody picked it up in time (TAB-7): delete it without opening a week-old tab.
      if (payload.data.sentAt + schema.COMMAND_TTL_MS < now) continue;
      const { url, title } = payload.data.command;
      await this.#receiver.open(
        { url, ...(title === undefined ? {} : { title }) },
        payload.data.sender,
      );
    }
    if (!changed) return;
    const keep = Object.fromEntries(
      Object.entries(done).filter(([, at]) => at + DONE_TTL_MS >= now),
    );
    await this.#write(DONE_KEY, keep);
    await this.#write(DELETE_KEY, [...toDelete]);
    // Push the tombstones soon, not at the next alarm.
    this.#notify?.();
  }

  watch(notify: () => void): void {
    this.#notify = notify;
  }

  async #read<T>(key: string, schemaOf: z.ZodType<T>, fallback: T): Promise<T> {
    const parsed = schemaOf.safeParse((await this.#browser.storage.local.get(key))[key]);
    return parsed.success ? parsed.data : fallback;
  }

  async #write(key: string, value: unknown): Promise<void> {
    await this.#browser.storage.local.set({ [key]: value });
  }
}

/** Storage keys this module owns, for "Remove the account from this browser". */
export const COMMANDS_STORAGE_KEYS = [OUTGOING_KEY, DELETE_KEY, DONE_KEY] as const;

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
