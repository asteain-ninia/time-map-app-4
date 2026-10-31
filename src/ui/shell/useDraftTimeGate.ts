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

import { useEffect, useRef } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { SessionStore } from '../state/store';

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
   * を呼ぶ。戻り値は捨てた頂点の数。
   */
  readonly onDiscardSilently: () => number;
  /** 下書きを捨てて年が動いたあとに呼ぶ（捨てた数を状態行へ。移動の知らせの後ろに続く）。 */
  readonly onMovedAfterDiscard: (lost: number) => void;
}

export function useDraftTimeGate<S>(options: DraftTimeGateOptions<S>): void {
  const { store } = options;
  // 関門はマウントのあいだ 1 回だけ張る。読む値はレンダーごとに ref で最新へ。
  const latest = useRef(options);
  latest.current = options;
  // 「捨てる」と答えられたあとの移動を、自分の関門で止めないための印。
  const passingRef = useRef(false);

  useEffect(
    () =>
      store.getState().addTimeChangeGate((time, source) => {
        if (passingRef.current) return false;
        const now = latest.current;
        if (now.isBoardOpen()) return true;
        if (!now.hasDraft) return false;
        const moveTime = (): void => {
          passingRef.current = true;
          try {
            store.getState().setCurrentTime(time, source);
          } finally {
            passingRef.current = false;
          }
        };
        if (now.asks) {
          now.onAsk(moveTime);
          return true;
        }
        const lost = now.onDiscardSilently();
        moveTime();
        now.onMovedAfterDiscard(lost);
        return true;
      }),
    [store],
  );
}
