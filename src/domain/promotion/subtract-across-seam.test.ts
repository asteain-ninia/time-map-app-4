// 引いて保存できる形にする処理の、面積の検算の幅と結果の形。
// 継ぎ目にかかる子の入口ごとの検査は `direct-domain.seam-child.test.ts` が見る。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { countLongEdgesInMultiPolygon } from '../geo/long-edge';
import { QUANTIZE_SCALE, type GeoRing } from '../geometry/index';

import { areasMatchWithinRounding, netLonLatArea, subtractAcrossSeam } from './subtract-across-seam';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const box = (w: number, s: number, e: number, n: number): GeoRing => [
  c(w, s),
  c(e, s),
  c(e, n),
  c(w, n),
];

describe('面積の検算の幅', () => {
  // 周の長さ 100 度の形は、頂点を 1 格子ずらしても 100 × 1e-7 = 1e-5 度²しか変わらない。
  const PERIMETER = 100;
  const ROUNDING = PERIMETER / QUANTIZE_SCALE;

  it('丸めの幅の中なら合うと言う', () => {
    expect(areasMatchWithinRounding(1000, 1000 + ROUNDING, PERIMETER)).toBe(true);
  });

  it('丸めの幅の 2 倍の差は合わないと言う（大きな面でも、面積に比例して緩めない）', () => {
    expect(areasMatchWithinRounding(1000, 1000 + 2 * ROUNDING, PERIMETER)).toBe(false);
    expect(areasMatchWithinRounding(1_000_000, 1_000_000 + 2 * ROUNDING, PERIMETER)).toBe(false);
  });

  it('幅いっぱいの面積 3,985 の面で、0.01 度²の子のぶんが消えると合わない', () => {
    // 実データの area-188 の大きさ。周の長さは約 800 度（面積に比例した 1e-5 では 0.04 まで通っていた）。
    expect(areasMatchWithinRounding(3985, 3985.01, 800)).toBe(false);
  });
});

describe('subtractAcrossSeam', () => {
  it('どの周にある引く形でも引ける', () => {
    for (const turn of [-360, 0, 360]) {
      const r = subtractAcrossSeam(
        [[box(170, 0, 190, 10)]],
        [[box(181 + turn, 2, 183 + turn, 4)]],
        [],
      );
      if (r.kind !== 'ok') throw new Error(r.kind);
      expect(netLonLatArea(r.shape)).toBeCloseTo(200 - 4, 6);
    }
  });

  it('全部覆われると empty', () => {
    expect(subtractAcrossSeam([[box(0, 0, 10, 10)]], [[box(-1, -1, 11, 11)]], []).kind).toBe('empty');
  });

  it('差分の面積は点を打つ前の値で、結果に長い辺が残らない', () => {
    const wide = [c(0, 0), c(100, 0), c(200, 0), c(300, 0), c(300, 10), c(200, 10), c(100, 10), c(0, 10)];
    const r = subtractAcrossSeam([[wide]], [[box(100, 2, 110, 4)]], []);
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.area).toBeCloseTo(3000 - 20, 6);
    expect(countLongEdgesInMultiPolygon(r.shape)).toBe(0);
  });

  it('消えた点を元の座標で辺へ戻す', () => {
    const r = subtractAcrossSeam(
      [[[c(0, 0), c(10, 0), c(20, 0), c(20, 10), c(0, 10)]]],
      [[box(5, 2, 6, 3)]],
      [c(10, 0)],
    );
    if (r.kind !== 'ok') throw new Error(r.kind);
    expect(r.shape[0]![0]!.some((q) => q.lon === 10 && q.lat === 0)).toBe(true);
  });
});
