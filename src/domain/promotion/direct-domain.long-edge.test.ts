// B105 / B107 — 幅いっぱいの面の分け残しが、保存して読み直しても同じ面積であること。
//
// 集合演算は一直線上の点を消す。幅の広い面の差分では、まっすぐな辺が経度 180 度以上の 1 本に
// なる。そのまま頂点にすると、読み直しが最短方向で繋ぐので別の形になる（面積 3,985 → 387 で
// 確定していた）。期待の面積はどれも、手で組んだ形から書いている（実装の出力を写さない）。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, resolveAt } from '../anchor-series';
import { deriveAnchorId } from '../anchor-id';
import { parentExisting } from '../affiliation/decision';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  FEATURE_KIND,
  createAggregateFeature,
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import { alignMultiPolygon, wrapLonDeg } from '../geo/index';
import { createGeoParams } from '../geo/geo-params';
import { countLongEdgesInMultiPolygon } from '../geo/long-edge';
import type { GeoMultiPolygon, GeoRing } from '../geometry/index';
import { buildForest } from '../hierarchy/forest';
import { resolveFeatureArea, resolveLeafShape } from '../hierarchy/resolve-shape';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { checkConsistency } from '../persistence/consistency';
import { applyRepair, REPAIR_OPTION } from '../persistence/repair';
import type { DomainProject } from '../persistence/serialize';
import { RING_KIND, createShape, createTerritoryRing } from '../ring';
import { validateRingHierarchy } from '../ring-hierarchy';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { buildDirectDomainForLeaf, promoteLeafToAggregate, PROMOTION_STATUS } from './promote';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const Y0 = timePointYear(0);
const NOW = (): number => 1000;
const P = asFeatureId('P');
const C = asFeatureId('C');

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

function shoelace(ring: GeoRing): number {
  let sum = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  });
  return Math.abs(sum) / 2;
}

function netArea(mp: GeoMultiPolygon): number {
  let total = 0;
  for (const poly of mp) {
    poly.forEach((ring, i) => {
      total += i === 0 ? shoelace(ring) : -shoelace(ring);
    });
  }
  return total;
}

interface Built {
  feature: LeafFeature;
  vertices: Vertex[];
}

/** 連続の座標で書いた外周 1 本の末端。保存は畳む（`keepPlus180` なら 180 はそのまま）。 */
function leafOf(
  id: string,
  ring: GeoRing,
  opts: { parentId?: FeatureId; keepPlus180?: boolean } = {},
): Built {
  const vertices = ring.map((p, i) =>
    createVertex(
      asVertexId(`${id}-${i}`),
      c(opts.keepPlus180 === true && p.lon === 180 ? 180 : wrapLonDeg(p.lon), p.lat),
    ),
  );
  return {
    vertices,
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 0),
      COLOR,
      createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
      opts.parentId === undefined ? {} : { parentId: opts.parentId },
    ),
  };
}

function box(w: number, s: number, e: number, n: number): GeoRing {
  return [c(w, s), c(e, s), c(e, n), c(w, n)];
}

/** 南北の辺を `step` 度ごとにまっすぐ刻んだ枠。集合演算でこの刻みが全部消える。 */
function straightBand(w: number, s: number, e: number, n: number, step: number): GeoRing {
  const ring: WorldCoordinate[] = [];
  for (let lon = w; lon < e; lon += step) ring.push(c(lon, s));
  ring.push(c(e, s), c(e, n));
  for (let lon = e - step; lon > w; lon -= step) ring.push(c(lon, n));
  ring.push(c(w, n));
  return ring;
}

const WIDE = straightBand(-180, -90, 179.99, -59, 30);
const WIDE_AREA = 359.99 * 31;
const CHILD_BOX = box(40, -86, 42, -84);
const CHILD_AREA = 4;

