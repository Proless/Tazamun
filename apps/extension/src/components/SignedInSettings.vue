<script setup lang="ts">
// UI-3 for a signed-in device: account (username ACC-13, recovery key ACC-5), this browser
// (name ACC-7, remember key SEC-5), sync (status, pause, modules with PRIV-2), excluded sites
// (PRIV-3), devices (revoke ACC-8) and sign out (ACC-11). Logic is in src/options/settings.ts.
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import type { schema } from '@tazamun/core';
import RecoveryKey from './RecoveryKey.vue';
import { loadDevices } from '../account/devices.ts';
import { getSettings, setRememberKey, type StoredAccount } from '../account/store.ts';
import type { EngineStatus } from '../engine/engine.ts';
import { clockNotice, statusMessageKey } from '../engine/status.ts';
import { EXCLUSION_EXAMPLES } from '../lib/exclusions.ts';
import { t, uiLocale } from '../lib/i18n.ts';
import { readStatus, requestSync, togglePaused, watchStatus } from '../lib/sync-client.ts';
import { formatLastSeen } from '../modules/tabs/view.ts';
import {
  changeUsername,
  loadAccountInfo,
  newRecoveryKey,
  orderDevices,
  privateAccessAllowed,
  setIncludePrivate,
  parseExclusionText,
  renameThisDevice,
  revokeDevice,
  saveExclusions,
  setModuleEnabled,
  type ActionResult,
  type RecoveryKeyResult,
  type UsernameResult,
} from '../options/settings.ts';

const props = defineProps<{ account: StoredAccount }>();
const emit = defineEmits<{ signOut: []; changed: [] }>();

const status = ref<EngineStatus | undefined>();
const paused = ref(false);
const rememberKey = ref(true);
const tabsOn = ref(true);
const tabsPrivate = ref(false);
const privateAllowed = ref(true);
const confirmingTabsOff = ref(false);
const deviceName = ref(props.account.deviceName);
const nameResult = ref<ActionResult | undefined>();
const exclusionsText = ref('');
const exclusionsSaved = ref(false);
const invalidExclusions = ref<string[]>([]);
const devices = ref<schema.Device[] | undefined>();
const accountInfo = ref<schema.AccountResponse | undefined>();
const usernameInput = ref(props.account.username ?? '');
const usernameResult = ref<UsernameResult | undefined>();
const recoveryAsking = ref(false);
const recoveryPassphrase = ref('');
const recoveryBusy = ref(false);
const recoveryResult = ref<RecoveryKeyResult | undefined>();
const deviceError = ref(false);
let stopWatching: (() => void) | undefined;

const clock = computed(() => (status.value === undefined ? undefined : clockNotice(status.value)));

const statusLine = computed(() => {
  const s = status.value;
  if (s === undefined) return '';
  const key = statusMessageKey(s);
  if (key !== 'statusIdle' || s.lastSuccessAt === undefined) return t(key);
  return t(key, [new Date(s.lastSuccessAt).toLocaleTimeString(uiLocale(), { timeStyle: 'short' })]);
});

async function loadSettings(): Promise<void> {
  const settings = await getSettings(browser);
  paused.value = settings.paused;
  rememberKey.value = settings.rememberKey;
  tabsOn.value = settings.modules.tabs;
  tabsPrivate.value = settings.includePrivate.tabs;
  privateAllowed.value = await privateAccessAllowed(browser);
  exclusionsText.value = settings.exclusions.join('\n');
}

onMounted(async () => {
  stopWatching = watchStatus(browser, (next) => {
    status.value = next;
  });
  status.value = await readStatus(browser);
  await loadSettings();
  const [info, list] = await Promise.all([loadAccountInfo(browser), loadDevices(browser)]);
  accountInfo.value = info;
  if (info !== undefined && info.username !== null) usernameInput.value = info.username;
  devices.value = list;
});

// ---- Account -----------------------------------------------------------------------------------

/** ACC-13: undefined while unknown (offline); null for an account from before usernames. */
const currentUsername = computed(() =>
  accountInfo.value === undefined ? props.account.username : accountInfo.value.username,
);

async function saveUsername(): Promise<void> {
  usernameResult.value = await changeUsername(browser, usernameInput.value);
  if (usernameResult.value.ok) {
    usernameInput.value = usernameResult.value.username;
    if (accountInfo.value !== undefined) {
      accountInfo.value = { ...accountInfo.value, username: usernameResult.value.username };
    }
    emit('changed');
  } else if (usernameResult.value.error === 'signed-out') {
    emit('changed');
  }
}

