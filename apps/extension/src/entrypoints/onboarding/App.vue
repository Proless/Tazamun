<script setup lang="ts">
// UI-2: create or connect an account, choose modules, recovery kit (SRS 3.1, ACC-1…8).
// Validation and error mapping live in src/onboarding/form.ts; flows in src/account/session.ts.
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { account } from '@tazamun/core';
import RecoveryKit from '../../components/RecoveryKit.vue';
import {
  OnboardingError,
  checkServer,
  connectAndSignIn,
  createAndSignIn,
  requestServerPermission,
  thisDevice,
} from '../../account/session.ts';
import { getAccountState, getSettings, saveSettings } from '../../account/store.ts';
import { t } from '../../lib/i18n.ts';
import {
  STRENGTH_KEYS,
  errorKey,
  parseServerStep,
  validateAccountId,
  validateDeviceName,
  validateNewPassphrase,
  type MessageKey,
} from '../../onboarding/form.ts';

type Mode = 'create' | 'connect';
type Step = 'welcome' | 'server' | 'device' | 'passphrase' | 'kit' | 'done';

const mode = ref<Mode>('create');
const step = ref<Step>('welcome');
const busy = ref<'' | 'server' | 'keys'>('');
const error = ref<MessageKey | undefined>();

// Server step
const serverInput = ref('');
const serverUrl = ref('');
const inviteNeeded = ref(false);

// Device step
const deviceName = ref('');
const deviceBrowser = ref({ family: 'chromium', version: '0' });
const rememberKey = ref(true);
const syncTabs = ref(true);

// Passphrase step
const accountIdInput = ref('');
const accountIdKnown = ref(false);
const passphrase = ref('');
const confirmation = ref('');
const acknowledged = ref(false);
const invite = ref('');

// Result
const accountId = ref('');

/** Set up before on this browser (signed out or revoked): offer to sign in again. */
const previous = ref<{ serverUrl: string; accountId: string } | undefined>();
/** ACC-12: this profile has (or had) an account; another one would replace it here. */
const existingServer = ref<string | undefined>();

const strength = computed(() => account.estimateStrength(passphrase.value));
const steps = computed<Step[]>(() =>
  mode.value === 'create'
    ? ['server', 'device', 'passphrase', 'kit']
    : ['server', 'device', 'passphrase'],
);
const stepNumber = computed(() => steps.value.indexOf(step.value) + 1);

onMounted(async () => {
  const [device, settings, state] = await Promise.all([
    thisDevice(browser, navigator.userAgent),
    getSettings(browser),
    getAccountState(browser),
  ]);
  deviceBrowser.value = device.browser;
  deviceName.value = state.account?.deviceName ?? device.defaultName;
  rememberKey.value = settings.rememberKey;
  syncTabs.value = settings.modules.tabs;
  if (state.status === 'disconnected') {
    previous.value = { serverUrl: state.account.serverUrl, accountId: state.account.accountId };
  }
  existingServer.value = state.account?.serverUrl;
});

function start(chosen: Mode): void {
  mode.value = chosen;
  error.value = undefined;
  step.value = 'server';
}

function back(): void {
  error.value = undefined;
  const index = steps.value.indexOf(step.value);
  step.value = index <= 0 ? 'welcome' : (steps.value[index - 1] ?? 'welcome');
}

/**
 * Server step. The permission request must be the first browser call in the click handler, before
 * any `await`, or the browser refuses it for lack of a user gesture.
 */
async function submitServer(): Promise<void> {
  error.value = undefined;
  const parsed = parseServerStep(mode.value, serverInput.value);
  if (!parsed.ok) {
    error.value = parsed.error;
    return;
  }
  const granted = requestServerPermission(browser, parsed.value.serverUrl);
  busy.value = 'server';
  try {
    if (!(await granted)) throw new OnboardingError('permission-denied');
    const info = await checkServer(browser, parsed.value.serverUrl);
    if (mode.value === 'create' && info.registration === 'closed') {
      throw new OnboardingError('registration-closed');
    }
    inviteNeeded.value = info.registration === 'invite';
    serverUrl.value = parsed.value.serverUrl;
    const fromCode = parsed.value.accountId;
    if (fromCode !== undefined) accountIdInput.value = fromCode;
    accountIdKnown.value = fromCode !== undefined;
    step.value = 'device';
  } catch (err) {
    error.value = errorKey(err);
  } finally {
    busy.value = '';
  }
}

/** "Sign in again": the server and account are known; the permission may need asking again. */
async function reconnect(): Promise<void> {
  if (previous.value === undefined) return;
  mode.value = 'connect';
  serverInput.value = account.formatPairingCode(previous.value);
  await submitServer();
}

