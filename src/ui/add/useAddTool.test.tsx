import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ADD_TOOL_KIND, parentSelection, PARENT_TOP_LEVEL } from '../../domain/add/index';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  PROCESS_STATUS,
  type CommittedResult,
  type ConflictsPendingResult,
  type ProcessResult,
  type RejectedResult,
} from '../../domain/consistency/index';
import {
  asFeatureId,
  asRingId,
  asVertexId,
  type FeatureId,
  type RingId,
  type VertexId,
} from '../../domain/ids';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { ADD_PHASE, useAddTool, type StartAddProcess, type UseAddToolOptions } from './useAddTool';
import type { AddProposal } from '../../domain/add/index';

const C = (lon: number, lat: number) => ({ lon, lat });
const attrs = createBasicAttributes('Newland', 1500, 1600);
const color = createColorInfo(true, '#fff', '#0ff', '#000');
const props = { attributes: attrs, color };
const currentTime = timePointYearMonthDay(1500, 6, 20);

type S = { tag: 'state' };
const STATE: S = { tag: 'state' };

const committed: CommittedResult<S> = {
  status: PROCESS_STATUS.Committed,
  state: STATE,
  command: { kind: 'k', execute: () => ({ state: STATE, result: undefined as never }) } as never,
};
const pending: ConflictsPendingResult<S> = {
  status: PROCESS_STATUS.ConflictsPending,
  conflicts: [],
  unresolvedConflictIds: [],
  trialState: STATE,
};
const rejected: RejectedResult = {
  status: PROCESS_STATUS.Rejected,
  kind: 'time-violation',
  message: '時間が不正です。',
};

interface Recorder {
  last: AddProposal | null;
}

function makeOptions(
  resultFor: () => ProcessResult<S>,
  onCommitted = vi.fn(),
  onConflicts = vi.fn(),
  recorder?: Recorder,
): UseAddToolOptions<S> {
  let v = 0;
  let f = 0;
  let r = 0;
  const startProcess: StartAddProcess<S> = (proposal) => {
    if (recorder) recorder.last = proposal;
    return resultFor();
  };
  return {
    currentTime,
    gridSpacing: 10,
    ids: {
      nextFeatureId: () => asFeatureId(`f${++f}`) as FeatureId,
      nextVertexId: () => asVertexId(`v${++v}`) as VertexId,
    },
    nextRingId: () => asRingId(`r${++r}`) as RingId,
    startProcess,
    onCommitted,
    onConflicts,
  };
}

describe('useAddTool flow (FR-76, 教訓 5.7 完了トリガー)', () => {
  it('line: start → place 2 → complete opens the property form', () => {
    const sp = vi.fn(() => committed);
    const { result } = renderHook(() => useAddTool(makeOptions(sp)));

    act(() => result.current.start(ADD_TOOL_KIND.Line));
    expect(result.current.phase).toBe(ADD_PHASE.Drawing);
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.canComplete).toBe(true);

    act(() => result.current.completeShape());
    expect(result.current.phase).toBe(ADD_PHASE.PropertyForm);
    expect(result.current.draft).not.toBeNull();
  });

  it('line: completing with <2 vertices is rejected with a Japanese message', () => {
    const sp = vi.fn(() => committed);
    const { result } = renderHook(() => useAddTool(makeOptions(sp)));
    act(() => result.current.start(ADD_TOOL_KIND.Line));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.completeShape());
    expect(result.current.phase).toBe(ADD_PHASE.Drawing);
    expect(result.current.message).toMatch(/頂点が足りません/);
  });

  it('save runs U13 with anchorTime = current time (教訓 5.15)', () => {
    const sp = vi.fn(() => committed);
    const onCommitted = vi.fn();
    const rec: Recorder = { last: null };
    const { result } = renderHook(() => useAddTool(makeOptions(sp, onCommitted, vi.fn(), rec)));
    act(() => result.current.start(ADD_TOOL_KIND.Line));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(1, 1)));
    act(() => result.current.completeShape());
    act(() => result.current.save(props));

    expect(sp).toHaveBeenCalledTimes(1);
    const proposal = rec.last;
    expect(proposal).not.toBeNull();
    expect(proposal?.anchorTime).toEqual(currentTime);
    // committed → onCommitted called with the new feature id (教訓 5.11)
    expect(onCommitted).toHaveBeenCalledWith(committed, proposal?.featureId);
    // session fully discarded after commit (教訓 5.2)
    expect(result.current.session).toBeNull();
    expect(result.current.phase).toBe(ADD_PHASE.Idle);
  });

  it('U13 conflicts → ConflictPaused + onConflicts (FR-62)', () => {
    const sp = vi.fn(() => pending);
    const onConflicts = vi.fn();
    const { result } = renderHook(() => useAddTool(makeOptions(sp, vi.fn(), onConflicts)));
    act(() => result.current.start(ADD_TOOL_KIND.Point));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.completeShape());
    act(() => result.current.save(props));
    expect(result.current.phase).toBe(ADD_PHASE.ConflictPaused);
    expect(onConflicts).toHaveBeenCalledTimes(1);
  });

  it('U13 rejection → Rejected + Japanese message, nothing recorded (FR-115 / 教訓 5.22)', () => {
    const sp = vi.fn(() => rejected);
    const onCommitted = vi.fn();
    const { result } = renderHook(() => useAddTool(makeOptions(sp, onCommitted)));
    act(() => result.current.start(ADD_TOOL_KIND.Point));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.completeShape());
    act(() => result.current.save(props));
    expect(result.current.phase).toBe(ADD_PHASE.Rejected);
    expect(result.current.message).toBe('時間が不正です。');
    expect(onCommitted).not.toHaveBeenCalled();
  });
});

