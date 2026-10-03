// UI layer (U20 / shell): the React keyboard-shortcut hook.
//
// Attaches one window keydown listener that resolves the chord through the
// keymap and dispatches via the command registry, gated by the SAME enabled
// judgement menu items use (dispatchChord -> resolveCommandEnabled). Editing
// shortcuts disable together with editing menu items in view-only mode
// (教訓 5.13). When a bound, enabled shortcut runs (or is a consumed disabled
// editing shortcut) the event is prevented so it never leaks to the browser.
//
// Focus guard (バグハント第10波 #1/#4): before ANY resolution, if a text-editing
// element owns the focus (name/開始年/終了年, timeline year field, or any
// input/textarea/select/contenteditable) the listener stands down entirely —
// neither dispatching nor preventDefault — so native input editing (character
// Delete/Backspace, per-field Ctrl+Z/Ctrl+Y) passes through untouched. Placed at
// this SINGLE chokepoint (教訓 5.13) so every menu-derived shortcut is protected
// without per-input onKeyDown duplication.

import { useEffect } from 'react';

import { COMMAND_ID, type CommandId, type CommandRegistry } from './commands';
import type { EditMode } from '../state/session';
import {
  blocksGlobalShortcuts,
  consumesSpaceNatively,
  editableTargetFromEvent,
  isEditableTarget,
} from './focus-guard';
import { MAP_FOCUS_ONLY_COMMANDS, NO_REPEAT_COMMANDS, focusIsOnMap } from './map-focus-scope';
import {
  DISPATCH_RESULT,
  dispatchChord,
  keyChordFromEvent,
  type Keymap,
} from './shortcuts';

export interface UseShortcutsOptions {
  readonly keymap: Keymap;
  readonly registry: CommandRegistry;
  /** Current mode; drives the editing-permission gate (教訓 5.13). */
  readonly mode: EditMode;
  /** When true, no shortcut is dispatched (e.g. a modal owns the keyboard). */
  readonly suspended?: boolean;
  /**
   * **止めている間でも通すコマンド**（増分 3。増分 1 の申し送り「追加モードで入力層が
   * 出ているあいだは Ctrl+S が届かない」への答え）。
   *
   * 道具が鍵盤を持つ設計（作図中の Ctrl+Z は打った頂点を 1 つ戻す＝二重 undo を避けるため
   * 大域の割り振りごと降ろす）は正しいが、**保存は道具に関係なく効いてほしい**。作図中の
   * 下書きはプロジェクトの一部ではないので、保存しても失われるものは何も無い。
   *
   * **止めている理由を知っているのは呼び出し側だけ**なので、通す集合も呼び出し側が決める
   * （道具が持っているときだけ渡し、ダイアログが持っているときは渡さない）。既定は空 ＝
   * 従来どおり「止めている間は 1 つも通さない」。
   */
  readonly alwaysAllowed?: ReadonlySet<CommandId>;
  /**
   * **止めている間に「効かなかった」ことを伝える口**（増分 3。現状.md B28 の第 2 の理由）。
   *
   * 止めているあいだ、割り当てのある打鍵は押しても何も起きず **理由も出ない**。増分 2 の
   * 手直しでコマンドに「断った理由を出す口」を足したが、リスナーごと降りている経路は
   * そこへ到達しない（どのコマンドが呼ばれたのかを知る手がかりが無い）。ここで打鍵を
   * 解いてから **実行せずに** 呼び出し側へ渡すと、状態行に理由を出せる。
   *
   * **渡してよいのは「ダイアログが鍵盤を持っているとき」だけ**である。道具が持っている
   * ときは Escape / Ctrl+Z を道具自身が受けて**ちゃんと効いている**ので、断り文を出すと
   * 嘘になる。
   */
  readonly onSuspendedRefusal?: (id: CommandId) => void;
}

/**
 * **文字を打っている最中でも通す打鍵**（増分 3 の手直し D4 / GPT #10）。
 *
 * 焦点が入力欄にあるとき、シェルの割り振りは原則として何もしない（native の文字編集を
 * 邪魔しないため）。ところが保存だけは例外で、**名前を打っている最中に Ctrl+S が効かない**
 * のは利用者から見れば不具合である（作図 → 名前入力 → 保存、という流れの途中でだけ
 * 保存が死ぬ）。文字編集が使う打鍵と重ならないものだけをここに入れること。
 */
const EDITABLE_PASSTHROUGH: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.FileSave,
  COMMAND_ID.FileSaveAs,
]);

/**
 * **打ちかけが無い欄でだけ**通す打鍵（2026-09-06、2 回目の手直し）。
 *
 * 素性欄の Enter は「保存して次へ」なので、送ったあとの焦点は **次の地物の名前欄**に
 * 入ったままである。そこで Ctrl+Z を押しても「焦点が入力欄にある」というだけで
 * 取り消しが止まり、**押しても何も起きない**（実測）。束の送り（Alt+↑ / Alt+↓）も同じ。
 * 220 件を順に片付ける流れの中で「取り消したければ焦点を外してから」と言うのは、
 * 作業の背骨（設計書 §E.1 の V5）を折る。
 *
 * **通すのは欄が `data-pristine="true"` と名乗っているときだけ。** 打ちかけがあれば
 * 従来どおり止める ―― 打った文字の取り消しが地物の取り消しに化けるのが、この guard を
 * 作った理由（バグハント第 10 波 #4）だからである。
 */
