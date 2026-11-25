<script setup lang="ts">
// UI-1: account state (ACC-11, SEC-5), sync status with "Sync now" and "Pause" (ENG-5, ENG-12,
// ENG-13). Other devices' tabs and "Send this tab" arrive with the tabs module.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { refreshAccountState } from '../../account/session.ts';
import type { AccountState } from '../../account/store.ts';
import type { EngineStatus } from '../../engine/engine.ts';
import { statusMessageKey } from '../../engine/status.ts';
import { t } from '../../lib/i18n.ts';
import { openOnboarding } from '../../lib/pages.ts';
import { readStatus, requestSync, togglePaused, watchStatus } from '../../lib/sync-client.ts';

const state = ref<AccountState | undefined>();
const status = ref<EngineStatus | undefined>();
let stopWatching: (() => void) | undefined;

const host = computed(() => {
  const url = state.value?.account?.serverUrl;
  return url === undefined ? '' : new URL(url).host;
});

const statusLine = computed(() => {
  const s = status.value;
  if (s === undefined) return '';
  const key = statusMessageKey(s);
  if (key !== 'statusIdle' || s.lastSuccessAt === undefined) return t(key);
  return t(key, [new Date(s.lastSuccessAt).toLocaleTimeString([], { timeStyle: 'short' })]);
});

onMounted(async () => {
  stopWatching = watchStatus(browser, (next) => {
    status.value = next;
  });
  state.value = await refreshAccountState(browser);
  status.value = await readStatus(browser);
  // ENG-5: opening the popup checks for changes right away (PERF-1: within 5 s).
  if (state.value.status === 'signed-in') void requestSync(browser);
});

onUnmounted(() => {
  stopWatching?.();
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
      <p v-if="status && status.pending > 0" class="muted hint">
        {{ t('statusPending', [String(status.pending)]) }}
      </p>
      <p class="muted hint">{{ t('popupSyncComing') }}</p>
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
    </template>
  </main>
</template>

<style scoped>
.popup {
  inline-size: 22rem;
}

.status {
  margin-block-end: 0.25rem;
}

.actions {
  margin-block-start: 0.75rem;
}
</style>
