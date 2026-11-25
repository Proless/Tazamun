/**
 * The modules this build ships (ADR-0001). The engine syncs exactly these; adding a data type
 * means adding its module here, with no engine change.
 */
import type { WxtBrowser } from 'wxt/browser';
import { getAccountState } from '../account/store.ts';
import type { AnyModule } from '../engine/module.ts';
import { CommandsModule } from './commands/module.ts';
import { TabReceiver } from './commands/receive.ts';
import { TabsModule } from './tabs/module.ts';

export interface Modules {
  readonly all: AnyModule[];
  /** Send tab (TAB-7) needs to queue commands from outside a sync run. */
  readonly commands: CommandsModule;
}

export function createModules(browser: WxtBrowser): Modules {
  const commands = new CommandsModule(browser, {
    receiver: new TabReceiver(browser),
    deviceId: async () => (await getAccountState(browser)).account?.deviceId,
  });
  return { all: [new TabsModule(browser), commands], commands };
}
