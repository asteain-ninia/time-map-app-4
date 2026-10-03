// 増分 8A（N-07）— 矩形選択の枠を描く。
//
// 固定すること: 空いた所の押下から始まったドラッグのあいだだけ枠が出る／しきい値の内側では
// 出ない／解放・取り消しで必ず消える／元の選択の口の呼び順を変えない／枠は U22 の矩形選択が
// 判定に使うのと同じ経緯度の矩形である。

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import {
  EMPTY_HIT,
  EMPTY_SELECTION,
  vertexHit,
  type HitResult,
  type SelectionState,
} from '../../domain/selection';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import { screenToWorld, type Camera, type ScreenPoint, type Viewport } from '../../render';
import type { DisplayControlInput } from '../../render/display-pipeline';
import type { LinePrimitive, PolygonPrimitive } from '../../render/map-renderer';
import { verticesAt } from '../live-lookup';

import { verticesInRectangle } from './live-hit-test';
import { createLiveSelectionPort } from './live-selection-port';
import { NO_MODIFIERS, type SelectionPort } from './ports';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
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

  // 増分 8A の手直し（GPT #4）: 「枠は選択が判定に使う矩形そのもの」を、描画の計算の再現では
  // なく **実際の矩形選択の結果**で確かめる。実の選択の口（`createLiveSelectionPort`）と実の
  // 判定（`verticesInRectangle`）を通し、選ばれた頂点の集合が「描いた枠の内側（縁を含む）に
  // ある頂点」とちょうど一致することを見る。
  describe('描いた枠と、実際に選ばれる頂点が一致する', () => {
    const T = timePointYear(0);
    function projectWith(points: readonly (readonly [string, number, number])[]): DomainProject {
      const vs = points.map(([id, lon, lat]) =>
        createVertex(asVertexId(id), createCoordinate(lon, lat)),
      );
      const feature = createLeafFeature(
        asFeatureId('F'),
        createBasicAttributes('F国', 0, 100),
        createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
        createShape([createTerritoryRing(asRingId('F-r'), vs.map((v) => v.id))]),
      );
      return {
        histories: [singleAnchorHistory('F', [feature], createVertexStore(vs), 0)],
        settings: DEFAULT_SETTINGS,
        baseMap: DEFAULT_BASEMAP,
      };
    }

    /** 枠を描いて離し、描いた枠（塗りの輪）と選ばれた頂点を返す。 */
    function dragBand(
      root: DomainProject,
      camera: Camera,
      viewport: Viewport,
      from: ScreenPoint,
      to: ScreenPoint,
    ) {
      let selection: SelectionState = EMPTY_SELECTION;
      let drawn: RubberBand | null = null;
      const toWorld = (p: ScreenPoint) => screenToWorld(p, camera, viewport);
      const port = withRubberBand(
        createLiveSelectionPort(
          { getSelection: () => selection, restoreSelection: (s) => (selection = s) },
          toWorld,
          {
            verticesInRectangle: (a, b) =>
              verticesInRectangle(
                { root, time: T, displayControl: DISPLAY, wrap: { camera, viewport } },
                a,
                b,
              ),
          },
        ),
        (b) => {
          if (b !== null) drawn = b;
        },
      );
      port.start(EMPTY_HIT, from, NO_MODIFIERS);
      port.move(to);
      port.end(to, true);
      expect(drawn).not.toBeNull();
      const fill = rubberBandPrimitives(drawn, { camera, viewport }).find(
        (p): p is PolygonPrimitive => p.kind === 'polygon',
      )!;
      return { ring: fill.ring, selected: new Set([...selection.vertexIds].map(String)) };
    }

    /** 描いた枠の内側（縁を含む）にある頂点（±360° の複製のどれかが入れば内側）。 */
    function insideDrawn(
      root: DomainProject,
      ring: readonly { lon: number; lat: number }[],
    ): Set<string> {
      const lons = ring.map((p) => p.lon);
      const lats = ring.map((p) => p.lat);
      const [lo, hi] = [Math.min(...lons), Math.max(...lons)];
      const [la, lb] = [Math.min(...lats), Math.max(...lats)];
      const out = new Set<string>();
      for (const [id, v] of verticesAt(root, T).byId) {
        const c = v.coordinate;
        const lonIn = [-360, 0, 360].some((k) => c.lon + k >= lo && c.lon + k <= hi);
        if (lonIn && c.lat >= la && c.lat <= lb) out.add(String(id));
      }
      return out;
    }

    const viewport: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

    it('内側・外側・縁の上・角の上（縁は含む）', () => {
      // 中心 (0,0)・4px/度: 画面 (420,320) = (5°E, 5°S)、(480,260) = (20°E, 10°N)。
      const root = projectWith([
        ['in', 10, 0],
        ['out-east', 30, 0],
        ['on-edge', 20, 0],
        ['on-corner', 5, -5],
        ['out-north', 10, 11],
      ]);
      const camera: Camera = { centerLon: 0, centerLat: 0, zoom: 4 };
      const { ring, selected } = dragBand(root, camera, viewport, { x: 420, y: 320 }, { x: 480, y: 260 });
      expect(selected).toEqual(new Set(['in', 'on-edge', 'on-corner']));
      expect(selected).toEqual(insideDrawn(root, ring));
    });

    it('経度 180° をまたぐ枠でも、描いた枠と選ばれる頂点が一致する', () => {
      // 中心 180°・4px/度: 画面 x=380 は 175°、x=440 は 190°（＝−170°）。
      const root = projectWith([
        ['east-in', 178, 0],
        ['west-in', -175, 2],
        ['west-out', -165, 0],
        ['east-out', 170, 0],
      ]);
      const camera: Camera = { centerLon: 180, centerLat: 0, zoom: 4 };
      const { ring, selected } = dragBand(root, camera, viewport, { x: 380, y: 320 }, { x: 440, y: 280 });
      expect(selected).toEqual(new Set(['east-in', 'west-in']));
      expect(selected).toEqual(insideDrawn(root, ring));
    });
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
