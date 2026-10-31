// 片の周の置き方（B108 (b) の手直し）。
//
// 穴の中の飛び地は、穴と同じ周に置く。範囲だけで見ると、幅の広い片の南北の外にある飛び地まで
// 動かして、刃物・穴あけ・結合が壊れる。期待値は手で組んだ形から書く（実装の出力を写さない）。

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { checkDrillable, DRILL_CHECK_STATUS } from '../drill/drill-geometry';
import { createLeafFeature, type LeafFeature } from '../feature';
import type { GeoRing } from '../geometry/index';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { KNIFE_LINE_KIND } from '../knife/knife-line';
import { checkSplittable, SPLIT_CHECK_STATUS } from '../knife/split-geometry';
import { parentNone, propertyNew } from '../merge/decision';
import { makeIdPorts } from '../merge/fixtures';
import { buildMergeProposal, MERGE_STATUS } from '../merge/proposal';
import { createHoleRing, createShape, createTerritoryRing, RING_KIND, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { alignMultiPolygon, wrapLonDeg } from './index';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

/** 連続の経度で書いた四角。 */
function box(west: number, south: number, east: number, north: number): GeoRing {
  return [c(west, south), c(east, south), c(east, north), c(west, north)];
}

/** 保存されるときの経度（代表区間へ畳んだ値）。 */
const stored = (ring: GeoRing): GeoRing => ring.map((p) => c(wrapLonDeg(p.lon), p.lat));

const lonRange = (ring: GeoRing): [number, number] => {
  const lons = ring.map((p) => p.lon);
  return [Math.min(...lons), Math.max(...lons)];
};

function shoelace(ring: GeoRing): number {
  let sum = 0;
  ring.forEach((a, i) => {
    const b = ring[(i + 1) % ring.length]!;
    sum += a.lon * b.lat - b.lon * a.lat;
  });
  return Math.abs(sum) / 2;
}

function netArea(mp: readonly (readonly GeoRing[])[]): number {
  let total = 0;
  for (const poly of mp) poly.forEach((r, i) => (total += i === 0 ? shoelace(r) : -shoelace(r)));
  return total;
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, i) =>
    permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest]),
  );
}

// 小さい片 A、継ぎ目にまたがる幅の広い片 B（穴あり）、B の南北の外の飛び地 C、B の穴の中の飛び地 D。
const A = box(-10, -10, 10, 10);
const B = box(170, -10, 190, 10);
const B_HOLE = box(175, -5, 185, 5);
const C = box(-177, 50, -175, 52);
const D = box(181, -1, 183, 1);

const piece = (outer: GeoRing, ...holes: GeoRing[]): GeoRing[] => [stored(outer), ...holes.map(stored)];

interface Piece {
  readonly outer: GeoRing;
  readonly holes?: readonly GeoRing[];
}

function leaf(id: string, pieces: readonly Piece[]): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices: Vertex[] = [];
  let n = 0;
  const mint = (ring: GeoRing) =>
    stored(ring).map((p) => {
      n += 1;
      const v = createVertex(asVertexId(`${id}-${n}`), p);
      vertices.push(v);
      return v.id;
    });
  const rings: Ring[] = [];
  pieces.forEach((p, i) => {
    const outerId = asRingId(`${id}-o${i}`);
    rings.push(createTerritoryRing(outerId, mint(p.outer)));
    (p.holes ?? []).forEach((h, j) => {
      rings.push(createHoleRing(asRingId(`${id}-h${i}-${j}`), mint(h), outerId));
    });
  });
  return {
    vertices,
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 100),
      COLOR,
      createShape(rings),
    ),
  };
}

