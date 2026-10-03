// 増分 8B の手直し（GPT 重 2）— 確定後のデータ保全を固定する。
//
// 隣と共有辺を持つ凹んだ面を、まっすぐな線で 3 片に分ける（V10 の新しい経路＝外周を切片で
// 分ける経路を通る）。それを本物の U13（`createLiveKnifeBinding`）で確定し、
//   確定 → 取り消し → やり直し → 保存 → 開き直し
// を通して、形・共有頂点・id・素性・年表が崩れないことを見る。反証係は実データで 44 回の
// 確定を試して崩せなかった（探針 `pipeline.probe.test.ts`）。ここではそれを小さな形で固定する。
//
// 何を見るか:
//   - 確定: 元の地物は同じ id のまま、名前・色を保って いちばん大きい片 になる。ほかの 2 片は
//     新しい地物。3 片は元の面積をちょうど覆い、互いに重ならない（U06 の共通部分で測る）。
//   - 共有頂点: 隣の地物 B の西の辺の (10,0)・(10,10) と、線が共有辺を横切った (10,5) は、
//     どれも B と片が **同じ頂点 id** で参照する（分割は片の頂点を採番し直すので、元の共有の
//     id は新しい id へ揃って移る）。片と B の間に T 字のつなぎ目ができない。
//   - 年表: 分割より前の年（1200 年）には元の形がそのまま引ける。元の地物の錨列は「1000 年の錨」
//     を保ったまま 1500 年の錨が足される。
//   - 取り消し: 保存形式の文字列が分割の前と 1 字違わず一致する。やり直し: 確定の直後と一致する。
//   - 保存 → 開き直し: やり直したあとの世界と一致し、開き直した世界でも上の検査がすべて通る。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate, type WorldCoordinate } from '../../domain/coordinate';
import { PROCESS_STATUS } from '../../domain/consistency/index';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createLeafFeature, FEATURE_KIND, type Feature, type LeafFeature } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { intersection, isOk, type GeoMultiPolygon } from '../../domain/geometry/index';
import { resolveLeafShape } from '../../domain/hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../../domain/ids';
import { createOpenKnifeLine } from '../../domain/knife/knife-line';
import {
  assembleSplitProposal,
  createInheritanceChoiceAt,
  toEditProposal,
} from '../../domain/knife/proposal';
import { executeSplit, largestPieceIndex } from '../../domain/knife/split-geometry';
import { isParsed, parseManifest } from '../../domain/persistence/boundary';
import { manifestToProject, serialize, type DomainProject } from '../../domain/persistence/serialize';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, getVertex, type Vertex } from '../../domain/vertex';

import { createLiveKnifeBinding, type DomainRoot } from '../consistency-binding';
import { featuresAt, verticesAt } from '../live-lookup';

const COLOR_A = createColorInfo(true, '#123456', '#ffb300', '#0d47a1');
const COLOR_B = createColorInfo(true, '#654321', '#ffb300', '#0d47a1');
const COLOR_NEW = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const BEFORE = timePointYear(1000);
const MIDDLE = timePointYear(1200);
const SPLIT_AT = timePointYear(1500);
const A_ID = asFeatureId('a-u');
const B_ID = asFeatureId('b-east');

function emptyProject(): DomainRoot {
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

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const v = (id: string, lon: number, lat: number): Vertex => createVertex(asVertexId(id), c(lon, lat));

// A: U の字（[0,10]² から谷 [3,7]×[3,10] を除いた形。面積 72）。
// B: 東隣 [10,20]×[0,10]。A と (10,0)・(10,10) の頂点 id を共有する（辺 (10,0)–(10,10) が共有辺）。
const SHARED_BOTTOM = 'sv-10-0';
const SHARED_TOP = 'sv-10-10';

const A_VERTICES = [
  v('a0', 0, 0),
  v(SHARED_BOTTOM, 10, 0),
  v(SHARED_TOP, 10, 10),
  v('a3', 7, 10),
  v('a4', 7, 3),
  v('a5', 3, 3),
  v('a6', 3, 10),
  v('a7', 0, 10),
];
const B_VERTICES = [v(SHARED_BOTTOM, 10, 0), v('b1', 20, 0), v('b2', 20, 10), v(SHARED_TOP, 10, 10)];
const U_AREA = 72;

function seededRoot(): DomainRoot {
  const a = createLeafFeature(
    A_ID,
    createBasicAttributes('アルラーク', 1000, 1000),
    COLOR_A,
    createShape([createTerritoryRing(asRingId('ra'), A_VERTICES.map((x) => x.id))]),
    { kindLabel: '国' },
  );
  const b = createLeafFeature(
    B_ID,
    createBasicAttributes('東隣', 1000, 1000),
    COLOR_B,
    createShape([createTerritoryRing(asRingId('rb'), B_VERTICES.map((x) => x.id))]),
  );
  let root = applyAddProposal(emptyProject(), {
    featureId: A_ID,
    anchorTime: BEFORE,
    snapshot: { feature: a, vertices: A_VERTICES, sharedCandidateIds: new Map() },
  });
  root = applyAddProposal(root, {
    featureId: B_ID,
    anchorTime: BEFORE,
    snapshot: {
      feature: b,
      vertices: B_VERTICES,
      sharedCandidateIds: new Map<VertexId, FeatureId>([
        [asVertexId(SHARED_BOTTOM), A_ID],
        [asVertexId(SHARED_TOP), A_ID],
      ]),
    },
  });
  return root;
}

function leafAt(root: DomainRoot, id: FeatureId, at = SPLIT_AT): LeafFeature {
  const f = featuresAt(root, at).find((x) => x.id === id);
  if (f === undefined || f.kind !== FEATURE_KIND.Leaf) throw new Error(`葉が無い: ${id}`);
  return f;
}

function shapeOf(root: DomainRoot, f: LeafFeature, at = SPLIT_AT): GeoMultiPolygon {
  const mp = resolveLeafShape(f.shape, verticesAt(root, at));
  if (mp === undefined) throw new Error(`形が引けない: ${f.id}`);
  return mp;
}

function planarArea(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, ri) => {
      let acc = 0;
      for (let i = 0; i < ring.length; i += 1) {
        const p = ring[i]!;
        const q = ring[(i + 1) % ring.length]!;
        acc += p.lon * q.lat - q.lon * p.lat;
      }
      total += (ri === 0 ? 1 : -1) * Math.abs(acc / 2);
    });
  }
  return total;
}