const usernameError = computed(() => {
  const r = usernameResult.value;
  if (r === undefined || r.ok) return undefined;
  if (r.error === 'invalid') return t('errorUsernameInvalid');
  if (r.error === 'taken') return t('errorUsernameTaken');
  return t('errorGeneric');
});

/** ACC-5: a new recovery key, shown once. Needs the passphrase (one Argon2id run). */
async function makeRecoveryKey(): Promise<void> {
  recoveryBusy.value = true;
  try {
    recoveryResult.value = await newRecoveryKey(browser, recoveryPassphrase.value);
  } finally {
    recoveryBusy.value = false;
    recoveryPassphrase.value = '';
  }
  if (recoveryResult.value.ok) {
    recoveryAsking.value = false;
    if (accountInfo.value !== undefined) {
      accountInfo.value = { ...accountInfo.value, recoveryKey: true };
    }
  } else if (recoveryResult.value.error === 'signed-out') {
    emit('changed');
  }
}

function hideRecoveryKey(): void {
  recoveryResult.value = undefined;
}

const recoveryError = computed(() => {
  const r = recoveryResult.value;
  if (r === undefined || r.ok) return undefined;
  if (r.error === 'wrong-passphrase') return t('unlockWrongPassphrase');
  if (r.error === 'locked') return t('optionsRecoveryLocked');
  return t('errorGeneric');
});

onUnmounted(() => {
  stopWatching?.();
});

// ---- This browser ----------------------------------------------------------------------------

async function rename(): Promise<void> {
  nameResult.value = await renameThisDevice(browser, deviceName.value);
  if (nameResult.value.ok) {
    devices.value = await loadDevices(browser);
    emit('changed');
  }
}

async function changeRemember(): Promise<void> {
  await setRememberKey(browser, rememberKey.value);
}

// ---- Sync --------------------------------------------------------------------------------------

async function syncNow(): Promise<void> {
  await requestSync(browser);
}

async function changePaused(): Promise<void> {
  await togglePaused(browser);
  await loadSettings();
}

function onTabsToggle(): void {
  if (tabsOn.value) {
    void setModuleEnabled(browser, 'tabs', true, false);
  } else {
    // PRIV-2: ask before turning off; the checkbox stays checked until the user decides.
    tabsOn.value = true;
    confirmingTabsOff.value = true;
  }
}

async function changeTabsPrivate(): Promise<void> {
  await setIncludePrivate(browser, 'tabs', tabsPrivate.value);
}

async function turnTabsOff(deleteFromServer: boolean): Promise<void> {
  confirmingTabsOff.value = false;
  tabsOn.value = false;
  await setModuleEnabled(browser, 'tabs', false, deleteFromServer);
}

// ---- Excluded sites ----------------------------------------------------------------------------

function addExamples(): void {
  const current = parseExclusionText(exclusionsText.value).patterns;
  const merged = [...current, ...EXCLUSION_EXAMPLES.filter((e) => !current.includes(e))];
  exclusionsText.value = merged.join('\n');
  exclusionsSaved.value = false;
}

async function saveExcluded(): Promise<void> {
  const { patterns, invalid } = parseExclusionText(exclusionsText.value);
  invalidExclusions.value = invalid;
  if (invalid.length > 0) return;
  await saveExclusions(browser, patterns);
  exclusionsText.value = patterns.join('\n');
  exclusionsSaved.value = true;
}

// ---- Devices -------------------------------------------------------------------------------------

const ordered = computed(() => orderDevices(devices.value ?? []));
const now = Date.now();

async function revoke(device: schema.Device): Promise<void> {
  if (!window.confirm(t('devicesRevokeConfirm', [device.name]))) return;
  const result = await revokeDevice(browser, device.id);
  deviceError.value = !result.ok;
  if (result.ok) devices.value = await loadDevices(browser);
  else if (result.error === 'signed-out') emit('changed');
}
</script>

