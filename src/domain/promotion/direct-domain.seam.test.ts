// B90 — 経度 180 度に接する面の分け残しで、穴が陸に変わらないこと。
//
// 分け残しの外周に経度 180.000 の頂点があると、頂点を保存するために畳むと 180 が -180 になり、
// 畳んだあとの座標の外周は「世界を一周する輪」になる（実データ area-544 で面積 633 → 4850）。
// 入れ子の組み立てがその座標で包含を見ていたので、穴はどれも外周の外と判定され、最上位の領土
// になっていた。ここでは次を見る。
//
//   - 分け残しを作る 3 つの入口（細分・所属変更・読み込みの修復）で、輪の階層と面積が正しい。
//   - 継ぎ目に接する・またぐ形を、経度をずらしても同じ結果になる（性質）。
//
// 面積は `alignMultiPolygon` のあとの連続の座標で測る。畳んだまま測ると、壊れた輪の面積を測る。

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
  createLeafFeature,
  isDirectDomainLeaf,
  type Feature,
  type LeafFeature,
} from '../feature';
import { alignMultiPolygon, wrapLonDeg } from '../geo/index';
import { createGeoParams } from '../geo/geo-params';
import type { GeoMultiPolygon, GeoRing } from '../geometry/index';
import { buildForest } from '../hierarchy/forest';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createIdGeneratorState } from '../id-generator';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId } from '../ids';
import {
  checkConsistency,
  SHAPE_DETAIL_LEAF_WITH_CHILDREN,
} from '../persistence/consistency';
import { applyRepair, REPAIR_OPTION } from '../persistence/repair';
import type { DomainProject, FeatureHistory } from '../persistence/serialize';
import { RING_KIND, createHoleRing, createShape, createTerritoryRing, type Ring, type Shape } from '../ring';
import { validateRingHierarchy } from '../ring-hierarchy';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { buildDirectDomainShape } from './direct-domain';
import { buildDirectDomainForLeaf, promoteLeafToAggregate, PROMOTION_STATUS } from './promote';

const CAL = getCalendar('gregorian');
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const Y0 = timePointYear(0);
const NOW = (): number => 1000;
const P = asFeatureId('P');
const C = asFeatureId('C');

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

type Box = readonly [west: number, south: number, east: number, north: number];

function boxRing([w, s, e, n]: Box): GeoRing {
  return [c(w, s), c(e, s), c(e, n), c(w, n)];
}

/**
 * 東西の辺を `step` 度ごとに刻み、0.5 度ずつ波打たせた枠。保存形式は 1 辺で経度 180 度以上を
 * 渡れない（技術方針 §6.8）。まっすぐに刻むと集合演算が同じ線上の点を消して長い辺に戻すので
 * （別の不具合。現状.md の B105）、波打たせて幅の広い形を確かめられるようにしている。
 */
function wavyBoxRing([w, s, e, n]: Box, step: number): GeoRing {
  const south: WorldCoordinate[] = [];
  const north: WorldCoordinate[] = [];
  let i = 0;
  for (let lon = w; lon < e; lon += step) {
    const wave = i % 2 === 0 ? 0 : 0.5;
    south.push(c(lon, s - wave));
    north.unshift(c(lon, n + wave));
    i += 1;
  }
  return [...south, c(e, s), c(e, n), ...north];
}

/**
 * 保存される経度へ畳む。`keepPlus180` は実データと同じく経度 180 をそのまま持つ形。アプリが
 * 作る頂点は -180 に畳まれるので、両方を確かめる。
 */
function storedLon(lon: number, keepPlus180: boolean): number {
  if (keepPlus180 && lon === 180) return 180;
  return wrapLonDeg(lon);
}

interface LeafSpec {
  readonly id: string;
  readonly outer: GeoRing;
  readonly holes?: readonly GeoRing[];
  /** 穴の中の飛び地（`holes` の番号と一組）。 */
  readonly enclaves?: readonly { readonly holeIndex: number; readonly ring: GeoRing }[];
  readonly parentId?: FeatureId;
  readonly keepPlus180?: boolean;
}

