import { z } from 'zod';

/**
 * Run first in every extension context (background, popup, options, onboarding).
 *
 * zod compiles parsers with `new Function` unless told not to, and the extension CSP forbids
 * eval (SRS 2.7). Without this, every schema parse logs a CSP violation.
 */
export function startup(): void {
  z.config({ jitless: true });
}
