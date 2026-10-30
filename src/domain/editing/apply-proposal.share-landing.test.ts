// B100 — 吸着で共有に変わる確定は、1 つの点を 1 つのまま保つ（教訓 5.94 / 5.103）。
//
// 単一の頂点のドラッグでは、提案の座標は **離した場所** のまま（吸着先の座標ではない）で、
// 共有の組だけが吸着先の id を名指しする。ここで見るのは、そのときの結果の状態:
//   - 掴んだ頂点を共有していた隣の面も、同じ吸着先の id を引く（共有が黙って切れない）
//   - 吸着先の体は、どの履歴でも確定済みの座標のまま（離した場所で食い違わない）
//   - T より後ろの錨でも同じ。ただし記録された歴史は壊さない
//   - 同じ輪が両方を引いていれば確定を断る（FR-32）

import { describe, expect, it } from 'vitest';

import { resolveAt } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createEditProposal } from '../consistency/types';
import { createLeafFeature, referencedVertexIds, type LeafFeature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import type { DomainProject } from '../persistence/serialize';
import { createShape, createTerritoryRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear, type TimePoint } from '../time/time-point';
import { createVertex, getVertex, type Vertex } from '../vertex';
import { applyAddProposal, applyEditProposal } from './apply-proposal';
import type { FeatureSnapshot } from './edit-flow';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T = timePointYear(1000);
const LATER = timePointYear(1500);

function emptyProject(): DomainProject {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

type Corner = readonly [id: string, lon: number, lat: number];

function leaf(name: string, corners: readonly Corner[]): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = corners.map(([id, lon, lat]) => createVertex(asVertexId(id), { lon, lat }));
  return {
    feature: createLeafFeature(
      asFeatureId(name),
      createBasicAttributes(name, 0, 0),
      color,
      createShape([
        createTerritoryRing(
          asRingId(`r-${name}`),
          corners.map(([id]) => asVertexId(id)),
        ),
      ]),
    ),
    vertices,
  };
}

function add(
  root: DomainProject,
  at: TimePoint,
  { feature, vertices }: ReturnType<typeof leaf>,
): DomainProject {
  return applyAddProposal(root, {
    featureId: feature.id,
    anchorTime: at,
    snapshot: { feature, vertices, sharedCandidateIds: new Map() },
  });
}

// A（左）と B（右）は右辺 s・t を共有する。D は上の方の小さな面で、その角 d が吸着先。
/** `piece` の履歴に、LATER の錨を足す（頂点 `moved` はその年に本当に動いた）。 */
function anchorLater(
  root: DomainProject,
  piece: ReturnType<typeof leaf>,
  moved: readonly Vertex[] = [],
): DomainProject {
  const snapshot: FeatureSnapshot = { feature: piece.feature, vertices: moved };
  return applyEditProposal(root, createEditProposal(piece.feature.id, LATER, snapshot), calendar);
}

const A = leaf('A', [['a0', 0, 10], ['s', 10, 10], ['t', 10, 0], ['a3', 0, 0]]);
const B = leaf('B', [['s', 10, 10], ['b1', 20, 10], ['b2', 20, 0], ['t', 10, 0]]);
const D = leaf('D', [['d', 13, 22], ['d1', 15, 22], ['d2', 15, 20], ['d3', 13, 20]]);
const D_CORNER = { lon: 13, lat: 22 };
/** 離した場所。吸着の距離の中だが、D の角そのものではない。 */
const RELEASED = { lon: 10, lat: 24 };

function snapShared(root: DomainProject): DomainProject {
  const snapshot: FeatureSnapshot = {
    feature: A.feature,
    vertices: [createVertex(asVertexId('s'), RELEASED)],
    sharePair: { dragged: asVertexId('s'), target: asVertexId('d') },
  };
  return applyEditProposal(root, createEditProposal(A.feature.id, T, snapshot), calendar);
}

function snapshotOf(root: DomainProject, name: string, at: TimePoint) {
  const history = root.histories.find((h) => h.featureId === asFeatureId(name));
  if (history === undefined) throw new Error(`no history: ${name}`);
  const resolved = resolveAt(history.series, at, calendar);
  if (resolved.kind !== 'present') throw new Error(`absent: ${name}`);
  return resolved.entry.anchor.snapshot;
}

function idsOf(root: DomainProject, name: string, at: TimePoint): string[] {
  const feature = snapshotOf(root, name, at).features.find((f) => f.id === asFeatureId(name));
  if (feature === undefined) throw new Error(`no feature: ${name}`);
  return referencedVertexIds(feature).map(String);
}

function bodyIn(root: DomainProject, name: string, at: TimePoint, id: string) {
  return getVertex(snapshotOf(root, name, at).vertices, asVertexId(id))?.coordinate;
}

describe('吸着で共有に変わる確定（B100）', () => {
  it('共有頂点を吸着させると、掴んでいない隣の面も同じ吸着先を引く', () => {
    const next = snapShared(add(add(add(emptyProject(), T, A), T, B), T, D));

    expect(idsOf(next, 'A', T)).toContain('d');
    expect(idsOf(next, 'B', T)).toContain('d');
    expect(idsOf(next, 'B', T)).not.toContain('s');
    expect(bodyIn(next, 'B', T, 's')).toBeUndefined();
  });

  it('吸着先の座標は全履歴で確定済みのまま（離した場所で食い違わない）', () => {
    const next = snapShared(add(add(add(emptyProject(), T, A), T, B), T, D));

    expect(bodyIn(next, 'A', T, 'd')).toEqual(D_CORNER);
    expect(bodyIn(next, 'B', T, 'd')).toEqual(D_CORNER);
    expect(bodyIn(next, 'D', T, 'd')).toEqual(D_CORNER);
  });

  it('吸着先の面の履歴は書き換えない', () => {
    const root = add(add(add(emptyProject(), T, A), T, B), T, D);
    const next = snapShared(root);

    expect(next.histories.find((h) => h.featureId === D.feature.id)).toBe(
      root.histories.find((h) => h.featureId === D.feature.id),
    );
  });

  it('共有していない頂点でも、吸着先の座標は離した場所へ動かない（履歴の順に依らない）', () => {
    const P = leaf('P', [['p0', 0, 10], ['p1', 10, 10], ['p2', 10, 0]]);
    // 吸着先の面を先に作る。後勝ちの解決でも食い違いが見えない順にしない。
    const root = add(add(emptyProject(), T, D), T, P);
    const snapshot: FeatureSnapshot = {
      feature: P.feature,
      vertices: [createVertex(asVertexId('p1'), RELEASED)],
      sharePair: { dragged: asVertexId('p1'), target: asVertexId('d') },
    };
    const next = applyEditProposal(root, createEditProposal(P.feature.id, T, snapshot), calendar);

    expect(idsOf(next, 'P', T)).toContain('d');
    expect(bodyIn(next, 'P', T, 'd')).toEqual(D_CORNER);
  });

  it('T より後ろの錨でも、隣の面の共有は切れない', () => {
    // B は 1500 年にも錨を持つ。形は同じ（s の座標も同じ）。
    const root = anchorLater(add(add(add(emptyProject(), T, A), T, B), T, D), B);
    const next = snapShared(root);

    expect(idsOf(next, 'B', LATER)).toContain('d');
    expect(idsOf(next, 'B', LATER)).not.toContain('s');
    expect(bodyIn(next, 'B', LATER, 'd')).toEqual(D_CORNER);
  });

  it('後の年に本当に動いた頂点の錨は、書き換えない', () => {
    const root = anchorLater(add(add(add(emptyProject(), T, A), T, B), T, D), B, [
      createVertex(asVertexId('s'), { lon: 11, lat: 11 }),
    ]);
    const next = snapShared(root);

    expect(idsOf(next, 'B', LATER)).toContain('s');
    expect(bodyIn(next, 'B', LATER, 's')).toEqual({ lon: 11, lat: 11 });
  });

  it('吸着先が後の年に動くなら、その年から先へ付け替えを持ち込まない', () => {
    const root = anchorLater(anchorLater(add(add(add(emptyProject(), T, A), T, B), T, D), B), D, [
      createVertex(asVertexId('d'), { lon: 14, lat: 23 }),
    ]);
    const next = snapShared(root);

    // B の 1500 年は s のまま（d を引くと、同じ id の体が年の中で食い違う）。座標は揃えて配る。
    expect(idsOf(next, 'B', LATER)).toContain('s');
    expect(bodyIn(next, 'B', LATER, 's')).toEqual(D_CORNER);
    expect(bodyIn(next, 'D', LATER, 'd')).toEqual({ lon: 14, lat: 23 });
  });

  it('隣の面の同じ輪が吸着先も引いているなら、確定を断る（FR-32。長さ 0 の辺を記録しない）', () => {
    const root = add(add(emptyProject(), T, A), T, B);
    const snapshot: FeatureSnapshot = {
      feature: A.feature,
      vertices: [createVertex(asVertexId('s'), { lon: 20, lat: 11 })],
      sharePair: { dragged: asVertexId('s'), target: asVertexId('b1') },
    };

    expect(() =>
      applyEditProposal(root, createEditProposal(A.feature.id, T, snapshot), calendar),
    ).toThrow(/collapses a ring/);
  });

  it('掴んだ面の輪が吸着先も引いているなら、確定を断る（FR-32）', () => {
    const root = add(add(emptyProject(), T, A), T, B);
    const snapshot: FeatureSnapshot = {
      feature: A.feature,
      vertices: [createVertex(asVertexId('s'), { lon: 10, lat: 1 })],
      sharePair: { dragged: asVertexId('s'), target: asVertexId('t') },
    };

    expect(() =>
      applyEditProposal(root, createEditProposal(A.feature.id, T, snapshot), calendar),
    ).toThrow(/collapses a ring/);
  });
});
