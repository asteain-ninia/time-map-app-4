// B108 — 継ぎ目にかかる子が親から半分しか引かれない不具合。
//
// 子の和を親の基準へ整列しても、子は基準 ±180 の窓の片側にしか置かれない。親が窓の外へ出ている
// 片や幅いっぱいの片を持つと、子の（または子の半分の）周が親と 1 周ずれ、差分に離れた形として
// 見えて引かれない。分け残しと子が重なったまま確定する。期待の面積はどれも手で組んだ形から書く。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { deriveAnchorId } from '../anchor-id';
import { createAnchorEntry } from '../anchor-series';
import { parentExisting } from '../affiliation/decision';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { FEATURE_KIND, createLeafFeature, isDirectDomainLeaf, type LeafFeature } from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { alignMultiPolygon, wrapLonDeg } from '../geo/index';
import { intersection, isOk, type GeoMultiPolygon, type GeoRing } from '../geometry/index';
import { buildForest } from '../hierarchy/forest';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { checkConsistency } from '../persistence/consistency';
import { applyRepair, REPAIR_OPTION } from '../persistence/repair';
import type { DomainProject } from '../persistence/serialize';
import { RING_KIND, createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { validateRingHierarchy } from '../ring-hierarchy';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { buildDirectDomainForLeaf, promoteLeafToAggregate, PROMOTION_STATUS } from './promote';

const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const CAL = getCalendar('gregorian');
const Y0 = timePointYear(0);
const P = asFeatureId('P');
const C = asFeatureId('C');
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

function box(w: number, s: number, e: number, n: number): GeoRing {
  return [c(w, s), c(e, s), c(e, n), c(w, n)];
}

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

/** 2 つの形の重なりの面積を、±360 の写しごとに集合演算で測る。実装の整列に頼らない。 */
function overlapArea(a: GeoMultiPolygon, b: GeoMultiPolygon): number {
  let total = 0;
  for (const turn of [-360, 0, 360]) {
    const shifted = b.map((poly) => poly.map((r) => r.map((q) => c(q.lon + turn, q.lat))));
    const res = intersection(a, shifted);
    if (!isOk(res)) throw new Error('重なりを測れない');
    total += netArea(res.result);
  }
  return total;
}

interface PieceSpec {
  readonly outer: GeoRing;
  readonly holes?: readonly {
    readonly ring: GeoRing;
    /** 穴の中の飛び地。 */
    readonly enclaves?: readonly GeoRing[];
  }[];
}

interface Built {
  readonly feature: LeafFeature;
  readonly vertices: readonly Vertex[];
}

function leafOf(id: string, pieces: readonly PieceSpec[], parentId?: FeatureId): Built {
  const vertices: Vertex[] = [];
  let n = 0;
  const mint = (ring: GeoRing) =>
    ring.map((q) => {
      const v = createVertex(asVertexId(`${id}-${(n += 1)}`), c(wrapLonDeg(q.lon), q.lat));
      vertices.push(v);
      return v.id;
    });
  const rings: Ring[] = [];
  pieces.forEach((piece, i) => {
    const outerId = asRingId(`${id}-o${i}`);
    rings.push(createTerritoryRing(outerId, mint(piece.outer)));
    piece.holes?.forEach((hole, h) => {
      const holeId = asRingId(`${id}-h${i}-${h}`);
      rings.push(createHoleRing(holeId, mint(hole.ring), outerId));
      hole.enclaves?.forEach((ring, e) => {
        rings.push(createTerritoryRing(asRingId(`${id}-e${i}-${h}-${e}`), mint(ring), holeId));
      });
    });
  });
  return {
    vertices,
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 0),
      COLOR,
      createShape(rings),
      parentId === undefined ? {} : { parentId },
    ),
  };
}

/** 南北の辺を `step` 度ごとに刻んだ帯（読み直せる形）。 */
function band(w: number, s: number, e: number, n: number, step = 90): GeoRing {
  const ring: WorldCoordinate[] = [];
  for (let lon = w; lon < e; lon += step) ring.push(c(lon, s));
  ring.push(c(e, s), c(e, n));
  for (let lon = e - step; lon > w; lon -= step) ring.push(c(lon, n));
  ring.push(c(w, n));
  return ring;
}

