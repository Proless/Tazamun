/**
 * Writes the configuration reference (DEP-15). `config.test.ts` fails when the committed file is
 * out of date, so CI catches a setting changed without regenerating the docs.
 */
import { writeFileSync } from 'node:fs';
import { CONFIG_REFERENCE_PATH } from './config-docs-path.ts';
import { renderConfigReference } from './config.ts';

writeFileSync(CONFIG_REFERENCE_PATH, renderConfigReference());
