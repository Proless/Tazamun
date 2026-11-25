<script setup lang="ts">
// UI-3 (account part): server and account, recovery kit (ACC-5), remember the key (SEC-5),
// unlock, sign out and the signed-out state (ACC-11). Modules, exclusions and the rest follow.
import { onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import RecoveryKit from '../../components/RecoveryKit.vue';
import { refreshAccountState, signOut, unlock } from '../../account/session.ts';
import {
  forgetAccount,
  getSettings,
  setRememberKey,
  type AccountState,
} from '../../account/store.ts';
import { openEngineStore } from '../../engine/idb-store.ts';
import { t } from '../../lib/i18n.ts';
import { openOnboarding } from '../../lib/pages.ts';
import { errorKey, type MessageKey } from '../../onboarding/form.ts';

const state = ref<AccountState | undefined>();
const rememberKey = ref(true);
const passphrase = ref('');
const busy = ref(false);
const error = ref<MessageKey | undefined>();

async function load(): Promise<void> {
  const [current, settings] = await Promise.all([
    refreshAccountState(browser),
    getSettings(browser),
  ]);
  state.value = current;
  rememberKey.value = settings.rememberKey;
}

onMounted(load);

async function changeRemember(): Promise<void> {
  await setRememberKey(browser, rememberKey.value);
}

async function submitUnlock(): Promise<void> {
  error.value = undefined;
  busy.value = true;
  try {
    await unlock(browser, passphrase.value);
    passphrase.value = '';
  } catch (err) {
    error.value = errorKey(err);
  } finally {
    busy.value = false;
  }
  await load();
}

async function doSignOut(): Promise<void> {
  busy.value = true;
  try {
    await signOut(browser);
  } finally {
    busy.value = false;
  }
  await load();
}

async function forget(): Promise<void> {
  if (!window.confirm(t('optionsForgetConfirm'))) return;
  await forgetAccount(browser);
  // The synced copies of other devices' data, the outbox and the sync state (ACC-11: removed
  // only now, when the user asks).
  const store = await openEngineStore();
  await store.clear();
  store.close();
  await load();
}

async function setUp(): Promise<void> {
  await openOnboarding(browser);
}
</script>

<template>
  <main class="options">
    <h1 class="no-print">{{ t('optionsTitle') }}</h1>
    <h2 class="no-print">{{ t('optionsAccount') }}</h2>

    <template v-if="state === undefined"></template>

    <template v-else-if="state.status === 'signed-out'">
      <p>{{ t('optionsNotConnected') }}</p>
      <button type="button" @click="setUp">{{ t('popupSetUp') }}</button>
    </template>

    <template v-else-if="state.status === 'disconnected'">
      <p>
        {{ state.account.signedOut === 'revoked' ? t('optionsRevoked') : t('optionsSignedOut') }}
      </p>
      <dl class="facts">
        <dt>{{ t('optionsServer') }}</dt>
        <dd>
          <code>{{ state.account.serverUrl }}</code>
        </dd>
        <dt>{{ t('optionsAccountId') }}</dt>
        <dd>
          <code>{{ state.account.accountId }}</code>
        </dd>
      </dl>
      <div class="actions">
        <button type="button" @click="setUp">{{ t('optionsSignInAgain') }}</button>
        <button type="button" class="secondary" @click="forget">{{ t('optionsForget') }}</button>
      </div>
    </template>

    <form v-else-if="state.status === 'locked'" novalidate @submit.prevent="submitUnlock">
      <p>{{ t('optionsUnlockLead') }}</p>
      <label for="passphrase">{{ t('passphraseLabel') }}</label>
      <input
        id="passphrase"
        v-model="passphrase"
        type="password"
        autocomplete="current-password"
        autofocus
      />
      <p v-if="busy" role="status">{{ t('deriving') }}</p>
      <div class="actions spaced">
        <button type="submit" :disabled="busy">{{ t('unlockButton') }}</button>
        <button type="button" class="secondary" :disabled="busy" @click="doSignOut">
          {{ t('optionsSignOut') }}
        </button>
      </div>
    </form>

    <template v-else>
      <dl class="facts no-print">
        <dt>{{ t('optionsDeviceName') }}</dt>
        <dd>{{ state.account.deviceName }}</dd>
      </dl>
      <RecoveryKit :server-url="state.account.serverUrl" :account-id="state.account.accountId" />
      <label class="check no-print">
        <input v-model="rememberKey" type="checkbox" @change="changeRemember" />
        <span>
          {{ t('optionsRememberKey') }}
          <span class="muted hint block">{{ t('optionsRememberKeyHelp') }}</span>
        </span>
      </label>
      <div class="actions spaced no-print">
        <button type="button" class="secondary" :disabled="busy" @click="doSignOut">
          {{ t('optionsSignOut') }}
        </button>
        <span class="muted hint">{{ t('optionsSignOutHelp') }}</span>
      </div>
    </template>

    <p v-if="error" role="alert" class="error">{{ t(error) }}</p>
  </main>
</template>

<style scoped>
.options {
  max-inline-size: 40rem;
  margin-inline: auto;
  padding-block: 2rem;
}

.facts {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
}

.facts dt {
  color: var(--fg-muted);
}

.facts dd {
  margin: 0;
  overflow-wrap: anywhere;
}

.spaced {
  margin-block-start: 1.5rem;
}
</style>
