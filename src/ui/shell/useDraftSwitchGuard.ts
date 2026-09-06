// UI layer (U20 / shell): **確定できる点数まで来ている下書きを、黙って捨てない**ための
// 見張り（設計書 §D.4.1 の 3 と表の 1 行目。増分 5 の手直し 2 回目）。
//
// 追加の道具（面・線・点）は増分 5 の手直し A3 でこの形になっていたが、**点列を打つ
// 残り 3 つの道具**（分ける の分断線・輪郭・穴あけ）には入っていなかった ―― 実測で
// 輪郭 4 点・穴あけ 4 点・分断線 2 点が、Escape でも道具の持ち替えでも鍵を閉じても
// **確認なしに消えた**。同じ規定を 4 通りに書き分けないよう、見張りをここ 1 本に置く。
//
// --- 「板が開いている間は切替先を構えない」（この手直しの本筋）------------------
//
// 旧版は **先に道具が切り替わってから**「捨てますか」を出し、［続ける］で元の道具へ
// 戻していた。これには 2 つの害があった:
//
//   ・板が出ているあいだ **切替先の道具が構えられている**ので、その道具の入力ブリッジが
//     地図（と板）を覆う。板のボタンの上に透明な層が乗り、マウスでは押せなかった
//     （`elementFromPoint` が `knife-input-layer` を返した）。板の外を押せば切替先が
//     対象を掴み、選択理由の板が二重に出た。
//   ・鍵を閉じる経路では **一瞬とはいえ「読むだけ」なのに下書きが生きている**状態ができ、
//     その状態から確認なしで view へ抜ける道が残っていた。
//
// そこで **遷移そのものを差し止める**: 板を出す瞬間に元の道具（と鍵）へ戻し、切替先は
// 「捨てる」と答えられて初めて構える。［続ける］は文字どおり何もしない。
//
// 見張りが「基準を進めない」のは追加の道具と同じ理由である（板が出ているあいだに基準を
// 進めると、戻した動きそのものが新しい変化に見えて板が閉じなくなる）。

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { EDIT_MODE, type ToolId } from '../state/session';
import type { SessionStore } from '../state/store';

import { DISCARD_REASON, type DiscardReason } from './DraftDiscardConfirm';

/** 「捨てる」と答えられて初めて実行する切替先。 */
interface ToolSwitchIntent {
  /** 鍵を閉じようとしていた（＝道具の持ち替えではない）。 */
  readonly lock: boolean;
  /** 構えようとしていた道具（`null` は「道具を外す」）。 */
  readonly tool: ToolId | null;
}

export interface DraftSwitchGuardOptions<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** この道具の id。構えているかの判定と、板を出したときに戻す先。 */
  readonly toolId: ToolId;
  /** **確定できる点数**まで来ている下書きを持っているか（聞く価値のある下書き）。 */
  readonly hasCommittableDraft: boolean;
  /** 打ちかけの頂点の数（板の文言と、捨てたことの報せに出す）。 */
  readonly vertexCount: number;
  /** 構えたときに走らせる（道具の `start()`）。 */
  readonly onArm: () => void;
  /** 降りるときに走らせる（道具の `resetForSwitch()`。下書きごと捨てる）。 */
  readonly onDisarm: () => void;
  /**
   * **点列だけ**を捨てる（対象も道具も保つ）。利用者自身の Escape で「捨てる」と
   * 答えられたときに走る ―― 設計書 §D.4.1 の表の 1 行目が言う 1 段ぶんである。
   */
  readonly onDiscardPoints: () => void;
  /** 捨てた頂点の数を報せる口（状態行の「直前の結果」）。 */
  readonly onDraftDiscarded?: ((count: number) => void) | undefined;
}

export interface DraftSwitchGuard {
  /** この道具を構えているか。 */
  readonly armed: boolean;
  /** 板を出している理由（出していなければ null）。 */
  readonly pending: DiscardReason | null;
  /** 板に出す頂点の数。 */
  readonly vertexCount: number;
  /**
   * 利用者自身の Escape で確認を出す。**呼ぶ前に「確定できる点数か」を判断すること** ――
   * それ未満の下書きは聞かずに捨てる（押し直せば済む＝§D.4.1 の 3）。
   */
  readonly askOnEscape: () => void;
  /** ［続ける］。切替先はもう戻してあるので、板を閉じるだけ。 */
  readonly keep: () => void;
  /** ［捨てる］。下書きを捨て、切替先があればそこで初めて構える。 */
  readonly discard: () => void;
}

