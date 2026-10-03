// 増分 8B の再手直し（再検証 3-1・2-1）— 穴（島）を斜めに横切る線で、穴の辺の切り口が
// 隣の島へ渡り、島と海の境目に T 字のつなぎ目が残らないことを固定する。
//
// 何が起きていたか: 手直しで穴のある面を「外周を切片で分け、各片から穴を差し引く」形にしたとき、
// 片の側の穴との交点は集合演算が **格子へ丸めた切片 P→Q の上** で求め、隣へ渡す切り口
// （`edgeCuts`）は **引いた線の区間 a→b の上** で求めていた。斜めの線では 2 つが隣り合う別の
// 格子点（1×10⁻⁷°）に丸まり、適用の段で「切り口の座標に片の頂点が無い」となって黙って
// 捨てられ、島の環には点が入らなかった（実データの穴のある海域で斜めの線 1,278 本中 265 本）。
// 延長で切る経路も、延長が横切った共有辺の切り口を隣へ渡していなかった。
//
// 直し方: 隣へ渡す切り口を **片に実際にできた頂点から** 作る（元の辺の途中に乗った新しい頂点を、
// その辺の切り口にする）。適用の段で切り口に片の頂点が無いときは、黙って捨てずに投げる
// （検査では落ち、本番は U13 の守りが「内部エラー」の断りに変える）。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { PROCESS_STATUS, REJECTION_KIND } from '../../domain/consistency/index';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createLeafFeature, FEATURE_KIND, type LeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import type { GeoMultiPolygon } from '../../domain/geometry/index';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../../domain/ids';
import { createOpenKnifeLine } from '../../domain/knife/knife-line';
import {
  assembleSplitProposal,
  createInheritanceChoiceAt,
  toEditProposal,
} from '../../domain/knife/proposal';
import { executeSplit, largestPieceIndex } from '../../domain/knife/split-geometry';
import { createHoleRing, createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, getVertex, type Vertex } from '../../domain/vertex';

import { createLiveKnifeBinding, type DomainRoot } from '../consistency-binding';
import { featuresAt, verticesAt } from '../live-lookup';

const COLOR = createColorInfo(true, '#123456', '#ffb300', '#0d47a1');
const BEFORE = timePointYear(1000);
const SPLIT_AT = timePointYear(1500);
const SEA = asFeatureId('sea');
const ISLAND = asFeatureId('island');

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const v = (id: string, p: WorldCoordinate): Vertex => createVertex(asVertexId(id), p);

// 海: 外周 [0,10]²。穴は斜めの四角（頂点は格子に乗らない値）。島: その穴と同じ頂点 id の陸。
const OUTER = [v('o0', c(0, 0)), v('o1', c(10, 0)), v('o2', c(10, 10)), v('o3', c(0, 10))];
const HOLE = [
  v('h0', c(3.1234567, 3.3333333)),
  v('h1', c(6.7654321, 3.1111111)),
  v('h2', c(6.9876543, 6.4444444)),
  v('h3', c(3.0123457, 6.8888888)),
];

function project(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40075, 0),
      gridSpacingDeg: 10,
      snapDistancePx: 8,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

function seaLeaf(): LeafFeature {
  const outer = createTerritoryRing(asRingId('sea-o'), OUTER.map((x) => x.id));
  const hole = createHoleRing(asRingId('sea-h'), HOLE.map((x) => x.id), outer.id);
  return createLeafFeature(SEA, createBasicAttributes('海', 1000, 1000), COLOR, createShape([outer, hole]));
}

function seededRoot(): DomainRoot {
  const island = createLeafFeature(
    ISLAND,
    createBasicAttributes('島', 1000, 1000),
    COLOR,
    createShape([createTerritoryRing(asRingId('island-r'), HOLE.map((x) => x.id))]),
  );
  let root = applyAddProposal(project(), {
    featureId: ISLAND,
    anchorTime: BEFORE,
    snapshot: { feature: island, vertices: HOLE, sharedCandidateIds: new Map() },
  });
  root = applyAddProposal(root, {
    featureId: SEA,
    anchorTime: BEFORE,
    snapshot: {
      feature: seaLeaf(),
      vertices: [...OUTER, ...HOLE],
      sharedCandidateIds: new Map<VertexId, FeatureId>(HOLE.map((x) => [x.id, ISLAND])),
    },
  });
  return root;
}

