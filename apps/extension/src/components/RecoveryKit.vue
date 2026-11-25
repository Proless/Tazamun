<script setup lang="ts">
// ACC-5: shown after creating an account and in the settings.
import { computed, ref } from 'vue';
import { recoveryKit, recoveryKitFileName, recoveryKitText } from '../account/recovery-kit.ts';
import { downloadText } from '../lib/download.ts';
import { t } from '../lib/i18n.ts';

const props = defineProps<{ serverUrl: string; accountId: string }>();

const kit = computed(() => recoveryKit(props.serverUrl, props.accountId));
const copied = ref(false);

function download(): void {
  downloadText(document, recoveryKitFileName(), recoveryKitText(kit.value, new Date()));
}

function print(): void {
  window.print();
}

async function copyPairing(): Promise<void> {
  await navigator.clipboard.writeText(kit.value.pairingCode);
  copied.value = true;
}
</script>

<template>
  <section class="kit print-only-target">
    <h2 class="print-only">{{ t('kitHeading') }}</h2>
    <dl>
      <dt>{{ t('kitServer') }}</dt>
      <dd>
        <code>{{ kit.serverUrl }}</code>
      </dd>
      <dt>{{ t('kitAccountId') }}</dt>
      <dd>
        <code>{{ kit.accountId }}</code>
      </dd>
      <dt>{{ t('kitPairingCode') }}</dt>
      <dd>
        <code class="wrap">{{ kit.pairingCode }}</code>
      </dd>
    </dl>
    <p class="print-only">{{ t('kitPassphraseNotIncluded') }}</p>
    <p class="print-only">{{ t('kitLostPassphrase') }}</p>
    <p class="print-only">{{ t('kitHowToConnect') }}</p>
    <div class="actions no-print">
      <button type="button" @click="download">{{ t('kitDownload') }}</button>
      <button type="button" class="secondary" @click="print">{{ t('kitPrint') }}</button>
      <button type="button" class="secondary" @click="copyPairing">
        {{ t('kitCopyPairing') }}
      </button>
      <span v-if="copied" role="status" class="muted">{{ t('kitCopied') }}</span>
    </div>
  </section>
</template>

<style scoped>
.kit {
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
}

.wrap {
  overflow-wrap: anywhere;
}
</style>
