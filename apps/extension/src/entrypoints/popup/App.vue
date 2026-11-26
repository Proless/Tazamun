<script setup lang="ts">
// UI-1: account state (ACC-11, SEC-5), sync status with "Sync now" and "Pause" (ENG-5, ENG-12,
// ENG-13) and other devices' tabs (TAB-6), checked every few seconds while open (PERF-1).
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { schema } from '@tazamun/core';
import OtherTabs from '../../components/OtherTabs.vue';
import { loadDevices } from '../../account/devices.ts';
import type { SyncRecord } from '../../engine/module.ts';
import { refreshAccountState } from '../../account/session.ts';
import type { AccountState } from '../../account/store.ts';
import type { EngineStatus } from '../../engine/engine.ts';
import { clockNotice, statusMessageKey } from '../../engine/status.ts';
import { t, uiLocale } from '../../lib/i18n.ts';
import { openOnboarding } from '../../lib/pages.ts';
import {
  readMirror,
  readStatus,
  requestSync,
  togglePaused,
  watchStatus,
} from '../../lib/sync-client.ts';

const state = ref<AccountState | undefined>();
const status = ref<EngineStatus | undefined>();
const tabs = ref<SyncRecord<schema.TabsData>[]>([]);
const devices = ref<schema.Device[] | undefined>();
let stopWatching: (() => void) | undefined;
let poll: ReturnType<typeof setInterval> | undefined;

/**
 * PERF-1: while the popup is open, check for changes this often. With TAB-5's 5 s debounce on the
 * other side, a change shows within about 12 s. Each check is one `GET /v1/info` when nothing
 * changed, and it respects the backoff.
 */
const POLL_MS = 5_000;

const host = computed(() => {
  const url = state.value?.account?.serverUrl;
  return url === undefined ? '' : new URL(url).host;
});

const clock = computed(() => (status.value === undefined ? undefined : clockNotice(status.value)));

const statusLine = computed(() => {
  const s = status.value;
  if (s === undefined) return '';
  const key = statusMessageKey(s);
  if (key !== 'statusIdle' || s.lastSuccessAt === undefined) return t(key);
  return t(key, [new Date(s.lastSuccessAt).toLocaleTimeString(uiLocale(), { timeStyle: 'short' })]);
});

onMounted(async () => {
  stopWatching = watchStatus(browser, (next) => {
    const finished = status.value?.state === 'syncing' && next.state !== 'syncing';
    status.value = next;
    if (finished) void loadTabs();
  });
  state.value = await refreshAccountState(browser);
  status.value = await readStatus(browser);
  if (state.value.status !== 'signed-in') return;
  await loadTabs();
  // ENG-5: opening the popup checks for changes right away, then every POLL_MS (PERF-1).
  void requestSync(browser);
  poll = setInterval(() => {
    void requestSync(browser, 'poll');
  }, POLL_MS);
  devices.value = await loadDevices(browser);
});

async function loadTabs(): Promise<void> {
  tabs.value = await readMirror<schema.TabsData>('tabs');
}

onUnmounted(() => {
  stopWatching?.();
  if (poll !== undefined) clearInterval(poll);
});

async function setUp(): Promise<void> {
  await openOnboarding(browser);
  window.close();
}

async function openSettings(): Promise<void> {
  await browser.runtime.openOptionsPage();
  window.close();
}

async function syncNow(): Promise<void> {
  await requestSync(browser);
}

async function togglePause(): Promise<void> {
  await togglePaused(browser);
}
</script>

<template>
  <main class="popup">
    <h1>{{ t('extName') }}</h1>
    <template v-if="state === undefined"></template>

    <template v-else-if="state.status === 'signed-out'">
      <p class="muted">{{ t('popupNotConnected') }}</p>
      <button type="button" @click="setUp">{{ t('popupSetUp') }}</button>
    </template>

    <template v-else-if="state.status === 'disconnected'">
      <p class="muted">
        {{ state.account.signedOut === 'revoked' ? t('optionsRevoked') : t('optionsSignedOut') }}
      </p>
      <button type="button" @click="setUp">{{ t('optionsSignInAgain') }}</button>
    </template>

    <template v-else-if="state.status === 'locked'">
      <p class="muted">{{ t('popupLocked') }}</p>
      <button type="button" @click="openSettings">{{ t('popupUnlock') }}</button>
    </template>

    <template v-else>
      <p>{{ t('popupConnected', [host, state.account.deviceName]) }}</p>
      <p v-if="statusLine" role="status" class="status">{{ statusLine }}</p>
      <p v-if="clock" role="alert" class="warning-box">{{ t(clock.key, clock.substitutions) }}</p>
      <p v-if="status && status.pending > 0" class="muted hint">
        {{ t('statusPending', [String(status.pending)]) }}
      </p>
      <div class="actions">
        <button
          type="button"
          :disabled="status?.state === 'syncing' || status?.state === 'paused'"
          @click="syncNow"
        >
          {{ t('syncNow') }}
        </button>
        <button type="button" class="secondary" @click="togglePause">
          {{ status?.state === 'paused' ? t('syncResume') : t('syncPause') }}
        </button>
        <button type="button" class="secondary" @click="openSettings">
          {{ t('popupOpenSettings') }}
        </button>
      </div>
      <OtherTabs :records="tabs" :devices="devices" :self-id="state.account.deviceId" />
    </template>
  </main>
</template>

<style scoped>
.popup {
  inline-size: 22rem;
}

.warning-box {
  padding: 0.5rem 0.625rem;
  border-radius: 6px;
  background: var(--warning-bg);
  font-size: 0.85rem;
}

.status {
  margin-block-end: 0.25rem;
}

.actions {
  margin-block-start: 0.75rem;
}
</style>