/** ほぼ対角の 2 点線（再検証の探針 (A) と同じ 40 本）。 */
function slantedLine(i: number): readonly [WorldCoordinate, WorldCoordinate] {
  return [c(-1.03 + i * 0.0137, -1.21 + i * 0.0071), c(11.17 - i * 0.0093, 11.31 - i * 0.0119)];
}

const keyOf = (p: WorldCoordinate): string =>
  `${String(Math.round(p.lon * 1e7))},${String(Math.round(p.lat * 1e7))}`;

function nodesOf(pieces: readonly GeoMultiPolygon[]): Set<string> {
  const s = new Set<string>();
  for (const pc of pieces) for (const poly of pc) for (const r of poly) for (const q of r) s.add(keyOf(q));
  return s;
}

function leafAt(root: DomainRoot, id: FeatureId): LeafFeature {
  const f = featuresAt(root, SPLIT_AT).find((x) => x.id === id);
  if (f === undefined || f.kind !== FEATURE_KIND.Leaf) throw new Error(`葉が無い: ${String(id)}`);
  return f;
}

/** a の環の頂点が b の環の辺の途中に乗っている数（全部の環。どちら向きも数える）。 */
function tJunctions(root: DomainRoot, a: LeafFeature, b: LeafFeature): number {
  const store = verticesAt(root, SPLIT_AT);
  const ringsOf = (f: LeafFeature): WorldCoordinate[][] =>
    f.shape.rings.map((r) => r.vertexIds.map((id) => getVertex(store, id)!.coordinate));
  const onEdgeInterior = (p: WorldCoordinate, ring: readonly WorldCoordinate[]): boolean => {
    if (ring.some((q) => q.lon === p.lon && q.lat === p.lat)) return false;
    for (let i = 0; i < ring.length; i += 1) {
      const s = ring[i]!;
      const e = ring[(i + 1) % ring.length]!;
      const dx = e.lon - s.lon;
      const dy = e.lat - s.lat;
      const len2 = dx * dx + dy * dy;
      if (len2 === 0) continue;
      const t = ((p.lon - s.lon) * dx + (p.lat - s.lat) * dy) / len2;
      if (t <= 0 || t >= 1) continue;
      // 格子 2 つ分（2×10⁻⁷°）以内を「辺の上」とみなす（切り口は格子へ丸めた点なので）。
      if (Math.hypot(s.lon + dx * t - p.lon, s.lat + dy * t - p.lat) < 2e-7) return true;
    }
    return false;
  };
  let n = 0;
  for (const ra of ringsOf(a)) {
    for (const rb of ringsOf(b)) {
      n += ra.filter((p) => onEdgeInterior(p, rb)).length;
      n += rb.filter((p) => onEdgeInterior(p, ra)).length;
    }
  }
  return n;
}

