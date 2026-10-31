// 集合演算が消した点の挿し直しと、長い辺の刻み。

import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import type { GeoMultiPolygon } from '../geometry/types';

import { countLongEdgesInMultiPolygon, restoreDroppedPoints, subdivideLongEdges } from './long-edge';

const c = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);
const SQ: WorldCoordinate[] = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];

describe('restoreDroppedPoints', () => {
  it('辺の上の点を、辺の順の位置へ挿す', () => {
    const out = restoreDroppedPoints([[SQ]], [c(7, 0), c(3, 0)]);
    expect(out[0]![0]!.map((q) => [q.lon, q.lat])).toEqual([
      [0, 0],
      [3, 0],
      [7, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ]);
  });

  it('別の輪に残っている点も、その点を通る輪へ挿す（点の有無は輪ごと）', () => {
    // A の南の辺の上に P(5,0)。P は B の頂点として残っている。
    const a = SQ;
    const b = [c(5, 0), c(4, -2), c(6, -2)];
    const out = restoreDroppedPoints([[a], [b]], [c(5, 0)]);
    expect(out[0]![0]!.some((q) => q.lon === 5 && q.lat === 0)).toBe(true);
    expect(out[0]![0]).toHaveLength(5);
    // B はもともと持っているので増えない。
    expect(out[1]![0]).toHaveLength(3);
  });

  it('同じ輪が別の位置に持っている点は、もう 1 度挿さない（1 つの輪が同じ点を 2 度引かない）', () => {
    // 外周が自分に接する形。(5,0) は頂点で、別の辺 (3,0)→(7,0) の上にも乗る。
    const pinched = [c(0, 0), c(3, 0), c(7, 0), c(10, 0), c(10, 10), c(5, 0), c(0, 10)];
    expect(restoreDroppedPoints([[pinched]], [c(5, 0)])[0]![0]).toBe(pinched);
  });

  it('同じ座標の候補を 2 度挿さない（+180 と -180 も同じ点）', () => {
    const ring = [c(170, 0), c(190, 0), c(190, 10), c(170, 10)];
    const out = restoreDroppedPoints([[ring]], [c(180, 0), c(-180, 0)]);
    expect(out[0]![0]).toHaveLength(5);
    expect(out[0]![0]![1]).toEqual(c(180, 0));
  });

  it('結果の枠の周へ置く（保存の -170 は枠の 190）', () => {
    const ring = [c(170, 0), c(200, 0), c(200, 10), c(170, 10)];
    const out = restoreDroppedPoints([[ring]], [c(-170, 0)]);
    expect(out[0]![0]![1]).toEqual(c(190, 0));
  });

  it('外積がちょうど 0 の点だけ挿す: 1 格子ずれた点は挿さない', () => {
    const ring = [c(0, 0), c(10, 0), c(10, 10), c(0, 10)];
    expect(restoreDroppedPoints([[ring]], [c(5, 0.0000001)])[0]![0]).toBe(ring);
  });

  it('斜めの長い辺でも、外積は整数の厳密な値で見る（浮動小数点の積では 0 に丸まる）', () => {
    // 辺 (−170, −80) から東へ約 340 度、北へ約 160 度。
    const a = c(-170, -80);
    const b = c(170.0000001, 79.9999999);
    const ring = [a, b, c(170, 85), c(-170, 85)];
    // 辺に 1 格子未満の所の点（外積が 1）。積が 2.7e18 まで育つので、倍精度では外積が 0 に見える。
    const nearly = c(-61.1999999, -28.8);
    const dx = 3400000001;
    const dy = 1599999999;
    const px = Math.round(nearly.lon * 1e7) + 1700000000;
    const py = Math.round(nearly.lat * 1e7) + 800000000;
    expect(BigInt(dx) * BigInt(py) - BigInt(dy) * BigInt(px)).toBe(1n); // 手計算の前提。
    expect(dx * py - dy * px).toBe(0); // 手計算の前提: 倍精度では 0 に丸まる。
    expect(restoreDroppedPoints([[ring]], [nearly])[0]![0]).toBe(ring);
  });

  it('挿す点が無ければ入力をそのまま返す', () => {
    const mp: GeoMultiPolygon = [[SQ]];
    expect(restoreDroppedPoints(mp, [c(50, 50)])).toBe(mp);
    expect(restoreDroppedPoints(mp, [])).toBe(mp);
  });
});

describe('subdivideLongEdges', () => {
  it('長い辺だけを 90 度以下に刻み、形を変えない', () => {
    const ring = [c(0, 0), c(240, 0), c(240, 10), c(0, 10)];
    const out = subdivideLongEdges([[ring]]);
    expect(countLongEdgesInMultiPolygon(out)).toBe(0);
    expect(out[0]![0]!.filter((q) => q.lat === 0).map((q) => q.lon)).toEqual([0, 80, 160, 240]);
    expect(out[0]![0]!.filter((q) => q.lat === 10).map((q) => q.lon)).toEqual([240, 160, 80, 0]);
  });
});
