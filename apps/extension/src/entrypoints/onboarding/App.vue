<script setup lang="ts">
// UI-2: create an account, sign in, or recover with the recovery key; choose modules; show the
// recovery key once (SRS 3.1, ACC-1…8, ACC-13). Validation and error mapping live in
// src/onboarding/form.ts; flows in src/account/session.ts.
import { computed, onMounted, ref } from 'vue';
import { browser } from 'wxt/browser';
import { account } from '@tazamun/core';
import RecoveryKey from '../../components/RecoveryKey.vue';
import {
  OnboardingError,
  checkServer,
  connectAndSignIn,
  createAndSignIn,
  recoverAndSignIn,
  requestServerPermission,
  thisDevice,
} from '../../account/session.ts';
import { getAccountState, getSettings, saveSettings } from '../../account/store.ts';
import { t } from '../../lib/i18n.ts';
import {
  STRENGTH_KEYS,
  errorKey,
  parseServerInput,
  validateDeviceName,
  validateNewPassphrase,
  validateRecoveryKey,
  validateUsername,
  type MessageKey,
} from '../../onboarding/form.ts';

type Mode = 'create' | 'connect' | 'recover';
type Step = 'welcome' | 'server' | 'device' | 'passphrase' | 'recovery' | 'done';

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

// Credentials step
const username = ref('');
const passphrase = ref('');
const confirmation = ref('');
const acknowledged = ref(false);
const invite = ref('');
const recoveryKeyInput = ref('');

// Result (create): shown once, never stored (ACC-5).
const recoveryKey = ref('');
const recoverySaved = ref(false);

/** Set up before on this browser (signed out or revoked): offer to sign in again. */
const previous = ref<{ serverUrl: string; username: string | undefined } | undefined>();
/** ACC-12: this profile has (or had) an account; another one would replace it here. */
const existingServer = ref<string | undefined>();

const strength = computed(() => account.estimateStrength(passphrase.value));
const steps = computed<Step[]>(() =>
  mode.value === 'create'
    ? ['server', 'device', 'passphrase', 'recovery']
    : ['server', 'device', 'passphrase'],
);
const stepNumber = computed(() => steps.value.indexOf(step.value) + 1);

/**
 * The defaults below fill fields the user can edit (device name, remember key, tabs). They load
 * asynchronously, so the device step waits for them (`submitServer`); otherwise a slow load could
 * overwrite a name the user already typed.
 */
let defaultsLoaded: Promise<void> = Promise.resolve();

onMounted(() => {
  defaultsLoaded = loadDefaults();
});

async function loadDefaults(): Promise<void> {
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
    previous.value = { serverUrl: state.account.serverUrl, username: state.account.username };
  }
  existingServer.value = state.account?.serverUrl;
}

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

/** On the credentials step: switch between signing in and recovering (ACC-5). */
function switchMode(next: 'connect' | 'recover'): void {
  mode.value = next;
  error.value = undefined;
  passphrase.value = '';
  confirmation.value = '';
}

/**
 * Server step. The permission request must be the first browser call in the click handler, before
 * any `await`, or the browser refuses it for lack of a user gesture.
 */
async function submitServer(): Promise<void> {
  error.value = undefined;
  const parsed = parseServerInput(serverInput.value);
  if (!parsed.ok) {
    error.value = parsed.error;
    return;
  }
  const granted = requestServerPermission(browser, parsed.value);
  busy.value = 'server';
  try {
    if (!(await granted)) throw new OnboardingError('permission-denied');
    const info = await checkServer(browser, parsed.value);
    if (mode.value === 'create' && info.registration === 'closed') {
      throw new OnboardingError('registration-closed');
    }
    inviteNeeded.value = info.registration === 'invite';
    serverUrl.value = parsed.value;
    await defaultsLoaded;
    step.value = 'device';
  } catch (err) {
    error.value = errorKey(err);
  } finally {
    busy.value = '';
  }
}

