// V10 / N-08（増分 8B）: 正しい分断線が「自己交差しています」と誤って断られない。
//
// 原因（実データで測って特定した）: n 分割の経路は切片ごとに、切片の両端の線分を
// 外へ延ばした「遠い枠までの片側」を切り抜き形にしていた。凹んだ面ではこの延長が
// 面へ入り直す。まっすぐな線なら 2 本目以降の切片はすべて 1 本目の延長の上に乗るので、
// 1 本目を切った時点で 2 本目以降の切り口までできてしまい、2 本目の代表点がどの片の
// 「内側」にも入らず（境界の上に乗る）断られていた。実データのアルラーク国（3000 年）
// では、面を横切る水平線 199 本のうち 110 本、垂直線 199 本のうち 99 本が断られていた。
// 直し方: 切片ごとに、その片の外周を切片の両端で 2 つに分けて切片で閉じる（切片以外は
// 何も切らない）。
//
// ここでは ① 南北に分ける（水平線）② 東西に分ける（垂直線）を実データの形で固定し、
// 合わせて「延長が別の腕まで切っていた」不具合と、本当の自己交差の断りを固定する。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import type { GeoMultiPolygon } from '../geometry/index';
import { squareLeaf, squareWithHole, unitSquare } from './fixtures';
import { ALRUK_RING_3000 } from './fixtures-alruk';
import { createOpenKnifeLine } from './knife-line';
import {
  SPLIT_CHECK_STATUS,
  SPLIT_REJECT,
  checkSplittable,
  executeSplit,
  splitsIntoManyPieces,
  type SplitCheckResult,
} from './split-geometry';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

/** 平面の面積（穴を引く）。面積の保存と片ごとの大きさを見る。 */
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

const alruk = () => squareLeaf('alruk', ALRUK_RING_3000);
const ALRUK_AREA = planarArea([[ALRUK_RING_3000]]);
const ALRUK_BOX = (() => {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of ALRUK_RING_3000) {
    minLon = Math.min(minLon, p.lon);
    maxLon = Math.max(maxLon, p.lon);
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
  }
  return { minLon, maxLon, minLat, maxLat };
})();

describe('V10 ① 南北に分ける — 実データのアルラーク国を水平の 2 点線で切る', () => {
  it('以前「自己交差」で断られた水平線（緯度 36.677°）が通り、面積が保たれる', () => {
    const { feature, store } = alruk();
    const line = createOpenKnifeLine([c(64.9098096, 36.677135872), c(126.3014849, 36.677135872)]);
    const pieces = piecesOf(checkSplittable(feature, store, line));
    // この線は境界を 4 回横切る（凹みを 1 つまたぐ）ので 3 片になる。
    expect(pieces.length).toBe(3);
    const sum = pieces.reduce((acc, p) => acc + planarArea(p), 0);
    expect(Math.abs(sum - ALRUK_AREA) / ALRUK_AREA).toBeLessThan(1e-6);
    // どの片も 1 枚の多角形（延長が別の場所を切った「飛び地付きの片」が混ざらない）。
    for (const p of pieces) expect(p.length).toBe(1);
    expect(executeSplit(feature, store, line)).toBeDefined();
  });
});

describe('V10 ② 東西に分ける — 実データのアルラーク国を垂直の 2 点線で切る', () => {
  it('以前「自己交差」で断られた垂直線（経度 67.825°）が通り、面積が保たれる', () => {
    const { feature, store } = alruk();
    const line = createOpenKnifeLine([c(67.825476612, 75.4587125), c(67.825476612, 35.5941677)]);
    const pieces = piecesOf(checkSplittable(feature, store, line));
    expect(pieces.length).toBe(3);
    const sum = pieces.reduce((acc, p) => acc + planarArea(p), 0);
    expect(Math.abs(sum - ALRUK_AREA) / ALRUK_AREA).toBeLessThan(1e-6);
    for (const p of pieces) expect(p.length).toBe(1);
    expect(executeSplit(feature, store, line)).toBeDefined();
  });
});