const PRISTINE_EDITABLE_PASSTHROUGH: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.EditUndo,
  COMMAND_ID.EditRedo,
  COMMAND_ID.ListBundlePrev,
  COMMAND_ID.ListBundleNext,
  // **時刻レールの年の欄で Enter を押した直後**（増分 6 の探索で見つけた）。年を決める
  // のは「この年に記録を作る」ための下ごしらえなので、確定したそのままの焦点で
  // `Ctrl+K` を押すのが自然な流れである。ところが焦点は年の欄に残るので、
  // **押しても何も起きず理由も出なかった**。欄が「打ちかけは無い」と名乗っている
  // ときだけ通す（打ちかけがあれば従来どおり止める）。
  COMMAND_ID.EditCreateAnchorHere,
]);

export function useShortcuts(options: UseShortcutsOptions): void {
  const { keymap, registry, mode, suspended = false } = options;
  const alwaysAllowed = options.alwaysAllowed;
  const onSuspendedRefusal = options.onSuspendedRefusal;

  useEffect(() => {
    // 止めている間に何もすることが無いなら、従来どおりリスナーごと降りる（余計な
    // keydown を一切増やさない）。
    if (
      suspended &&
      (alwaysAllowed === undefined || alwaysAllowed.size === 0) &&
      onSuspendedRefusal === undefined
    ) {
      return;
    }

    const onKeyDown = (e: KeyboardEvent): void => {
      const chord = keyChordFromEvent(e);
      // Focus guard: a text-editing element owns the keyboard — let the native
      // edit keys through, dispatching NOTHING and preventing NOTHING (#1/#4).
      //
      // **ただし「文字を打っている最中でも必ず通す」打鍵がある**（増分 3 の手直し D4 /
      // GPT #10）。保存（Ctrl+S / Ctrl+Shift+S）がそれで、名前を打っている最中だけ
      // 保存が効かないのは利用者から見れば不具合である。文字編集の打鍵（Ctrl+Z・
      // Ctrl+A・矢印…）とは衝突しないので、通しても native の編集を邪魔しない。
      // 集合はこの module が持つ ―― 「止めている間に通す集合」（`alwaysAllowed`）とは
      // **止める理由が違う**ので分ける（教訓 5.30: 制約が違うなら安易に共有しない）。
      const editableTarget = editableTargetFromEvent(e);
      // **空白キーだけは、押されるボタンに譲る**（増分 6）。設計書 §I.2 は `Space` を
      // 再生／一時停止に割り当てるが、焦点のあるボタンは空白で **自分が押される** ので、
      // 重ねると 1 回の空白で 2 つ起きる。止める理由は「その control が空白を使う」
      // ことなので、**打鍵の入口 1 か所**で見る（教訓 5.75）。
      if (e.key === ' ' && consumesSpaceNatively(editableTarget)) return;
      // **文字を打つ欄だけでなく、鍵盤を使う control も遮る**（増分 5 の手直し A4）。
      // つまみ（`input[type=range]`）は矢印・Home / End を自分で使うので、焦点がそこに
      // あるあいだ Delete や Ctrl+Z が背後の地物へ抜けてはならない。
      if (blocksGlobalShortcuts(editableTarget)) {
        // **つまみからは Escape で抜けられる**（設計書 §D.4 の階段「欄から抜ける」）。
        // 文字の欄は native の Escape（入力の取り消し）があるのでそちらに任せるが、
        // つまみには出口が無く、焦点が残ったままだと打鍵が全部そこへ吸われる。
        if (e.key === 'Escape' && !isEditableTarget(editableTarget)) {
          if (e.target instanceof HTMLElement) e.target.blur();
          e.preventDefault();
          return;
        }
        const id = keymap.resolve(chord);
        const allowed =
          id !== undefined &&
          (EDITABLE_PASSTHROUGH.has(id) ||
            (editableTarget?.pristine === true && PRISTINE_EDITABLE_PASSTHROUGH.has(id)));
        if (!allowed) return;
        if (suspended && alwaysAllowed?.has(id) !== true) return;
        const passResult = dispatchChord(chord, keymap, registry, mode);
        if (passResult !== DISPATCH_RESULT.Unbound) e.preventDefault();
        return;
      }

      if (suspended) {
        // 止めている間は「通す集合」だけを見る。**それ以外は preventDefault もしない**
        // ので、道具が自分で登録した Escape / Ctrl+Z のリスナーはこれまでどおり届く
        // （ここで飲み込むと、道具の頂点取り消しが黙って死ぬ）。
        const id = keymap.resolve(chord);
        if (id === undefined) return;
        if (alwaysAllowed?.has(id) === true) {
          const allowedResult = dispatchChord(chord, keymap, registry, mode);
          if (allowedResult !== DISPATCH_RESULT.Unbound) e.preventDefault();
          return;
        }
        // 実行はしない。**理由だけ**を呼び出し側へ渡す（preventDefault もしない）。
        onSuspendedRefusal?.(id);
        return;
      }

      // 増分 8C の手直し: 地図に焦点があるときだけ効く打鍵と、押しっぱなしで繰り返さない打鍵
      // （`map-focus-scope.ts`）。地図の外では何もせず、打鍵も飲み込まない。
      const scopedId = keymap.resolve(chord);
      if (scopedId !== undefined) {
        if (MAP_FOCUS_ONLY_COMMANDS.has(scopedId) && !focusIsOnMap(e.target)) return;
        if (e.repeat && NO_REPEAT_COMMANDS.has(scopedId)) {
          e.preventDefault();
          return;
        }
      }

      const result = dispatchChord(chord, keymap, registry, mode);
      // A bound chord is consumed whether it ran or was a disabled editing
      // shortcut — in view-only mode the keyboard edit path is closed, not
      // leaked (教訓 5.13). Unbound chords pass through.
      if (result !== DISPATCH_RESULT.Unbound) {
        e.preventDefault();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [keymap, registry, mode, suspended, alwaysAllowed, onSuspendedRefusal]);
}