async function submitDevice(): Promise<void> {
  const name = validateDeviceName(deviceName.value);
  if (!name.ok) {
    error.value = name.error;
    return;
  }
  deviceName.value = name.value;
  error.value = undefined;
  const settings = await getSettings(browser);
  await saveSettings(browser, {
    ...settings,
    modules: { ...settings.modules, tabs: syncTabs.value },
  });
  step.value = 'passphrase';
}

async function submitPassphrase(): Promise<void> {
  error.value = undefined;
  const device = { name: deviceName.value, browser: deviceBrowser.value };
  if (mode.value === 'create') {
    const invalid = validateNewPassphrase(passphrase.value, confirmation.value, acknowledged.value);
    if (invalid !== undefined) {
      error.value = invalid;
      return;
    }
  }
  const id = validateAccountId(accountIdInput.value);
  if (mode.value === 'connect' && !id.ok) {
    error.value = id.error;
    return;
  }
  busy.value = 'keys';
  try {
    if (mode.value === 'create') {
      accountId.value = await createAndSignIn(browser, {
        serverUrl: serverUrl.value,
        passphrase: passphrase.value,
        invite: invite.value.trim(),
        device,
        rememberKey: rememberKey.value,
      });
      step.value = 'kit';
    } else if (id.ok) {
      await connectAndSignIn(browser, {
        serverUrl: serverUrl.value,
        accountId: id.value,
        passphrase: passphrase.value,
        device,
        rememberKey: rememberKey.value,
      });
      accountId.value = id.value;
      step.value = 'done';
    }
    // Don't keep the passphrase in the page any longer than needed.
    passphrase.value = '';
    confirmation.value = '';
  } catch (err) {
    error.value = errorKey(err);
  } finally {
    busy.value = '';
  }
}

function closeTab(): void {
  window.close();
}
</script>

