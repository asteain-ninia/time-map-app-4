import { unwrapRing } from '../geo/seam';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { FEATURE_KIND } from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import { timePointYearMonthDay } from '../time/time-point';

import {
  PARENT_TOP_LEVEL,
  PARENT_UNSET,
  parentSelection,
  placeVertex,
  startSession,
  ADD_TOOL_KIND,
} from './session';
import { CONFIRM_STATUS, confirmShape, type ShapeDraft } from './shape-draft';
import {
  assembleAddProposal,
  resolveParentId,
  type AddIdPorts,
} from './proposal';

const C = (lon: number, lat: number) => ({ lon, lat });
const attrs = createBasicAttributes('Newland', 1500, 1600);
const color = createColorInfo(true, '#fff', '#0ff', '#000');
const properties = { attributes: attrs, color };

function makeIds() {
  let v = 0;
  let f = 0;
  let r = 0;
  const ids: AddIdPorts = {
    nextFeatureId: () => asFeatureId(`f${++f}`) as FeatureId,
    nextVertexId: () => asVertexId(`v${++v}`) as VertexId,
  };
  const nextRingId = () => asRingId(`r${++r}`) as RingId;
  return { ids, nextRingId };
}

function draftOf(tool: Parameters<typeof startSession>[0], coords: ReadonlyArray<readonly [number, number]>, sharedAt?: { index: number; fid: FeatureId }): ShapeDraft {
  let s = startSession(tool);
  coords.forEach(([lon, lat], i) => {
    s = placeVertex(s, C(lon, lat), sharedAt && sharedAt.index === i ? sharedAt.fid : undefined);
  });
  const r = confirmShape(s);
  if (r.status !== CONFIRM_STATUS.Ok) throw new Error('test draft invalid');
  return r.draft;
}

const currentTime = timePointYearMonthDay(1500, 6, 20);

describe('resolveParentId (FR-39 同値)', () => {
  it('unset and top-level both map to no parent', () => {
    expect(resolveParentId(PARENT_UNSET)).toBeUndefined();
    expect(resolveParentId(PARENT_TOP_LEVEL)).toBeUndefined();
  });
  it('a chosen parent maps to its id', () => {
    const pid = asFeatureId('parent');
    expect(resolveParentId(parentSelection(pid))).toBe(pid);
  });
});

describe('assembleAddProposal (FR-76 / FR-59 / 教訓 5.15)', () => {
  it('point: builds a point feature, anchorTime = current time', () => {
    const { ids } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Point, [[1, 2]]),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect(p.anchorTime).toEqual(currentTime);
    expect(p.snapshot.feature.kind).toBe(FEATURE_KIND.Point);
    expect(p.snapshot.vertices).toHaveLength(1);
    expect(p.featureId).toBe(p.snapshot.feature.id);
  });

  it('line: builds a line feature with ordered vertex ids', () => {
    const { ids } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]]),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect(p.snapshot.feature.kind).toBe(FEATURE_KIND.Line);
    expect(p.snapshot.vertices).toHaveLength(2);
  });

  it('face: builds a leaf with one territory ring and a parent link (FR-77)', () => {
    const { ids, nextRingId } = makeIds();
    const pid = asFeatureId('cover');
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
      properties,
      parent: parentSelection(pid),
      currentTime,
      ids,
      nextRingId,
    });
    const f = p.snapshot.feature;
    expect(f.kind).toBe(FEATURE_KIND.Leaf);
    expect(f.parentId).toBe(pid);
    if (f.kind === FEATURE_KIND.Leaf) {
      expect(f.shape.rings).toHaveLength(1);
      expect(f.shape.rings[0]?.vertexIds).toHaveLength(3);
    }
  });

  it('face with 親なし has NO parentId (top-level, FR-39)', () => {
    const { ids, nextRingId } = makeIds();
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime,
      ids,
      nextRingId,
    });
    expect(p.snapshot.feature.parentId).toBeUndefined();
  });

  it('records shared-vertex candidates in the snapshot (FR-30〜33)', () => {
    const { ids } = makeIds();
    const shareWith = asFeatureId('existing');
    const p = assembleAddProposal({
      draft: draftOf(ADD_TOOL_KIND.Line, [[0, 0], [1, 1]], { index: 0, fid: shareWith }),
      properties,
      parent: PARENT_UNSET,
      currentTime,
      ids,
    });
    expect([...p.snapshot.sharedCandidateIds.values()]).toContain(shareWith);
  });

  it('throws an internal error if a face is assembled without a ring-id port', () => {
    const { ids } = makeIds();
    expect(() =>
      assembleAddProposal({
        draft: draftOf(ADD_TOOL_KIND.Face, [[0, 0], [2, 0], [1, 2]]),
        properties,
        parent: PARENT_UNSET,
        currentTime,
        ids,
      }),
    ).toThrow();
  });
});

// --- 増分 3: 吸着した頂点は「共有」になる（FR-30〜33 / V2 の合格条件 ②）----------
//
// このリポジトリで「頂点を共有している」＝ 2 つの地物が同じ VertexId を参照している
// （`editing/apply-proposal.ts` の `applySharePair` / `applyMovedVerticesToHistories`）。
// したがって、吸着した頂点は **採番せずに既存の id を使い回さなければならない**。
// 使い回さないと、あとで隣の角を動かしてももう一方は動かず、境界が裂ける。

