// 増分 8B の手直し — 穴のある面で、線の延長が引いていない所まで切らない（B65 / GPT 重 3・反証 2-1）、
// くぼみの先に内側から触れる線を断らない（反証 2-3）、日付変更線をまたぐ面の予告と結果を揃える（反証 2-4）。
//
// B65: 穴のある面（島を穴に持つ海域・領海・湾）は「遠い枠までの延長」で切る 2 分割の経路を
// 通っていたので、凹んだ面の腕を 1 本だけ横切る短い線が、引いていない別の腕まで切っていた
// （実データ 34 地物・面積で 18%。腕を 1 本だけ横切る線の 91%）。いまは外周だけを切片で分け、
// できた各片から穴を差し引く。ここでは結果の形（片の数・面積・多角形の数）と所属先（どの点が
// どの片に入るか）を見る。面積の保存だけでは、余計に切っても通ってしまう（開発ガイド §5.87）。
//
// 延長で切る経路が残る形（飛び地のある面・線の端が穴の中にある線）は、延ばした先で切ったとき
// `cutsBeyondLine` を立てる（画面が確定の前にそれを言う）。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature } from '../feature';
import {
  intersection,
  isOk,
  pointInPolygon,
  POINT_LOCATION,
  type GeoMultiPolygon,
} from '../geometry/index';
import { asFeatureId, asRingId, asVertexId, type RingId, type VertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import { ATTRS, COLOR, squareLeaf } from './fixtures';
import { createOpenKnifeLine } from './knife-line';
import {
  SPLIT_CHECK_STATUS,
  checkSplittable,
  executeSplit,
  splitsIntoManyPieces,
  type SplitCheckResult,
} from './split-geometry';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

/** 多角形（環の配列。最初が外周、残りは穴）を 1 つ以上持つ末端地物を作る。 */
function multiLeaf(id: string, polys: readonly (readonly (readonly WorldCoordinate[])[])[]) {
  const vertices: Vertex[] = [];
  const rings: Ring[] = [];
  let n = 0;
  polys.forEach((poly, pi) => {
    let territoryId: RingId | undefined;
    poly.forEach((coords, ri) => {
      const ids: VertexId[] = coords.map((co) => {
        const vid = asVertexId(`${id}-v${n++}`);
        vertices.push(createVertex(vid, co));
        return vid;
      });
      if (ri === 0) {
        const t = createTerritoryRing(asRingId(`${id}-p${pi}`), ids);
        territoryId = t.id;
        rings.push(t);
      } else {
        rings.push(createHoleRing(asRingId(`${id}-p${pi}h${ri}`), ids, territoryId!));
      }
    });
  });
  return {
    feature: createLeafFeature(asFeatureId(id), ATTRS, COLOR, createShape(rings)),
    store: createVertexStore(vertices),
  };
}

/** 平面の面積（穴を引く）。 */
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

function piecesOf(res: SplitCheckResult): GeoMultiPolygon[] {
  if (res.status !== SPLIT_CHECK_STATUS.Splittable) {
    throw new Error(`断られた: ${res.reason}`);
  }
  return (res.pieces ?? [res.sideA, res.sideB]).map((s) => s.area);
}

/** 点がどの片の内側に入るか（どれにも入らなければ -1）。 */
function pieceAt(pieces: readonly GeoMultiPolygon[], p: WorldCoordinate): number {
  return pieces.findIndex((mp) => mp.some((poly) => pointInPolygon(p, poly) === POINT_LOCATION.Inside));
}

/** 片どうしが重ならない（どの 2 片の共通部分も面積を持たない）。表示から独立に U06 で測る。 */
function expectNoOverlap(pieces: readonly GeoMultiPolygon[]): void {
  for (let i = 0; i < pieces.length; i += 1) {
    for (let j = i + 1; j < pieces.length; j += 1) {
      const res = intersection(pieces[i]!, pieces[j]!);
      expect(isOk(res)).toBe(true);
      if (isOk(res)) expect(planarArea(res.result)).toBeLessThan(1e-9);
    }
  }
}

/** 片の頂点に座標 p があるか。 */
function hasNode(mp: GeoMultiPolygon, p: WorldCoordinate): boolean {
  return mp.some((poly) => poly.some((ring) => ring.some((q) => q.lon === p.lon && q.lat === p.lat)));
}

// 穴のある U の字: 外周 [0,30]² から谷 [10,20]×[10,30] を除いた形（面積 700）。
// 根元の帯 y∈[0,10] に穴 [13,17]×[2,5]（面積 12）。面の面積 688。
const U_OUTER = [c(0, 0), c(30, 0), c(30, 30), c(20, 30), c(20, 10), c(10, 10), c(10, 30), c(0, 30)];
const U_HOLE = [c(13, 2), c(17, 2), c(17, 5), c(13, 5)];
const U_AREA = 688;
const uWithHole = () => multiLeaf('uh', [[U_OUTER, U_HOLE]]);

describe('B65 — 穴のある面でも、線は引いた所だけを切る', () => {
  it('左腕だけを横切る短い線は、右腕を切らない（結果の形と所属先）', () => {
    const { feature, store } = uWithHole();
    // 終点 (12,20) は U の谷（面の外）。線は左腕だけを貫く。
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 20), c(12, 20)])));
    expect(pieces).toHaveLength(2);
    const areas = pieces.map(planarArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(100, 6); // 左腕の上 [0,10]×[20,30]
    expect(areas[1]).toBeCloseTo(U_AREA - 100, 6);
    // どの片も 1 枚の多角形（延長で切っていた頃は「左腕の上＋右腕の上」の 2 枚組ができた）。
    for (const p of pieces) expect(p).toHaveLength(1);
    // 所属先: 右腕の上と下は同じ片（＝切られていない）。左腕の上だけが別の片。
    const rightTop = pieceAt(pieces, c(25, 25));
    const rightBottom = pieceAt(pieces, c(25, 15));
    const leftTop = pieceAt(pieces, c(5, 25));
    expect(rightTop).toBeGreaterThanOrEqual(0);
    expect(rightTop).toBe(rightBottom);
    expect(leftTop).not.toBe(rightTop);
    // 穴は切られずに大きいほうの片に残る（穴の中は面の外）。
    expect(pieceAt(pieces, c(15, 3.5))).toBe(-1);
    const big = pieces[pieceAt(pieces, c(15, 7))]!;
    expect(big[0]).toHaveLength(2);
    expectNoOverlap(pieces);
    expect(executeSplit(feature, store, createOpenKnifeLine([c(-1, 20), c(12, 20)]))).toBeDefined();
  });

  it('両腕を横切る線は 3 片（境界を 4 回横切る＝k+1 片の契約）で、穴は根元の片に残る', () => {
    const { feature, store } = uWithHole();
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 20), c(31, 20)])));
    expect(pieces).toHaveLength(3);
    const areas = pieces.map(planarArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(100, 6);
    expect(areas[1]).toBeCloseTo(100, 6);
    expect(areas[2]).toBeCloseTo(U_AREA - 200, 6);
    expect(pieceAt(pieces, c(25, 25))).not.toBe(pieceAt(pieces, c(5, 25)));
    expectNoOverlap(pieces);
  });

  it('穴を横切る線は穴ごと切り、切り口の点は両側の片に同じ座標で入る', () => {
    const { feature, store } = uWithHole();
    // y=3.5 は根元の帯と穴を横切る（外周を 2 回・穴を 2 回）。外周の切片は 1 本＝2 片。
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 3.5), c(31, 3.5)])));
    expect(pieces).toHaveLength(2);
    const below = pieces[pieceAt(pieces, c(5, 1))]!;
    const above = pieces[pieceAt(pieces, c(5, 20))]!;
    expect(below).not.toBe(above);
    // 下の片: 30×3.5 − 穴の下半分 4×1.5 = 99。上の片は残り。
    expect(planarArea(below)).toBeCloseTo(99, 6);
    expect(planarArea(above)).toBeCloseTo(U_AREA - 99, 6);
    // 穴の中は両方の片の外。穴の切り口 (13,3.5)・(17,3.5) は両方の片の頂点に同じ座標で入る
    // （隣と共有の点を作る FR-95 と同じ前提＝切り口が食い違わない）。
    expect(pieceAt(pieces, c(15, 3))).toBe(-1);
    expect(pieceAt(pieces, c(15, 4))).toBe(-1);
    for (const p of [c(13, 3.5), c(17, 3.5), c(0, 3.5), c(30, 3.5)]) {
      expect(hasNode(below, p)).toBe(true);
      expect(hasNode(above, p)).toBe(true);
    }
    expectNoOverlap(pieces);
  });

  it('穴に触れない片は、穴を持たない（穴は自分の居る片にだけ残る）', () => {
    const { feature, store } = uWithHole();
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(31, 20), c(18, 20)])));
    expect(pieces).toHaveLength(2);
    const rightTop = pieces[pieceAt(pieces, c(25, 25))]!;
    expect(rightTop[0]).toHaveLength(1);
    expect(planarArea(rightTop)).toBeCloseTo(100, 6);
  });

  it('穴のある面は n 分割できる面として扱う（画面の予告も同じ関数を見る）', () => {
    const { feature, store } = uWithHole();
    expect(splitsIntoManyPieces(resolveLeafShape(feature.shape, store)!)).toBe(true);
  });
});

