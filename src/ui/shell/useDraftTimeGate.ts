// UI layer (U20 / shell): **打ちかけの下書きを持ったまま年を動かそうとしたら、動かす前に止める**
// 関門（設計書 §D.2 の☆☆ / §D.4.1 の 3。B112）。追加の道具・輪郭・穴あけ・分ける の 4 つが
// この 1 本を通る。
//
// --- なぜ「動いてから戻す」をやめたか ------------------------------------------
//
// 追加の道具は、年が動いたあとで見張りが気づき、元の年へ書き戻してから板を出していた。
// 同じ形を残り 3 道具へ配ると、書き戻しでは取り返せないものが 3 つある:
//
//   ・年を動かした瞬間にストアが選択を洗い直す。掴んでいる面がその年に居ないと選択が外れ、
//     年を戻しても選択は戻らない（教訓 5.71 の「前倒しした状態が未変更」が破れる）。
//   ・一覧の印も、居なくなったぶんが外れて戻らない。
//   ・分けるの「対象が居なくなったら手放す」が同じコミットで先に走り、分断線ごと消える。
//
// 時刻の変更はすべて `store.setCurrentTime` の 1 本を通るので、その入口で止める（教訓 5.75）。
// 再生・レールのクリック・鍵盤の送り・直接ジャンプ・錨の行のどれから来ても同じに扱える。
//
// --- 「年を動かして、続きをする」は 1 つの遷移 -----------------------------------
//
// 一覧の行は「年を動かして選ぶ」、錨の行は「年を動かして印を動かす」。続きを呼ぶ側に残すと、
// 年だけ止まって続きが走る（選択だけ動く）。続きは `setCurrentTime` の第 3 引数で渡し、止めた
// 移動と一緒にここが預かる。［捨てる］で年と一緒に走り、［続ける］では走らない。
//
// --- 聞かない 1 つの例外 ---------------------------------------------------------
//
// 設定で表示年の範囲を狭めると、いまの年が範囲の外へ出て補正される。範囲は確定済みなので止め
// られず、聞いても答えが 1 つしかない。下書きをその年へ持ち越すと別の年の記録になるので、聞かずに
// 捨てて言う（`TIME_CHANGE_SOURCE.RangeClamp`。呼ぶのはストアの書き込みの出口）。

import { useEffect, useRef } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { TimePoint } from '../../domain/time/time-point';
import { TIME_CHANGE_SOURCE, type SessionStore, type TimeChangeSource } from '../state/store';

/** 下書きを聞かずに捨てた理由、または［捨てる］のあとの年の移動（状態行の言い方が変わる）。 */
export const DRAFT_LOSS_CAUSE = {
  /** 年を動かした（移動の知らせの後ろへ続ける）。 */
  TimeMoved: 'time-moved',
  /** 設定で表示年の範囲が変わり、年が補正された。 */
  RangeClamped: 'range-clamped',
  /** ファイルを開いた・新規にした。 */
  ProjectSwitched: 'project-switched',
} as const;

export type DraftLossCause = (typeof DRAFT_LOSS_CAUSE)[keyof typeof DRAFT_LOSS_CAUSE];

/** 捨てたものを状態行へ言う口。`what` は文言の表から作った「○○を捨てました」、`time` は動いた先。 */
export type DraftLostHandler = (what: string, cause: DraftLossCause, time: TimePoint) => void;

export interface DraftTimeGateOptions<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** 「捨てますか」の板が開いている。答えるまで年は動かさない（どの理由の板でも）。 */
  readonly isBoardOpen: () => boolean;
  /** 打った年に結びついている下書きがあるか。無ければ関門は何もしない。 */
  readonly hasDraft: boolean;
  /** 聞く価値のある下書きか（確定できる点数まで来ている）。 */
  readonly asks: boolean;
  /**
   * 板を出す。**渡された `moveTime` を呼ぶと、頼まれていた年へ実際に動く**（「捨てる」と
   * 答えられたときに呼ぶ）。［続ける］は何も呼ばない ―― 年はまだ動いていない。
   */
  readonly onAsk: (moveTime: () => void) => void;
  /**
   * 聞くまでもない下書きを捨てる（§D.4.1 の一線）。このあと年を動かし、{@link onMovedAfterDiscard}
   * を呼ぶ。戻り値は捨てたものの文（無ければ空文字）。
   */
  readonly onDiscardSilently: () => string;
  /** 下書きを捨てて年が動いたあとに呼ぶ（捨てたものを状態行へ。移動の知らせの後ろに続く）。 */
  readonly onMovedAfterDiscard: (what: string) => void;
  /** 設定の補正で年が動く。聞かずに下書きを捨て（板が開いていれば閉じ）、そう言う。 */
  readonly onRangeClamped: (time: TimePoint) => void;
}

export function useDraftTimeGate<S>(options: DraftTimeGateOptions<S>): void {
  const { store } = options;
  // 関門はマウントのあいだ 1 回だけ張る。読む値はレンダーごとに ref で最新へ。
  const latest = useRef(options);
  latest.current = options;
  // 「捨てる」と答えられたあとの移動を、自分の関門で止めないための印。
  const passingRef = useRef(false);
  // 止めている移動（行き先と続き）。板が開いているあいだに次の移動を頼まれたら差し替える ――
  // レールを引いている途中で板が開いても、行き先は離した位置である。年の板でなければ読まれない。
  const heldRef = useRef<{
    readonly time: TimePoint;
    readonly source: TimeChangeSource;
    readonly andThen: (() => void) | undefined;
  } | null>(null);

  useEffect(
    () =>
      store.getState().addTimeChangeGate((time, source, andThen) => {
        const now = latest.current;
        if (source === TIME_CHANGE_SOURCE.RangeClamp) {
          if (now.hasDraft || now.isBoardOpen()) now.onRangeClamped(time);
          return false;
        }
        if (passingRef.current) return false;
        if (now.isBoardOpen()) {
          heldRef.current = { time, source, andThen };
          return true;
        }
        if (!now.hasDraft) return false;
        heldRef.current = { time, source, andThen };
        const moveTime = (): void => {
          const held = heldRef.current;
          heldRef.current = null;
          if (held === null) return;
          passingRef.current = true;
          try {
            store.getState().setCurrentTime(held.time, held.source, held.andThen);
          } finally {
            passingRef.current = false;
          }
        };
        if (now.asks) {
          now.onAsk(moveTime);
          return true;
        }
        const what = now.onDiscardSilently();
        moveTime();
        now.onMovedAfterDiscard(what);
        return true;
      }),
    [store],
  );
}
