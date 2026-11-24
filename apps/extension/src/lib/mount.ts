import { createApp, type Component } from 'vue';
import './base.css';
import { applyDocumentLocale, type t } from './i18n.ts';
import { startup } from './startup.ts';

/** Start an extension page: CSP-safe zod, locale and direction, then the Vue app. */
export function mountPage(root: Component, titleKey: Parameters<typeof t>[0]): void {
  startup();
  applyDocumentLocale(document, titleKey);
  createApp(root).mount('#app');
}