function affiliate(
  parent: Built,
  child: Built,
): { dd: LeafFeature; store: VertexStore; childArea: GeoMultiPolygon } {
  const store = createVertexStore([...parent.vertices, ...child.vertices]);
  const r = buildAffiliationProposal(
    [parent.feature, child.feature],
    child.feature.id,
    parentExisting(parent.feature.id),
    { idState: createIdGeneratorState(), now: () => 1000, vertexStore: store },
  );
  if (r.status !== 'proposal') throw new Error(`断られた: ${r.kind} ${r.message}`);
  const dd = r.proposal.nextFeatures.find(
    (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
  );
  if (dd === undefined) throw new Error('分け残しが無い');
  const next = createVertexStore([...store.byId.values(), ...r.proposal.newVertices]);
  return { dd, store: next, childArea: resolveLeafShape(child.feature.shape, next)! };
}

interface Case {
  readonly name: string;
  readonly parent: readonly PieceSpec[];
  readonly child: GeoRing;
  /** 手で組んだ分け残しの面積。 */
  readonly expected: number;
  /** 子が親の中に収まる（細分でも通る）。 */
  readonly childInside: boolean;
}

const TWO_PIECES: readonly PieceSpec[] = [
  { outer: box(-10, -10, 10, 10) },
  { outer: box(170, -10, 190, 10) },
];
const WIDE_AND_NARROW: readonly PieceSpec[] = [
  { outer: box(-5, -30, 5, -20) },
  {
    outer: [
      c(0, 0),
      c(150, 0),
      c(300, 0),
      c(300, 20),
      c(280, 20),
      c(260, 20),
      c(240, 20),
      c(220, 20),
      c(200, 20),
      c(150, 20),
      c(0, 20),
    ],
  },
];
/** 実データの `area-188` と同じ、経度 -180〜179.99 の帯。面積 359.99 × 30 = 10,799.7。 */
const WIDE_BAND: readonly PieceSpec[] = [{ outer: band(-180, -90, 179.99, -60) }];

const CASES: readonly Case[] = [
  {
    name: '2 つ目の片の窓の外側に子（181〜183）',
    parent: TWO_PIECES,
    child: box(181, -1, 183, 1),
    expected: 800 - 4,
    childInside: true,
  },
  {
    name: '2 つ目の片の窓の境をまたぐ子（179〜181）',
    parent: TWO_PIECES,
    child: box(179, -1, 181, 1),
    expected: 800 - 4,
    childInside: true,
  },
  {
    name: '2 つ目の片の窓の内側の子（178〜179）',
    parent: TWO_PIECES,
    child: box(178, -1, 179, 1),
    expected: 800 - 2,
    childInside: true,
  },
  {
    name: '幅の広い片の、基準から 180 度より遠いところの子',
    parent: WIDE_AND_NARROW,
    child: box(280, 5, 290, 10),
    // 狭い片 10×10 + 広い片 300×20 − 子 10×5。
    expected: 100 + 6000 - 50,
    childInside: true,
  },
  {
    name: '幅いっぱいの帯の東の端の継ぎ目にかかる子（179〜181）',
    parent: WIDE_BAND,
    child: box(179, -80, 181, -70),
    // 親と重なるのは東の端の 0.99 × 10 と西の端の 1 × 10。
    expected: 10799.7 - 9.9 - 10,
    childInside: false,
  },
  {
    name: '幅いっぱいの帯の西の端の継ぎ目にかかる子（-181〜-179）',
    parent: WIDE_BAND,
    child: box(-181, -80, -179, -70),
    expected: 10799.7 - 9.9 - 10,
    childInside: false,
  },
];

describe('B108 継ぎ目にかかる子は、親の全部の周で引かれる', () => {
  it.each(CASES)('所属変更: $name', ({ parent, child, expected }) => {
    const { dd, store, childArea } = affiliate(leafOf('P', parent), leafOf('C', [{ outer: child }]));
    const mp = resolveLeafShape(dd.shape, store)!;
    expect(netArea(alignMultiPolygon(mp))).toBeCloseTo(expected, 5);
    expect(overlapArea(alignMultiPolygon(mp), alignMultiPolygon(childArea))).toBeCloseTo(0, 5);
    expect(validateRingHierarchy(dd.shape, store).violations).toEqual([]);
  });

  it.each(CASES.filter((k) => k.childInside))('細分: $name', ({ parent, child, expected }) => {
    const p = leafOf('P', parent);
    const k = leafOf('C', [{ outer: child }], P);
    const r = promoteLeafToAggregate({
      features: [p.feature, k.feature],
      vertices: createVertexStore([...p.vertices, ...k.vertices]),
      targetId: P,
      acquiredChildIds: [C],
      idState: createIdGeneratorState(),
      now: () => 1000,
    });
    if (r.status !== PROMOTION_STATUS.Committed) throw new Error(`断られた: ${JSON.stringify(r)}`);
    const dd = r.nextFeatures.find(
      (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
    )!;
    expect(netArea(alignMultiPolygon(resolveLeafShape(dd.shape, r.nextVertices)!))).toBeCloseTo(
      expected,
      5,
    );
  });

  it('性質: 幅いっぱいの帯で、継ぎ目にかかる子のぶんが必ず引かれて重ならない', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -30, max: 30 }).map((n) => n / 10),
        fc.integer({ min: 1, max: 40 }).map((n) => n / 10),
        fc.constantFrom(0, 360, -360),
        (west, width, turn) => {
          // 継ぎ目 180 の近くに置く。親は -180〜179.99 なので 179.99〜180 の隙間には親が無い。
          const w = 180 + west;
          const e = w + width;
          const parent = leafOf('P', WIDE_BAND);
          const child = leafOf('C', [{ outer: box(w + turn, -80, e + turn, -70) }]);
          const inParent = (a: number, b: number): number => Math.max(0, Math.min(b, 179.99) - Math.max(a, -180));
          // 東の周（w..e）と、西の周（w-360..e-360）で親と重なる幅を足す。
          const covered = inParent(w, e) + inParent(w - 360, e - 360);
          if (covered < 0.05) return; // 隙間にしか無い子は引くものが無い（別の検査の領分）。
          const { dd, store, childArea } = affiliate(parent, child);
          const mp = alignMultiPolygon(resolveLeafShape(dd.shape, store)!);
          expect(netArea(mp)).toBeCloseTo(10799.7 - covered * 10, 4);
          expect(overlapArea(mp, alignMultiPolygon(childArea))).toBeCloseTo(0, 4);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('子がどの周にも親と重ならないなら、分け残しは親のまま', () => {
    const p = leafOf('P', TWO_PIECES);
    const k = leafOf('C', [{ outer: box(100, -1, 102, 1) }], P);
    const store = createVertexStore([...p.vertices, ...k.vertices]);
    let n = 0;
    const r = buildDirectDomainForLeaf(p.feature, buildForest([p.feature, k.feature]), [C], store, {
      nextVertexId: () => asVertexId(`n${(n += 1)}`),
      nextRingId: () => asRingId(`nr${(n += 1)}`),
      nextFeatureId: () => asFeatureId(`nf${(n += 1)}`),
    });
    if (r.kind !== 'domain') throw new Error(r.kind);
    const next = createVertexStore([...store.byId.values(), ...r.newVertices]);
    expect(netArea(alignMultiPolygon(resolveLeafShape(r.directDomain.shape, next)!))).toBeCloseTo(800, 6);
  });
});

describe('B108 読み込みの修復', () => {
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

  it.each(CASES)('1 回で解けて不整合が残らない: $name', ({ parent, child, expected }) => {
    const root = projectOf(leafOf('P', parent), leafOf('C', [{ outer: child }], P));
    const target = checkConsistency(root, CAL).inconsistencies[0]!;
    const repaired = applyRepair(root, target, REPAIR_OPTION.MaterializeDirectDomain, CAL);
    expect(repaired).not.toBe(root);
    expect(checkConsistency(repaired, CAL).inconsistencies).toEqual([]);
    const dd = repaired.histories
      .flatMap((h) => h.series.entries.flatMap((e) => e.anchor.snapshot.features))
      .find((f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f))!;
    const store = repaired.histories
      .flatMap((h) => h.series.entries)
      .find((e) => e.anchor.snapshot.features.some((f) => f.id === dd.id))!.anchor.snapshot.vertices;
    expect(netArea(alignMultiPolygon(resolveLeafShape(dd.shape, store)!))).toBeCloseTo(expected, 5);
  });
});

describe('B108 (b) 穴の中の飛び地が基準の境をまたぐ', () => {
  /** 2 つ目の片に穴 175〜185、その中に飛び地 181〜183。面積 400 + 400 − 100 + 4 = 704。 */
  const nested: readonly PieceSpec[] = [
    { outer: box(-10, -10, 10, 10) },
    {
      outer: box(170, -10, 190, 10),
      holes: [{ ring: box(175, -5, 185, 5), enclaves: [box(181, -1, 183, 1)] }],
    },
  ];

  it('親そのものは正しい形（検査の前提）', () => {
    const p = leafOf('P', nested);
    const store = createVertexStore(p.vertices);
    expect(validateRingHierarchy(p.feature.shape, store).violations).toEqual([]);
    expect(netArea(alignMultiPolygon(resolveLeafShape(p.feature.shape, store)!))).toBeCloseTo(704, 6);
  });

  it('飛び地は整列で穴と同じ周へ置かれる', () => {
    const p = leafOf('P', nested);
    const mp = alignMultiPolygon(resolveLeafShape(p.feature.shape, createVertexStore(p.vertices))!);
    const lons = mp[2]![0]!.map((q) => q.lon);
    expect(Math.min(...lons)).toBe(181);
    expect(Math.max(...lons)).toBe(183);
  });

  it('所属変更: 飛び地が穴の中に残り、輪の検査が通る', () => {
    const { dd, store } = affiliate(leafOf('P', nested), leafOf('C', [{ outer: box(-2, -2, 2, 2) }]));
    expect(validateRingHierarchy(dd.shape, store).violations).toEqual([]);
    const enclave = dd.shape.rings.filter(
      (r) => r.kind === RING_KIND.Territory && r.parentRingId !== undefined,
    );
    expect(enclave).toHaveLength(1);
    expect(netArea(alignMultiPolygon(resolveLeafShape(dd.shape, store)!))).toBeCloseTo(704 - 16, 5);
  });

  it('子が飛び地に重なっても引かれる', () => {
    const { dd, store } = affiliate(
      leafOf('P', nested),
      leafOf('C', [{ outer: box(181.5, -0.5, 182.5, 0.5) }]),
    );
    expect(validateRingHierarchy(dd.shape, store).violations).toEqual([]);
    expect(netArea(alignMultiPolygon(resolveLeafShape(dd.shape, store)!))).toBeCloseTo(704 - 1, 5);
  });
});