/** 連続の座標で書いた形を、保存される形（畳んだ頂点と輪の階層）の末端にする。 */
function leafOf(spec: LeafSpec): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices: Vertex[] = [];
  const keep = spec.keepPlus180 === true;
  const ids = (ring: GeoRing, tag: string): ReturnType<typeof asVertexId>[] =>
    ring.map((p, i) => {
      const id = asVertexId(`${spec.id}-${tag}-${i}`);
      vertices.push(createVertex(id, c(storedLon(p.lon, keep), p.lat)));
      return id;
    });
  const outerId = asRingId(`${spec.id}-o`);
  const rings: Ring[] = [createTerritoryRing(outerId, ids(spec.outer, 'o'))];
  (spec.holes ?? []).forEach((hole, i) => {
    const holeId = asRingId(`${spec.id}-h${i}`);
    rings.push(createHoleRing(holeId, ids(hole, `h${i}`), outerId));
    (spec.enclaves ?? [])
      .filter((e) => e.holeIndex === i)
      .forEach((e, j) => {
        rings.push(
          createTerritoryRing(asRingId(`${spec.id}-e${i}-${j}`), ids(e.ring, `e${i}-${j}`), holeId),
        );
      });
  });
  const feature = createLeafFeature(
    asFeatureId(spec.id),
    createBasicAttributes(spec.id, 0, 0),
    COLOR,
    createShape(rings),
    spec.parentId === undefined ? {} : { parentId: spec.parentId },
  );
  return { feature, vertices };
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
  for (const poly of alignMultiPolygon(mp)) {
    poly.forEach((ring, i) => {
      total += i === 0 ? shoelace(ring) : -shoelace(ring);
    });
  }
  return total;
}

function shapeNetArea(shape: Shape, store: VertexStore): number {
  const mp = resolveLeafShape(shape, store);
  if (mp === undefined) throw new Error('形が解決できない');
  return netArea(mp);
}

/** 領土と穴の数、親の種類を含む輪の階層の要約。 */
function hierarchyOf(shape: Shape): { territories: number; holes: number; orphanHoles: number } {
  const byId = new Map<RingId, Ring>(shape.rings.map((r) => [r.id, r] as const));
  const holes = shape.rings.filter((r) => r.kind === RING_KIND.Hole);
  return {
    territories: shape.rings.length - holes.length,
    holes: holes.length,
    orphanHoles: holes.filter(
      (h) => h.parentRingId === undefined || byId.get(h.parentRingId)?.kind !== RING_KIND.Territory,
    ).length,
  };
}

function historyOf(s: { feature: LeafFeature; vertices: Vertex[] }): FeatureHistory {
  return {
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
  };
}

