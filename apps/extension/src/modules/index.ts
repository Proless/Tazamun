/**
 * The modules this build ships (ADR-0001). The engine syncs exactly these; adding a data type
 * means adding its module here, with no engine change. Tabs (TAB-1…6) is next.
 */
import type { AnyModule } from '../engine/module.ts';

export function createModules(): AnyModule[] {
  return [];
}
