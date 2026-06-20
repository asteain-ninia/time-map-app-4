// U19 feature-layer tests (FR-17 / FR-21 / FR-71 / FR-86, NFR 5.1 / 5.2).
// Pure primitive-building: existence/即時更新, hole透過/飛び地独立, derived aggregate
// shape (single source), per-type label visibility, constant on-screen size, view
// clipping + LOD, and purity. No Canvas — we inspect the中間表現 (教訓 5.41).

import { describe, expect, it } from 'vitest';

import type { GeoMultiPolygon } from '../domain/geometry/types';

import type { Camera, Viewport } from './camera';
import {
  type BuildOptions,
  type EvaluatedArea,
  type EvaluatedFeature,
  type FeatureStyle,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  areaRingLabelVisible,
  buildFeaturePrimitives,
  clipViewRect,
  featureIntersectsViewport,
  selectVisibleFeatures,
  lineLabelVisible,
  lodLevelForZoom,
  pointLabelVisible,
  projectedLengthPx,
  ringOccupancy,
  simplifyRing,
  simplifyShape,
  viewportWorldRect,
  LOD_LEVEL,
} from './feature-layer';
import type {
  LabelPrimitive,
  PointPrimitive,
  PolygonShapePrimitive,
} from './map-renderer';

const VP: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAM: Camera = { centerLon: 0, centerLat: 0, zoom: 10 };

const STYLE: FeatureStyle = { fill: '#3366cc', stroke: '#123456', selectedColor: '#00e5ff' };

function opts(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    camera: CAM,
    viewport: VP,
    sizes: DEFAULT_SCREEN_SIZES,
    thresholds: DEFAULT_LABEL_THRESHOLDS,
    ...over,
  };
}

function shapes(prims: readonly { kind: string }[]): PolygonShapePrimitive[] {
  return prims.filter((p): p is PolygonShapePrimitive => p.kind === 'shape');
}
function points(prims: readonly { kind: string }[]): PointPrimitive[] {
  return prims.filter((p): p is PointPrimitive => p.kind === 'point');
}
function labels(prims: readonly { kind: string }[]): LabelPrimitive[] {
  return prims.filter((p): p is LabelPrimitive => p.kind === 'label');
}

// --- 受け入れ基準 1: existence + 即時更新 -------------------------------------

describe('受け入れ基準 1: selected-time drawing + immediate update (FR-71)', () => {
  it('draws every supplied (existing) feature; absent features never appear', () => {
    const features: EvaluatedFeature[] = [
      { kind: 'point', id: 'p1', at: { lon: 0, lat: 0 }, style: STYLE, label: '', selected: false },
      {
        kind: 'line',
        id: 'l1',
        points: [
          { lon: -2, lat: 0 },
          { lon: 2, lat: 0 },
        ],
        style: STYLE,
        label: '',
        selected: false,
      },
    ];
    const prims = buildFeaturePrimitives(features, opts());
    // p1 + l1 drawn; a feature with id 'gone' was never in the list ⇒ never drawn.
    expect(points(prims).length).toBe(1);
    expect(prims.some((p) => p.kind === 'line')).toBe(true);
  });

  it('reflects a replaced evaluated state (existence appears/disappears)', () => {
    const before: EvaluatedFeature[] = [
      { kind: 'point', id: 'p1', at: { lon: 0, lat: 0 }, style: STYLE, label: '', selected: false },
    ];
    const after: EvaluatedFeature[] = []; // the feature ceased to exist at the new time.
    expect(points(buildFeaturePrimitives(before, opts())).length).toBe(1);
    expect(points(buildFeaturePrimitives(after, opts())).length).toBe(0);
  });

  it('reflects a shape change at a new time (different geometry ⇒ different primitive)', () => {
    const t0: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[squareRing(0, 0, 1)]],
      style: STYLE,
      label: '',
      selected: false,
    };
    const t1: EvaluatedArea = { ...t0, shape: [[squareRing(0, 0, 5)]] };
    const s0 = shapes(buildFeaturePrimitives([t0], opts()))[0]!;
    const s1 = shapes(buildFeaturePrimitives([t1], opts()))[0]!;
    expect(s0.pieces[0]![0]).not.toEqual(s1.pieces[0]![0]);
  });
});

