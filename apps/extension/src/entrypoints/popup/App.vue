<script setup lang="ts">
// UI-1. Status, other devices' tabs and "Send this tab" arrive with the engine and tabs module.
import { browser } from 'wxt/browser';
import { t } from '../../lib/i18n.ts';
import { openOnboarding } from '../../lib/pages.ts';

async function setUp(): Promise<void> {
  await openOnboarding(browser);
  window.close();
}
</script>

<template>
  <main class="popup">
    <h1>{{ t('extName') }}</h1>
    <p class="muted">{{ t('popupNotConnected') }}</p>
    <button type="button" @click="setUp">{{ t('popupSetUp') }}</button>
  </main>
</template>

<style scoped>
.popup {
  inline-size: 20rem;
}
</style>
