/**
 * The modules this build ships (ADR-0001). The engine syncs exactly these; adding a data type
 * means adding its module here, with no engine change.
 */
import type { WxtBrowser } from 'wxt/browser';
import type { AnyModule } from '../engine/module.ts';
import { TabsModule } from './tabs/module.ts';

export function createModules(browser: WxtBrowser): AnyModule[] {
  return [new TabsModule(browser)];
}
