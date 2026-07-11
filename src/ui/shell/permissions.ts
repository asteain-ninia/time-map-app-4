// UI layer (U20 / shell): the SINGLE editing-permission gate (教訓 5.13).
//
// 教訓 5.13「表示専用モードでは編集経路を一括無効化する」(引用):「表示専用モード
// では、編集 UI・編集メニュー項目・編集ショートカットを同じ権限判定で一括無効化
// する。部品ごとに個別判定を書くと、見た目だけ非表示でショートカットや右クリック
// 操作が残る。モード境界は共通ヘルパーまたは状態機械で表現する。」
//
// 適用: this module defines ONE predicate — `canEdit(mode)` — that every edit
// surface (toolbar edit buttons, edit menu items, edit shortcuts, context-menu
// edit items) consults to decide enabled/disabled. No widget writes its own
// view-only check. The permission axis is SEPARATE from the mode axis: View is
// the not-editable state; Add/Edit are editable (FR-42: 表示モードは編集/追加
// モードと干渉しない別軸).

import { EDIT_MODE, type EditMode } from '../state/session';
import { COMMAND_ID, type CommandId } from './commands';

/**
 * The one editing-permission predicate. True iff the current mode permits any
 * editing action. View mode (= display-only) returns false; Add/Edit return
 * true. Every edit-gated surface derives enabled/disabled from THIS function so
 * there is no second, drifting view-only check anywhere (教訓 5.13).
 */
export function canEdit(mode: EditMode): boolean {
  return mode !== EDIT_MODE.View;
}

/**
 * Commands that mutate the document and therefore must be disabled in
 * display-only mode (教訓 5.13). View-only commands (open, zoom, view-mode
 * toggle, help, settings) are NOT in this set and stay available while viewing.
 * Membership is declared once here so menu items and shortcuts share it
 * (§4 単一の真実源).
 */
const EDITING_COMMANDS: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.EditUndo,
  COMMAND_ID.EditRedo,
  COMMAND_ID.EditDelete,
  // HB5-4: 選択解除 is an edit-context action — disabled in 表示専用 mode together
  // with its Escape shortcut (教訓 5.13), so it fires only in 追加/編集 mode.
  COMMAND_ID.EditDeselect,
]);

/** True if the command is an editing command gated by the permission axis. */
export function isEditingCommand(id: CommandId): boolean {
  return EDITING_COMMANDS.has(id);
}

/**
 * The single enabled-resolution for a command id, shared by menu items, toolbar
 * buttons and shortcuts (受け入れ基準 7 / 9; 教訓 5.13). A command is enabled
 * iff: (1) it is registered AND runnable (its dynamic gate, e.g. undo
 * availability FR-74, passes), AND (2) if it is an editing command, the
 * permission axis allows editing. Editing shortcuts and editing menu items thus
 * disable together — there is no path where the menu looks disabled but the
 * shortcut still fires.
 */
export interface EnabledInput {
  /** Whether the command is registered AND its dynamic canRun gate passes. */
  readonly runnable: boolean;
  /** The current mode (drives the permission axis). */
  readonly mode: EditMode;
}

export function resolveCommandEnabled(id: CommandId, input: EnabledInput): boolean {
  if (!input.runnable) return false;
  if (isEditingCommand(id) && !canEdit(input.mode)) return false;
  return true;
}
