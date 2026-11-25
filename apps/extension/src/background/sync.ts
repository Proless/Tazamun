/**
 * Runs the engine in the background script: when to sync (ENG-5), the push debounce (ENG-4), the
 * retry timer (ENG-9), messages from the pages, and the toolbar badge (UI-6).
 *
 * MV3: the service worker can be killed after ~30 s idle, so nothing here relies on staying alive.
 * The periodic alarm survives suspension and restarts; timers are only a shortcut for delays below
 * the alarm minimum, each backed by an alarm. All state is in IndexedDB and `storage`.
 */
import type { WxtBrowser } from 'wxt/browser';
import { getAccountState, getSettings, markSignedOut } from '../account/store.ts';
import { clientFor, clientVersion } from '../account/session.ts';
import { SyncEngine, type EngineStatus, type Trigger } from '../engine/engine.ts';
import { openEngineStore } from '../engine/idb-store.ts';
import type { AnyModule } from '../engine/module.ts';
import type { EngineStore } from '../engine/store.ts';
import { POLL_PERIOD_MINUTES, PUSH_DEBOUNCE_MS } from '../engine/policy.ts';
import { STATUS_KEY, badgeFor } from '../engine/status.ts';
import type { CommandsModule } from '../modules/commands/module.ts';
import { isSendableUrl } from '../modules/commands/send.ts';
import { createModules } from '../modules/index.ts';

export const POLL_ALARM = 'tz-poll';
export const RETRY_ALARM = 'tz-retry';
/** Chrome refuses alarms sooner than 30 s. */
const MIN_ALARM_MS = 30_000;

/** Messages from popup and options to the background. */
export type SyncMessage =
  | { type: 'sync-now' }
  | { type: 'local-change' }
  | { type: 'send-tab'; target: string; url: string; title?: string };

export function isSyncMessage(value: unknown): value is SyncMessage {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  if (m['type'] === 'sync-now' || m['type'] === 'local-change') return true;
  return (
    m['type'] === 'send-tab' &&
    typeof m['target'] === 'string' &&
    typeof m['url'] === 'string' &&
    (m['title'] === undefined || typeof m['title'] === 'string')
  );
}

export type SendResult = 'sent' | 'refused' | 'signed-out';

export class BackgroundSync {
  readonly #browser: WxtBrowser;
  readonly #engine: SyncEngine;
  readonly #modules: readonly AnyModule[];
  readonly #commands: CommandsModule | undefined;
  #debounce: ReturnType<typeof setTimeout> | undefined;
  #retry: ReturnType<typeof setTimeout> | undefined;

  constructor(
    browser: WxtBrowser,
    options: {
      store?: Promise<EngineStore>;
      modules?: AnyModule[];
      commands?: CommandsModule;
    } = {},
  ) {
    this.#browser = browser;
    const store = options.store ?? openEngineStore();
    if (options.modules === undefined) {
      const created = createModules(browser);
      this.#modules = created.all;
      this.#commands = created.commands;
    } else {
      this.#modules = options.modules;
      this.#commands = options.commands;
    }
    this.#engine = new SyncEngine({
      store: {
        // The store opens lazily on first use; each method waits for it.
        getMirror: async (c, id) => (await store).getMirror(c, id),
        listMirror: async (c) => (await store).listMirror(c),
        listOutbox: async () => (await store).listOutbox(),
        getMeta: async () => (await store).getMeta(),
        commit: async (commit) => (await store).commit(commit),
        clear: async () => (await store).clear(),
      },
      modules: this.#modules,
      session: async () => {
        const state = await getAccountState(browser);
        if (state.status === 'signed-in') {
          const { serverUrl, accountId, deviceId, token } = state.account;
          return { serverUrl, accountId, deviceId, token, accountKey: state.accountKey };
        }
        return state.status === 'locked' ? 'locked' : 'signed-out';
      },
      switches: async () => {
        const settings = await getSettings(browser);
        return { paused: settings.paused, modules: settings.modules };
      },
      client: (serverUrl, token) => clientFor(serverUrl, token),
      onUnauthorized: () => markSignedOut(browser, 'revoked'),
      publishStatus: (status) => this.#publish(status),
      clientVersion: clientVersion(browser),
      now: () => Date.now(),
      random: () => Math.random(),
    });
  }

  /** Make sure the periodic poll exists (ENG-5). Creating it again would reset its schedule. */
  async ensureAlarm(): Promise<void> {
    if ((await this.#browser.alarms.get(POLL_ALARM)) === undefined) {
      await this.#browser.alarms.create(POLL_ALARM, { periodInMinutes: POLL_PERIOD_MINUTES });
    }
  }

  async sync(trigger: Trigger): Promise<EngineStatus> {
    const status = await this.#engine.sync(trigger);
    await this.#scheduleRetry(status);
    return status;
  }

  /**
   * Register every module's browser events (`SyncModule.watch`). Call synchronously at the top
   * level of the background script, so events that wake a suspended worker reach the listeners.
   */
  watchModules(): void {
    for (const module of this.#modules) {
      module.watch?.(() => {
        this.localChange(module.debounceMs);
      });
    }
  }

  /**
   * TAB-7: queue a tab for another device and sync right away (PERF-2). Only web pages are sent;
   * the pages check too, this is the last line.
   */
  async sendTab(target: string, tab: { url: string; title?: string }): Promise<SendResult> {
    if (this.#commands === undefined || !isSendableUrl(tab.url)) return 'refused';
    const state = await getAccountState(this.#browser);
    if (state.status !== 'signed-in') return 'signed-out';
    if (target === state.account.deviceId) return 'refused';
    await this.#commands.send(target, state.account.deviceId, tab);
    void this.sync('ui');
    return 'sent';
  }

  /** ENG-4: a module saw a change; sync after the debounce, restarting it on every change. */
  localChange(delayMs: number = PUSH_DEBOUNCE_MS): void {
    if (this.#debounce !== undefined) clearTimeout(this.#debounce);
    this.#debounce = setTimeout(() => {
      this.#debounce = undefined;
      void this.sync('local-change');
    }, delayMs);
  }

  async onAlarm(name: string): Promise<void> {
    if (name === POLL_ALARM) await this.sync('alarm');
    else if (name === RETRY_ALARM) await this.sync('retry');
  }

  /** Account or settings changed (signed in, unlocked, resumed, module switched): sync now. */
  async onStorageChanged(keys: readonly string[]): Promise<void> {
    if (keys.some((k) => k === 'account' || k === 'accountKey' || k === 'settings')) {
      await this.sync('ui');
    }
  }

  async #scheduleRetry(status: EngineStatus): Promise<void> {
    if (this.#retry !== undefined) clearTimeout(this.#retry);
    this.#retry = undefined;
    if (status.retryAt === undefined) {
      await this.#browser.alarms.clear(RETRY_ALARM);
      return;
    }
    const delay = Math.max(0, status.retryAt - Date.now());
    if (delay < MIN_ALARM_MS) {
      this.#retry = setTimeout(() => {
        this.#retry = undefined;
        void this.sync('retry');
      }, delay);
    }
    // Backup in case the worker is suspended before the timer fires.
    await this.#browser.alarms.create(RETRY_ALARM, {
      when: Date.now() + Math.max(delay, MIN_ALARM_MS),
    });
  }

  async #publish(status: EngineStatus): Promise<void> {
    await this.#browser.storage.local.set({ [STATUS_KEY]: status });
    const badge = badgeFor(status);
    await this.#browser.action.setBadgeText({ text: badge.text });
    if (badge.text !== '')
      await this.#browser.action.setBadgeBackgroundColor({ color: badge.color });
  }
}
