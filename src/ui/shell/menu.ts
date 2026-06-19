// UI layer (U20 / shell): the standard menu structure (FR-111).
//
// The five top menus (ファイル・編集・表示・ツール・ヘルプ) and their item
// frames. Each item carries a COMMAND ID, an optional shortcut, and is gated by
// the SINGLE permission/enabled resolution (教訓 5.13: menu items and shortcuts
// share one enabled judgement). This unit defines the STRUCTURE only; each
// command's实处理 is registered by a later unit (spec スコープ「やらないこと」).

import { COMMAND_ID, type CommandId } from './commands';
import { MENU_TITLES, MENU_ITEM_LABELS } from './strings';
import type { Shortcut } from './shortcuts';

/** Top-level menu keys (in display order). */
export const MENU_KEY = {
  File: 'file',
  Edit: 'edit',
  View: 'view',
  Tools: 'tools',
  Help: 'help',
} as const;

export type MenuKey = (typeof MENU_KEY)[keyof typeof MENU_KEY];

/** A single menu item frame. */
export interface MenuItemDef {
  readonly commandId: CommandId;
  readonly label: string;
  /** Optional accelerator; the SAME shortcut is registered in the keymap. */
  readonly shortcut?: Shortcut;
}

/** A top-level menu (title + ordered items). */
export interface MenuDef {
  readonly key: MenuKey;
  readonly title: string;
  readonly items: readonly MenuItemDef[];
}

// Accelerators are declared here AND mirrored in the default keymap (shortcuts.ts)
// so the menu accelerator label and the dispatched shortcut never diverge
// (教訓 5.33 / §4 単一の真実源). Both sides reference COMMAND_ID, not literals.
function item(commandId: CommandId, shortcut?: Shortcut): MenuItemDef {
  return shortcut === undefined
    ? { commandId, label: MENU_ITEM_LABELS[commandId] }
    : { commandId, label: MENU_ITEM_LABELS[commandId], shortcut };
}

/**
 * The complete standard menu structure (FR-111). Frozen definition: components
 * render from this; tests assert the five menus and their item command ids.
 */
export const STANDARD_MENUS: readonly MenuDef[] = [
  {
    key: MENU_KEY.File,
    title: MENU_TITLES.file,
    items: [
      item(COMMAND_ID.FileNew, { key: 'n', ctrlOrMeta: true }),
      item(COMMAND_ID.FileOpen, { key: 'o', ctrlOrMeta: true }),
      item(COMMAND_ID.FileSave, { key: 's', ctrlOrMeta: true }),
      item(COMMAND_ID.FileSaveAs, { key: 's', ctrlOrMeta: true, shift: true }),
    ],
  },
  {
    key: MENU_KEY.Edit,
    title: MENU_TITLES.edit,
    items: [
      item(COMMAND_ID.EditUndo, { key: 'z', ctrlOrMeta: true }),
      item(COMMAND_ID.EditRedo, { key: 'z', ctrlOrMeta: true, shift: true }),
      item(COMMAND_ID.EditDelete, { key: 'Delete' }),
    ],
  },
  {
    key: MENU_KEY.View,
    title: MENU_TITLES.view,
    items: [
      item(COMMAND_ID.ViewToggleViewMode),
      item(COMMAND_ID.ViewZoomIn, { key: '=', ctrlOrMeta: true }),
      item(COMMAND_ID.ViewZoomOut, { key: '-', ctrlOrMeta: true }),
    ],
  },
  {
    key: MENU_KEY.Tools,
    title: MENU_TITLES.tools,
    items: [item(COMMAND_ID.ToolsSettings)],
  },
  {
    key: MENU_KEY.Help,
    title: MENU_TITLES.help,
    items: [item(COMMAND_ID.HelpAbout), item(COMMAND_ID.HelpShortcuts)],
  },
];