// --- 受け入れ基準 2: hole透過 / 飛び地独立 (FR-21) ---------------------------

function squareRing(lon: number, lat: number, r: number) {
  return [
    { lon: lon - r, lat: lat - r },
    { lon: lon + r, lat: lat - r },
    { lon: lon + r, lat: lat + r },
    { lon: lon - r, lat: lat + r },
  ];
}

describe('受け入れ基準 2: hole透過 + 飛び地独立 (FR-21)', () => {
  it('emits ONE shape primitive carrying outer + hole rings, single fill (hole透過)', () => {
    const area: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[squareRing(0, 0, 5), squareRing(0, 0, 1)]], // outer + hole
      style: STYLE,
      label: '',
      selected: false,
    };
    const s = shapes(buildFeaturePrimitives([area], opts()))[0]!;
    expect(s.pieces.length).toBe(1);
    expect(s.pieces[0]!.length).toBe(2); // outer + hole, both in ONE primitive (even-odd透過)
    expect(s.fill).toBe(STYLE.fill); // single fill color, no per-ring color
  });

  it('emits飛び地 as a separate piece with the SAME fill/stroke (no連結線, FR-101)', () => {
    const area: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[squareRing(-10, 0, 2)], [squareRing(10, 0, 2)]], // mainland + enclave
      style: STYLE,
      label: '',
      selected: false,
    };
    const s = shapes(buildFeaturePrimitives([area], opts()))[0]!;
    expect(s.pieces.length).toBe(2); // two independent territory pieces
    expect(s.fill).toBe(STYLE.fill); // identical fill — 飛び地 is not recolored
    expect(s.stroke).toBe(STYLE.stroke);
  });

  it('selected state changes only the COLOR, never the ring structure (教訓 5.25)', () => {
    const base: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[squareRing(0, 0, 5), squareRing(0, 0, 1)], [squareRing(20, 0, 2)]],
      style: STYLE,
      label: '',
      selected: false,
    };
    const normal = shapes(buildFeaturePrimitives([base], opts()))[0]!;
    const sel = shapes(buildFeaturePrimitives([{ ...base, selected: true }], opts()))[0]!;
    // Same pieces / same ring counts; only fill color differs.
    expect(sel.pieces.map((p) => p.length)).toEqual(normal.pieces.map((p) => p.length));
    expect(normal.fill).toBe(STYLE.fill);
    expect(sel.fill).toBe(STYLE.selectedColor);
  });

  it('nested enclave (hole-then-territory) is kept as its own piece (交互規則)', () => {
    // piece0 = outer+hole; piece1 = enclave sitting inside that hole.
    const area: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[squareRing(0, 0, 9), squareRing(0, 0, 5)], [squareRing(0, 0, 2)]],
      style: STYLE,
      label: '',
      selected: false,
    };
    const s = shapes(buildFeaturePrimitives([area], opts()))[0]!;
    expect(s.pieces.length).toBe(2);
  });
});

// --- 受け入れ基準 3: aggregate derived shape, single source (教訓 5.29/5.1) ---

describe('受け入れ基準 3: aggregate derived shape (single resolution, 教訓 5.29/5.1)', () => {
  it('draws all pieces of a multi-piece derived union (片落とししない, 教訓 5.1)', () => {
    // U08 resolved an aggregate to TWO disjoint pieces; both must be drawn.
    const derived: GeoMultiPolygon = [[squareRing(-30, 0, 3)], [squareRing(30, 0, 3)]];
    const agg: EvaluatedArea = {
      kind: 'area',
      id: 'agg',
      shape: derived,
      style: STYLE,
      label: '',
      selected: false,
    };
    const s = shapes(buildFeaturePrimitives([agg], opts({ camera: { centerLon: 0, centerLat: 0, zoom: 2 } })))[0]!;
    expect(s.pieces.length).toBe(2);
  });

  it('uses the SAME shape for fill and label anchor (no divergence, 教訓 5.29)', () => {
    const derived: GeoMultiPolygon = [[squareRing(0, 0, 20)]];
    const agg: EvaluatedArea = {
      kind: 'area',
      id: 'agg',
      shape: derived,
      style: STYLE,
      label: 'AGG',
      selected: false,
    };
    const prims = buildFeaturePrimitives([agg], opts());
    const s = shapes(prims)[0]!;
    const lbl = labels(prims)[0];
    // The drawn outer ring and the label both come from the same `derived` shape.
    expect(s.pieces[0]![0]!.length).toBe(4);
    expect(lbl?.text).toBe('AGG');
  });
});

