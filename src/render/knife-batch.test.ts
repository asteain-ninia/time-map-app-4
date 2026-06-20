import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../domain/coordinate';
import type { GeoMultiPolygon } from '../domain/geometry/types';
import {
  createClosedKnifeLine,
  KNIFE_PHASE,
  placeCutPoint,
  selectTarget,
  startKnife,
  type KnifeState,
} from '../domain/knife/index';
import { asFeatureId } from '../domain/ids';

import { buildKnifePrimitives, DEFAULT_KNIFE_STYLE } from './knife-batch';
import type { DrawPrimitive, LinePrimitive, PointPrimitive } from './map-renderer';

const TARGET: GeoMultiPolygon = [
  [
    [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 10),
    ],
  ],
];

function kinds(prims: readonly DrawPrimitive[]): string[] {
  return prims.map((p) => p.kind);
}

describe('buildKnifePrimitives — overlay + target emphasis (受け入れ基準1 / FR-90)', () => {
  it('an inactive state draws nothing (教訓 5.18 valid empty frame)', () => {
    const prims = buildKnifePrimitives({
      state: { phase: KNIFE_PHASE.Inactive },
      targetShape: undefined,
      zoom: 10,
    });
    expect(prims).toEqual([]);
  });

  it('selecting-target draws the map-wide overlay but no target/circle yet', () => {
    const prims = buildKnifePrimitives({
      state: startKnife(),
      targetShape: undefined,
      zoom: 10,
    });
    expect(kinds(prims)).toEqual(['polygon']);
    const overlay = prims[0] as Extract<DrawPrimitive, { kind: 'polygon' }>;
    // The overlay spans the whole world and is translucent (alpha < 1).
    expect(overlay.ring).toHaveLength(4);
    expect(overlay.fill).toBe(DEFAULT_KNIFE_STYLE.overlayFill);
    expect(overlay.fill).toMatch(/rgba\(.+0\.\d+\)/);
  });

  it('once a target is selected its resolved shape is emphasized over the overlay', () => {
    const state = selectTarget(startKnife(), asFeatureId('leaf'));
    const prims = buildKnifePrimitives({ state, targetShape: TARGET, zoom: 10 });
    // overlay polygon, then the target shape emphasis (FR-90 / FR-21 even-odd shape).
    expect(kinds(prims)).toContain('polygon');
    expect(kinds(prims)).toContain('shape');
    const shape = prims.find((p) => p.kind === 'shape') as Extract<
      DrawPrimitive,
      { kind: 'shape' }
    >;
    expect(shape.fill).toBe(DEFAULT_KNIFE_STYLE.targetFill);
    expect(shape.stroke).toBe(DEFAULT_KNIFE_STYLE.targetStroke);
    expect(shape.strokeWidthPx).toBe(DEFAULT_KNIFE_STYLE.targetStrokeWidthPx);
  });
});

describe('buildKnifePrimitives — cut line + fixed circle (受け入れ基準3 / FR-92 / FR-17)', () => {
  function drawingWith(...pts: readonly [number, number][]): KnifeState {
    let state = selectTarget(startKnife(), asFeatureId('leaf'));
    for (const [lon, lat] of pts) {
      state = placeCutPoint(state, createCoordinate(lon, lat));
    }
    return state;
  }

  it('shows the fixed circle once at least one cut point is placed', () => {
    const prims = buildKnifePrimitives({
      state: drawingWith([3, 3]),
      targetShape: TARGET,
      zoom: 10,
    });
    // The circle is a closed polyline; a single point also draws its marker.
    const lines = prims.filter((p) => p.kind === 'line') as LinePrimitive[];
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const markers = prims.filter((p) => p.kind === 'point') as PointPrimitive[];
    expect(markers).toHaveLength(1);
  });

  it('the fixed circle ON-SCREEN radius is constant across zoom (ズーム非依存; FR-17)', () => {
    const state = drawingWith([5, 5]);
    const circleRadiusPx = DEFAULT_KNIFE_STYLE.circleRadiusPx;
    const center = createCoordinate(5, 5);

    const radiusOnScreen = (zoom: number): number => {
      const prims = buildKnifePrimitives({ state, targetShape: TARGET, zoom });
      // The circle is the closed polyline whose first point lies on +x of center.
      const circle = prims.find(
        (p): p is LinePrimitive =>
          p.kind === 'line' && p.points.length > 8,
      );
      expect(circle).toBeDefined();
      const pt0 = circle!.points[0]!;
      // World radius = pt0.lon - center.lon; on-screen radius = worldRadius * zoom.
      const worldRadius = pt0.lon - center.lon;
      return worldRadius * zoom;
    };

    const r1 = radiusOnScreen(2);
    const r2 = radiusOnScreen(20);
    const r3 = radiusOnScreen(50);
    // All three on-screen radii equal the configured screen px (within float error).
    for (const r of [r1, r2, r3]) {
      expect(Math.abs(r - circleRadiusPx)).toBeLessThan(1e-6);
    }
  });

  it('a CLOSED cut line draws its closing edge back to the first point', () => {
    let state = selectTarget(startKnife(), asFeatureId('leaf'));
    // Replace with a closed line of 4 points (simulating閉線確定 render input).
    state = {
      phase: KNIFE_PHASE.DrawingCut,
      targetId: asFeatureId('leaf'),
      line: createClosedKnifeLine([
        createCoordinate(2, 2),
        createCoordinate(6, 2),
        createCoordinate(6, 6),
        createCoordinate(2, 6),
      ]),
    };
    const prims = buildKnifePrimitives({ state, targetShape: TARGET, zoom: 10 });
    const lines = prims.filter((p) => p.kind === 'line') as LinePrimitive[];
    // The closing edge is a 2-point line from last (2,6) back to first (2,2).
    const closing = lines.find(
      (l) =>
        l.points.length === 2 &&
        l.points[0]!.lon === 2 &&
        l.points[0]!.lat === 6 &&
        l.points[1]!.lon === 2 &&
        l.points[1]!.lat === 2,
    );
    expect(closing).toBeDefined();
    expect(closing!.stroke).toBe(DEFAULT_KNIFE_STYLE.closingStroke);
  });
});
