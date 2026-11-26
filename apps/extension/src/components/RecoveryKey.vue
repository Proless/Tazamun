<script setup lang="ts">
// ACC-5: the recovery key, shown once after creating an account or making a new one in the
// settings. It is never stored; this component only holds it while it is on screen.
import { ref } from 'vue';
import {
  recoveryKeyFileName,
  recoveryKeyText,
  type RecoveryKeyInfo,
} from '../account/recovery-key.ts';
import { downloadText } from '../lib/download.ts';
import { t } from '../lib/i18n.ts';

const props = defineProps<{ info: RecoveryKeyInfo }>();
const copied = ref(false);

function download(): void {
  downloadText(document, recoveryKeyFileName(), recoveryKeyText(props.info, new Date()));
}

function print(): void {
  window.print();
}

async function copy(): Promise<void> {
  await navigator.clipboard.writeText(props.info.recoveryKey);
  copied.value = true;
}
</script>

<template>
  <section class="recovery print-only-target">
    <h2 class="print-only">{{ t('recoveryDocHeading') }}</h2>
    <dl>
      <dt>{{ t('recoveryDocServer') }}</dt>
      <dd>
        <code>{{ info.serverUrl }}</code>
      </dd>
      <dt>{{ t('usernameLabel') }}</dt>
      <dd>
        <code>{{ info.username }}</code>
      </dd>
    </dl>
    <p class="key">
      <code>{{ info.recoveryKey }}</code>
    </p>
    <p class="print-only">{{ t('recoveryDocKeepSafe') }}</p>
    <p class="print-only">{{ t('recoveryDocHowTo') }}</p>
    <div class="actions no-print">
      <button type="button" @click="download">{{ t('recoveryDownload') }}</button>
      <button type="button" class="secondary" @click="print">{{ t('recoveryPrint') }}</button>
      <button type="button" class="secondary" @click="copy">{{ t('recoveryCopy') }}</button>
      <span v-if="copied" role="status" class="muted">{{ t('recoveryCopied') }}</span>
    </div>
  </section>
</template>

<style scoped>
.recovery {
  padding: 1rem;
  border: 1px solid var(--border);
  border-radius: 8px;
}

dl {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 0.25rem 1rem;
  margin-block: 0 1rem;
}

dt {
  color: var(--fg-muted);
}

dd {
  margin: 0;
  min-inline-size: 0;
  overflow-wrap: anywhere;
}

.key {
  margin-block: 0 1rem;
  font-size: 1.25rem;
  letter-spacing: 0.05em;
  overflow-wrap: anywhere;
}
</style>