function projectOf(...items: { feature: LeafFeature; vertices: Vertex[] }[]): DomainProject {
  return {
    histories: items.map(historyOf),
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

interface Case {
  readonly name: string;
  readonly parent: Omit<LeafSpec, 'id'>;
  readonly child: Box;
  readonly expected: { readonly territories: number; readonly holes: number };
  /**
   * 細分の面積の検算（`areasEqualSeamAware`）が、輪を別々に展開するので断る形。
   * 分け残しそのものは正しい（ほかの入口と性質の検査で見る）。現状.md の B104。
   */
  readonly promoteFalselyRejected?: true;
}

// 期待の穴の数は、もとの穴 + 面の内側に描いた子のぶん。
const CASES: readonly Case[] = [
  {
    name: '東の端が経度 180 ちょうど（実データと同じく +180 で保存）',
    parent: { outer: boxRing([150, 0, 180, 20]), holes: [boxRing([158, 5, 160, 8])], keepPlus180: true },
    child: [165, 5, 168, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '東の端が経度 180 ちょうど（-180 で保存）',
    parent: { outer: boxRing([150, 0, 180, 20]), holes: [boxRing([158, 5, 160, 8])] },
    child: [165, 5, 168, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '西の端が経度 -180 ちょうど',
    parent: { outer: boxRing([-180, 0, -150, 20]), holes: [boxRing([-170, 5, -165, 8])] },
    child: [-160, 5, -155, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '外周が継ぎ目をまたぎ、穴と子は西側',
    parent: { outer: boxRing([170, 0, 190, 20]), holes: [boxRing([172, 5, 174, 8])] },
    child: [175, 5, 178, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '外周が継ぎ目をまたぎ、穴は東側、子は西側',
    parent: { outer: boxRing([170, 0, 190, 20]), holes: [boxRing([183, 5, 186, 8])] },
    child: [172, 5, 175, 8],
    expected: { territories: 1, holes: 2 },
    promoteFalselyRejected: true,
  },
  {
    name: '穴そのものが継ぎ目をまたぐ',
    parent: { outer: boxRing([170, 0, 190, 20]), holes: [boxRing([178, 5, 182, 8])] },
    child: [172, 5, 175, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '穴の東の辺が経度 180 に乗る',
    parent: { outer: boxRing([170, 0, 190, 20]), holes: [boxRing([175, 5, 180, 8])] },
    child: [183, 5, 186, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '子が継ぎ目をまたぐ',
    parent: { outer: boxRing([170, 0, 190, 20]), holes: [boxRing([172, 5, 174, 8])] },
    child: [178, 5, 182, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '穴の頂点が 1 つだけ、経度 180 の外周の辺に接する',
    parent: {
      outer: boxRing([150, 0, 180, 20]),
      holes: [[c(170, 5), c(180, 10), c(170, 15)]],
      keepPlus180: true,
    },
    child: [155, 5, 160, 8],
    expected: { territories: 1, holes: 2 },
  },
  {
    name: '穴の中の飛び地が継ぎ目をまたぐ',
    parent: {
      outer: boxRing([170, 0, 190, 20]),
      holes: [boxRing([175, 3, 185, 15])],
      enclaves: [{ holeIndex: 0, ring: boxRing([178, 6, 182, 12]) }],
    },
    child: [171, 3, 173, 8],
    expected: { territories: 2, holes: 2 },
  },
];

function childAndParent(k: Case): {
  parent: { feature: LeafFeature; vertices: Vertex[] };
  child: { feature: LeafFeature; vertices: Vertex[] };
} {
  return {
    parent: leafOf({ id: 'P', ...k.parent }),
    child: leafOf({ id: 'C', outer: boxRing(k.child), parentId: P }),
  };
}

function expectedArea(k: Case): number {
  const parent = leafOf({ id: 'P', ...k.parent });
  const store = createVertexStore(parent.vertices);
  return shapeNetArea(parent.feature.shape, store) - shoelace(boxRing(k.child));
}

function expectGoodDirectDomain(dd: LeafFeature, store: VertexStore, k: Case): void {
  const h = hierarchyOf(dd.shape);
  expect({ territories: h.territories, holes: h.holes }).toEqual(k.expected);
  expect(h.orphanHoles).toBe(0);
  expect(validateRingHierarchy(dd.shape, store).violations).toEqual([]);
  expect(shapeNetArea(dd.shape, store)).toBeCloseTo(expectedArea(k), 5);
}

describe('B90 分け残しの輪の階層（継ぎ目に接する・またぐ形）', () => {
  describe.each(CASES.map((k) => [k.name, k] as const))('%s', (_name, k) => {
    it('細分（promoteLeafToAggregate）', () => {
      const { parent, child } = childAndParent(k);
      const r = promoteLeafToAggregate({
        features: [parent.feature, child.feature],
        vertices: createVertexStore([...parent.vertices, ...child.vertices]),
        targetId: P,
        acquiredChildIds: [C],
        idState: createIdGeneratorState(),
        now: NOW,
      });
      if (k.promoteFalselyRejected === true) {
        expect(r.status).toBe(PROMOTION_STATUS.Rejected);
        return;
      }
      if (r.status !== PROMOTION_STATUS.Committed) throw new Error(`確定しない: ${r.status}`);
      const dd = r.nextFeatures.find(
        (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
      );
      if (dd === undefined) throw new Error('分け残しが無い');
      expectGoodDirectDomain(dd, r.nextVertices, k);
    });

    it('所属変更（buildAffiliationProposal）', () => {
      const parent = leafOf({ id: 'P', ...k.parent });
      const child = leafOf({ id: 'C', outer: boxRing(k.child) });
      const store = createVertexStore([...parent.vertices, ...child.vertices]);
      const r = buildAffiliationProposal([parent.feature, child.feature], C, parentExisting(P), {
        idState: createIdGeneratorState(),
        now: NOW,
        vertexStore: store,
      });
      if (r.status !== 'proposal') throw new Error(`確定しない: ${JSON.stringify(r)}`);
      const dd = r.proposal.nextFeatures.find(
        (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf && isDirectDomainLeaf(f),
      );
      if (dd === undefined) throw new Error('分け残しが無い');
      const after = createVertexStore([...store.byId.values(), ...r.proposal.newVertices]);
      expectGoodDirectDomain(dd, after, k);
    });

    it('読み込みの修復（applyRepair の「直轄領を生成」）のあと、不整合が残らない', () => {
      const { parent, child } = childAndParent(k);
      const root = projectOf(parent, child);
      const incs = checkConsistency(root, CAL).inconsistencies;
      expect(incs.map((i) => i.detail)).toEqual([SHAPE_DETAIL_LEAF_WITH_CHILDREN]);
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
      expectGoodDirectDomain(dd, createVertexStore(vertices), k);
    });
  });
});

describe('B90 buildDirectDomainShape（組み立ての段だけ）', () => {
  const makePorts = () => {
    let n = 0;
    return {
      nextVertexId: () => asVertexId(`v${(n += 1)}`),
      nextRingId: () => asRingId(`r${(n += 1)}`),
    };
  };

  it('頂点は畳んで保存し、輪の階層は連続の座標で組む', () => {
    const built = buildDirectDomainShape(
      [[boxRing([150, 0, 180, 20]), boxRing([160, 5, 170, 15])]],
      makePorts(),
    );
    if (built === undefined) throw new Error('組めない');
    expect(hierarchyOf(built.shape)).toEqual({ territories: 1, holes: 1, orphanHoles: 0 });
    // 保存される頂点は代表区間 [-180, 180) に入る（畳むのをやめたわけではない）。
    expect(built.vertices.every((v) => v.coordinate.lon >= -180 && v.coordinate.lon < 180)).toBe(true);
    expect(built.vertices.some((v) => v.coordinate.lon === -180)).toBe(true);
  });

  it('入れ子の親には、含む輪のうちいちばん小さいものを選ぶ（継ぎ目の外周の面積で迷わない）', () => {
    const built = buildDirectDomainShape(
      [
        [boxRing([150, 0, 180, 40]), boxRing([155, 5, 175, 35])],
        [boxRing([160, 10, 170, 30]), boxRing([162, 15, 168, 25])],
      ],
      makePorts(),
    );
    if (built === undefined) throw new Error('組めない');
    const [outer, hole, enclave, innerHole] = built.shape.rings;
    expect(hole?.parentRingId).toBe(outer?.id);
    expect(enclave?.parentRingId).toBe(hole?.id);
    expect(innerHole?.parentRingId).toBe(enclave?.id);
  });
});

describe('B90 性質: 経度をずらしても、輪の階層と面積は変わらない', () => {
  // 幅 w の外周を 4 つの区画に割り、穴と子を別々の区画に置く。ずらし幅には、東の端がちょうど
  // 180 に接する値・西の端がちょうど -180 に接する値・区画の境が 180 に乗る値を必ず混ぜる。
  const arbitrary = fc
    .record({
      width: fc.integer({ min: 12, max: 75 }).map((n) => n * 4),
      height: fc.integer({ min: 8, max: 40 }),
      south: fc.integer({ min: -40, max: 40 }),
      holeCells: fc.subarray([0, 1, 2], { minLength: 1 }),
      withEnclave: fc.boolean(),
      offsetKind: fc.constantFrom('east-touch', 'west-touch', 'cell-1', 'cell-2', 'free'),
      freeWest: fc.integer({ min: -180, max: 179 }),
      keepPlus180: fc.boolean(),
    })
    .map((a) => {
      const west =
        a.offsetKind === 'east-touch'
          ? 180 - a.width
          : a.offsetKind === 'west-touch'
            ? -180
            : a.offsetKind === 'cell-1'
              ? 180 - a.width / 4
              : a.offsetKind === 'cell-2'
                ? 180 - a.width / 2
                : a.freeWest;
      return { ...a, west };
    });

  it('領土と穴の数・親の種類・面積が、どこへずらしても同じ', () => {
    fc.assert(
      fc.property(arbitrary, (a) => {
        const cell = a.width / 4;
        const cellBox = (i: number, shrink: number): Box => [
          a.west + i * cell + shrink,
          a.south + 1,
          a.west + (i + 1) * cell - shrink,
          a.south + a.height - 1,
        ];
        const holes = a.holeCells.map((i) => boxRing(cellBox(i, 1)));
        // 飛び地は、最初の穴の中に置ける大きさのときだけ。
        const enclaves =
          a.withEnclave && a.height >= 8
            ? [
                {
                  holeIndex: 0,
                  ring: boxRing([
                    a.west + a.holeCells[0]! * cell + 3,
                    a.south + 3,
                    a.west + (a.holeCells[0]! + 1) * cell - 3,
                    a.south + a.height - 3,
                  ]),
                },
              ]
            : [];
        const parent = leafOf({
          id: 'P',
          outer: wavyBoxRing([a.west, a.south, a.west + a.width, a.south + a.height], 30),
          holes,
          enclaves,
          keepPlus180: a.keepPlus180,
        });
        // 子は穴の無い最後の区画。
        const childBox = cellBox(3, 1);
        const child = leafOf({ id: 'C', outer: boxRing(childBox), parentId: P });
        const store = createVertexStore([...parent.vertices, ...child.vertices]);
        let n = 0;
        const built = buildDirectDomainForLeaf(
          parent.feature,
          buildForest([parent.feature, child.feature]),
          [C],
          store,
          {
            nextVertexId: () => asVertexId(`n${(n += 1)}`),
            nextRingId: () => asRingId(`nr${(n += 1)}`),
            nextFeatureId: () => asFeatureId(`nf${(n += 1)}`),
          },
        );
        if (built.kind !== 'domain') throw new Error(`分け残しができない: ${built.kind}`);
        const after = createVertexStore([...store.byId.values(), ...built.newVertices]);
        const h = hierarchyOf(built.directDomain.shape);
        expect(h).toEqual({
          territories: 1 + enclaves.length,
          holes: holes.length + 1,
          orphanHoles: 0,
        });
        expect(validateRingHierarchy(built.directDomain.shape, after).violations).toEqual([]);
        const before = shapeNetArea(parent.feature.shape, store);
        expect(shapeNetArea(built.directDomain.shape, after)).toBeCloseTo(
          before - shoelace(boxRing(childBox)),
          4,
        );
      }),
      { numRuns: 200 },
    );
  });
});