/** "Sign in again": the server and username are known; the permission may need asking again. */
async function reconnect(): Promise<void> {
  if (previous.value === undefined) return;
  mode.value = 'connect';
  serverInput.value = previous.value.serverUrl;
  username.value = previous.value.username ?? '';
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

/** The form's own checks, before any Argon2id run. */
function invalidCredentials(): MessageKey | undefined {
  const name = validateUsername(username.value);
  if (!name.ok) return name.error;
  username.value = name.value;
  if (mode.value === 'create') {
    return validateNewPassphrase(passphrase.value, confirmation.value, acknowledged.value);
  }
  if (mode.value === 'recover') {
    const key = validateRecoveryKey(recoveryKeyInput.value);
    if (!key.ok) return key.error;
    // No acknowledgement: the recovery key exists, so the passphrase isn't the only way in.
    return validateNewPassphrase(passphrase.value, confirmation.value, true);
  }
  return undefined;
}

async function submitPassphrase(): Promise<void> {
  error.value = invalidCredentials();
  if (error.value !== undefined) return;
  const device = { name: deviceName.value, browser: deviceBrowser.value };
  const common = {
    serverUrl: serverUrl.value,
    username: username.value,
    device,
    rememberKey: rememberKey.value,
  };
  busy.value = 'keys';
  try {
    if (mode.value === 'create') {
      recoveryKey.value = await createAndSignIn(browser, {
        ...common,
        passphrase: passphrase.value,
        invite: invite.value.trim(),
      });
      step.value = 'recovery';
    } else if (mode.value === 'recover') {
      await recoverAndSignIn(browser, {
        ...common,
        recoveryKey: recoveryKeyInput.value,
        newPassphrase: passphrase.value,
      });
      recoveryKeyInput.value = '';
      step.value = 'done';
    } else {
      await connectAndSignIn(browser, { ...common, passphrase: passphrase.value });
      step.value = 'done';
    }
    // Don't keep the passphrase in the page any longer than needed.
    passphrase.value = '';
    confirmation.value = '';
  } catch (err) {
    error.value = errorKey(err, mode.value);
  } finally {
    busy.value = '';
  }
}

function finishRecovery(): void {
  if (!recoverySaved.value) {
    error.value = 'errorRecoverySaved';
    return;
  }
  error.value = undefined;
  // Gone from the page once it's saved (ACC-5: never stored).
  recoveryKey.value = '';
  step.value = 'done';
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
      <label for="server">{{ t('serverUrlLabel') }}</label>
      <input
        id="server"
        v-model="serverInput"
        type="text"
        inputmode="url"
        autocomplete="url"
        spellcheck="false"
        placeholder="https://sync.example.org"
        required
        autofocus
      />
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

    <!-- Credentials: create, sign in, or recover -->
    <form v-else-if="step === 'passphrase'" novalidate @submit.prevent="submitPassphrase">
      <h1 v-if="mode === 'create'">{{ t('passphraseHeading') }}</h1>
      <h1 v-else-if="mode === 'recover'">{{ t('recoverHeading') }}</h1>
      <h1 v-else>{{ t('signInHeading') }}</h1>
      <p v-if="mode === 'create'">{{ t('passphraseLead') }}</p>
      <p v-else-if="mode === 'recover'">{{ t('recoverLead') }}</p>

      <label for="username">{{ t('usernameLabel') }}</label>
      <input
        id="username"
        v-model="username"
        type="text"
        spellcheck="false"
        autocapitalize="none"
        autocomplete="username"
        maxlength="64"
        required
      />
      <p v-if="mode === 'create'" class="muted hint">{{ t('usernameHelp') }}</p>

      <template v-if="mode === 'create' && inviteNeeded">
        <label for="invite">{{ t('inviteLabel') }}</label>
        <input id="invite" v-model="invite" type="text" spellcheck="false" autocomplete="off" />
        <p class="muted hint">{{ t('inviteHelp') }}</p>
      </template>

      <template v-if="mode === 'recover'">
        <label for="recovery-key">{{ t('recoveryKeyLabel') }}</label>
        <input
          id="recovery-key"
          v-model="recoveryKeyInput"
          type="text"
          spellcheck="false"
          autocapitalize="characters"
          autocomplete="off"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          required
        />
      </template>

      <label for="passphrase">
        {{ mode === 'recover' ? t('newPassphraseLabel') : t('passphraseLabel') }}
      </label>
      <input
        id="passphrase"
        v-model="passphrase"
        type="password"
        :autocomplete="mode === 'connect' ? 'current-password' : 'new-password'"
        required
      />
      <template v-if="mode !== 'connect'">
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
      </template>
      <label v-if="mode === 'create'" class="check warning">
        <input v-model="acknowledged" type="checkbox" />
        <span>{{ t('passphraseAcknowledge') }}</span>
      </label>

      <p v-if="mode === 'connect'" class="hint">
        <button type="button" class="link" @click="switchMode('recover')">
          {{ t('forgotPassphrase') }}
        </button>
      </p>
      <p v-else-if="mode === 'recover'" class="hint">
        <button type="button" class="link" @click="switchMode('connect')">
          {{ t('backToSignIn') }}
        </button>
      </p>

      <p v-if="busy === 'keys'" role="status">{{ t('deriving') }}</p>
      <div class="nav">
        <button type="button" class="secondary" :disabled="busy !== ''" @click="back">
          {{ t('onboardingBack') }}
        </button>
        <button type="submit" :disabled="busy !== ''">
          {{
            mode === 'create'
              ? t('createButton')
              : mode === 'recover'
                ? t('recoverButton')
                : t('signInButton')
          }}
        </button>
      </div>
    </form>

    <!-- Recovery key (create only), shown once -->
    <section v-else-if="step === 'recovery'">
      <h1 class="no-print">{{ t('recoveryHeading') }}</h1>
      <p class="no-print">{{ t('recoveryLead') }}</p>
      <RecoveryKey :info="{ serverUrl, username, recoveryKey }" />
      <label class="check no-print">
        <input v-model="recoverySaved" type="checkbox" />
        <span>{{ t('recoverySaved') }}</span>
      </label>
      <div class="nav no-print">
        <span></span>
        <button type="button" @click="finishRecovery">{{ t('onboardingContinue') }}</button>
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