// --- 受け入れ基準 4: per-type label visibility + constant size (FR-86/FR-17) --

describe('受け入れ基準 4: point label min-zoom boundary (FR-86)', () => {
  const th = { ...DEFAULT_LABEL_THRESHOLDS, pointMinZoom: 5 };
  it('hides below, shows at/above (境界含む)', () => {
    expect(pointLabelVisible(4.999, th)).toBe(false);
    expect(pointLabelVisible(5, th)).toBe(true);
    expect(pointLabelVisible(5.001, th)).toBe(true);
  });
  it('build path drops the point label below min-zoom', () => {
    const f: EvaluatedFeature = {
      kind: 'point',
      id: 'p',
      at: { lon: 0, lat: 0 },
      style: STYLE,
      label: 'P',
      selected: false,
    };
    const below = buildFeaturePrimitives([f], opts({ camera: { ...CAM, zoom: 4 }, thresholds: th }));
    const above = buildFeaturePrimitives([f], opts({ camera: { ...CAM, zoom: 6 }, thresholds: th }));
    expect(labels(below).length).toBe(0);
    expect(labels(above).length).toBe(1);
  });
});

describe('受け入れ基準 4: line label visible-length boundary (FR-86)', () => {
  it('hides a short line, shows a long line', () => {
    const shortLine = [
      { lon: 0, lat: 0 },
      { lon: 1, lat: 0 },
    ];
    const longLine = [
      { lon: -20, lat: 0 },
      { lon: 20, lat: 0 },
    ];
    // At zoom 10: 1° = 10px (short=10px), 40° = 400px (long).
    expect(lineLabelVisible(shortLine, CAM, VP, DEFAULT_LABEL_THRESHOLDS)).toBe(false);
    expect(lineLabelVisible(longLine, CAM, VP, DEFAULT_LABEL_THRESHOLDS)).toBe(true);
  });
  it('projectedLengthPx scales with zoom', () => {
    const pts = [
      { lon: 0, lat: 0 },
      { lon: 10, lat: 0 },
    ];
    expect(projectedLengthPx(pts, { ...CAM, zoom: 10 }, VP)).toBeCloseTo(100, 5);
    expect(projectedLengthPx(pts, { ...CAM, zoom: 20 }, VP)).toBeCloseTo(200, 5);
  });
});

describe('受け入れ基準 4: area-ring occupancy, per ring (FR-86 リング単位)', () => {
  it('labels only rings whose occupancy passes the threshold', () => {
    // Big outer (passes) + tiny enclave (fails) at the same feature.
    const big = squareRing(-30, 0, 12); // 24°×24° = 576 deg²
    const tiny = squareRing(40, 0, 0.2); // 0.4° square, negligible
    const area: EvaluatedArea = {
      kind: 'area',
      id: 'a',
      shape: [[big], [tiny]],
      style: STYLE,
      label: 'L',
      selected: false,
    };
    const camOut: Camera = { centerLon: 0, centerLat: 0, zoom: 5 };
    const prims = buildFeaturePrimitives([area], opts({ camera: camOut }));
    // exactly one ring (the big one) passes ⇒ one label.
    expect(labels(prims).length).toBe(1);
  });

  it('areaRingLabelVisible boundary uses occupancy threshold', () => {
    const ring = squareRing(0, 0, 10);
    const occ = ringOccupancy(ring, CAM, VP);
    const thBelow = { ...DEFAULT_LABEL_THRESHOLDS, areaMinOccupancy: occ + 0.001 };
    const thAt = { ...DEFAULT_LABEL_THRESHOLDS, areaMinOccupancy: occ };
    expect(areaRingLabelVisible(ring, CAM, VP, thBelow)).toBe(false);
    expect(areaRingLabelVisible(ring, CAM, VP, thAt)).toBe(true);
  });
});

