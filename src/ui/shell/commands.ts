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
  /**
   * 時間の 11 コマンド（増分 6 / 設計書 §I.2 の「時間」の群）。**現状は時間を動かす
   * 打鍵が 1 つも無い**（C8）ので、ここでまとめて足す。
   *
   * **どれも編集ではない**ので `EDITING_COMMANDS` には入れない ―― 読むだけでも年は
   * 動かせる（裁定 §N-4「読むだけでも選べる・読める」の趣旨と同じ）。
   *
   * 送りは 1 / 10 / 100 の 3 段。**FR-68 の「ステップ値は常に 1 単位」は
   * 「前へ／次へ」ボタンの仕様**なので、ボタンは 1 単位のまま残し、10・100 は別の
   * コマンドとして足す（条文に触れない切り分け）。
   */
  TimeStepBack1: 'time.stepBack1',
  TimeStepForward1: 'time.stepForward1',
  TimeStepBack10: 'time.stepBack10',
  TimeStepForward10: 'time.stepForward10',
  TimeStepBack100: 'time.stepBack100',
  TimeStepForward100: 'time.stepForward100',
  /** 選択中の地物の前／次の錨へ（二分探索。裁定 2(b) の逃げ道 3）。 */
  TimePrevAnchor: 'time.prevAnchor',
  TimeNextAnchor: 'time.nextAnchor',
  /** レールの年入力欄へ焦点を入れる（V11 の「狙った年へ 1 手」）。 */
  TimeFocusYear: 'time.focusYear',
  /** 再生／一時停止。 */
  TimeTogglePlay: 'time.togglePlay',
  /** 直前にいた年へ戻る（走査で迷子にならない）。 */
  TimeBack: 'time.back',
  /**
   * 「面を描く」道具を構える（増分 3 の中身 9 / 設計書 §I.2）。
   *
   * **`F` ではなく `Shift+F`** である。`F` は「選んでいるものに視点を合わせる」
   * （`view.fitSelection`）に取ってあるので衝突する。設計書 §C.3 の図と §E.1 の
   * V1・V2 の手順も `Shift+F` に統一されている。
   *
   * 実体は「追加モードへ入って面ツールを構える」で、**モードのボタンを 2 回押すのと
   * 同じ経路を通る**（道具 1 段への作り直しは増分 5）。読むだけでは押せない
   * （`EDITING_COMMANDS` に載せる ―― K-6）。
   */
  ToolsAddFace: 'tools.addFace',
  /**
   * 「測る」を持つ／終える（増分 8C / 設計書 §I.2 の `U` ・§E.1 V15 の 1 手目）。
   *
   * 左のレールの「📏 測る」（`survey-toggle`）と **同じ 1 本**を通す（押していなければ
   * 持ち、持っていれば終える）。測るのは編集ではないので **読むだけでも効く**
   * （`EDITING_COMMANDS` に載せない ―― 設計書 §C.3「読むだけでも使える」）。
   */
  ToolsSurvey: 'tools.survey',
  ToolsSettings: 'tools.settings',
  /**
   * 地物を探す（U41 / FR-113）。**増分 4 で行き先が変わった。**
   *
   * 旧: 独立した検索モーダルを開く。母集団が一覧と別に組まれていて（N-41）、
   * しかも **年を属性の検索対象に入れていた**ので、数字 1 文字でほぼ全件が一致した
   * （C10）。新: **地物一覧の絞り込み欄へ焦点を入れる**（E-6。探す・見る・直すが
   * 1 本の母集団で閉じる）。
   */
  ToolsSearch: 'tools.search',
  /**
   * どこへでも移動（Ctrl+P。設計書 §C.2 の 26 / §I.2）。地物名・年・コマンドを
   * 1 本の入力で探して飛ぶ、全機能への保険の経路。
   */
  ToolsJump: 'tools.jump',
  /**
   * 一覧の「◀ 前へ」（作業のまとまりの前の地物へ）。増分 4 の手直し B8 / 設計書 §I.2。
   *
   * **メニューとショートカット一覧に載せる**ために、画面のボタンと同じ 1 本を
   * コマンドとして宣言する（結合点 #10:「画面にはあるのに鍵盤から届かない」を作らない）。
   */
  ListBundlePrev: 'list.bundlePrev',
  /** 一覧の「次へ ▶」（次の未処理へ）。 */
  ListBundleNext: 'list.bundleNext',
  /** 一覧の行でその場改名する（F2）。 */
  ListRename: 'list.rename',
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
