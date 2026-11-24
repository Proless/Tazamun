import { fileURLToPath } from 'node:url';

/** Where the generated configuration reference lives (DEP-15). */
export const CONFIG_REFERENCE_PATH = fileURLToPath(
  new URL('../../../docs/guides/server-configuration.md', import.meta.url),
);