describe('受け入れ基準 4 / FR-17: constant on-screen size across zoom', () => {
  it('point radius, stroke width, label font are zoom-independent', () => {
    const f: EvaluatedFeature = {
      kind: 'point',
      id: 'p',
      at: { lon: 0, lat: 0 },
      style: STYLE,
      label: 'P',
      selected: false,
    };
    const a = buildFeaturePrimitives([f], opts({ camera: { ...CAM, zoom: 3 } }));
    const b = buildFeaturePrimitives([f], opts({ camera: { ...CAM, zoom: 30 } }));
    expect(points(a)[0]!.radiusPx).toBe(points(b)[0]!.radiusPx);
    expect(labels(a)[0]!.fontPx).toBe(labels(b)[0]!.fontPx);
    expect(points(a)[0]!.radiusPx).toBe(DEFAULT_SCREEN_SIZES.pointRadiusPx);
  });
});

// --- 受け入れ基準 5: clipping + LOD --------------------------------------------

describe('受け入れ基準 5: view clipping drops off-screen features', () => {
  it('clip ON removes a feature outside the viewport; clip OFF keeps it', () => {
    const onScreen: EvaluatedFeature = {
      kind: 'point',
      id: 'in',
      at: { lon: 0, lat: 0 },
      style: STYLE,
      label: '',
      selected: false,
    };
    const offScreen: EvaluatedFeature = {
      kind: 'point',
      id: 'out',
      at: { lon: 170, lat: 0 }, // far outside a zoom-10 viewport centered at 0
      style: STYLE,
      label: '',
      selected: false,
    };
    const clipped = buildFeaturePrimitives([onScreen, offScreen], opts({ clip: true }));
    const unclipped = buildFeaturePrimitives([onScreen, offScreen], opts({ clip: false }));
    expect(points(clipped).length).toBe(1);
    expect(points(unclipped).length).toBe(2);
  });

  it('viewportWorldRect reflects the camera span', () => {
    const r = viewportWorldRect(CAM, VP);
    // 800px / 10 = 80° wide ⇒ ±40°.
    expect(r.minLon).toBeCloseTo(-40, 5);
    expect(r.maxLon).toBeCloseTo(40, 5);
  });

  it('featureIntersectsViewport handles each kind', () => {
    const view = viewportWorldRect(CAM, VP);
    expect(
      featureIntersectsViewport(
        { kind: 'point', id: 'p', at: { lon: 0, lat: 0 }, style: STYLE, label: '', selected: false },
        view,
      ),
    ).toBe(true);
    expect(
      featureIntersectsViewport(
        { kind: 'point', id: 'p', at: { lon: 120, lat: 0 }, style: STYLE, label: '', selected: false },
        view,
      ),
    ).toBe(false);
  });

  it('keeps a feature whose ±360° replica is on screen after panning past one turn (Codex high #1)', () => {
    // Pan east past a whole world period: centerLon 360 ⇒ view span ~[320, 400].
    // A feature at lon=0 is NOT in [320,400] raw, but its +360° replica (lon=360)
    // IS — and the renderer draws that replica. Period-aware clipping must KEEP it.
    const panned: Camera = { centerLon: 360, centerLat: 0, zoom: 10 };
    const view = viewportWorldRect(panned, VP);
    const atZero = {
      kind: 'point' as const,
      id: 'p',
      at: { lon: 0, lat: 0 },
      style: STYLE,
      label: '',
      selected: false,
    };
    expect(featureIntersectsViewport(atZero, view)).toBe(true);
    // And it survives the full build pipeline (clip ON) so it actually draws.
    const prims = buildFeaturePrimitives([atZero], opts({ camera: panned }));
    expect(points(prims).length).toBe(1);
    // A feature with no visible replica (lon=180, half a turn from any edge) is dropped.
    const atFar = { ...atZero, id: 'far', at: { lon: 180, lat: 0 } };
    expect(featureIntersectsViewport(atFar, view)).toBe(false);
  });

  it('keeps an edge-straddling point whose radius pokes into view (Codex medium #4)', () => {
    // A point a few px outside the bare viewport span but within pointRadiusPx of
    // the edge is still partly visible ⇒ must NOT be clipped (inflated clip rect).
    // View is ±40°; place the point just past the edge by less than radius/zoom.
    const marginDeg = DEFAULT_SCREEN_SIZES.pointRadiusPx / CAM.zoom; // 5/10 = 0.5°
    const justOutside = {
      kind: 'point' as const,
      id: 'edge',
      at: { lon: 40 + marginDeg / 2, lat: 0 },
      style: STYLE,
      label: '',
      selected: false,
    };
    expect(points(buildFeaturePrimitives([justOutside], opts())).length).toBe(1);
  });
});

