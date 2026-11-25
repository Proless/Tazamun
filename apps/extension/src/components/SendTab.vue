<script setup lang="ts">
// TAB-7: send the current tab to another device. The background queues the command and syncs at
// once; the target opens it on its next poll (PERF-2: within 90 s).
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { schema } from '@tazamun/core';
import { t } from '../lib/i18n.ts';
import { sendTab } from '../lib/sync-client.ts';
import { sendTargets } from '../modules/commands/receive.ts';
import { sendRefusal, type SendRefusal } from '../modules/commands/send.ts';

const props = defineProps<{ devices: schema.Device[] | undefined; selfId: string }>();

const current = ref<{ url?: string | undefined; title?: string | undefined; incognito: boolean }>();
const result = ref<'sent' | 'failed' | undefined>();
const busy = ref(false);

const targets = computed(() => sendTargets(props.devices ?? [], props.selfId));
const refusal = computed<SendRefusal | undefined>(() =>
  current.value === undefined ? undefined : sendRefusal(current.value),
);

onMounted(async () => {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab !== undefined)
    current.value = { url: tab.url, title: tab.title, incognito: tab.incognito };
});

async function send(target: string): Promise<void> {
  const tab = current.value;
  if (tab?.url === undefined || refusal.value !== undefined) return;
  busy.value = true;
  const sent = await sendTab(browser, target, {
    url: tab.url,
    ...(tab.title === undefined || tab.title === '' ? {} : { title: tab.title }),
  });
  busy.value = false;
  result.value = sent === 'sent' ? 'sent' : 'failed';
}
</script>

<template>
  <section v-if="current" class="send">
    <h2>{{ t('sendHeading') }}</h2>
    <p v-if="refusal === 'private'" class="muted hint">{{ t('sendPrivate') }}</p>
    <p v-else-if="refusal === 'not-a-web-page'" class="muted hint">{{ t('sendNotWebPage') }}</p>
    <p v-else-if="devices !== undefined && targets.length === 0" class="muted hint">
      {{ t('sendNoDevices') }}
    </p>
    <div v-else class="targets">
      <button
        v-for="device in targets"
        :key="device.id"
        type="button"
        class="secondary"
        :disabled="busy"
        @click="send(device.id)"
      >
        {{ t('sendTo', [device.name]) }}
      </button>
    </div>
    <p v-if="result === 'sent'" role="status" class="hint">{{ t('sendSent') }}</p>
    <p v-if="result === 'failed'" role="alert" class="error">{{ t('sendFailed') }}</p>
  </section>
</template>

<style scoped>
.send {
  margin-block-start: 0.75rem;
}

h2 {
  margin-block: 0 0.5rem;
  font-size: 1rem;
}

.targets {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
}
</style>
