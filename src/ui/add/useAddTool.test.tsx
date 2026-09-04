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
    // committed → onCommitted called with the new feature id (教訓 5.11)。
    // 増分 3 で 3 つ目に「確定したものの素性」（いまは共有した頂点の数）が付いた。
    expect(onCommitted).toHaveBeenCalledWith(committed, proposal?.featureId, {
      sharedVertexCount: 0,
    });
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

// --- 増分 3: 吸着（FR-31）と FR-29 の断り ------------------------------------

describe('useAddTool — 吸着と FR-29 の断り（増分 3 / C1）', () => {
  const neighbour = asFeatureId('f-neighbour') as FeatureId;
  const neighbourVertex = asVertexId('v-neighbour') as VertexId;

  function withPorts(extra: Partial<UseAddToolOptions<S>>): UseAddToolOptions<S> {
    return { ...makeOptions(() => committed), ...extra };
  }

  it('吸着すると、置かれる座標が吸着先になり、共有する頂点の id が残る', () => {
    const resolveProximity = vi.fn(() => ({
      coordinate: C(4, 4),
      bodyCoordinate: C(4, 4),
      featureId: neighbour,
      vertexId: neighbourVertex,
    }));
    const { result } = renderHook(() =>
      useAddTool(withPorts({ resolveProximity })),
    );
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    // 押したのは (5, 5) だが、吸着先の (4, 4) に置かれる。
    act(() => result.current.placeAt(C(5, 5)));
    const placed = result.current.session?.vertices[0];
    expect(placed?.coordinate).toEqual(C(4, 4));
    expect(placed?.sharedCandidateId).toBe(neighbour);
    // **どの頂点か**まで持つ（これが無いと共有頂点にならない）。
    expect(placed?.sharedVertexId).toBe(neighbourVertex);
  });

  it('カーソルを動かすと、置かれる場所の予告が入る（琥珀の輪の元）', () => {
    const resolveProximity = vi.fn(() => ({
      coordinate: C(4, 4),
      bodyCoordinate: C(4, 4),
      featureId: neighbour,
      vertexId: neighbourVertex,
    }));
    const { result } = renderHook(() => useAddTool(withPorts({ resolveProximity })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.preview(C(5, 5)));
    expect(result.current.session?.preview).toEqual(C(5, 5));
    expect(result.current.session?.previewSnap).toEqual({
      coordinate: C(4, 4),
      sharedCandidateId: neighbour,
    });
  });

  it('o: 点の道具は面・線の頂点に吸着しない（司令塔の決定 3。所有者が覆せる）', () => {
    const resolveProximity = vi.fn(() => ({
      coordinate: C(4, 4),
      sharedCandidateId: asFeatureId('f-neighbour') as FeatureId,
      featureId: asFeatureId('f-neighbour') as FeatureId,
      bodyCoordinate: C(4, 4),
      vertexId: asVertexId('v-neighbour') as VertexId,
    }));
    const { result } = renderHook(() => useAddTool(withPorts({ resolveProximity })));
    act(() => result.current.start(ADD_TOOL_KIND.Point));
    act(() => result.current.preview(C(5, 5)));
    expect(result.current.session?.previewSnap).toBeNull();
    act(() => result.current.placeAt(C(5, 5)));
    expect(result.current.session?.vertices[0]?.coordinate).toEqual(C(5, 5));
    expect(result.current.session?.vertices[0]?.sharedVertexId).toBeUndefined();
    // 供給元も呼ばない（都市が国境の角と繋がる余地を残さない）。
    expect(resolveProximity).not.toHaveBeenCalled();
    // 面の道具では今までどおり吸着する（道具ごとの規則であることを示す）。
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.preview(C(5, 5)));
    expect(result.current.session?.previewSnap).not.toBeNull();
  });

  it('o: 線が同じ頂点を使い直せるのは **始点だけ**（途中の出戻りは長さ 0 の辺になる）', () => {
    const v1 = asVertexId('v-1') as VertexId;
    const v2 = asVertexId('v-2') as VertexId;
    let target = v1;
    const resolveProximity = vi.fn(() => ({
      coordinate: C(0, 0),
      sharedCandidateId: asFeatureId('f-n') as FeatureId,
      featureId: asFeatureId('f-n') as FeatureId,
      bodyCoordinate: C(0, 0),
      vertexId: target,
    }));
    const { result } = renderHook(() => useAddTool(withPorts({ resolveProximity })));
    act(() => result.current.start(ADD_TOOL_KIND.Line));
    act(() => result.current.placeAt(C(0, 0))); // 始点（v-1 に吸着）
    target = v2;
    act(() => result.current.placeAt(C(1, 1))); // 2 点目（v-2 に吸着）
    expect(result.current.session?.vertices).toHaveLength(2);
    // **2 点目をもう一度**押しても増えない（長さ 0 の辺になるので断る）。
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.session?.vertices).toHaveLength(2);
    expect(result.current.message).toContain('もう使っています');
    // **始点**へ戻るのは通す（閉じた線は正しい形）。
    target = v1;
    act(() => result.current.placeAt(C(0, 0)));
    expect(result.current.session?.vertices).toHaveLength(3);
  });

  it('C6: Ctrl を押している間は吸着を切る（設計書 §I.2）', () => {
    const neighbour = asFeatureId('f-neighbour') as FeatureId;
    const resolveProximity = vi.fn(() => ({
      coordinate: C(4, 4),
      sharedCandidateId: neighbour,
      featureId: neighbour,
      bodyCoordinate: C(4, 4),
      vertexId: asVertexId('v-neighbour') as VertexId,
    }));
    const { result } = renderHook(() => useAddTool(withPorts({ resolveProximity })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    // 押していないときは吸着する。
    act(() => result.current.preview(C(5, 5)));
    expect(result.current.session?.previewSnap).not.toBeNull();
    // 押している間は予告も出ない（供給元も呼ばない）。
    resolveProximity.mockClear();
    act(() => result.current.preview(C(5, 5), true));
    expect(result.current.session?.previewSnap).toBeNull();
    expect(resolveProximity).not.toHaveBeenCalled();
    // 置く点も吸着しない（押した場所そのままに落ちる）。
    act(() => result.current.placeAt(C(5, 5), true));
    expect(result.current.session?.vertices[0]?.coordinate).toEqual(C(5, 5));
    expect(result.current.session?.vertices[0]?.sharedVertexId).toBeUndefined();
  });

  it('吸着しないカーソル移動では予告が入らない', () => {
    const { result } = renderHook(() =>
      useAddTool(withPorts({ resolveProximity: () => null })),
    );
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.preview(C(5, 5)));
    expect(result.current.session?.previewSnap).toBeNull();
  });

  const baaka = asFeatureId('f-baaka') as FeatureId;
  const kornia = asFeatureId('f-kornia') as FeatureId;

  it('FR-29: 外に打ったあとで別の面の内側へ入れると断り、**理由が文字で出る**', () => {
    // 隣を描いていて誤って重ねた事故＝ FR-29 が本当に止めたい形。
    let hit: { featureId: FeatureId; name: string | null } | null = null;
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0))); // 外側
    hit = { featureId: baaka, name: 'バアカ' };
    act(() => result.current.placeAt(C(1, 1))); // バアカの内側
    expect(result.current.session?.vertices).toHaveLength(1);
    expect(result.current.message).toContain('バアカ');
    expect(result.current.message).toContain('内側');
  });

  it('FR-29: 名前が引けなくても、内部 id ではなく一般の文で断る（U-1）', () => {
    let hit: { featureId: FeatureId; name: string | null } | null = null;
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    hit = { featureId: baaka, name: null };
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.message).toContain('既存の面の内側');
  });

  it('**入れ子は通す**: 全部の頂点が同じ面の内側なら断らない（親の中に子を描く）', () => {
    const { result } = renderHook(() =>
      useAddTool(withPorts({ terminalAt: () => ({ featureId: baaka, name: 'バアカ' }) })),
    );
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(1, 1)));
    act(() => result.current.placeAt(C(2, 1)));
    act(() => result.current.placeAt(C(2, 2)));
    expect(result.current.session?.vertices).toHaveLength(3);
    expect(result.current.message).toBeNull();
  });

  it('入れ子の途中で **別の面**の内側へ入ったら断る', () => {
    let hit = { featureId: baaka, name: 'バアカ' as string | null };
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(1, 1)));
    hit = { featureId: kornia, name: 'コルニア' };
    act(() => result.current.placeAt(C(9, 9)));
    expect(result.current.session?.vertices).toHaveLength(1);
    expect(result.current.message).toContain('コルニア');
  });

  it('B3: 断り文には **上位領域と種別** を添える（同名の州がどこの州か分かるように）', () => {
    let hit: {
      featureId: FeatureId;
      name: string | null;
      where?: string | null;
    } | null = null;
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    hit = {
      featureId: baaka,
      name: 'ガロアミド州',
      where: 'デーレ共和国の州「ガロアミド州」',
    };
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.message).toContain('デーレ共和国の州「ガロアミド州」');
    expect(result.current.message).toContain('内側');
  });

  it('B1: 境界（線）の上に載った頂点は断らず、入れ子の見分けでも「その面の側」に数える', () => {
    // 親の角へ吸着した点は必ず境界の上に載る。初版はこれを「その面の側」に数えず、
    // 次に内側へ打った瞬間に断っていた（＝吸着して入れ子を作る導線が死んでいた）。
    let hit: {
      featureId: FeatureId;
      name: string | null;
      onBoundary?: boolean;
    } = { featureId: baaka, name: 'バアカ', onBoundary: true };
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0))); // 親の角へ吸着（境界の上）
    expect(result.current.message).toBeNull();
    hit = { featureId: baaka, name: 'バアカ', onBoundary: false };
    act(() => result.current.placeAt(C(1, 1))); // 親の内側
    act(() => result.current.placeAt(C(2, 1)));
    expect(result.current.session?.vertices).toHaveLength(3);
    expect(result.current.message).toBeNull();
  });

  it('B3: カーソルを乗せている間に、次の一手を予告する（押す前に分かる）', () => {
    let hit: {
      featureId: FeatureId;
      name: string | null;
      where?: string | null;
      onBoundary?: boolean;
    } | null = null;
    const { result } = renderHook(() =>
      useAddTool(withPorts({ terminalAt: () => hit, resolveProximity: () => null })),
    );
    act(() => result.current.start(ADD_TOOL_KIND.Face));

    // 1 点目を外に打ってから内側へカーソルを乗せる ＝ 押したら断られる。
    act(() => result.current.placeAt(C(0, 0)));
    hit = { featureId: baaka, name: 'バアカ', where: '「バアカ」' };
    act(() => result.current.preview(C(1, 1)));
    expect(result.current.message).toContain('内側には置けません');

    // 面の外へ戻ると予告は消える。
    hit = null;
    act(() => result.current.preview(C(50, 50)));
    expect(result.current.message).toBeNull();
  });

  it('B3: 入れ子になる場合は「中の領域になります」と予告する（断りではない）', () => {
    const hit = { featureId: baaka, name: 'バアカ' as string | null };
    const { result } = renderHook(() =>
      useAddTool(withPorts({ terminalAt: () => hit, resolveProximity: () => null })),
    );
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.preview(C(1, 1)));
    expect(result.current.message).toContain('中の領域になります');
  });

  it('A6: 緯度 ±90 度の外には置けない（理由が文字で出る）', () => {
    const { result } = renderHook(() => useAddTool(withPorts({})));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 118))); // 地図セルの上端。状態行の座標は「—」
    expect(result.current.session?.vertices).toHaveLength(0);
    expect(result.current.message).toContain('世界の外');
    // ±90 ちょうどは中（極そのものは場所である）。
    act(() => result.current.placeAt(C(0, 90)));
    act(() => result.current.placeAt(C(1, -90)));
    expect(result.current.session?.vertices).toHaveLength(2);
  });

  it('A6: 点・線でも世界の外には置けない（面だけの規則ではない）', () => {
    const { result } = renderHook(() => useAddTool(withPorts({})));
    act(() => result.current.start(ADD_TOOL_KIND.Point));
    act(() => result.current.placeAt(C(0, -122)));
    expect(result.current.session?.vertices).toHaveLength(0);
    expect(result.current.message).toContain('世界の外');
  });

  it('FR-29 は面だけ（教訓 5.25: 線・点へ広げない）', () => {
    let hit: { featureId: FeatureId; name: string | null } | null = null;
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Line));
    act(() => result.current.placeAt(C(0, 0)));
    hit = { featureId: baaka, name: 'バアカ' };
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.session?.vertices).toHaveLength(2);
    expect(result.current.message).toBeNull();
  });

  it('断ったあと、置ける場所を押すと理由が消える（教訓 5.12 の裏面: 意味のある契機で消す）', () => {
    let hit: { featureId: FeatureId; name: string | null } | null = null;
    const { result } = renderHook(() => useAddTool(withPorts({ terminalAt: () => hit })));
    act(() => result.current.start(ADD_TOOL_KIND.Face));
    act(() => result.current.placeAt(C(0, 0)));
    hit = { featureId: baaka, name: 'バアカ' };
    act(() => result.current.placeAt(C(1, 1)));
    expect(result.current.message).not.toBeNull();
    hit = null;
    act(() => result.current.placeAt(C(9, 9)));
    expect(result.current.message).toBeNull();
    expect(result.current.session?.vertices).toHaveLength(2);
  });
});