describe('HB-14: selectVisibleFeatures is the single clip source + survives zoom-in', () => {
  it('selectVisibleFeatures returns exactly the features buildFeaturePrimitives draws', () => {
    const inView: EvaluatedFeature = {
      kind: 'point', id: 'in', at: { lon: 0, lat: 0 }, style: STYLE, label: '', selected: false,
    };
    const outView: EvaluatedFeature = {
      kind: 'point', id: 'out', at: { lon: 170, lat: 0 }, style: STYLE, label: '', selected: false,
    };
    const visible = selectVisibleFeatures([inView, outView], CAM, VP, DEFAULT_SCREEN_SIZES);
    expect(visible.map((f) => f.id)).toEqual(['in']);
    // The pipeline draws exactly those — one point primitive.
    expect(points(buildFeaturePrimitives([inView, outView], opts())).length).toBe(visible.length);
  });

  it('clip OFF returns the input unchanged (harness parity)', () => {
    const f: EvaluatedFeature = {
      kind: 'point', id: 'p', at: { lon: 170, lat: 0 }, style: STYLE, label: '', selected: false,
    };
    expect(selectVisibleFeatures([f], CAM, VP, DEFAULT_SCREEN_SIZES, false)).toEqual([f]);
  });

  it('clipViewRect widens the bare viewport rect by the inflate margin', () => {
    const bare = viewportWorldRect(CAM, VP);
    const clip = clipViewRect(CAM, VP, DEFAULT_SCREEN_SIZES);
    expect(clip.minLon).toBeLessThan(bare.minLon);
    expect(clip.maxLon).toBeGreaterThan(bare.maxLon);
  });

  it('a centred feature stays in the clip set across progressive zoom-in (HB-14 core)', () => {
    const at = { lon: 12, lat: -7 };
    const feature: EvaluatedFeature = {
      kind: 'point', id: 'c', at, style: STYLE, label: '', selected: false,
    };
    let lastZoom = 0;
    for (const zoom of [1, 2, 5, 10, 25, 60, 150, 400, 1000]) {
      const camera: Camera = { centerLon: at.lon, centerLat: at.lat, zoom };
      const kept = selectVisibleFeatures([feature], camera, VP, DEFAULT_SCREEN_SIZES);
      expect(kept).toHaveLength(1); // never culled while centred — no "消える"
      expect(zoom).toBeGreaterThan(lastZoom);
      lastZoom = zoom;
    }
  });
});

