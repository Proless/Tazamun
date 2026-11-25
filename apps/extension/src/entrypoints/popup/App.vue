<script setup lang="ts">
// UI-1, account part: signed out, disconnected (ACC-11), locked (SEC-5) or connected. Sync status,
// other devices' tabs and "Send this tab" arrive with the engine and the tabs module.
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { refreshAccountState } from '../../account/session.ts';
import type { AccountState } from '../../account/store.ts';
import { t } from '../../lib/i18n.ts';
import { openOnboarding } from '../../lib/pages.ts';

const state = ref<AccountState | undefined>();

const host = computed(() => {
  const url = state.value?.account?.serverUrl;
  return url === undefined ? '' : new URL(url).host;
});

onMounted(async () => {
  state.value = await refreshAccountState(browser);
});

async function setUp(): Promise<void> {
  await openOnboarding(browser);
  window.close();
}

async function openSettings(): Promise<void> {
  await browser.runtime.openOptionsPage();
  window.close();
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
      <p class="muted">{{ t('popupSyncComing') }}</p>
      <button type="button" class="secondary" @click="openSettings">
        {{ t('popupOpenSettings') }}
      </button>
    </template>
  </main>
</template>

<style scoped>
.popup {
  inline-size: 20rem;
}
</style>