const vertexIdsOf = (f: LeafFeature): Set<string> =>
  new Set(f.shape.rings.flatMap((r) => r.vertexIds.map(String)));

/** 片の頂点が隣の環の辺の途中に乗っている（T 字のつなぎ目）数。 */
function tJunctions(root: DomainRoot, a: LeafFeature, b: LeafFeature): number {
  const store = verticesAt(root, SPLIT_AT);
  const coordsOf = (f: LeafFeature): WorldCoordinate[] =>
    f.shape.rings[0]!.vertexIds.map((id) => getVertex(store, id)!.coordinate);
  const onEdgeInterior = (p: WorldCoordinate, ring: readonly WorldCoordinate[]): boolean => {
    if (ring.some((q) => q.lon === p.lon && q.lat === p.lat)) return false;
    for (let i = 0; i < ring.length; i += 1) {
      const s = ring[i]!;
      const e = ring[(i + 1) % ring.length]!;
      const cross = (e.lon - s.lon) * (p.lat - s.lat) - (e.lat - s.lat) * (p.lon - s.lon);
      const within =
        Math.min(s.lon, e.lon) <= p.lon &&
        p.lon <= Math.max(s.lon, e.lon) &&
        Math.min(s.lat, e.lat) <= p.lat &&
        p.lat <= Math.max(s.lat, e.lat);
      if (Math.abs(cross) < 1e-12 && within) return true;
    }
    return false;
  };
  const ra = coordsOf(a);
  const rb = coordsOf(b);
  return ra.filter((p) => onEdgeInterior(p, rb)).length + rb.filter((p) => onEdgeInterior(p, ra)).length;
}

function saveThenLoad(project: DomainProject): DomainProject {
  const parsed = parseManifest(JSON.parse(JSON.stringify(serialize(project))));
  if (!isParsed(parsed)) throw new Error('読み直せない');
  return manifestToProject(parsed.manifest);
}

const text = (root: DomainRoot): string => JSON.stringify(serialize(root));