function ports(): {
  nextVertexId: () => ReturnType<typeof asVertexId>;
  nextRingId: () => ReturnType<typeof asRingId>;
  nextFeatureId: () => FeatureId;
} {
  let n = 0;
  return {
    nextVertexId: () => asVertexId(`n${(n += 1)}`),
    nextRingId: () => asRingId(`nr${(n += 1)}`),
    nextFeatureId: () => asFeatureId(`nf${(n += 1)}`),
  };
}

function coreOf(
  parent: Built,
  children: readonly Built[],
): ReturnType<typeof buildDirectDomainForLeaf> {
  const store = createVertexStore([...parent.vertices, ...children.flatMap((k) => k.vertices)]);
  return buildDirectDomainForLeaf(
    parent.feature,
    buildForest([parent.feature, ...children.map((k) => k.feature)]),
    children.map((k) => k.feature.id),
    store,
    ports(),
  );
}

function readBack(dd: LeafFeature, store: VertexStore): GeoMultiPolygon {
  const mp = resolveLeafShape(dd.shape, store);
  if (mp === undefined) throw new Error('読み直せない');
  return alignMultiPolygon(mp);
}

function projectOf(...items: Built[]): DomainProject {
  return {
    histories: items.map((s) => ({
      featureId: s.feature.id,
      series: {
        entries: [
          createAnchorEntry(
            createAnchor(
              deriveAnchorId(s.feature.id, Y0),
              createAnchorSnapshot([s.feature], createVertexStore(s.vertices)),
            ),
            Y0,
            null,
          ),
        ],
      },
    })),
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

function affiliate(parent: Built, childRing: GeoRing) {
  const child = leafOf('C', childRing);
  const store = createVertexStore([...parent.vertices, ...child.vertices]);
  const result = buildAffiliationProposal([parent.feature, child.feature], C, parentExisting(P), {
    idState: createIdGeneratorState(),
    now: NOW,
    vertexStore: store,
  });
  return { result, store };
}

describe('B105 幅いっぱいの面の分け残し', () => {
  it('所属変更: 面積が保たれ、長い辺が無く、親の頂点の id を全部引き継ぐ', () => {
    const parent = leafOf('P', WIDE);
    const { result, store } = affiliate(parent, CHILD_BOX);
    if (result.status !== 'proposal') throw new Error(JSON.stringify(result));
    const dd = result.proposal.nextFeatures.find(
      (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
    );
    if (dd === undefined) throw new Error('分け残しが無い');
    const after = createVertexStore([...store.byId.values(), ...result.proposal.newVertices]);
    const mp = readBack(dd, after);
    expect(netArea(mp)).toBeCloseTo(WIDE_AREA - CHILD_AREA, 5);
    expect(countLongEdgesInMultiPolygon(mp)).toBe(0);
    expect(validateRingHierarchy(dd.shape, after).violations).toEqual([]);
    expect(dd.shape.rings.map((r) => r.kind)).toEqual([RING_KIND.Territory, RING_KIND.Hole]);
    const ddIds = new Set(dd.shape.rings.flatMap((r) => r.vertexIds));
    for (const v of parent.vertices) expect(ddIds.has(v.id)).toBe(true);
    // 新しい頂点は子のぶんの 4 つだけ（辺を刻む新しい点は要らない）。
    expect(ddIds.size).toBe(parent.vertices.length + 4);
  });

  it('細分: 面積が保たれて確定する', () => {
    const parent = leafOf('P', WIDE);
    const child = leafOf('C', CHILD_BOX, { parentId: P });
    const r = promoteLeafToAggregate({
      features: [parent.feature, child.feature],
      vertices: createVertexStore([...parent.vertices, ...child.vertices]),
      targetId: P,
      acquiredChildIds: [C],
      idState: createIdGeneratorState(),
      now: NOW,
    });
    if (r.status !== PROMOTION_STATUS.Committed) throw new Error(JSON.stringify(r));
    const dd = r.nextFeatures.find(
      (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
    );
    if (dd === undefined) throw new Error('分け残しが無い');
    expect(netArea(readBack(dd, r.nextVertices))).toBeCloseTo(WIDE_AREA - CHILD_AREA, 5);
  });

  it('読み込みの修復: 1 回で解け、面積が保たれる', () => {
    const parent = leafOf('P', WIDE);
    const child = leafOf('C', CHILD_BOX, { parentId: P });
    const root = projectOf(parent, child);
    const incs = checkConsistency(root, CAL).inconsistencies;
    const repaired = applyRepair(root, incs[0]!, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(checkConsistency(repaired, CAL).inconsistencies).toEqual([]);
    const features: Feature[] = [];
    const vertices: Vertex[] = [];
    for (const h of repaired.histories) {
      const at = resolveAt(h.series, Y0, CAL);
      if (at.kind !== 'present') continue;
      features.push(...at.entry.anchor.snapshot.features);
      vertices.push(...at.entry.anchor.snapshot.vertices.byId.values());
    }
    const dd = features.find(
      (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
    );
    if (dd === undefined) throw new Error('分け残しが無い');
    expect(netArea(readBack(dd, createVertexStore(vertices)))).toBeCloseTo(
      WIDE_AREA - CHILD_AREA,
      5,
    );
  });

  it('辺の上に保存済みの頂点が無い長い辺は、90 度以下に刻む新しい点で保つ', () => {
    // 子の南の辺に乗る親の頂点は無い。子の頂点は和で消えるので、穴の南の辺が 200 度の 1 本になる。
    const parent = leafOf('P', straightBand(-170, -60, 170, 60, 60));
    const child = leafOf('C', straightBand(-100, -30, 100, 30, 50), { parentId: P });
    const built = coreOf(parent, [child]);
    if (built.kind !== 'domain') throw new Error(JSON.stringify(built));
    const store = createVertexStore(built.newVertices);
    const mp = readBack(built.directDomain, store);
    expect(netArea(mp)).toBeCloseTo(340 * 120 - 200 * 60, 4);
    expect(countLongEdgesInMultiPolygon(mp)).toBe(0);
    const hole = mp[0]![1]!;
    hole.forEach((a, i) => {
      const b = hole[(i + 1) % hole.length]!;
      expect(Math.abs(b.lon - a.lon)).toBeLessThanOrEqual(90);
    });
  });

  it('子が幅いっぱいの親のどこにあっても、面積が保たれる（頂点が片側に密な親）', () => {
    // 頂点は西の 60 度に密。子を東へ置くと、周を頂点の平均で決める実装では引けなかった。
    const south: WorldCoordinate[] = [];
    for (let lon = -180; lon <= -120; lon += 1) south.push(c(lon, -90));
    for (let lon = -60; lon <= 120; lon += 60) south.push(c(lon, -90));
    const ring = [
      ...south,
      c(179.99, -90),
      c(179.99, -59),
      c(120, -59),
      c(0, -59),
      c(-120, -59),
      c(-180, -59),
    ];
    for (const at of [-170, -60, 100, 170]) {
      const parent = leafOf('P', ring);
      const child = leafOf('C', box(at, -86, at + 2, -84), { parentId: P });
      const built = coreOf(parent, [child]);
      if (built.kind !== 'domain') throw new Error(JSON.stringify(built));
      const store = createVertexStore(built.newVertices);
      expect(netArea(readBack(built.directDomain, store))).toBeCloseTo(WIDE_AREA - 4, 5);
      expect(validateRingHierarchy(built.directDomain.shape, store).violations).toEqual([]);
    }
  });

  it('まとめ役の派生の形にも長い辺が残らず、整列し直しても面積が同じ（子が 2 つのとき）', () => {
    const child1 = leafOf('C', CHILD_BOX);
    const child2 = leafOf('D', box(-100, -86, -98, -84));
    const parent = leafOf('P', WIDE);
    const features1 = affiliate(parent, CHILD_BOX);
    if (features1.result.status !== 'proposal') throw new Error('確定しない');
    const dd = features1.result.proposal.nextFeatures.find(
      (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
    );
    if (dd === undefined) throw new Error('分け残しが無い');
    const store = createVertexStore([
      ...features1.store.byId.values(),
      ...features1.result.proposal.newVertices,
      ...child2.vertices,
    ]);
    // 分け残しに子を 1 つ足した形のまとめ役: 分け残し（2 つの穴になる前の形）+ 子 1 + 子 2。
    const aggregate = createAggregateFeature(P, parent.feature.attributes, COLOR, [
      dd.id,
      C,
      child2.feature.id,
    ]);
    const features: Feature[] = [
      aggregate,
      { ...dd, parentId: P },
      { ...child1.feature, parentId: P },
      { ...child2.feature, parentId: P },
    ];
    const res = resolveFeatureArea(buildForest(features), store, P);
    if (res.status !== 'ok') throw new Error('解決できない');
    expect(countLongEdgesInMultiPolygon(res.area)).toBe(0);
    // 子 2 は分け残しの上に重なるので、和は親の形そのもの。
    expect(netArea(res.area)).toBeCloseTo(WIDE_AREA, 5);
    expect(netArea(alignMultiPolygon(res.area))).toBeCloseTo(WIDE_AREA, 5);
  });

  it('性質: 幅 180〜360 度のまっすぐな帯のどこに子を置いても、読み直した面積が保たれる', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 46, max: 89 }).map((n) => n * 4),
        fc.integer({ min: -180, max: 179 }),
        fc.double({ min: 0.02, max: 0.9, noNaN: true }),
        fc.integer({ min: -80, max: 40 }),
        (width, west, at, south) => {
          const parent = leafOf('P', straightBand(west, south, west + width, south + 30, 40));
          const childWest = Math.round(west + width * at);
          const child = leafOf('C', box(childWest, south + 5, childWest + 3, south + 8), {
            parentId: P,
          });
          const built = coreOf(parent, [child]);
          if (built.kind !== 'domain') throw new Error(JSON.stringify(built));
          const store = createVertexStore(built.newVertices);
          const mp = readBack(built.directDomain, store);
          expect(netArea(mp)).toBeCloseTo(width * 30 - 9, 4);
          expect(countLongEdgesInMultiPolygon(mp)).toBe(0);
          expect(validateRingHierarchy(built.directDomain.shape, store).violations).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });
});

describe('B107 経度 +180 で保存された頂点の id', () => {
  it('分け残しへ引き継ぎ、頂点の体（+180）も変えない', () => {
    const parent = leafOf('P', box(150, 0, 180, 20), { keepPlus180: true });
    const child = leafOf('C', box(160, 5, 165, 8), { parentId: P });
    const built = coreOf(parent, [child]);
    if (built.kind !== 'domain') throw new Error(JSON.stringify(built));
    const ids = new Set(built.directDomain.shape.rings.flatMap((r) => r.vertexIds));
    for (const v of parent.vertices) expect(ids.has(v.id)).toBe(true);
    const plus = parent.vertices.filter((v) => v.coordinate.lon === 180);
    expect(plus).toHaveLength(2);
    for (const v of plus) {
      expect(built.newVertices.find((x) => x.id === v.id)?.coordinate.lon).toBe(180);
    }
  });
});

describe('一直線上の点の引き継ぎ（隣と共有していた頂点）', () => {
  it('まっすぐな辺の途中の頂点の id が、分け残しに残る', () => {
    // 集合演算が消す点。隣がこの頂点を引いていると、消えたら隣を動かしても付いてこない。
    const parent = leafOf('P', [c(0, 0), c(5, 0), c(10, 0), c(10, 10), c(0, 10)]);
    const child = leafOf('C', box(2, 2, 4, 4), { parentId: P });
    const built = coreOf(parent, [child]);
    if (built.kind !== 'domain') throw new Error(JSON.stringify(built));
    const outer = built.directDomain.shape.rings[0]!;
    expect(outer.vertexIds).toContain(parent.vertices[1]!.id);
  });
});