describe('受け入れ基準 5: LOD reduces vertex count but preserves topology', () => {
  it('simplifyRing collapses near vertices at coarse tolerance', () => {
    const ring = [
      { lon: 0, lat: 0 },
      { lon: 0.01, lat: 0 }, // very close to previous
      { lon: 5, lat: 0 },
      { lon: 5, lat: 5 },
      { lon: 0, lat: 5 },
    ];
    const simplified = simplifyRing(ring, 1);
    expect(simplified.length).toBeLessThan(ring.length);
    expect(simplified.length).toBeGreaterThanOrEqual(3);
  });

  it('simplifyRing force-keeps BOTH the first and last vertex (Codex medium #3)', () => {
    // A long run of near-anchor vertices then a far tail: the radial test would, at
    // the previous impl, only keep the tail if it passed against the running anchor.
    // The contract now force-keeps ring[last] so the closing edge is preserved.
    const ring = [
      { lon: 0, lat: 0 }, // first (force-kept)
      { lon: 0.01, lat: 0 },
      { lon: 0.02, lat: 0 },
      { lon: 10, lat: 0 },
      { lon: 10, lat: 10 },
      { lon: 9.99, lat: 9.99 }, // last: very close to previous ⇒ fails distance test
    ];
    const simplified = simplifyRing(ring, 2);
    expect(simplified[0]).toEqual(ring[0]);
    expect(simplified[simplified.length - 1]).toEqual(ring[ring.length - 1]);
  });

  it('simplifyShape never drops a piece (穴/飛び地の正しさ維持, 教訓 5.1)', () => {
    const shape: GeoMultiPolygon = [
      [squareRing(0, 0, 5), squareRing(0, 0, 1)],
      [squareRing(30, 0, 5)],
    ];
    const out = simplifyShape(shape, 2);
    expect(out.length).toBe(2); // both pieces kept
    expect(out[0]!.length).toBe(2); // outer + hole kept
  });

  it('lodLevelForZoom: coarse when zoomed out, full when zoomed in', () => {
    expect(lodLevelForZoom(1)).toBe(LOD_LEVEL.Coarse);
    expect(lodLevelForZoom(10)).toBe(LOD_LEVEL.Medium);
    expect(lodLevelForZoom(50)).toBe(LOD_LEVEL.Full);
  });
});

// --- 受け入れ基準 6: purity + draw order --------------------------------------

describe('受け入れ基準 6: purity + draw order', () => {
  it('does not mutate the input features or shapes', () => {
    const shape: GeoMultiPolygon = [[squareRing(0, 0, 5), squareRing(0, 0, 1)]];
    const f: EvaluatedFeature = {
      kind: 'area',
      id: 'a',
      shape,
      style: STYLE,
      label: 'L',
      selected: false,
    };
    const snapshot = JSON.stringify(f);
    buildFeaturePrimitives([f], opts());
    expect(JSON.stringify(f)).toBe(snapshot);
  });

  it('same input yields the same output (deterministic)', () => {
    const f: EvaluatedFeature = {
      kind: 'point',
      id: 'p',
      at: { lon: 1, lat: 2 },
      style: STYLE,
      label: 'P',
      selected: false,
    };
    expect(buildFeaturePrimitives([f], opts())).toEqual(buildFeaturePrimitives([f], opts()));
  });

  it('orders primitives areas → lines → points → labels', () => {
    const features: EvaluatedFeature[] = [
      { kind: 'point', id: 'p', at: { lon: 0, lat: 0 }, style: STYLE, label: 'P', selected: false },
      {
        kind: 'area',
        id: 'a',
        shape: [[squareRing(0, 0, 20)]],
        style: STYLE,
        label: 'A',
        selected: false,
      },
      {
        kind: 'line',
        id: 'l',
        points: [
          { lon: -20, lat: 0 },
          { lon: 20, lat: 0 },
        ],
        style: STYLE,
        label: 'L',
        selected: false,
      },
    ];
    const prims = buildFeaturePrimitives(features, opts());
    const kinds = prims.map((p) => p.kind);
    const firstLabel = kinds.indexOf('label');
    const lastNonLabel = Math.max(
      kinds.lastIndexOf('shape'),
      kinds.lastIndexOf('line'),
      kinds.lastIndexOf('point'),
    );
    // every label comes after every non-label.
    expect(firstLabel).toBeGreaterThan(lastNonLabel);
    // shape (area) is first band.
    expect(kinds[0]).toBe('shape');
  });
});