<template>
  <section class="no-print">
    <h2>{{ t('optionsUsername') }}</h2>
    <p v-if="currentUsername === null" role="alert" class="warning-box">
      {{ t('optionsUsernameMissing') }}
    </p>
    <form novalidate @submit.prevent="saveUsername">
      <label for="username">{{ t('usernameLabel') }}</label>
      <div class="inline">
        <input
          id="username"
          v-model="usernameInput"
          type="text"
          spellcheck="false"
          autocapitalize="none"
          autocomplete="username"
          maxlength="64"
        />
        <button type="submit" class="secondary">{{ t('optionsUsernameSave') }}</button>
      </div>
      <p class="muted hint">{{ t('optionsUsernameHelp') }}</p>
      <p v-if="usernameResult?.ok" role="status" class="hint">{{ t('optionsSaved') }}</p>
      <p v-else-if="usernameError" role="alert" class="error">{{ usernameError }}</p>
    </form>
  </section>

  <section>
    <h2 class="no-print">{{ t('optionsRecoveryHeading') }}</h2>
    <template v-if="recoveryResult?.ok">
      <p class="no-print warning-box">{{ t('optionsRecoveryShown') }}</p>
      <RecoveryKey
        :info="{
          serverUrl: account.serverUrl,
          username: currentUsername ?? '',
          recoveryKey: recoveryResult.recoveryKey,
        }"
      />
      <div class="actions no-print spaced">
        <button type="button" @click="hideRecoveryKey">{{ t('recoverySaved') }}</button>
      </div>
    </template>
    <template v-else>
      <p v-if="accountInfo?.recoveryKey === false" role="alert" class="no-print warning-box">
        {{ t('optionsRecoveryMissing') }}
      </p>
      <p v-else-if="accountInfo?.recoveryKey" class="muted hint no-print">
        {{ t('optionsRecoverySet') }}
      </p>
      <form v-if="recoveryAsking" class="no-print" novalidate @submit.prevent="makeRecoveryKey">
        <label for="recovery-passphrase">{{ t('optionsRecoveryPassphrase') }}</label>
        <div class="inline">
          <input
            id="recovery-passphrase"
            v-model="recoveryPassphrase"
            type="password"
            autocomplete="current-password"
          />
          <button type="submit" :disabled="recoveryBusy">{{ t('optionsRecoveryNew') }}</button>
        </div>
        <p v-if="recoveryBusy" role="status">{{ t('deriving') }}</p>
      </form>
      <button v-else type="button" class="secondary no-print" @click="recoveryAsking = true">
        {{ t('optionsRecoveryNew') }}
      </button>
      <p v-if="recoveryError" role="alert" class="error no-print">{{ recoveryError }}</p>
    </template>
  </section>

  <section class="no-print">
    <h2>{{ t('optionsThisBrowser') }}</h2>
    <form novalidate @submit.prevent="rename">
      <label for="device-name">{{ t('deviceNameLabel') }}</label>
      <div class="inline">
        <input id="device-name" v-model="deviceName" type="text" maxlength="100" />
        <button type="submit" class="secondary">{{ t('optionsRename') }}</button>
      </div>
      <p class="muted hint">{{ t('deviceNameHelp') }}</p>
      <p v-if="nameResult?.ok" role="status" class="hint">{{ t('optionsSaved') }}</p>
      <p v-else-if="nameResult?.error === 'invalid'" role="alert" class="error">
        {{ t('errorDeviceNameEmpty') }}
      </p>
      <p v-else-if="nameResult" role="alert" class="error">{{ t('errorGeneric') }}</p>
    </form>
    <label class="check">
      <input v-model="rememberKey" type="checkbox" @change="changeRemember" />
      <span>
        {{ t('optionsRememberKey') }}
        <span class="muted hint block">{{ t('optionsRememberKeyHelp') }}</span>
      </span>
    </label>
  </section>

  <section class="no-print">
    <h2>{{ t('optionsSync') }}</h2>
    <p v-if="statusLine" role="status">{{ statusLine }}</p>
    <p v-if="clock" role="alert" class="warning-box">{{ t(clock.key, clock.substitutions) }}</p>
    <div class="actions">
      <button type="button" :disabled="paused" @click="syncNow">{{ t('syncNow') }}</button>
      <button type="button" class="secondary" @click="changePaused">
        {{ paused ? t('syncResume') : t('syncPause') }}
      </button>
    </div>
    <h3>{{ t('modulesHeading') }}</h3>
    <label class="check">
      <input v-model="tabsOn" type="checkbox" @change="onTabsToggle" />
      <span>
        {{ t('moduleTabs') }}
        <span class="muted hint block">{{ t('moduleTabsHelp') }}</span>
      </span>
    </label>
    <label class="check nested">
      <input
        v-model="tabsPrivate"
        type="checkbox"
        :disabled="!tabsOn"
        @change="changeTabsPrivate"
      />
      <span>
        {{ t('privateWindowsTabs') }}
        <span class="muted hint block">{{ t('privateWindowsHelp') }}</span>
      </span>
    </label>
    <p v-if="tabsPrivate && !privateAllowed" role="alert" class="warning-box nested">
      {{ t('privateWindowsNotAllowed') }}
    </p>
    <div v-if="confirmingTabsOff" class="confirm" role="alertdialog" aria-labelledby="tabs-off">
      <p id="tabs-off">{{ t('moduleOffQuestion') }}</p>
      <div class="actions">
        <button type="button" @click="turnTabsOff(true)">{{ t('moduleOffDelete') }}</button>
        <button type="button" class="secondary" @click="turnTabsOff(false)">
          {{ t('moduleOffKeep') }}
        </button>
        <button type="button" class="secondary" @click="confirmingTabsOff = false">
          {{ t('optionsCancel') }}
        </button>
      </div>
    </div>
    <p class="muted hint">{{ t('modulesLater') }}</p>
  </section>

  <section class="no-print">
    <h2>{{ t('exclusionsHeading') }}</h2>
    <p class="muted hint">{{ t('exclusionsHelp') }}</p>
    <label for="exclusions" class="visually-hidden">{{ t('exclusionsHeading') }}</label>
    <textarea
      id="exclusions"
      v-model="exclusionsText"
      rows="6"
      spellcheck="false"
      :placeholder="'bank.example\nhealth.example/records'"
      @input="exclusionsSaved = false"
    ></textarea>
    <p v-if="invalidExclusions.length > 0" role="alert" class="error">
      {{ t('exclusionsInvalid', [invalidExclusions.join(', ')]) }}
    </p>
    <p v-else-if="exclusionsSaved" role="status" class="hint">{{ t('optionsSaved') }}</p>
    <div class="actions">
      <button type="button" @click="saveExcluded">{{ t('optionsSave') }}</button>
      <button type="button" class="secondary" @click="addExamples">
        {{ t('exclusionsAddExamples') }}
      </button>
    </div>
  </section>

  <section class="no-print">
    <h2>{{ t('devicesHeading') }}</h2>
    <p v-if="devices === undefined" class="muted hint">{{ t('devicesUnavailable') }}</p>
    <ul v-else class="devices">
      <li v-for="device in ordered" :key="device.id">
        <span>
          <strong>{{ device.name }}</strong>
          <span v-if="device.current" class="muted"> · {{ t('devicesThisOne') }}</span>
          <span class="muted hint block">
            {{ device.browser.family }} {{ device.browser.version }} ·
            {{ formatLastSeen(Date.parse(device.lastSeenAt), now, uiLocale()) }}
          </span>
        </span>
        <button v-if="!device.current" type="button" class="secondary" @click="revoke(device)">
          {{ t('devicesRevoke') }}
        </button>
      </li>
    </ul>
    <p v-if="deviceError" role="alert" class="error">{{ t('errorGeneric') }}</p>
  </section>

  <section class="no-print">
    <h2>{{ t('optionsSignOut') }}</h2>
    <p class="muted hint">{{ t('optionsSignOutHelp') }}</p>
    <button type="button" class="secondary" @click="emit('signOut')">
      {{ t('optionsSignOut') }}
    </button>
  </section>
</template>

<style scoped>
section {
  margin-block-end: 2rem;
}

h3 {
  margin-block: 1.25rem 0.25rem;
  font-size: 0.95rem;
}

.inline {
  display: flex;
  gap: 0.5rem;
}

.inline input {
  flex: 1;
}

textarea {
  box-sizing: border-box;
  inline-size: 100%;
  padding: 0.5rem 0.625rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  font: inherit;
  font-family: ui-monospace, monospace;
  color: inherit;
  background: transparent;
  margin-block: 0.5rem;
}

.nested {
  margin-inline-start: 1.75rem;
}

.warning-box {
  padding: 0.75rem;
  border-radius: 6px;
  background: var(--warning-bg);
}

.spaced {
  margin-block-start: 1rem;
}

.confirm {
  margin-block: 0.5rem;
  padding: 0.75rem;
  border-radius: 6px;
  background: var(--warning-bg);
}

.devices {
  margin: 0;
  padding: 0;
  list-style: none;
}

.devices li {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 1rem;
  padding-block: 0.5rem;
  border-block-end: 1px solid var(--border);
}

.visually-hidden {
  position: absolute;
  inline-size: 1px;
  block-size: 1px;
  overflow: hidden;
  clip-path: inset(50%);
}
</style>