describe('alignMultiPolygon は、穴の中の飛び地だけを穴の周へ置く', () => {
  it('幅の広い片の南北の外にある飛び地は動かない', () => {
    const out = alignMultiPolygon([piece(A), piece(B, B_HOLE), piece(C)]);
    expect(lonRange(out[1]![0]!)).toEqual([170, 190]);
    expect(lonRange(out[2]![0]!)).toEqual([-177, -175]);
    expect(netArea(out)).toBeCloseTo(400 + 400 - 100 + 4, 6);
  });

  it('穴の無い幅の広い片の範囲に入る片は動かない（経度も緯度も範囲の中でも）', () => {
    // B の凹みに入る形。穴が無いので、同じ周へ置く理由が無い。
    const bay: GeoRing = [
      c(170, -10),
      c(190, -10),
      c(190, 10),
      c(170, 10),
      c(170, 5),
      c(185, 5),
      c(185, -5),
      c(170, -5),
    ];
    const out = alignMultiPolygon([piece(A), piece(bay), piece(box(-178, -1, -176, 1))]);
    expect(lonRange(out[2]![0]!)).toEqual([-178, -176]);
  });

  it('穴の外で幅の広い片の外周の中に写る片（古いデータの重なり）は動かない', () => {
    const out = alignMultiPolygon([piece(A), piece(B, B_HOLE), piece(box(186, -1, 188, 1))]);
    expect(lonRange(out[2]![0]!)).toEqual([-174, -172]);
  });

  it('穴の中の飛び地は穴の周へ動く（B108 (b)）', () => {
    const out = alignMultiPolygon([piece(A), piece(B, B_HOLE), piece(D)]);
    expect(lonRange(out[2]![0]!)).toEqual([181, 183]);
    expect(netArea(out)).toBeCloseTo(400 + 400 - 100 + 4, 6);
  });

  it('穴の縁に辺で接する飛び地も穴の周へ動く', () => {
    const out = alignMultiPolygon([piece(A), piece(B, B_HOLE), piece(box(183, -1, 185, 1))]);
    expect(lonRange(out[2]![0]!)).toEqual([183, 185]);
  });

  it('入れ子が 2 段でも、片の順によらず、それぞれ外側の片の穴の周へ動く', () => {
    const outer = box(150, -40, 210, 40);
    const outerHole = box(181, -30, 205, 30);
    const middle = box(183, -20, 203, 20);
    const middleHole = box(185, -10, 200, 10);
    const inner = box(187, -5, 198, 5);
    for (const order of permutations([
      piece(A),
      piece(outer, outerHole),
      piece(middle, middleHole),
      piece(inner),
    ])) {
      const out = alignMultiPolygon(order);
      const find = (west: number): GeoRing[] =>
        out.find((p) => ((lonRange(p[0]!)[0] - west) % 360) === 0)!;
      const shift = lonRange(find(150)[0]!)[0] - 150;
      expect(lonRange(find(183)[0]!)).toEqual([183 + shift, 203 + shift]);
      expect(lonRange(find(187)[0]!)).toEqual([187 + shift, 198 + shift]);
    }
  });

  it('片の順を入れ替えても、D は B の穴の中にあり、面積が変わらない', () => {
    const area = 400 + 400 - 100 + 4 + 4;
    for (const order of permutations([piece(A), piece(B, B_HOLE), piece(C), piece(D)])) {
      const out = alignMultiPolygon(order);
      const wide = out.find((p) => p.length === 2)!;
      const inHole = out.find((p) => p[0]!.some((q) => q.lat === -1))!;
      const [holeWest, holeEast] = lonRange(wide[1]!);
      const [west, east] = lonRange(inHole[0]!);
      expect(west).toBeGreaterThan(holeWest);
      expect(east).toBeLessThan(holeEast);
      expect(netArea(out)).toBeCloseTo(area, 6);
    }
  });

  it('性質: 格子の上の経度で、穴の縁に接する飛び地も穴の周へ動く（±360 の丸めに負けない）', () => {
    const lonOf = (n: number): number => 181 + n / 1e7;
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 30_000_000 }),
        fc.integer({ min: 1, max: 20_000_000 }),
        (a, b) => {
          // 飛び地の東の辺が穴の東の辺に乗る。
          const holeWest = lonOf(0);
          const holeEast = lonOf(a + b);
          const enclaveWest = lonOf(a);
          const hole: GeoRing = [c(holeWest, -5), c(holeEast, -5), c(holeEast, 5), c(holeWest, 5)];
          const enclave: GeoRing = [
            c(enclaveWest, -1),
            c(holeEast, -1),
            c(holeEast, 1),
            c(enclaveWest, 1),
          ];
          // 幅の広い片の中央はちょうど 180（基準 0 の窓から東へはみ出す）。
          const out = alignMultiPolygon([
            piece(A),
            piece(box(165, -10, 195, 10), hole),
            piece(enclave),
          ]);
          const [holeLo, holeHi] = lonRange(out[1]![1]!);
          const [west, east] = lonRange(out[2]![0]!);
          expect(west).toBeGreaterThanOrEqual(holeLo - 1e-6);
          expect(east).toBeLessThanOrEqual(holeHi + 1e-6);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('南北の外の飛び地を、穴あり・幅広の片と一緒に持つ面の編集', () => {
  const P = leaf('P', [{ outer: A }, { outer: B, holes: [B_HOLE] }, { outer: C }]);
  const store = createVertexStore(P.vertices);

  it('刃物: 飛び地を縦に切る線が通る', () => {
    const r = checkSplittable(P.feature, store, {
      kind: KNIFE_LINE_KIND.Open,
      points: [c(-176, 49), c(-176, 53)],
    });
    expect(r.status).toBe(SPLIT_CHECK_STATUS.Splittable);
  });

  it('穴あけ: 飛び地の中の四角を穴にできる', () => {
    const r = checkDrillable(P.feature, store, box(-176.5, 50.5, -175.5, 51.5));
    expect(r.status).toBe(DRILL_CHECK_STATUS.Drillable);
  });

  it('結合: 飛び地の東隣と結ぶと、順によらず領土 3 で面積が手の計算と合う', () => {
    const N = leaf('N', [{ outer: box(-175, 50, -173, 52) }]);
    const all = createVertexStore([...P.vertices, ...N.vertices]);
    for (const features of [
      [P.feature, N.feature],
      [N.feature, P.feature],
    ]) {
      const r = buildMergeProposal({
        features,
        vertices: all,
        targetIds: features.map((f) => f.id),
        atTime: 50,
        parentDecision: parentNone,
        propertyDecision: propertyNew({
          attributes: createBasicAttributes('m', 0, 100),
          color: COLOR,
        }),
        ids: makeIdPorts('m'),
      });
      if (r.status !== MERGE_STATUS.Proposal) throw new Error(`断られた: ${r.status}`);
      const result = r.proposal.nextFeatures.find(
        (f) => f.id === r.proposal.resultFeatureId,
      ) as LeafFeature;
      expect(result.shape.rings.filter((x) => x.kind === RING_KIND.Territory)).toHaveLength(3);
      const mp = resolveLeafShape(result.shape, r.proposal.nextVertices)!;
      // A 400 + B 400 − 穴 100 + C と N を合わせて 4 × 2。
      expect(netArea(alignMultiPolygon(mp))).toBeCloseTo(400 + 300 + 8, 6);
    }
  });
});
