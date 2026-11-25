<script setup lang="ts">
// UI-2. Create or connect an account, passphrase, recovery kit and modules come next (ACC-1…8).
import { t } from '../../lib/i18n.ts';
</script>

<template>
  <main class="onboarding">
    <h1>{{ t('onboardingTitle') }}</h1>
    <p>{{ t('onboardingLead') }}</p>
    <p class="muted">{{ t('onboardingNext') }}</p>
  </main>
</template>

<style scoped>
.onboarding {
  max-inline-size: 40rem;
  margin-inline: auto;
  padding-block: 3rem;
}
</style>
