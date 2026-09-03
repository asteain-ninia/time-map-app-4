// UI layer (U20 / shell): command identifiers and the command registry.
//
// Menu items, toolbar buttons and keyboard shortcuts all route to a COMMAND ID
// (never to a function literal). The actual command implementations are
// registered by later units (save/load/undo/settings/help); this unit owns the
// id vocabulary, the empty-by-default registry, and the "未登録 == 無効" rule
// (spec スコープ: 本ユニットは未登録項目を安全に無効として扱う; 教訓 5.19:
// 分岐識別子は型・定数を経由する).

/**
 * The canonical command-id set. Strings are an implementation detail; code
 * branches on these constants, never on bare literals (教訓 5.19).
 */
export const COMMAND_ID = {
  FileNew: 'file.new',
  FileOpen: 'file.open',
  FileSave: 'file.save',
  FileSaveAs: 'file.saveAs',
  EditUndo: 'edit.undo',
  EditRedo: 'edit.redo',
  EditDelete: 'edit.delete',
  /** HB5-4: clear the active-feature + vertex selection (U22 clearSelection). */
  EditDeselect: 'edit.deselect',
  /**
   * 「この年に錨を作る」（増分 2 の中身 3 / 設計書 §D.3）。
   *
   * 保存ボタンとは **別のコマンド** である。素性欄の保存は「値が同じなら
   * dispatch しない」関門を持つので（教訓 5.24）、「1500 年から同じ姿が続くことを
   * 記録したい」は保存ボタンでは表せない（押しても無反応になる）。
   */
  EditCreateAnchorHere: 'edit.createAnchorHere',
  ViewToggleViewMode: 'view.toggleViewMode',
  ViewZoomIn: 'view.zoomIn',
  ViewZoomOut: 'view.zoomOut',
  /**
   * 全体表示: frame the camera so EVERY feature effective at the current time fits
   * (現在の視点から一発で全体へ戻る). Reuses the 錨一覧 fit calculation applied to the
   * whole-project extent; with no features it returns to the FR-11 既定視点.
   */
  ViewFitAll: 'view.fitAll',
  ToolsSettings: 'tools.settings',
  /** Open the feature search UI (U41 / FR-113). Registered by the discovery unit. */
  ToolsSearch: 'tools.search',
  HelpAbout: 'help.about',
  HelpShortcuts: 'help.shortcuts',
  /** Show the diagnostics info view (U41 / FR-117). Registered by discovery. */
  HelpDiagnostics: 'help.diagnostics',
} as const;

export type CommandId = (typeof COMMAND_ID)[keyof typeof COMMAND_ID];

const ALL_COMMAND_IDS: ReadonlySet<string> = new Set(Object.values(COMMAND_ID));

/** Type guard: is this string a known command id? */
export function isCommandId(raw: string): raw is CommandId {
  return ALL_COMMAND_IDS.has(raw);
}

/** 断られた理由の種類（分岐識別子は定数を経由する、教訓 5.19）。 */
export const COMMAND_REFUSAL = {
  /** 登録されているが、いまの状態では動かせない（`canRun` が偽）。 */
  NotRunnable: 'notRunnable',
  /** 「読むだけ」なので編集経路が閉じている（教訓 5.13）。 */
  ViewOnly: 'viewOnly',
} as const;

export type CommandRefusal = (typeof COMMAND_REFUSAL)[keyof typeof COMMAND_REFUSAL];

/** A registered command: the side-effecting handler plus a dynamic enabled check. */
export interface CommandHandler {
  /** Run the command. */
  readonly run: () => void;
  /**
   * Optional dynamic gate supplied by the owning unit (e.g. undo availability,
   * FR-74). Combined with the shell's permission gate at dispatch time; a
   * command with no `canRun` is treated as runnable when registered.
   */
  readonly canRun?: () => boolean;
  /**
   * 断ったときに呼ばれる（任意）。**鍵盤から押して黙って終わるのをなくす**ための口で
   * ある（増分 2 の手直し A5 / バグ狩り #2 / 反証 F5）。メニュー項目は灰色で理由を持てるが、
   * 鍵盤には灰色が無いので、拒んだこと自体が見えなかった。
   *
   * これは **関門ではない**。可否の判定は `canRun` と `resolveCommandEnabled` の 2 つの
   * 既存の場所に 1 つずつだけあり（教訓 5.13 / 5.30）、ここはその結果を利用者へ
   * 伝えるだけである。
   */
  readonly onRefused?: (reason: CommandRefusal) => void;
}

/**
 * The command registry. A frozen vocabulary of ids, a mutable map of handlers.
 * Empty at construction: every id is "unregistered" (== disabled) until a later
 * unit registers it. This is the single truth source for "is this command
 * available" (教訓 5.13 / §4 単一の真実源) — menu items AND shortcuts both ask
 * the registry, so they never drift apart.
 */
export class CommandRegistry {
  private readonly handlers = new Map<CommandId, CommandHandler>();

  /** Register (or replace) the handler for a command id. */
  register(id: CommandId, handler: CommandHandler): void {
    this.handlers.set(id, handler);
  }

  /** Remove a handler (returns to the unregistered/disabled state). */
  unregister(id: CommandId): void {
    this.handlers.delete(id);
  }

  /** True if a handler is registered for this id. */
  isRegistered(id: CommandId): boolean {
    return this.handlers.has(id);
  }

  /**
   * Whether the command can currently run: it must be registered AND, if it
   * supplies a `canRun` gate, that gate must pass. This does NOT consider the
   * shell permission gate (view-only) — that is layered on by the caller via
   * `resolveEnabled` so the same id can be gated for different reasons in one
   * place (§4 単一の真実源).
   */
  isRunnable(id: CommandId): boolean {
    const handler = this.handlers.get(id);
    if (handler === undefined) return false;
    return handler.canRun === undefined || handler.canRun();
  }

  /**
   * Dispatch a command id. Returns true if it ran, false if it was unregistered
   * or not runnable (safe no-op — an unregistered shortcut never throws,
   * spec スコープ).
   */
  dispatch(id: CommandId): boolean {
    const handler = this.handlers.get(id);
    if (handler === undefined) return false;
    if (handler.canRun !== undefined && !handler.canRun()) {
      handler.onRefused?.(COMMAND_REFUSAL.NotRunnable);
      return false;
    }
    handler.run();
    return true;
  }

  /**
   * 断ったことをコマンドの持ち主へ伝える（実行はしない）。鍵盤の経路は権限の
   * 関門（`resolveCommandEnabled`）で `dispatch` へ到達せずに終わることがあるので、
   * その場合も理由を出せるように別の口を置く。未登録・口の無いコマンドには何もしない。
   */
  reportRefusal(id: CommandId, reason: CommandRefusal): void {
    this.handlers.get(id)?.onRefused?.(reason);
  }
}
