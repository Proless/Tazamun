<script setup lang="ts">
// TAB-6: other devices' tabs, grouped by device and window, with device name and last-seen time.
// Click a tab to open it here, or open a whole window. Favicons aren't loaded: fetching them from
// the sites would be a third-party request (PRIV-4).
import { computed, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { schema } from '@tazamun/core';
import { t, uiLocale } from '../lib/i18n.ts';
import { openTab, openWindow, type OpenResult } from '../modules/tabs/open.ts';
import {
  displayHost,
  formatLastSeen,
  otherDevicesTabs,
  type DeviceTabs,
} from '../modules/tabs/view.ts';
import type { SyncRecord } from '../engine/module.ts';

const props = defineProps<{
  records: SyncRecord<schema.TabsData>[];
  devices: schema.Device[] | undefined;
  selfId: string;
}>();

const result = ref<OpenResult | undefined>();
const now = Date.now();
const locale = uiLocale();

const groups = computed<DeviceTabs[]>(() =>
  otherDevicesTabs(props.records, props.devices, props.selfId),
);

function deviceLabel(group: DeviceTabs): string {
  const name = group.name ?? t('tabsUnknownDevice');
  return group.lastSeenAt === undefined
    ? name
    : t('tabsDeviceSeen', [name, formatLastSeen(group.lastSeenAt, now, locale)]);
}

async function open(url: string): Promise<void> {
  result.value = await openTab(browser, url, navigator.clipboard);
  if (result.value === 'opened') window.close();
}

async function openAll(w: schema.TabWindow): Promise<void> {
  result.value = await openWindow(
    browser,
    w.tabs.map((tab) => tab.url),
    navigator.clipboard,
  );
  if (result.value === 'opened') window.close();
}
</script>

<template>
  <section class="other-tabs">
    <h2>{{ t('tabsHeading') }}</h2>
    <p v-if="groups.length === 0" class="muted hint">{{ t('tabsNone') }}</p>
    <div v-for="group in groups" :key="group.deviceId" class="device">
      <h3>{{ deviceLabel(group) }}</h3>
      <div v-for="(w, i) in group.windows" :key="i" class="window">
        <div v-if="group.windows.length > 1 || w.tabs.length > 1 || w.private" class="window-head">
          <span class="muted">
            {{ t('tabsWindow', [String(i + 1), String(w.tabs.length)]) }}
            <template v-if="w.private"> · {{ t('tabsPrivateWindow') }}</template>
          </span>
          <button type="button" class="link" @click="openAll(w)">{{ t('tabsOpenAll') }}</button>
        </div>
        <ul>
          <li v-for="(tab, j) in w.tabs" :key="j">
            <button type="button" class="tab" :title="tab.url" @click="open(tab.url)">
              <span class="title">{{ tab.title || displayHost(tab.url) }}</span>
              <span class="host muted">{{ displayHost(tab.url) }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
    <p v-if="result === 'copied'" role="status" class="hint">{{ t('tabsCopied') }}</p>
    <p v-if="result === 'failed'" role="alert" class="error">{{ t('tabsOpenFailed') }}</p>
  </section>
</template>

<style scoped>
.other-tabs {
  max-block-size: 26rem;
  overflow-y: auto;
  margin-block-start: 0.75rem;
}

h2 {
  margin-block: 0 0.5rem;
  font-size: 1rem;
}

h3 {
  margin-block: 0.75rem 0.25rem;
  font-size: 0.9rem;
}

.window-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  font-size: 0.8rem;
}

ul {
  margin: 0;
  padding: 0;
  list-style: none;
}

button.tab {
  display: grid;
  inline-size: 100%;
  padding: 0.3rem 0.4rem;
  border-radius: 4px;
  text-align: start;
  color: inherit;
  background: transparent;
}

button.tab:hover,
button.tab:focus-visible {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.title,
.host {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.host {
  font-size: 0.75rem;
}

button.link {
  padding: 0;
  color: var(--accent);
  background: transparent;
  font-size: 0.8rem;
}
</style>