<template>
  <main class="onboarding">
    <p v-if="stepNumber > 0" class="muted no-print">
      {{ t('onboardingStep', [String(stepNumber), String(steps.length)]) }}
    </p>

    <!-- Welcome -->
    <section v-if="step === 'welcome'">
      <h1>{{ t('onboardingTitle') }}</h1>
      <p>{{ t('onboardingLead') }}</p>
      <div class="choices">
        <button v-if="previous" type="button" class="choice" @click="reconnect">
          <strong>{{ t('onboardingReconnect', [previous.serverUrl]) }}</strong>
        </button>
        <button
          type="button"
          class="choice"
          :class="{ secondary: previous }"
          @click="start('create')"
        >
          <strong>{{ t('onboardingCreate') }}</strong>
          <span>{{ t('onboardingCreateHelp') }}</span>
        </button>
        <button type="button" class="choice secondary" @click="start('connect')">
          <strong>{{ t('onboardingConnect') }}</strong>
          <span>{{ t('onboardingConnectHelp') }}</span>
        </button>
      </div>
      <p v-if="existingServer" class="muted hint replace-note">
        {{ t('onboardingReplaceNote', [existingServer]) }}
      </p>
    </section>

    <!-- Server -->
    <form v-else-if="step === 'server'" novalidate @submit.prevent="submitServer">
      <h1>{{ t('serverHeading') }}</h1>
      <p>{{ t('serverLead') }}</p>
      <label for="server">
        {{ mode === 'create' ? t('serverUrlLabel') : t('serverOrPairingLabel') }}
      </label>
      <input
        id="server"
        v-model="serverInput"
        type="text"
        inputmode="url"
        autocomplete="url"
        spellcheck="false"
        :placeholder="mode === 'create' ? 'https://sync.example.org' : 'tazamun:…@https://…'"
        required
        autofocus
      />
      <p v-if="mode === 'connect'" class="muted hint">{{ t('serverOrPairingHelp') }}</p>
      <p class="muted hint">{{ t('serverPermissionNote') }}</p>
      <p v-if="busy === 'server'" role="status">{{ t('serverChecking') }}</p>
      <div class="nav">
        <button type="button" class="secondary" :disabled="busy !== ''" @click="back">
          {{ t('onboardingBack') }}
        </button>
        <button type="submit" :disabled="busy !== ''">{{ t('onboardingContinue') }}</button>
      </div>
    </form>

    <!-- Device and modules -->
    <form v-else-if="step === 'device'" novalidate @submit.prevent="submitDevice">
      <h1>{{ t('deviceHeading') }}</h1>
      <label for="device-name">{{ t('deviceNameLabel') }}</label>
      <input id="device-name" v-model="deviceName" type="text" maxlength="100" required />
      <p class="muted hint">{{ t('deviceNameHelp') }}</p>

      <label class="check">
        <input v-model="rememberKey" type="checkbox" />
        <span>
          {{ t('optionsRememberKey') }}
          <span class="muted hint block">{{ t('optionsRememberKeyHelp') }}</span>
        </span>
      </label>

      <h2>{{ t('modulesHeading') }}</h2>
      <label class="check">
        <input v-model="syncTabs" type="checkbox" />
        <span>
          {{ t('moduleTabs') }}
          <span class="muted hint block">{{ t('moduleTabsHelp') }}</span>
        </span>
      </label>
      <p class="muted hint">{{ t('modulesLater') }}</p>
      <div class="nav">
        <button type="button" class="secondary" @click="back">{{ t('onboardingBack') }}</button>
        <button type="submit">{{ t('onboardingContinue') }}</button>
      </div>
    </form>

    <!-- Passphrase -->
    <form v-else-if="step === 'passphrase'" novalidate @submit.prevent="submitPassphrase">
      <template v-if="mode === 'create'">
        <h1>{{ t('passphraseHeading') }}</h1>
        <p>{{ t('passphraseLead') }}</p>
        <template v-if="inviteNeeded">
          <label for="invite">{{ t('inviteLabel') }}</label>
          <input id="invite" v-model="invite" type="text" spellcheck="false" autocomplete="off" />
          <p class="muted hint">{{ t('inviteHelp') }}</p>
        </template>
        <label for="passphrase">{{ t('passphraseLabel') }}</label>
        <input
          id="passphrase"
          v-model="passphrase"
          type="password"
          autocomplete="new-password"
          required
        />
        <div class="strength" aria-live="polite">
          <meter min="0" max="4" low="2" high="3" optimum="4" :value="strength.score"></meter>
          <span>{{ t(STRENGTH_KEYS[strength.score]) }}</span>
        </div>
        <p class="muted hint">{{ t('passphraseHint') }}</p>
        <label for="confirmation">{{ t('passphraseConfirmLabel') }}</label>
        <input
          id="confirmation"
          v-model="confirmation"
          type="password"
          autocomplete="new-password"
          required
        />
        <label class="check warning">
          <input v-model="acknowledged" type="checkbox" />
          <span>{{ t('passphraseAcknowledge') }}</span>
        </label>
      </template>
      <template v-else>
        <h1>{{ t('signInHeading') }}</h1>
        <template v-if="!accountIdKnown">
          <label for="account-id">{{ t('accountIdLabel') }}</label>
          <input
            id="account-id"
            v-model="accountIdInput"
            type="text"
            spellcheck="false"
            autocomplete="username"
            required
          />
        </template>
        <label for="passphrase">{{ t('passphraseLabel') }}</label>
        <input
          id="passphrase"
          v-model="passphrase"
          type="password"
          autocomplete="current-password"
          required
        />
      </template>
      <p v-if="busy === 'keys'" role="status">{{ t('deriving') }}</p>
      <div class="nav">
        <button type="button" class="secondary" :disabled="busy !== ''" @click="back">
          {{ t('onboardingBack') }}
        </button>
        <button type="submit" :disabled="busy !== ''">
          {{ mode === 'create' ? t('createButton') : t('signInButton') }}
        </button>
      </div>
    </form>

    <!-- Recovery kit (create only) -->
    <section v-else-if="step === 'kit'">
      <h1 class="no-print">{{ t('kitHeading') }}</h1>
      <p class="no-print">{{ t('kitLead') }}</p>
      <RecoveryKit :server-url="serverUrl" :account-id="accountId" />
      <div class="nav no-print">
        <span></span>
        <button type="button" @click="step = 'done'">{{ t('onboardingContinue') }}</button>
      </div>
    </section>

    <!-- Done -->
    <section v-else>
      <h1>{{ t('doneHeading') }}</h1>
      <p>{{ t('doneLead') }}</p>
      <button type="button" @click="closeTab">{{ t('doneClose') }}</button>
    </section>

    <p v-if="error" role="alert" class="error no-print">{{ t(error) }}</p>
  </main>
</template>

<style scoped>
.onboarding {
  max-inline-size: 36rem;
  margin-inline: auto;
  padding-block: 3rem;
}

.choices {
  display: grid;
  gap: 0.75rem;
  margin-block-start: 1.5rem;
}

.choice {
  display: grid;
  gap: 0.125rem;
  padding: 0.875rem 1rem;
  text-align: start;
}

.choice span {
  font-size: 0.875rem;
  opacity: 0.85;
}

.replace-note {
  margin-block-start: 1rem;
}

.nav {
  display: flex;
  justify-content: space-between;
  margin-block-start: 1.5rem;
}

.strength {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  margin-block-start: 0.375rem;
}

.strength meter {
  inline-size: 10rem;
}

.warning {
  margin-block-start: 1rem;
  padding: 0.75rem;
  border-radius: 6px;
  background: var(--warning-bg);
}
</style>