/** 分割した世界が満たすべきことを全部見る（確定直後・やり直し・開き直しで同じ検査を掛ける）。 */
function expectSplitWorld(root: DomainRoot, newIds: readonly FeatureId[]): void {
  // id と素性: 元の地物は同じ id のまま名前・色・種別を保つ。新しい片は素性欄の名前。
  const a = leafAt(root, A_ID);
  expect(a.attributes.name).toBe('アルラーク');
  expect(a.color).toEqual(COLOR_A);
  expect(a.kindLabel).toBe('国');
  const news = newIds.map((id) => leafAt(root, id));
  for (const n of news) {
    expect(n.attributes.name).toBe('新しい片');
    expect(n.kindLabel).toBe('入り江');
  }
  // 形: 3 片で元の面積をちょうど覆い、重ならない。元の地物はいちばん大きい片（根元 42）。
  const pieces = [a, ...news].map((f) => shapeOf(root, f));
  expect(planarArea(pieces[0]!)).toBeCloseTo(42, 6);
  expect(pieces.reduce((acc, p) => acc + planarArea(p), 0)).toBeCloseTo(U_AREA, 6);
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      const res = intersection(pieces[i]!, pieces[j]!);
      expect(isOk(res)).toBe(true);
      if (isOk(res)) expect(planarArea(res.result)).toBeLessThan(1e-9);
    }
  }
  // 共有頂点: B の西の辺（経度 10）の頂点 (10,0)・(10,5)・(10,10) は、どれも片のどれかと
  // **同じ頂点 id** を参照する（座標が同じなだけでは足りない ―― 共有は id の参照である）。
  // (10,5) は線が共有辺を横切った所で、FR-95 が B の辺へ差し込む点。分割は片の頂点を採番し
  // 直す（旧→新の写像）ので、元の共有の id は新しい id へ揃って移る。
  const b = leafAt(root, B_ID);
  expect(b.color).toEqual(COLOR_B);
  const store = verticesAt(root, SPLIT_AT);
  const coordOf = (id: string): WorldCoordinate | undefined =>
    getVertex(store, asVertexId(id))?.coordinate;
  const westIds = [...vertexIdsOf(b)].filter((id) => coordOf(id)?.lon === 10);
  expect(westIds.map((id) => coordOf(id)!.lat).sort((x, y) => x - y)).toEqual([0, 5, 10]);
  const pieceFeatures = [a, ...news];
  for (const id of westIds) {
    expect(
      pieceFeatures.some((f) => vertexIdsOf(f).has(id)),
      `B の (10,${String(coordOf(id)!.lat)}) を片が同じ id で参照する`,
    ).toBe(true);
  }
  for (const f of pieceFeatures) expect(tJunctions(root, f, b)).toBe(0);
  // 年表: 分割より前の年には元の形（元の頂点 id）がそのまま引ける。
  const aBefore = leafAt(root, A_ID, MIDDLE);
  expect([...vertexIdsOf(aBefore)].sort()).toEqual(A_VERTICES.map((x) => String(x.id)).sort());
  expect(planarArea(shapeOf(root, aBefore, MIDDLE))).toBeCloseTo(U_AREA, 6);
  for (const id of newIds) {
    expect(featuresAt(root, MIDDLE).some((f) => f.id === id)).toBe(false);
  }
  const history = root.histories.find((h) => h.featureId === A_ID)!;
  const starts = history.series.entries.map((e) => e.start.year);
  expect(starts).toEqual([1000, 1500]);
}

describe('増分 8B の手直し — 隣と共有辺を持つ分割の、確定後のデータ保全', () => {
  it('確定 → 取り消し → やり直し → 保存 → 開き直しで、形・共有頂点・id・素性・年表が崩れない', () => {
    const root0 = seededRoot();
    const before = text(root0);

    const a = leafAt(root0, A_ID, MIDDLE);
    const store = verticesAt(root0, MIDDLE);
    // 両腕と共有辺を横切る水平線（y=5）。終点 (15,5) は B の中（A の外）。
    const line = createOpenKnifeLine([c(-1, 5), c(15, 5)]);
    const result = executeSplit(a, store, line);
    expect(result).toBeDefined();
    if (result === undefined) return;
    expect(result.pieces).toHaveLength(3);

    let n = 0;
    const split = assembleSplitProposal({
      target: a,
      store: store.byId,
      result,
      choice: createInheritanceChoiceAt(largestPieceIndex(result)),
      nonInherited: {
        attributes: createBasicAttributes('新しい片', 1500, 1500),
        color: COLOR_NEW,
        kindLabel: '入り江',
      },
      ids: {
        nextFeatureId: () => asFeatureId(`nf-${n++}`),
        nextVertexId: () => asVertexId(`nv-${n++}`),
        nextRingId: () => asRingId(`nr-${n++}`),
      },
    });
    expect(split.inheritorFeatureId).toBe(A_ID);
    const newIds = split.newFeatures.map((f: Feature) => f.id);
    expect(newIds).toHaveLength(2);

    let k = 0;
    const binding = createLiveKnifeBinding({
      getRoot: () => root0,
      nextVertexId: () => asVertexId(`kv-${k++}`),
      nextRingId: () => asRingId(`kr-${k++}`),
    });
    const outcome = binding.startProcess(toEditProposal(split, SPLIT_AT));
    expect(outcome.status).toBe(PROCESS_STATUS.Committed);
    if (outcome.status !== PROCESS_STATUS.Committed) return;

    // 確定の直後。
    const root1 = outcome.state;
    expectSplitWorld(root1, newIds);
    const committed = text(root1);

    // 取り消し: 分割の前と 1 字違わず一致する。
    const undone = outcome.command.undo(root1).state;
    expect(text(undone)).toBe(before);

    // やり直し: 確定の直後と一致する（id を採番し直さない＝教訓 5.20）。
    const redone = outcome.command.redo(undone).state;
    expect(text(redone)).toBe(committed);
    expectSplitWorld(redone, newIds);

    // 保存 → 開き直し: やり直したあとの世界と一致し、同じ検査がすべて通る。
    const reloaded = saveThenLoad(redone);
    expect(text(reloaded)).toBe(committed);
    expectSplitWorld(reloaded, newIds);
  });
});
