// 「時間のかかる確定に進行表示を出し、二重に適用させない」共有の器の検査
//（増分 7 の中身 9 / 設計書 §C.2 の 25）。
//
// 実測で所属変更の確定は 2.8 秒、分割は 2.5〜3.1 秒かかる。押したあと画面が動かないので
// **もう一度押される** ―― そして 2 回目が本当に走る（確定は同期なので 1 回目の最中でも
// 押せる）。ここで固定するのは 2 つ: ①進行表示が **実際に出る**（1 コマ遅らせるので、
// 走らせる前に busy が真になる）②走っている間の 2 回目は走らない。

import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useDeferredCommit, type CommitScheduler } from './useDeferredCommit';

/** 遅らせを手で進める足場（本番の rAF＋setTimeout を検査から操れる形にする）。 */
function manualScheduler(): { schedule: CommitScheduler; flush: () => void } {
  const queue: (() => void)[] = [];
  return {
    schedule: (run) => queue.push(run),
    flush: () => {
      const pending = [...queue];
      queue.length = 0;
      for (const run of pending) run();
    },
  };
}

function Harness(props: {
  readonly schedule: CommitScheduler;
  readonly onRun: () => void;
}): JSX.Element {
  const deferred = useDeferredCommit({ schedule: props.schedule });
  return (
    <div>
      <span data-testid="busy">{deferred.busy ? 'yes' : 'no'}</span>
      <button type="button" data-testid="go" onClick={() => deferred.run(props.onRun)}>
        確定
      </button>
    </div>
  );
}

describe('useDeferredCommit — 進行表示と二重クリックの関門（増分 7 の中身 9）', () => {
  it('押した時点で busy になり、仕事はまだ走っていない（進行表示が 1 コマ出る）', () => {
    const s = manualScheduler();
    const onRun = vi.fn();
    render(<Harness schedule={s.schedule} onRun={onRun} />);

    act(() => screen.getByTestId('go').click());
    expect(screen.getByTestId('busy').textContent).toBe('yes');
    // **ここが肝**: 同じ実行の中で走らせると、進行表示は 1 度も画面に出ない。
    expect(onRun).not.toHaveBeenCalled();

    act(() => s.flush());
    expect(onRun).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('busy').textContent).toBe('no');
  });

  it('走っている間に押し直しても 2 回は走らない（二重適用の関門）', () => {
    const s = manualScheduler();
    const onRun = vi.fn();
    render(<Harness schedule={s.schedule} onRun={onRun} />);

    act(() => {
      // 1 コミットの中に 2 発（マウスのダブルクリックはこう入る）。
      screen.getByTestId('go').click();
      screen.getByTestId('go').click();
    });
    act(() => s.flush());
    expect(onRun).toHaveBeenCalledTimes(1);
  });

  it('走り終えたら次の確定は通る（関門が固まらない）', () => {
    const s = manualScheduler();
    const onRun = vi.fn();
    render(<Harness schedule={s.schedule} onRun={onRun} />);

    act(() => screen.getByTestId('go').click());
    act(() => s.flush());
    act(() => screen.getByTestId('go').click());
    act(() => s.flush());
    expect(onRun).toHaveBeenCalledTimes(2);
  });

  it('仕事が投げても関門は開く（例外で押せなくならない）', () => {
    const s = manualScheduler();
    const boom = (): void => {
      throw new Error('確定できません');
    };
    render(<Harness schedule={s.schedule} onRun={boom} />);

    act(() => screen.getByTestId('go').click());
    expect(() => act(() => s.flush())).toThrow('確定できません');
    // 例外のあとでも busy は下りている（`finally` で必ず開ける）。**投げた実行が
    // 中断されるので、React の書き戻しは次の `act` で流し込む**（検査の都合であって、
    // 実物では例外はその場で捕まえられ、再描画は続く）。
    act(() => {
      /* 中断された更新を流す */
    });
    expect(screen.getByTestId('busy').textContent).toBe('no');
  });

  it('走っている間に部品が消えても、消えた木へ書き戻さない（教訓 5.2）', () => {
    const s = manualScheduler();
    const onRun = vi.fn();
    const view = render(<Harness schedule={s.schedule} onRun={onRun} />);

    act(() => screen.getByTestId('go').click());
    view.unmount();
    // 消えたあとに走らせても、React の警告なしに完了する。
    expect(() => act(() => s.flush())).not.toThrow();
    expect(onRun).toHaveBeenCalledTimes(1);
  });
});