describe('assembleAddProposal — 吸着した頂点の共有（増分 3）', () => {
  it('吸着した頂点は既存の id をそのまま使う（新しく採番しない）', () => {
    const existing = asVertexId('v-existing');
    let session = startSession(ADD_TOOL_KIND.Face);
    session = placeVertex(session, C(0, 0));
    session = placeVertex(session, C(2, 0));
    // 3 点目だけが既存の頂点へ吸着した。
    session = placeVertex(session, C(1, 2), asFeatureId('f-neighbour'), existing);
    const confirmed = confirmShape(session);
    if (confirmed.status !== CONFIRM_STATUS.Ok) throw new Error('確定できるはず');

    const proposal = assembleAddProposal({
      draft: confirmed.draft,
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime: timePointYearMonthDay(1500, 1, 1),
      ids: makeIds().ids,
      nextRingId: () => asRingId('r-1') as RingId,
    });

    const ids = proposal.snapshot.vertices.map((v) => v.id);
    expect(ids).toContain(existing);
    // 吸着した 1 個ぶんは採番していない（採番は 2 回だけ）。
    expect(ids.filter((id) => id === existing)).toHaveLength(1);
    // 体（座標）も入っている ―― 錨のスナップショットは参照する頂点の体を必ず持つ。
    const body = proposal.snapshot.vertices.find((v) => v.id === existing);
    expect(body?.coordinate).toEqual(C(1, 2));
    // 共有相手の地物 id も助言として残る。
    expect(proposal.snapshot.sharedCandidateIds.get(existing)).toBe(asFeatureId('f-neighbour'));
  });

  it('吸着していない頂点は今までどおり採番する', () => {
    let session = startSession(ADD_TOOL_KIND.Line);
    session = placeVertex(session, C(0, 0));
    session = placeVertex(session, C(1, 1));
    const confirmed = confirmShape(session);
    if (confirmed.status !== CONFIRM_STATUS.Ok) throw new Error('確定できるはず');
    const proposal = assembleAddProposal({
      draft: confirmed.draft,
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime: timePointYearMonthDay(1500, 1, 1),
      ids: makeIds().ids,
      nextRingId: () => asRingId('r-1') as RingId,
    });
    expect(proposal.snapshot.vertices).toHaveLength(2);
    expect(proposal.snapshot.sharedCandidateIds.size).toBe(0);
  });

  it('A2: 日付変更線の向こうで吸着すると、保存されるリングに 360 度の飛びを作らない', () => {
    // バグ狩り #1。地図を日付変更線の向こうへパンして描いているので、下書きの座標は
    // 180 度を越えた連続値（179.6 / 180.4 / 180.2）である。3 点目は隣の地物の頂点へ
    // 吸着していて、その頂点の **保存されている体** は −179.8（別の周回）。
    // 吸着した体は動かせない（同じ id を指す 2 つの地物の体が食い違ってはいけない）ので、
    // **吸着していない 2 点の体を同じ周回へ寄せる**。
    const existing = asVertexId('v-seam');
    let session = startSession(ADD_TOOL_KIND.Face);
    session = placeVertex(session, C(179.6, 0));
    session = placeVertex(session, C(180.4, 0));
    session = placeVertex(
      session,
      C(180.2, 2), // 押した位置と同じ周回へ寄せた値（下書きに入る値）
      asFeatureId('f-neighbour'),
      existing,
      null,
      C(-179.8, 2), // 保存されている体（相手の周回）
    );
    const confirmed = confirmShape(session);
    if (confirmed.status !== CONFIRM_STATUS.Ok) throw new Error('確定できるはず');

    const proposal = assembleAddProposal({
      draft: confirmed.draft,
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime: timePointYearMonthDay(1500, 1, 1),
      ids: makeIds().ids,
      nextRingId: () => asRingId('r-1') as RingId,
    });

    const lonById = new Map(proposal.snapshot.vertices.map((v) => [v.id, v.coordinate.lon]));
    // 吸着した頂点の体は 1 ビットも動かない（共有の相手と食い違わせない）。
    expect(lonById.get(existing)).toBe(-179.8);
    // 残り 2 点は保存の形に畳まれている（B113）。
    const others = [...lonById.entries()].filter(([id]) => id !== existing).map(([, lon]) => lon);
    expect(others).toHaveLength(2);
    for (const lon of others) {
      expect(lon).toBeGreaterThanOrEqual(-180);
      expect(lon).toBeLessThan(180);
    }

    // 隣り合う頂点を最短の向きでつなぐと、形は下書きのまま（1 度に満たない 3 角形）。
    const ring = proposal.snapshot.vertices.map((v) => v.coordinate);
    const unwrapped = unwrapRing(ring).map((v) => v.lon);
    expect(Math.max(...unwrapped) - Math.min(...unwrapped)).toBeCloseTo(0.8, 6);
  });

  it('吸着が無くても、継ぎ目を越えた体は保存の形に畳む（B113）', () => {
    let session = startSession(ADD_TOOL_KIND.Face);
    session = placeVertex(session, C(179.6, 0));
    session = placeVertex(session, C(180.4, 0));
    session = placeVertex(session, C(180.2, 2));
    const confirmed = confirmShape(session);
    if (confirmed.status !== CONFIRM_STATUS.Ok) throw new Error('確定できるはず');
    const proposal = assembleAddProposal({
      draft: confirmed.draft,
      properties,
      parent: PARENT_TOP_LEVEL,
      currentTime: timePointYearMonthDay(1500, 1, 1),
      ids: makeIds().ids,
      nextRingId: () => asRingId('r-1') as RingId,
    });
    const lons = proposal.snapshot.vertices.map((v) => v.coordinate.lon);
    expect(lons[0]).toBe(179.6); // 範囲の中は 1 ビットも変えない。
    expect(lons[1]).toBeCloseTo(-179.6, 9);
    expect(lons[2]).toBeCloseTo(-179.8, 9);
  });
});
