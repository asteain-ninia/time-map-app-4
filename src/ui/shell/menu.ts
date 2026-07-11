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
  /**
   * The PRIMARY accelerator; the SAME shortcut is registered in the keymap and
   * is the one rendered next to the menu label. This is the canonical chord a
   * user learns from the menu (HB-10: やり直し = Ctrl+Y).
   */
  readonly shortcut?: Shortcut;
  /**
   * Additional accelerators that ALSO dispatch this command but are NOT the one
   * shown in the menu label (HB-10: keep Ctrl+Shift+Z working as a redo alias
   * while the menu advertises Ctrl+Y). Each is registered in the default keymap
   * exactly like {@link shortcut}, so a key判定 is single-sourced (教訓 5.33).
   */
  readonly extraShortcuts?: readonly Shortcut[];
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
function item(
  commandId: CommandId,
  shortcut?: Shortcut,
  extraShortcuts?: readonly Shortcut[],
): MenuItemDef {
  const base = { commandId, label: MENU_ITEM_LABELS[commandId] };
  if (shortcut === undefined) return base;
  if (extraShortcuts === undefined || extraShortcuts.length === 0) {
    return { ...base, shortcut };
  }
  return { ...base, shortcut, extraShortcuts };
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
      // HB-10: やり直しのデフォルトを Ctrl+Y に。メニュー表示は Ctrl+Y、従来の
      // Ctrl+Shift+Z は別名アクセラレータとして併存させる(どちらも redo を起動)。
      item(
        COMMAND_ID.EditRedo,
        { key: 'y', ctrlOrMeta: true },
        [{ key: 'z', ctrlOrMeta: true, shift: true }],
      ),
      item(COMMAND_ID.EditDelete, { key: 'Delete' }),
      // HB5-4: 選択解除. Escape clears the active-feature + vertex selection through
      // the SAME global dispatcher the other 編集 shortcuts use — which STANDS DOWN
      // while a modal / tool-draft owns the keyboard (shortcutsSuspended), so a tool
      // draft-cancel or modal-close keeps Escape priority (task HB5-4 優先順位).
      item(COMMAND_ID.EditDeselect, { key: 'Escape' }),
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
    items: [
      item(COMMAND_ID.ToolsSettings),
      // U41 (FR-113): feature search, registered through the same基盤 (教訓 5.30).
      item(COMMAND_ID.ToolsSearch, { key: 'f', ctrlOrMeta: true }),
    ],
  },
  {
    key: MENU_KEY.Help,
    title: MENU_TITLES.help,
    items: [
      item(COMMAND_ID.HelpAbout),
      item(COMMAND_ID.HelpShortcuts),
      // U41 (FR-117): diagnostics info view.
      item(COMMAND_ID.HelpDiagnostics),
    ],
  },
];

/** One row for the ショートカット一覧 view (HB-9): a command's label + its accelerator. */
export interface ShortcutListEntry {
  readonly commandId: CommandId;
  readonly label: string;
  readonly shortcut: Shortcut;
}

/**
 * Every menu item that declares an accelerator, flattened in menu order (HB-9
 * ショートカット一覧). Derived from the SAME STANDARD_MENUS source the menu bar +
 * default keymap read, so the help list can never drift from the live bindings
 * (§4 単一の真実源 / 教訓 5.33). Items without a shortcut are omitted.
 */
export function listShortcutEntries(): readonly ShortcutListEntry[] {
  const rows: ShortcutListEntry[] = [];
  for (const menu of STANDARD_MENUS) {
    for (const it of menu.items) {
      if (it.shortcut !== undefined) {
        rows.push({ commandId: it.commandId, label: it.label, shortcut: it.shortcut });
        // HB-10: alias accelerators (e.g. やり直し の Ctrl+Shift+Z) are also valid
        // bindings, so the help一覧 lists them too — derived from the SAME source
        // as the keymap so the list can never drift from the live bindings.
        for (const extra of it.extraShortcuts ?? []) {
          rows.push({ commandId: it.commandId, label: it.label, shortcut: extra });
        }
      }
    }
  }
  return rows;
}
