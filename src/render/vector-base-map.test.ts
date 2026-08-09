// ベクター背景の焼き付け (FR-03 ベクター背景)。
//
// 検証の要点は「SVG ユーザー座標 → 焼き付け先ピクセル」の変換が、viewBox 矩形と世界矩形の
// 対応という 1 つの規約だけから正しく導かれること。実 Canvas は使わず、命令を記録する偽の
// 焼き付け先で確かめる (NFR 5.8)。

import { describe, expect, it } from 'vitest';

import type { VectorBaseMap } from '../domain/basemap/vector';
import { VECTOR_BASEMAP_KIND } from '../domain/basemap/vector';

import {
  bakeVectorBaseMap,
  prepareVectorBaseMap,
  vectorBakeTransform,
  type VectorBakeTarget,
} from './vector-base-map';

/** viewBox が世界全体に対応する最小の地図 (幅 360 / 高さ 180 = 1 ユーザー単位が 1 度)。 */
const MAP: VectorBaseMap = {
  kind: VECTOR_BASEMAP_KIND,
  viewBox: { x: 0, y: 0, width: 360, height: 180 },
  background: '#0000ff',
  layers: [
    { fill: '#00ff00', paths: ['M0,0H10V10H0Z'] },
    { fill: '#ff0000', paths: ['M20,20H30V30H20Z', 'M40,40H50V50H40Z'] },
  ],
};

interface Recorded {
  transforms: number[][];
  fills: { style: string; path: unknown }[];
  rects: { style: string; x: number; y: number; w: number; h: number }[];
}

function fakeTarget(): { target: VectorBakeTarget; rec: Recorded } {
  const rec: Recorded = { transforms: [], fills: [], rects: [] };
  const target: VectorBakeTarget = {
    fillStyle: '',
    setTransform(a, b, c, d, e, f) {
      rec.transforms.push([a, b, c, d, e, f]);
    },
    fillRect(x, y, w, h) {
      rec.rects.push({ style: String(target.fillStyle), x, y, w, h });
    },
    fill(path) {
      rec.fills.push({ style: String(target.fillStyle), path });
    },
  };
  return { target, rec };
}

/** SVG ユーザー座標 → ピクセル (テストが期待値を組み立てるための素直な適用)。 */
const apply = (
  t: { scaleX: number; scaleY: number; offsetX: number; offsetY: number },
  x: number,
  y: number,
): [number, number] => [t.scaleX * x + t.offsetX, t.scaleY * y + t.offsetY];

describe('vectorBakeTransform — SVG 座標 → 焼き付け先ピクセル', () => {
  it('世界全体を焼くとき、viewBox の四隅がキャンバスの四隅に一致する', () => {
    const t = vectorBakeTransform(
      MAP,
      { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
      720,
      360,
    );
    expect(apply(t, 0, 0)[0]).toBeCloseTo(0, 6);
    expect(apply(t, 0, 0)[1]).toBeCloseTo(0, 6);
    expect(apply(t, 360, 180)[0]).toBeCloseTo(720, 6);
    expect(apply(t, 360, 180)[1]).toBeCloseTo(360, 6);
  });

  it('一部の矩形を焼くとき、その矩形がキャンバス全面に広がる', () => {
    // 経度 0..90 / 緯度 90..45 = viewBox の (180,0)-(270,45)
    const t = vectorBakeTransform(
      MAP,
      { lonWest: 0, lonEast: 90, latNorth: 90, latSouth: 45 },
      400,
      200,
    );
    expect(apply(t, 180, 0)[0]).toBeCloseTo(0, 6);
    expect(apply(t, 180, 0)[1]).toBeCloseTo(0, 6);
    expect(apply(t, 270, 45)[0]).toBeCloseTo(400, 6);
    expect(apply(t, 270, 45)[1]).toBeCloseTo(200, 6);
  });

  it('シームを跨ぐ連続経度 (180 超) でも線形に続く', () => {
    const t = vectorBakeTransform(
      MAP,
      { lonWest: 170, lonEast: 190, latNorth: 10, latSouth: -10 },
      200,
      200,
    );
    // 経度 170 = viewBox x=350、経度 180 = x=360 (viewBox の右端) が中央に来る
    expect(apply(t, 350, 90)[0]).toBeCloseTo(0, 6);
    expect(apply(t, 360, 90)[0]).toBeCloseTo(100, 6);
  });

  it('退化した矩形・寸法では恒等変換を返す (落ちない)', () => {
    const t = vectorBakeTransform(
      MAP,
      { lonWest: 10, lonEast: 10, latNorth: 0, latSouth: 0 },
      100,
      100,
    );
    expect(t).toEqual({ scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 });
  });
});

describe('bakeVectorBaseMap — 焼き付けの手順', () => {
  it('下地を全面に塗ってから、レイヤー順にパスを塗る', () => {
    const { target, rec } = fakeTarget();
    const prepared = prepareVectorBaseMap(MAP, (d) => ({ d }));
    bakeVectorBaseMap(target, prepared, { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 }, 720, 360);

    // 下地は恒等変換のまま全面
    expect(rec.rects).toEqual([{ style: '#0000ff', x: 0, y: 0, w: 720, h: 360 }]);
    // 塗りは宣言順 (奥から手前) で、パスは 1 度だけ生成した値がそのまま渡る
    expect(rec.fills.map((f) => f.style)).toEqual(['#00ff00', '#ff0000', '#ff0000']);
    expect(rec.fills[0]?.path).toBe(prepared.layers[0]?.paths[0]);
    expect(rec.fills[2]?.path).toBe(prepared.layers[1]?.paths[1]);
  });

  it('最後に変換を恒等へ戻す (呼び出し側が続けて描ける)', () => {
    const { target, rec } = fakeTarget();
    const prepared = prepareVectorBaseMap(MAP, (d) => ({ d }));
    bakeVectorBaseMap(target, prepared, { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 }, 720, 360);
    expect(rec.transforms[rec.transforms.length - 1]).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it('パス生成は地図あたり 1 度で、焼き直しでは再生成しない', () => {
    let created = 0;
    const prepared = prepareVectorBaseMap(MAP, (d) => {
      created += 1;
      return { d };
    });
    expect(created).toBe(3); // 全パス数
    const { target } = fakeTarget();
    const rect = { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 };
    bakeVectorBaseMap(target, prepared, rect, 720, 360);
    bakeVectorBaseMap(target, prepared, rect, 720, 360);
    expect(created).toBe(3);
  });
});
