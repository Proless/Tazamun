import { commands } from './commands.ts';
import { extensions } from './extensions.ts';
import { history } from './history.ts';
import { tabs } from './tabs.ts';

export * from './commands.ts';
export * from './extensions.ts';
export * from './history.ts';
export * from './tabs.ts';

/** Every collection with a payload schema, by name. `bookmarks` follows in P4. */
export const COLLECTIONS = { tabs, commands, history, extensions } as const;
