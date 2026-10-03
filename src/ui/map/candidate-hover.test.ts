// 増分 8A の手直し（設計適合 2-3）— 一覧の行に乗っている頂点を、地図の上で輪で囲む。

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../../domain/coordinate';
import type { LinePrimitive } from '../../render/map-renderer';

import {
  CANDIDATE_HOVER_STYLE,
  candidateHoverPrimitives,
  withCandidateHoverLayer,
} from './candidate-hover';

const view = {
  camera: { centerLon: 0, centerLat: 0, zoom: 4 },
  viewport: { widthCss: 400, heightCss: 300, devicePixelRatio: 1 },
};

describe('行に乗っている頂点の輪', () => {
  it('頂点を中心に、画面の上で一定の半径の閉じた輪を描く（頂点の印ではなく線）', () => {
    const at = createCoordinate(10, 20);
    const prims = candidateHoverPrimitives(at, view);
    expect(prims).toHaveLength(1);
    const ring = prims[0] as LinePrimitive;
    expect(ring.kind).toBe('line');
    expect(ring.points[0]).toEqual(ring.points.at(-1));
    const r = CANDIDATE_HOVER_STYLE.radiusPx / view.camera.zoom;
    for (const p of ring.points) {
      expect(Math.hypot(p.lon - at.lon, p.lat - at.lat)).toBeCloseTo(r, 9);
    }
  });

  it('乗っていなければ・倍率が測れなければ何も描かない', () => {
    expect(candidateHoverPrimitives(null, view)).toEqual([]);
    expect(
      candidateHoverPrimitives(createCoordinate(0, 0), { ...view, camera: { ...view.camera, zoom: 0 } }),
    ).toEqual([]);
  });

  it('層の包みは、乗っていないときは中身をそのまま返し、乗っているときは上に足す', () => {
    let hover: ReturnType<typeof createCoordinate> | null = null;
    const base = [{ kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' } as const];
    const layer = withCandidateHoverLayer(() => hover, () => base);
    expect(layer(view)).toBe(base);
    hover = createCoordinate(1, 1);
    const out = layer(view);
    expect(out[0]).toBe(base[0]);
    expect(out).toHaveLength(2);
  });
});
