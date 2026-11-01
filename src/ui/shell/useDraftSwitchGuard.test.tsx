// B118: 分ける・穴あけ・輪郭の下書きを持ったまま、同じ年の別の地物を一覧で選んだとき。
//
// 実機の 3 道具の通し検査は `e2e/b117-b118-leftovers.spec.ts`。ここは見張りの分かれ道を見る。

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { useStore } from 'zustand';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';
import { timePointYear } from '../../domain/time/time-point';
import { EDIT_MODE } from '../state/session';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';

import { DISCARD_REASON } from './DraftDiscardConfirm';
import { TOOL_ID } from './tools';
import { useDraftSwitchGuard, type DraftSwitchGuard } from './useDraftSwitchGuard';

const A = asFeatureId('A');
const B = asFeatureId('B');

function makeStore() {
  return createSessionStore<{ readonly tag: string }>({
    initialDomain: { tag: 'd0' },
    existence: { featureExistsAt: () => true, vertexExistsAt: () => true },
    initial: { mode: EDIT_MODE.Edit, activeTool: TOOL_ID.EditRing, activeFeature: A },
  });
}

type TestStore = ReturnType<typeof makeStore>;

interface Draft {
  readonly committable: boolean;
  readonly count: number;
}

function setup(initial: Draft) {
  const store: TestStore = makeStore();
  const calls = {
    discardForTime: vi.fn(),
    discardPoints: vi.fn(),
    discarded: vi.fn(),
    focus: vi.fn(),
    held: vi.fn(),
    disarm: vi.fn(),
  };
  let guard: DraftSwitchGuard | null = null;
  function Harness(props: Draft): null {
    guard = useDraftSwitchGuard({
      store,
      toolId: TOOL_ID.EditRing,
      hasCommittableDraft: props.committable,
      vertexCount: props.count,
      onArm: () => {},
      onDisarm: calls.disarm,
      onDiscardPoints: calls.discardPoints,
      onDiscardForTimeMove: calls.discardForTime,
      onDraftDiscarded: calls.discarded,
      onFocusSelection: calls.focus,
      onDraftHeldChange: calls.held,
    });
    return null;
  }
  const utils = render(<Harness {...initial} />);
  return {
    store,
    calls,
    current: (): DraftSwitchGuard => guard!,
    redraft: (next: Draft) => utils.rerender(<Harness {...next} />),
    select: (id: FeatureId | null) => act(() => store.getState().setActiveFeature(id)),
  };
}

const COMMITTABLE: Draft = { committable: true, count: 3 };
const SHORT: Draft = { committable: false, count: 2 };
const NONE: Draft = { committable: false, count: 0 };

