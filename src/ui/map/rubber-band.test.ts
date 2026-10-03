// 増分 8A（N-07）— 矩形選択の枠を描く。
//
// 固定すること: 空いた所の押下から始まったドラッグのあいだだけ枠が出る／しきい値の内側では
// 出ない／解放・取り消しで必ず消える／元の選択の口の呼び順を変えない／枠は U22 の矩形選択が
// 判定に使うのと同じ経緯度の矩形である。

import { describe, expect, it } from 'vitest';

import { EMPTY_HIT, vertexHit, type HitResult } from '../../domain/selection';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { screenToWorld, type Camera, type ScreenPoint, type Viewport } from '../../render';
import type { LinePrimitive, PolygonPrimitive } from '../../render/map-renderer';

import { NO_MODIFIERS, type SelectionPort } from './ports';
import {
  rubberBandPrimitives,
  withRubberBand,
  withRubberBandLayer,
  type RubberBand,
} from './rubber-band';

class LogPort implements SelectionPort {
  readonly log: string[] = [];
  start(hit: HitResult): void {
    this.log.push(`start:${hit.kind}`);
  }
  move(): void {
    this.log.push('move');
  }
  end(_p: ScreenPoint, wasDrag: boolean): void {
    this.log.push(`end:${String(wasDrag)}`);
  }
  cancel(): void {
    this.log.push('cancel');
  }
}

function setup() {
  const inner = new LogPort();
  const bands: (RubberBand | null)[] = [];
  const port = withRubberBand(inner, (b) => bands.push(b));
  return { inner, bands, port };
}

describe('矩形選択の枠', () => {
  it('空いた所からしきい値を越えて動かすと枠が出て、離すと消える', () => {
    const { inner, bands, port } = setup();
    port.start(EMPTY_HIT, { x: 10, y: 10 }, NO_MODIFIERS);
    port.move({ x: 12, y: 11 }); // しきい値の内側
    expect(bands).toEqual([]);
    port.move({ x: 60, y: 40 });
    expect(bands.at(-1)).toEqual({ from: { x: 10, y: 10 }, to: { x: 60, y: 40 } });
    port.end({ x: 60, y: 40 }, true);
    expect(bands.at(-1)).toBeNull();
    // 元の口の呼び順はそのまま。
    expect(inner.log).toEqual(['start:empty', 'move', 'move', 'end:true']);
  });

  it('頂点・本体の押下からのドラッグでは枠を出さない（編集ドラッグの持ち物）', () => {
    const { bands, port } = setup();
    port.start(vertexHit(asFeatureId('A'), asVertexId('v')), { x: 0, y: 0 }, NO_MODIFIERS);
    port.move({ x: 100, y: 100 });
    port.end({ x: 100, y: 100 }, true);
    expect(bands).toEqual([]);
  });

  it('取り消し（道具の持ち替え・pointercancel）でも必ず消える', () => {
    const { inner, bands, port } = setup();
    port.start(EMPTY_HIT, { x: 0, y: 0 }, NO_MODIFIERS);
    port.move({ x: 50, y: 50 });
    port.cancel();
    expect(bands.at(-1)).toBeNull();
    expect(inner.log.at(-1)).toBe('cancel');
    // 次の押下に枠が持ち越されない。
    port.start(vertexHit(asFeatureId('A'), asVertexId('v')), { x: 0, y: 0 }, NO_MODIFIERS);
    port.move({ x: 80, y: 80 });
    expect(bands.filter((b) => b !== null)).toHaveLength(1);
  });

  it('枠は、選択が判定に使う経緯度の矩形そのもの（破線の縁＋薄い塗り）', () => {
    const camera: Camera = { centerLon: 10, centerLat: 5, zoom: 4 };
    const viewport: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
    const band: RubberBand = { from: { x: 100, y: 100 }, to: { x: 300, y: 250 } };
    const prims = rubberBandPrimitives(band, { camera, viewport });
    const a = screenToWorld(band.from, camera, viewport);
    const b = screenToWorld(band.to, camera, viewport);
    const fill = prims.find((p): p is PolygonPrimitive => p.kind === 'polygon')!;
    const edge = prims.find((p): p is LinePrimitive => p.kind === 'line')!;
    expect(fill.ring).toEqual([
      { lon: a.lon, lat: a.lat },
      { lon: b.lon, lat: a.lat },
      { lon: b.lon, lat: b.lat },
      { lon: a.lon, lat: b.lat },
    ]);
    // 縁は閉じた破線（観測の `dashedLine` に数えられる）。
    expect(edge.points).toHaveLength(5);
    expect(edge.points[0]).toEqual(edge.points[4]);
    expect(edge.dashPx).toBeDefined();
    expect(rubberBandPrimitives(null, { camera, viewport })).toEqual([]);
  });

  it('層の包みは、枠が無いときは中身をそのまま返し、あるときは上に足す', () => {
    const view = {
      camera: { centerLon: 0, centerLat: 0, zoom: 2 },
      viewport: { widthCss: 400, heightCss: 300, devicePixelRatio: 1 },
    };
    let band: RubberBand | null = null;
    const base = [{ kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' } as const];
    const layer = withRubberBandLayer(() => band, () => base);
    expect(layer(view)).toBe(base);
    band = { from: { x: 0, y: 0 }, to: { x: 50, y: 50 } };
    const out = layer(view);
    expect(out[0]).toBe(base[0]);
    expect(out).toHaveLength(3);
  });
});
