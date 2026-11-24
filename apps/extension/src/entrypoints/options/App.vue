<script setup lang="ts">
// UI-3. Account, device name, modules and exclusions arrive with onboarding and the engine.
import { t } from '../../lib/i18n.ts';
</script>

<template>
  <main>
    <h1>{{ t('optionsTitle') }}</h1>
    <p class="muted">{{ t('optionsPlaceholder') }}</p>
  </main>
</template>