describe('B65 の残り — 延長で切る経路を通る形は、延ばした先で切ったことを返す', () => {
  // 本土 [0,10]² と、同じ緯度にある島 [20,25]×[4,6]（飛び地）。
  const exclave = () =>
    multiLeaf('ex', [
      [[c(0, 0), c(10, 0), c(10, 10), c(0, 10)]],
      [[c(20, 4), c(25, 4), c(25, 6), c(20, 6)]],
    ]);

  it('飛び地のある面で、本土だけを横切る線の延長が島を割ると cutsBeyondLine が立つ', () => {
    const { feature, store } = exclave();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(-1, 5), c(11, 5)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
    expect(res.cutsBeyondLine).toBe(true);
    // 実際に島が 2 つに割れている（印が嘘をついていない）。
    const pieces = piecesOf(res);
    expect(pieceAt(pieces, c(22, 5.5))).not.toBe(pieceAt(pieces, c(22, 4.5)));
    expect(executeSplit(feature, store, createOpenKnifeLine([c(-1, 5), c(11, 5)]))?.cutsBeyondLine).toBe(
      true,
    );
  });

  it('延長が島に届かない線では立たない', () => {
    const { feature, store } = exclave();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(-1, 8), c(11, 8)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
    expect(res.cutsBeyondLine).toBeUndefined();
  });

  it('線の端が穴の中にある線は、延長で穴の向こう側まで切るので立つ', () => {
    // 正方形 [0,10]² に穴 [3,7]²。穴の中 (5,5) から左へ抜ける線。
    const { feature, store } = multiLeaf('wh', [
      [
        [c(0, 0), c(10, 0), c(10, 10), c(0, 10)],
        [c(3, 3), c(7, 3), c(7, 7), c(3, 7)],
      ],
    ]);
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(5, 5), c(-1, 5)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
    expect(res.cutsBeyondLine).toBe(true);
  });

  it('穴を持つ面でも、外周の切片で分けられる線では立たない', () => {
    const { feature, store } = uWithHole();
    const res = checkSplittable(feature, store, createOpenKnifeLine([c(-1, 20), c(12, 20)]));
    expect(res.status).toBe(SPLIT_CHECK_STATUS.Splittable);
    if (res.status !== SPLIT_CHECK_STATUS.Splittable) return;
    expect(res.cutsBeyondLine).toBeUndefined();
  });
});

