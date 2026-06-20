// UI layer (U20 / shell): derive the default keymap from the menu definition.
//
// The menu accelerators (menu.ts) and the dispatched shortcuts MUST be the same
// bindings (教訓 5.33 / §4 単一の真実源). Rather than declaring chords twice, the
// keymap is BUILT from STANDARD_MENUS: every menu item that carries a shortcut
// contributes one binding. A test asserts the two sides agree.

import type { CommandId } from './commands';
import { STANDARD_MENUS } from './menu';
import { buildKeymap, type Keymap, type Shortcut } from './shortcuts';

/** Build the keymap from the standard menu's declared accelerators. */
export function buildDefaultKeymap(): Keymap {
  const bindings: { shortcut: Shortcut; commandId: CommandId }[] = [];
  for (const menu of STANDARD_MENUS) {
    for (const item of menu.items) {
      if (item.shortcut !== undefined) {
        bindings.push({ shortcut: item.shortcut, commandId: item.commandId });
        // HB-10: bind every alias accelerator (e.g. redo's Ctrl+Shift+Z) to the
        // SAME command id, so both the displayed chord and its aliases dispatch
        // identically (single key判定 source, 教訓 5.33).
        for (const extra of item.extraShortcuts ?? []) {
          bindings.push({ shortcut: extra, commandId: item.commandId });
        }
      }
    }
  }
  return buildKeymap(bindings);
}
