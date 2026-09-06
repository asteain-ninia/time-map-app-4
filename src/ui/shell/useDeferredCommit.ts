// UI layer (U20 / shell): **時間のかかる確定に進行表示を出し、二重に適用させない**
// （増分 7 の中身 9 / 設計書 §C.2 の 25「進行中の表示」）。
//
// **これが直すもの**: 所属変更の確定は実測 2.8 秒、分割は 2.5〜3.1 秒かかるのに、押した
// あと画面が 3 秒間まったく動かなかった（C6）。利用者からは「効かなかった」に見えるので
// もう一度押す ―― そして 2 回目が本当に走る（確定は同期なので、1 回目の最中は押せて
// しまう）。**押せない時間を作るのではなく、押せていることを画面に出す。**
//
// **なぜ 1 コマ遅らせるのか**: 確定そのものは同期の重い計算で、その間ブラウザは 1 度も
// 描かない。だから「busy を立てる → 確定を走らせる」を同じ実行の中で書くと、**busy の
// 表示は 1 度も画面に出ない**（描く暇なく false へ戻る）。`requestAnimationFrame` で
// 1 枚描かせてから `setTimeout` で仕事を始めると、進行表示が確実に出る。
//
// **二重適用の関門はここ 1 か所**（教訓 5.24 / 5.29）。呼び出し側はボタンを `disabled` に
// するだけでよく、`disabled` を外せる経路（打鍵・右クリック・別の入口）があっても
// 走るのは 1 回である ―― `FileOpsController` の `runExclusive` と同じ考え方だが、
// あちらは UI に何も出さない（押せるが no-op）ので、こちらは **出す**ほうに倒す。

import { useCallback, useEffect, useRef, useState } from 'react';

/** 実行を遅らせる口（検査では同期の実装を差し込む）。 */
export type CommitScheduler = (run: () => void) => void;

/**
 * 既定の遅らせ方: 1 枚描かせてから始める。`requestAnimationFrame` が無い環境
 * （古い jsdom・Node）では `setTimeout` だけに落ちる。
 */
export const defaultCommitScheduler: CommitScheduler = (run) => {
  const start = (): void => {
    setTimeout(run, 0);
  };
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(start);
    return;
  }
  start();
};

export interface DeferredCommit {
  /** 確定が走っている（進行表示を出し、確定ボタンを止める）。 */
  readonly busy: boolean;
  /**
   * 確定を 1 コマ遅らせて走らせる。**走っている間に呼んでも 2 回目は走らない**
   * （二重クリックの関門）。
   */
  readonly run: (task: () => void) => void;
}

export function useDeferredCommit(options?: {
  readonly schedule?: CommitScheduler;
}): DeferredCommit {
  const schedule = options?.schedule ?? defaultCommitScheduler;
  const [busy, setBusy] = useState(false);
  // **旗は ref でも持つ**。`busy` の state は次のコミットまで真にならないので、同じ
  // ティックの中で 2 回押されたら state だけでは止められない（実測: マウスの
  // ダブルクリックは 1 コミットの中に 2 発入る）。
  const runningRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const run = useCallback(
    (task: () => void): void => {
      if (runningRef.current) return;
      runningRef.current = true;
      setBusy(true);
      schedule(() => {
        try {
          task();
        } finally {
          runningRef.current = false;
          // 走り終えた時点で部品ごと消えていることがある（板が閉じる）。消えた木へ
          // 書き戻さない（教訓 5.2 全経路で捨てる）。
          if (mountedRef.current) setBusy(false);
        }
      });
    },
    [schedule],
  );

  return { busy, run };
}