describe('反証 2-3 — くぼみの先に内側から触れる線を断らない', () => {
  // 上から V 字のくぼみがある正方形（面積 95）。くぼみの先 (5,5) を水平線 y=5 がかすめる。
  const notch = [c(0, 0), c(10, 0), c(10, 10), c(6, 10), c(5, 5), c(4, 10), c(0, 10)];

  it('くぼみの先をかすめる線は、少しずらした線と同じ 3 片になる', () => {
    const { feature, store } = squareLeaf('notch', notch);
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 5), c(11, 5)])));
    expect(pieces).toHaveLength(3);
    const areas = pieces.map(planarArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(22.5, 6);
    expect(areas[1]).toBeCloseTo(22.5, 6);
    expect(areas[2]).toBeCloseTo(50, 6);
    for (const p of pieces) expect(p).toHaveLength(1);
    expectNoOverlap(pieces);

    const shifted = piecesOf(
      checkSplittable(feature, store, createOpenKnifeLine([c(-1, 5.000001), c(11, 5.000001)])),
    );
    expect(shifted).toHaveLength(3);
  });
});

describe('反証 2-4 — 日付変更線をまたぐ面で、予告と結果が食い違わない', () => {
  // 170°E〜170°W に広がる U の字（保存されている経度のまま＝生の値）。
  const ring = [
    c(170, 0),
    c(-170, 0),
    c(-170, 30),
    c(-175, 30),
    c(-175, 10),
    c(175, 10),
    c(175, 30),
    c(170, 30),
  ];

  it('生の形を渡しても「n 片に分かれる」と言い、実際に 3 片に分かれる', () => {
    const { feature, store } = squareLeaf('am', ring);
    const raw = resolveLeafShape(feature.shape, store)!;
    expect(splitsIntoManyPieces(raw)).toBe(true);
    const pieces = piecesOf(
      checkSplittable(feature, store, createOpenKnifeLine([c(168, 20), c(-168, 20)])),
    );
    expect(pieces).toHaveLength(3);
  });
});
