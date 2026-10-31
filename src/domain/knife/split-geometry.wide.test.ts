// 幅の広い面を刃物で切る。整列を輪ごとにすると穴が別の周へ行って埋まり、基準を先頭の頂点に取ると
// 面の東側を貫く線が面から外れる（どちらも `alignMultiPolygon` と揃える前の不具合）。
// 期待の面積は手で組んだ形から書いている。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type LeafFeature } from '../feature';
import { alignMultiPolygon, wrapLonDeg } from '../geo/index';
import type { GeoMultiPolygon, GeoRing } from '../geometry/index';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

import { KNIFE_LINE_KIND, type KnifeLine } from './index';
import { checkSplittable, executeSplit, SPLIT_CHECK_STATUS, SPLIT_REJECT } from './split-geometry';

const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const box = (w: number, s: number, e: number, n: number): GeoRing => [
  c(w, s),
  c(e, s),
  c(e, n),
  c(w, n),
];

function leaf(outer: GeoRing, holes: readonly GeoRing[] = []): { feature: LeafFeature; store: VertexStore } {
  const vertices: Vertex[] = [];
  let n = 0;
  const mint = (ring: GeoRing) =>
    ring.map((q) => {
      const v = createVertex(asVertexId(`v${(n += 1)}`), c(wrapLonDeg(q.lon), q.lat));
      vertices.push(v);
      return v.id;
    });
  const outerId = asRingId('o');
  const rings: Ring[] = [createTerritoryRing(outerId, mint(outer))];
  holes.forEach((hole, i) => rings.push(createHoleRing(asRingId(`h${i}`), mint(hole), outerId)));
  return {
    feature: createLeafFeature(asFeatureId('T'), createBasicAttributes('T', 0, 0), COLOR, createShape(rings)),
    store: createVertexStore(vertices),
  };
}

function netArea(mp: GeoMultiPolygon): number {
  const area = (r: GeoRing): number => {
    let s = 0;
    r.forEach((a, i) => {
      const b = r[(i + 1) % r.length]!;
      s += a.lon * b.lat - b.lon * a.lat;
    });
    return Math.abs(s) / 2;
  };
  let total = 0;
  for (const poly of alignMultiPolygon(mp)) {
    poly.forEach((r, i) => (total += i === 0 ? area(r) : -area(r)));
  }
  return total;
}

const lineAt = (lon: number): KnifeLine => ({
  kind: KNIFE_LINE_KIND.Open,
  points: [c(wrapLonDeg(lon), -5), c(wrapLonDeg(lon), 25)],
});

/** 外周の頂点を 0 と 120 と 240 に持つ、一直線に並ばない幅 240 度の面。面積 4800 − 240 = 4560。 */
const KINKED: GeoRing = [c(0, 0), c(120, 1), c(240, 0), c(240, 20), c(120, 19), c(0, 20)];

describe('幅の広い面の穴', () => {
  const STRAIGHT: GeoRing = [c(0, 0), c(120, 0), c(240, 0), c(240, 20), c(120, 20), c(0, 20)];

  it('外周の先頭の頂点から 180 度より遠い穴が、切っても残る', () => {
    const { feature, store } = leaf(STRAIGHT, [box(220, 5, 230, 10)]);
    const r = executeSplit(feature, store, lineAt(120));
    if (r === undefined) throw new Error('切れない');
    const areas = r.pieces!.map((p) => netArea(p.area)).sort((a, b) => a - b);
    // 西の片 120 × 20。東の片 120 × 20 − 穴 10 × 5。
    expect(areas[0]).toBeCloseTo(2400 - 50, 6);
    expect(areas[1]).toBeCloseTo(2400, 6);
  });

  it('下見と確定で同じ片になる', () => {
    const { feature, store } = leaf(STRAIGHT, [box(220, 5, 230, 10)]);
    const check = checkSplittable(feature, store, lineAt(120));
    if (check.status !== SPLIT_CHECK_STATUS.Splittable) throw new Error(String(check.status));
    expect(check.pieces!.map((p) => netArea(p.area)).sort((a, b) => a - b)[0]).toBeCloseTo(2350, 6);
  });
});

describe('基準から 180 度前後の片の穴', () => {
  it('2 つ目の片の東側の穴が、切っても残る', () => {
    // 片 -10〜10 と 170〜190。穴 181〜183 は保存では -179 なので、輪ごとに寄せると別の周へ行く。
    const vertices: Vertex[] = [];
    let n = 0;
    const mint = (ring: GeoRing) =>
      ring.map((q) => {
        const v = createVertex(asVertexId(`m${(n += 1)}`), c(wrapLonDeg(q.lon), q.lat));
        vertices.push(v);
        return v.id;
      });
    const second = asRingId('second');
    const feature = createLeafFeature(
      asFeatureId('T'),
      createBasicAttributes('T', 0, 0),
      COLOR,
      createShape([
        createTerritoryRing(asRingId('first'), mint(box(-10, -10, 10, 10))),
        createTerritoryRing(second, mint(box(170, -10, 190, 10))),
        createHoleRing(asRingId('hole'), mint(box(181, -1, 183, 1)), second),
      ]),
    );
    const check = checkSplittable(feature, createVertexStore(vertices), {
      kind: KNIFE_LINE_KIND.Open,
      points: [c(0, -20), c(0, 20)],
    });
    if (check.status !== SPLIT_CHECK_STATUS.Splittable) throw new Error(check.reason);
    const total = check.pieces!.reduce((sum, p) => sum + netArea(p.area), 0);
    // 400 + 400 − 穴 4。
    expect(total).toBeCloseTo(796, 6);
  });
});

describe('幅の広い面を貫く線', () => {
  it.each([
    // 片 1 は経度 x より東。高さは x で 20 − 2(1 − |x − 120| / 120)、240 で 20。
    [200, 786 + 2 / 3],
    [230, 199 + 1 / 6],
  ])('経度 %d の線で 2 つに切れる（先頭の頂点から 180 度より遠い）', (lon, eastArea) => {
    const { feature, store } = leaf(KINKED);
    const check = checkSplittable(feature, store, lineAt(lon));
    if (check.status !== SPLIT_CHECK_STATUS.Splittable) throw new Error(check.reason);
    const areas = check.pieces!.map((p) => netArea(p.area)).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(eastArea, 4);
    expect(areas[0]! + areas[1]!).toBeCloseTo(4560, 4);
  });

  it('基準の側の線も今までどおり切れる', () => {
    const { feature, store } = leaf(KINKED);
    const check = checkSplittable(feature, store, lineAt(60));
    expect(check.status).toBe(SPLIT_CHECK_STATUS.Splittable);
  });

  it('外周が一直線で片に長い辺が残る線は、貫いていないとは言わず、長い辺で断る', () => {
    const { feature, store } = leaf([c(0, 0), c(120, 0), c(240, 0), c(240, 20), c(120, 20), c(0, 20)]);
    const check = checkSplittable(feature, store, lineAt(200));
    if (check.status === SPLIT_CHECK_STATUS.Splittable) throw new Error('切れてしまった');
    expect(check.reason).toBe(SPLIT_REJECT.LongEdge);
  });

  it('本当に面の外の線は、貫いていないと断る', () => {
    const { feature, store } = leaf(KINKED);
    const check = checkSplittable(feature, store, lineAt(300));
    if (check.status === SPLIT_CHECK_STATUS.Splittable) throw new Error('切れてしまった');
    expect(check.reason).toBe(SPLIT_REJECT.DoesNotPierce);
  });
});