describe('useDraftSwitchGuard — 一覧で別の地物を選んだ', () => {
  it('確定できる下書き: 聞く。続けるで選択を戻し、下書きは触らず、開き直さない', () => {
    const h = setup(COMMITTABLE);
    h.select(B);
    expect(h.current().pending).toBe(DISCARD_REASON.Select);
    expect(h.calls.discardForTime).not.toHaveBeenCalled();
    expect(h.calls.focus).not.toHaveBeenCalled();

    act(() => h.current().keep());
    expect(h.current().pending).toBeNull();
    expect(h.store.getState().activeFeature).toBe(A);
    expect(h.calls.discardForTime).not.toHaveBeenCalled();
  });

  it('板を開くと決めた回の後ろの effect にも、板のことが読める（対象の見張りが待つため。B134）', () => {
    const store: TestStore = makeStore();
    const seen: Array<readonly [FeatureId | null, boolean]> = [];
    function Harness(): null {
      const guard = useDraftSwitchGuard({
        store,
        toolId: TOOL_ID.EditRing,
        hasCommittableDraft: true,
        vertexCount: 3,
        onArm: () => {},
        onDisarm: () => {},
        onDiscardPoints: () => {},
      });
      // 宿主の対象の見張りと同じ置き方。見張りの hook の後ろで、選択が動いた回に読む。
      const activeFeature = useStore(store, (s) => s.activeFeature);
      useEffect(() => {
        seen.push([activeFeature, guard.isBoardOpen()]);
      }, [activeFeature, guard]);
      return null;
    }
    render(<Harness />);
    act(() => store.getState().setActiveFeature(B));
    // B へ動いた最初の回から、板のことが読める（`pending` はこの回ではまだ古い）。
    expect(seen.find(([id]) => id === B)?.[1]).toBe(true);
  });

  it('確定できる下書き: 捨てるで選んだほうを残し、下書きだけ捨てて言い、視点を合わせる', () => {
    const h = setup(COMMITTABLE);
    h.select(B);
    act(() => h.current().discard());
    expect(h.current().pending).toBeNull();
    expect(h.store.getState().activeFeature).toBe(B);
    expect(h.calls.discardForTime).toHaveBeenCalledTimes(1);
    expect(h.calls.discarded).toHaveBeenCalledWith(3);
    expect(h.calls.focus).toHaveBeenCalledTimes(1);
    // 道具からは降りない。
    expect(h.calls.disarm).not.toHaveBeenCalled();
    expect(h.current().armed).toBe(true);

    // 下書きが片付いたあとの選択は聞かない。
    h.redraft(NONE);
    h.select(A);
    expect(h.current().pending).toBeNull();
  });

  it('確定できない点数: 聞かずに捨てて言い、視点を合わせる', () => {
    const h = setup(SHORT);
    h.select(B);
    expect(h.current().pending).toBeNull();
    expect(h.store.getState().activeFeature).toBe(B);
    expect(h.calls.discardForTime).toHaveBeenCalledTimes(1);
    expect(h.calls.discarded).toHaveBeenCalledWith(2);
    expect(h.calls.focus).toHaveBeenCalledTimes(1);
  });

  it('下書きが無い（道具が自分で対象を選んだときも）: 何もしない', () => {
    const h = setup(NONE);
    h.select(B);
    expect(h.current().pending).toBeNull();
    expect(h.calls.discardForTime).not.toHaveBeenCalled();
    expect(h.calls.discarded).not.toHaveBeenCalled();
    expect(h.calls.focus).not.toHaveBeenCalled();
  });

  it('選択を外しただけなら聞かない', () => {
    const h = setup(COMMITTABLE);
    h.select(null);
    expect(h.current().pending).toBeNull();
    expect(h.calls.discardForTime).not.toHaveBeenCalled();
  });

  it('年の移動の［捨てる］: 年の移動の続きが走る前に「もう持っていない」と知らせる（通史の行の視点）', () => {
    const h = setup(COMMITTABLE);
    const heldAtMove: unknown[] = [];
    const unsubscribe = h.store.subscribe(() => {
      heldAtMove.push(h.calls.held.mock.lastCall?.[0]);
    });
    act(() => h.store.getState().setCurrentTime(timePointYear(1700), TIME_CHANGE_SOURCE.NumericJump));
    expect(h.current().pending).toBe(DISCARD_REASON.Time);
    heldAtMove.length = 0;
    act(() => h.current().discard());
    unsubscribe();
    expect(h.store.getState().currentTime.year).toBe(1700);
    expect(heldAtMove[0]).toBe(false);
  });

  it('視点を止めるための知らせ: 聞く下書きか点があるあいだだけ真', () => {
    const h = setup(NONE);
    expect(h.calls.held).toHaveBeenLastCalledWith(false);
    h.redraft(SHORT);
    expect(h.calls.held).toHaveBeenLastCalledWith(true);
    h.redraft(COMMITTABLE);
    expect(h.calls.held).toHaveBeenLastCalledWith(true);
    h.redraft(NONE);
    expect(h.calls.held).toHaveBeenLastCalledWith(false);
  });
});