describe('V10 ①② 面を横切るまっすぐな線は、どの高さ・どの経度でも断られない', () => {
  // 修正前は水平 110/199・垂直 99/199 本が断られていた（探針の実測）。ここでは 24 本ずつ。
  const STEPS = 25;
  for (const orient of ['水平（南北に分ける）', '垂直（東西に分ける）'] as const) {
    it(`${orient}の線 ${STEPS - 1} 本がすべて分けられ、面積が保たれる`, () => {
      const { feature, store } = alruk();
      const b = ALRUK_BOX;
      const refused: string[] = [];
      for (let i = 1; i < STEPS; i += 1) {
        const f = i / STEPS;
        const line =
          orient === '水平（南北に分ける）'
            ? createOpenKnifeLine([
                c(b.minLon - 0.5, b.minLat + (b.maxLat - b.minLat) * f),
                c(b.maxLon + 0.5, b.minLat + (b.maxLat - b.minLat) * f),
              ])
            : createOpenKnifeLine([
                c(b.minLon + (b.maxLon - b.minLon) * f, b.maxLat + 0.5),
                c(b.minLon + (b.maxLon - b.minLon) * f, b.minLat - 0.5),
              ]);
        const res = checkSplittable(feature, store, line);
        if (res.status !== SPLIT_CHECK_STATUS.Splittable) {
          refused.push(`${f.toFixed(2)}: ${res.reason}`);
          continue;
        }
        const pieces = piecesOf(res);
        const sum = pieces.reduce((acc, p) => acc + planarArea(p), 0);
        expect(Math.abs(sum - ALRUK_AREA) / ALRUK_AREA).toBeLessThan(1e-6);
      }
      expect(refused).toEqual([]);
    });
  }
});

describe('V10 — 凹んだ面で、線の延長が触っていない所まで切らない', () => {
  // U の字: 下の帯 [0,10]×[0,3] と、左右の腕 [0,3]×[3,10]・[7,10]×[3,10]。面積 72。
  const uShape = () =>
    squareLeaf('u', [c(0, 0), c(10, 0), c(10, 10), c(7, 10), c(7, 3), c(3, 3), c(3, 10), c(0, 10)]);

  it('両腕を横切る水平線は 3 片（左腕の上・右腕の上・残り）', () => {
    const { feature, store } = uShape();
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 5), c(11, 5)])));
    const areas = pieces.map(planarArea).sort((a, b) => a - b);
    expect(areas).toHaveLength(3);
    expect(areas[0]).toBeCloseTo(15, 6);
    expect(areas[1]).toBeCloseTo(15, 6);
    expect(areas[2]).toBeCloseTo(42, 6);
  });

  it('左腕だけを横切る短い線は、右腕を切らない（延長が右腕まで切っていた）', () => {
    const { feature, store } = uShape();
    // 終点 (5,5) は U の谷（面の外）。線は左腕だけを貫く。
    const pieces = piecesOf(checkSplittable(feature, store, createOpenKnifeLine([c(-1, 5), c(5, 5)])));
    expect(pieces).toHaveLength(2);
    const areas = pieces.map(planarArea).sort((a, b) => a - b);
    expect(areas[0]).toBeCloseTo(15, 6);
    expect(areas[1]).toBeCloseTo(57, 6);
    // 修正前は「左腕の上＋右腕の上」の 2 枚組の片ができていた。
    for (const p of pieces) expect(p.length).toBe(1);
  });
});

describe('V10 — 本当に自己交差する線は「自己交差」で断る（理由を使い回さない）', () => {
  it('面の中で 2 本の切片が交わる線は SelfIntersectingCut', () => {
    const { feature, store } = unitSquare();
    // 左下→右上で貫き、外を回って、右下→左上で貫き直す（2 本の切片が中央で交わる）。
    const line = createOpenKnifeLine([c(-1, 2), c(11, 8), c(12, 8), c(12, 2), c(11, 2), c(-1, 8)]);
    const res = checkSplittable(feature, store, line);
    expect(res.status).toBe(SPLIT_CHECK_STATUS.NotSplittable);
    if (res.status === SPLIT_CHECK_STATUS.NotSplittable) {
      expect(res.reason).toBe(SPLIT_REJECT.SelfIntersectingCut);
    }
  });
});

describe('splitsIntoManyPieces — n 分割できる面か（V10 ③④ の予告に使う）', () => {
  it('穴も飛び地も無い 1 リングの面は真', () => {
    expect(splitsIntoManyPieces([[ALRUK_RING_3000]])).toBe(true);
  });

  it('穴のある面は偽', () => {
    const { feature } = squareWithHole();
    expect(feature.shape.rings.length).toBe(2);
    const outer = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    const hole = [c(3, 3), c(7, 3), c(7, 7), c(3, 7)];
    expect(splitsIntoManyPieces([[outer, hole]])).toBe(false);
  });

  it('飛び地のある面（多角形が 2 つ）は偽', () => {
    const a = [c(0, 0), c(2, 0), c(2, 2), c(0, 2)];
    const b = [c(5, 0), c(7, 0), c(7, 2), c(5, 2)];
    expect(splitsIntoManyPieces([[a], [b]])).toBe(false);
  });

  it('1 リングでも自分に接している（くびれで囲んだ入り江）面は偽', () => {
    // (4,4) で外周が自分に接し、内側の三角が実質の穴になっている。
    const pinched = [c(0, 0), c(10, 0), c(10, 10), c(4, 4), c(6, 4), c(4, 4), c(0, 10)];
    expect(splitsIntoManyPieces([[pinched]])).toBe(false);
  });
});