export function useDraftSwitchGuard<S>(
  options: DraftSwitchGuardOptions<S>,
): DraftSwitchGuard {
  const { store, toolId, hasCommittableDraft, vertexCount } = options;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const armed = mode === EDIT_MODE.Edit && activeTool === toolId;

  const [pending, setPending] = useState<DiscardReason | null>(null);
  // 見張りの中から「いま板が出ているか」を読む（effect の閉包は 1 コミット古いことがある）。
  const pendingRef = useRef<DiscardReason | null>(null);
  pendingRef.current = pending;
  const intentRef = useRef<ToolSwitchIntent | null>(null);
  // 下書きの量は毎レンダー変わる。見張りの effect は `armed` だけを鍵にするので、
  // 中で読む値は ref 越しにする（依存に入れると打つたびに張り替わる）。
  const draftRef = useRef({ has: hasCommittableDraft, count: vertexCount });
  draftRef.current = { has: hasCommittableDraft, count: vertexCount };
  const armRef = useRef(options.onArm);
  armRef.current = options.onArm;
  const disarmRef = useRef(options.onDisarm);
  disarmRef.current = options.onDisarm;
  const discardPointsRef = useRef(options.onDiscardPoints);
  discardPointsRef.current = options.onDiscardPoints;
  const discardedRef = useRef(options.onDraftDiscarded);
  discardedRef.current = options.onDraftDiscarded;

  const prevArmedRef = useRef(false);
  useEffect(() => {
    const prev = prevArmedRef.current;
    if (armed === prev) return;
    if (prev && !armed && (pendingRef.current !== null || draftRef.current.has)) {
      // **切替先を構えないまま聞く。** 戻したあとは `armed` がまた真になるので、
      // 次のコミットでこの effect は `armed === prev` で素通りする（基準は進めない）。
      //
      // **板が出ているあいだに別の切替が来ても同じ**（背面の覆いをすり抜ける経路が
      // あったときの備え）。ここで素通りさせて後片付けへ落とすと、**答える前に下書きが
      // 黙って消える** ―― 板を出した意味が無くなる。意図だけを最新の切替へ差し替える。
      const st = store.getState();
      const locked = st.mode === EDIT_MODE.View;
      intentRef.current = { lock: locked, tool: st.activeTool };
      // 鍵を閉じたのなら、まず開ける（`setMode` は道具を外すので順序が要る）。
      if (locked) store.getState().setMode(EDIT_MODE.Edit);
      store.getState().setActiveTool(toolId);
      // 既に出ている板の理由は書き換えない（「なぜ聞いているか」が途中で変わらない）。
      if (pendingRef.current === null) {
        setPending(locked ? DISCARD_REASON.Lock : DISCARD_REASON.Tool);
      }
      return;
    }
    prevArmedRef.current = armed;
    if (armed) armRef.current();
    else disarmRef.current();
    // 鍵は `armed`（道具 × モード）だけを見る。中で読む残りは ref 越しなので、
    // 頂点を打つたびに構え直しが走ることはない。
  }, [armed, store, toolId]);

  const askOnEscape = useCallback(() => {
    intentRef.current = null;
    setPending(DISCARD_REASON.Escape);
  }, []);

  const keep = useCallback(() => {
    intentRef.current = null;
    setPending(null);
  }, []);

  const discard = useCallback(() => {
    const intent = intentRef.current;
    intentRef.current = null;
    setPending(null);
    const lost = draftRef.current.count;
    if (intent === null) {
      // 利用者自身の Escape ―― 1 段ぶん（点列だけ）を捨てる。対象も道具も保つ。
      discardPointsRef.current();
    } else {
      // 道具の持ち替え・鍵 ―― この道具から降りるので、下書きごと畳む。
      disarmRef.current();
      prevArmedRef.current = false;
    }
    if (lost > 0) discardedRef.current?.(lost);
    if (intent === null) return;
    const st = store.getState();
    if (intent.lock) {
      st.setMode(EDIT_MODE.View);
      return;
    }
    st.setActiveTool(intent.tool);
  }, [store]);

  return { armed, pending, vertexCount, askOnEscape, keep, discard };
}