describe('増分 8B の再手直し — 穴を斜めに横切る線の切り口は、片の頂点と同じ点で隣へ渡る', () => {
  it('斜めの線 40 本で、隣へ渡す切り口（edgeCuts）はどれも片の頂点にある', () => {
    const root = seededRoot();
    const sea = featuresAt(root, BEFORE).find((f) => f.id === SEA) as LeafFeature;
    const store = verticesAt(root, BEFORE);
    let holeCuts = 0;
    const missing: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const result = executeSplit(sea, store, createOpenKnifeLine([...slantedLine(i)]));
      expect(result, `線 ${String(i)} が通る`).toBeDefined();
      if (result === undefined) continue;
      const nodes = nodesOf((result.pieces ?? []).map((p) => p.area));
      for (const cut of result.edgeCuts) {
        if (String(cut.ringId) === 'sea-h') holeCuts += 1;
        if (!nodes.has(keyOf(cut.coordinate))) missing.push(`${String(i)}: ${keyOf(cut.coordinate)}`);
      }
    }
    // 線はどれも穴を 2 回横切る。直す前はこのうち 12 点が片の頂点から 1 格子ずれていた。
    expect(holeCuts).toBe(80);
    expect(missing).toEqual([]);
  });

  it('U13 で確定すると、島が切り口の頂点を同じ id で参照し、島と片の間に T 字が残らない', () => {
    const root0 = seededRoot();
    const sea = featuresAt(root0, BEFORE).find((f) => f.id === SEA) as LeafFeature;
    const store = verticesAt(root0, BEFORE);
    // 直す前に切り口が 1 格子ずれた線（再検証の例: (6.4909483, 6.4999767) と (…484, …767)）。
    const line = createOpenKnifeLine([c(-1.0026, -1.1958), c(11.1514, 11.2862)]);
    const result = executeSplit(sea, store, line);
    expect(result).toBeDefined();
    if (result === undefined) return;
    let n = 0;
    const split = assembleSplitProposal({
      target: sea,
      store: store.byId,
      result,
      choice: createInheritanceChoiceAt(largestPieceIndex(result)),
      nonInherited: { attributes: createBasicAttributes('新しい海', 1500, 1500), color: COLOR },
      ids: {
        nextFeatureId: () => asFeatureId(`nf-${String(n++)}`),
        nextVertexId: () => asVertexId(`nv-${String(n++)}`),
        nextRingId: () => asRingId(`nr-${String(n++)}`),
      },
    });
    let k = 0;
    const binding = createLiveKnifeBinding({
      getRoot: () => root0,
      nextVertexId: () => asVertexId(`kv-${String(k++)}`),
      nextRingId: () => asRingId(`kr-${String(k++)}`),
    });
    const outcome = binding.startProcess(toEditProposal(split, SPLIT_AT));
    expect(outcome.status).toBe(PROCESS_STATUS.Committed);
    if (outcome.status !== PROCESS_STATUS.Committed) return;
    const root1 = outcome.state;

    const island = leafAt(root1, ISLAND);
    const pieces = [split.inheritorFeatureId, ...split.newFeatures.map((f) => f.id)].map((id) =>
      leafAt(root1, id),
    );
    const store1 = verticesAt(root1, SPLIT_AT);
    const islandIds = island.shape.rings[0]!.vertexIds.map(String);
    // 島の環は元の 4 頂点＋線が横切った 2 点（切り口）。
    expect(islandIds).toHaveLength(6);
    const pieceIds = new Set(pieces.flatMap((f) => f.shape.rings.flatMap((r) => r.vertexIds.map(String))));
    // 島の頂点はどれも片と同じ id で共有されている（座標が同じなだけでは足りない）。
    for (const id of islandIds) {
      expect(pieceIds.has(id), `島の頂点 ${id}（${keyOf(getVertex(store1, asVertexId(id))!.coordinate)}）を片も参照する`).toBe(true);
    }
    for (const piece of pieces) expect(tJunctions(root1, piece, island)).toBe(0);
  });
});

describe('増分 8B の再手直し — 片の頂点が無い切り口は黙って捨てずに断る', () => {
  it('切り口の座標に片の頂点が無いと、確定は「内部エラー」で断られる（隣に T 字を残さない）', () => {
    const root0 = seededRoot();
    const sea = featuresAt(root0, BEFORE).find((f) => f.id === SEA) as LeafFeature;
    const store = verticesAt(root0, BEFORE);
    const result = executeSplit(sea, store, createOpenKnifeLine([c(-1.0026, -1.1958), c(11.1514, 11.2862)]));
    expect(result).toBeDefined();
    if (result === undefined) return;
    let n = 0;
    const split = assembleSplitProposal({
      target: sea,
      store: store.byId,
      result,
      choice: createInheritanceChoiceAt(largestPieceIndex(result)),
      nonInherited: { attributes: createBasicAttributes('新しい海', 1500, 1500), color: COLOR },
      ids: {
        nextFeatureId: () => asFeatureId(`nf-${String(n++)}`),
        nextVertexId: () => asVertexId(`nv-${String(n++)}`),
        nextRingId: () => asRingId(`nr-${String(n++)}`),
      },
    });
    // 直す前の作り方で起きていた形を再現する: 切り口を 1 格子ずらす。
    const shifted = {
      ...split,
      sharedEdgeCuts: split.sharedEdgeCuts.map((cut) => ({
        ...cut,
        cutCoordinate: c(cut.cutCoordinate.lon + 1e-7, cut.cutCoordinate.lat),
      })),
    };
    expect(shifted.sharedEdgeCuts.length).toBeGreaterThan(0);
    const binding = createLiveKnifeBinding({
      getRoot: () => root0,
      nextVertexId: () => asVertexId('kv'),
      nextRingId: () => asRingId('kr'),
    });
    const outcome = binding.startProcess(toEditProposal(shifted, SPLIT_AT));
    // **わざと壊すなら**: apply-proposal の `groupSharedEdgeCuts` を「見つからなければ continue」へ
    // 戻すと、確定が通って島に T 字が残り、ここが赤くなる。
    expect(outcome.status).toBe(PROCESS_STATUS.Rejected);
    if (outcome.status === PROCESS_STATUS.Rejected) {
      expect(outcome.kind).toBe(REJECTION_KIND.Internal);
      expect(outcome.detail).toContain('no piece vertex');
    }
  });
});
