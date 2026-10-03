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
      // 増分 8D: 以前の保存から開く（V14 の手順 (a)）。打鍵は割り当てない（稀な操作）。
      item(COMMAND_ID.FileOpenBackup),
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
      // 増分 2 の中身 3: 「この年に錨を作る」。現在時刻に錨が無いときだけ
      // 押せる（canRun が決める）。値を変えずに錨だけを 1 本増やす専用の経路。
      item(COMMAND_ID.EditCreateAnchorHere, { key: 'k', ctrlOrMeta: true }),
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
      // 拡大: 表示ラベルは「Ctrl++」（formatShortcut が '=' を '+' として見せる = 慣用表記）。
      // ラベル通りの打鍵を **全配列で** 受けるため、shift 有無と '=' / '+' の 4 通りを別名
      // 登録する（HB-10 の redo と同じ extraShortcuts 機構 = 宣言の単一真実源, 教訓 5.33）:
      //   - US 配列: '+' は Shift+= なので keydown は key='+' / shiftKey=true で届く。
      //   - JIS 配列: '=' 自体が Shift+「-」なので、素の `mod+=` は **原理的に発生し得ない** —
      //     shift 別名が無いと日本語キーボードでは拡大がキーボードから一切実行できなかった
      //     (縮小 Ctrl+- は無修飾キーなので動く = 非対称な穴)。
      item(
        COMMAND_ID.ViewZoomIn,
        { key: '=', ctrlOrMeta: true },
        [
          { key: '=', ctrlOrMeta: true, shift: true },
          { key: '+', ctrlOrMeta: true },
          { key: '+', ctrlOrMeta: true, shift: true },
        ],
      ),
      item(COMMAND_ID.ViewZoomOut, { key: '-', ctrlOrMeta: true }),
      // 全体表示: Ctrl+Home —「原点/全体へ戻る」の慣用キー. It collides with none of the
      // app's own bindings (a test asserts chord uniqueness across the whole menu tree)
      // AND deliberately avoids Ctrl+0, which Electron's DEFAULT application menu owns
      // as its resetZoom role accelerator and therefore never delivers to the renderer
      // (実測: Ctrl+0 では data-zoom が動かない). The Ctrl modifier also keeps it clear of
      // a BARE Home, which a focused range input (timeline slider) uses natively — the
      // focus guard only stands down for TEXT inputs (focus-guard.ts). Declared HERE so
      // it reaches the keymap AND the ショートカット一覧 from one source (教訓 5.33).
      item(COMMAND_ID.ViewFitAll, { key: 'Home', ctrlOrMeta: true }),
      // 時間の 11 コマンド（増分 6 / 設計書 §I.2 の「時間」の群）。**現状は時間を
      // 動かす打鍵が 1 つも無い**（C8）。メニューは 5 つのままで（FR-111）、
      // 「見ている年を動かす」操作なので 表示 に置く。
      //
      // `,` / `.` に修飾を付けた 10・100 の送りは、**配列によって `key` が変わる**ので
      // 別名を登録する（拡大の Ctrl+= と同じ機構）。US 配列では Shift+`,` が `<`、
      // Shift+`.` が `>` として届くので、それが無いと 10 年送りが打てない。
      item(COMMAND_ID.TimeStepBack1, { key: ',' }),
      item(COMMAND_ID.TimeStepForward1, { key: '.' }),
      item(
        COMMAND_ID.TimeStepBack10,
        { key: ',', shift: true },
        [{ key: '<', shift: true }],
      ),
      item(
        COMMAND_ID.TimeStepForward10,
        { key: '.', shift: true },
        [{ key: '>', shift: true }],
      ),
      item(COMMAND_ID.TimeStepBack100, { key: ',', ctrlOrMeta: true }),
      item(COMMAND_ID.TimeStepForward100, { key: '.', ctrlOrMeta: true }),
      item(COMMAND_ID.TimePrevAnchor, { key: '[' }),
      item(COMMAND_ID.TimeNextAnchor, { key: ']' }),
      item(COMMAND_ID.TimeFocusYear, { key: 'g', ctrlOrMeta: true }),
      item(COMMAND_ID.TimeTogglePlay, { key: ' ' }),
      item(COMMAND_ID.TimeBack, { key: 'ArrowLeft', alt: true }),
    ],
  },
  {
    key: MENU_KEY.Tools,
    title: MENU_TITLES.tools,
    items: [
      // 増分 3 の中身 9: 面を描く道具を鍵盤から構える（設計書 §I.2）。
      // **`F` は「選んでいるものに視点を合わせる」なので `Shift+F`**。
      // メニューと keymap の両方へ届くよう、ここ 1 か所で宣言する（結合点 #10:
      // 「メニューには載っているのに実体が登録されていない」を作らない）。
      item(COMMAND_ID.ToolsAddFace, { key: 'f', shift: true }),
      item(COMMAND_ID.ToolsSettings),
      // U41 (FR-113): feature search, registered through the same基盤 (教訓 5.30).
      item(COMMAND_ID.ToolsSearch, { key: 'f', ctrlOrMeta: true }),
      // 増分 4 / 設計書 §C.2 の 26: どこへでも移動（地物名・年・コマンドを 1 本で）。
      // メニューと keymap の両方へ届くよう、ここ 1 か所で宣言する（結合点 #10）。
      item(COMMAND_ID.ToolsJump, { key: 'p', ctrlOrMeta: true }),
      // 増分 4 の手直し B8: 一覧の送りと改名を鍵盤から届かせる（設計書 §I.2）。
      // **Alt+↑ / Alt+↓** は矢印そのもの（一覧の行移動）と衝突しない。**F2** は
      // 一覧に焦点があるときの改名と同じ働きで、焦点がどこにあっても効く。
      item(COMMAND_ID.ListBundlePrev, { key: 'ArrowUp', alt: true }),
      item(COMMAND_ID.ListBundleNext, { key: 'ArrowDown', alt: true }),
      item(COMMAND_ID.ListRename, { key: 'F2' }),
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