describe('transient discard (教訓 5.2 全経路で破棄)', () => {
  it('cancel discards placed vertices; re-start is empty', () => {
    const { result } = renderHook(() => useAddTool(makeOptions(vi.fn(() => committed))));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(1, 0)));
    act(() => result.current.cancel());
    expect(result.current.session).toBeNull();
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    expect(result.current.session?.vertices).toEqual([]);
  });

  it('tool switch (resetForSwitch) discards the in-progress session', () => {
    const { result } = renderHook(() => useAddTool(makeOptions(vi.fn(() => committed))));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.resetForSwitch());
    expect(result.current.session).toBeNull();
    expect(result.current.phase).toBe(ADD_PHASE.Idle);
  });

  it('undo at 0 vertices cancels the add (spec §注意点)', () => {
    const { result } = renderHook(() => useAddTool(makeOptions(vi.fn(() => committed))));
    act(() => result.current.start(ADD_TOOL_KIND.Line));
    act(() => result.current.undo());
    expect(result.current.session).toBeNull();
  });

  it('undo removes the last vertex one at a time', () => {
    const { result } = renderHook(() => useAddTool(makeOptions(vi.fn(() => committed))));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(1, 0)));
    act(() => result.current.undo());
    expect(result.current.session?.vertices).toHaveLength(1);
  });
});

describe('grid snap + parent selection (FR-77 / FR-78)', () => {
  it('grid snap on rounds the placed coordinate', () => {
    const { result } = renderHook(() => useAddTool(makeOptions(vi.fn(() => committed))));
    act(() => result.current.start(ADD_TOOL_KIND.Point));
    act(() => result.current.toggleGridSnap(true));
    act(() => result.current.placeAt(C(12, 7)));
    expect(result.current.session?.vertices[0]?.coordinate).toEqual(C(10, 10));
  });

  it('a chosen parent is included in the saved proposal (FR-77 同一操作)', () => {
    const rec: Recorder = { last: null };
    const { result } = renderHook(() => useAddTool(makeOptions(() => committed, vi.fn(), vi.fn(), rec)));
    const pid = asFeatureId('cover') as FeatureId;
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(2, 0)));
    act(() => result.current.placeAt(C(1, 2)));
    act(() => result.current.chooseParent(parentSelection(pid)));
    act(() => result.current.completeShape());
    act(() => result.current.save(props));
    expect(rec.last?.snapshot.feature.parentId).toBe(pid);
  });

  it('親なし selection saves a top-level face (no parentId, FR-39)', () => {
    const rec: Recorder = { last: null };
    const { result } = renderHook(() => useAddTool(makeOptions(() => committed, vi.fn(), vi.fn(), rec)));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    act(() => result.current.placeAt(C(2, 0)));
    act(() => result.current.placeAt(C(1, 2)));
    act(() => result.current.chooseParent(PARENT_TOP_LEVEL));
    act(() => result.current.completeShape());
    act(() => result.current.save(props));
    expect(rec.last?.snapshot.feature.parentId).toBeUndefined();
  });
});
