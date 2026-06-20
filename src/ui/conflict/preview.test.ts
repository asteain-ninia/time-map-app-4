// U35 — pure minimap-preview build tests (受け入れ基準 3, 教訓 5.41).
//
// Node-environment, no Canvas: the preview is validated as a DRAW-COMMAND列 from
// U19's `buildFeaturePrimitives` (穴透過・飛び地は U19 規則のまま, no minimap-only
// fill) plus the fitted camera. We assert the role colours, that holes/enclaves
// survive as pieces (片落としなし, 教訓 5.1), and the camera fit centres on the
// conflict neighbourhood.

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';
import { createCoordinate } from '../../domain/coordinate';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import { timePointYear } from '../../domain/time/time-point';
import type { Conflict } from '../../domain/consistency/index';
import type { Viewport } from '../../render/camera';
import type { PolygonShapePrimitive } from '../../render/map-renderer';

import {
  PREVIEW_COLORS,
  buildConflictPreview,
  conflictBounds,
  fitCameraToRect,
  remainingArea,
  type ConflictShapes,
} from './preview';

const FA = asFeatureId('a');
const FB = asFeatureId('b');

const VIEWPORT: Viewport = { widthCss: 200, heightCss: 200, devicePixelRatio: 1 };

// A square with a hole (piece = [outer, hole]) to prove穴 survives.
const SQUARE_WITH_HOLE: GeoMultiPolygon = [
  [
    [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 10),
    ],
    [
      createCoordinate(3, 3),
      createCoordinate(7, 3),
      createCoordinate(7, 7),
      createCoordinate(3, 7),
    ],
  ],
];

const SQUARE_B: GeoMultiPolygon = [
  [
    [
      createCoordinate(5, 0),
      createCoordinate(15, 0),
      createCoordinate(15, 10),
      createCoordinate(5, 10),
    ],
  ],
];

const OVERLAP: GeoMultiPolygon = [
  [
    [
      createCoordinate(5, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(5, 10),
    ],
  ],
];

const SHAPES: ConflictShapes = {
  aFeatureId: FA,
  aShape: SQUARE_WITH_HOLE,
  bFeatureId: FB,
  bShape: SQUARE_B,
};

const CONFLICT: Conflict = {
  id: 'c1',
  kind: 'terminal-overlap',
  time: { kind: 'point', at: timePointYear(800) },
  a: { featureId: FA, displayName: 'A' },
  b: { featureId: FB, displayName: 'B' },
  overlap: OVERLAP,
};

function shapePrims(prims: readonly unknown[]): PolygonShapePrimitive[] {
  return prims.filter((p): p is PolygonShapePrimitive => (p as { kind: string }).kind === 'shape');
}

describe('fitCameraToRect', () => {
  it('centres on the rect and never overflows either axis', () => {
    const cam = fitCameraToRect(
      { minLon: 0, minLat: 0, maxLon: 10, maxLat: 20 },
      VIEWPORT,
    );
    expect(cam.centerLon).toBe(5);
    expect(cam.centerLat).toBe(10);
    // The tighter axis (lat span 20 vs lon 10) constrains zoom with padding.
    expect(cam.zoom).toBeCloseTo(200 / (20 * 1.3), 5);
  });

  it('degenerate rect uses a 1° window (no Infinity)', () => {
    const cam = fitCameraToRect(
      { minLon: 4, minLat: 4, maxLon: 4, maxLat: 4 },
      VIEWPORT,
    );
    expect(Number.isFinite(cam.zoom)).toBe(true);
    expect(cam.zoom).toBeGreaterThan(0);
  });
});

describe('conflictBounds', () => {
  it('unions the two shapes and the overlap', () => {
    const r = conflictBounds(SHAPES, OVERLAP);
    expect(r).toEqual({ minLon: 0, minLat: 0, maxLon: 15, maxLat: 10 });
  });
  it('empty inputs fall back to a finite window', () => {
    const r = conflictBounds({ aFeatureId: FA, aShape: [], bFeatureId: FB, bShape: [] }, []);
    expect(Number.isFinite(r.minLon)).toBe(true);
  });
});

describe('remainingArea (差分の見える化, 教訓 5.1)', () => {
  it('subtracts the priority shape from the adjusted one', () => {
    const remaining = remainingArea(SQUARE_B, SQUARE_WITH_HOLE);
    // B minus A leaves the lon 10..15 strip (non-empty).
    expect(remaining.length).toBeGreaterThan(0);
  });
});

describe('buildConflictPreview (受け入れ基準 3)', () => {
  it('before a choice: both features neutral + overlap highlighted, holes kept', () => {
    const preview = buildConflictPreview(CONFLICT, SHAPES, {
      viewport: VIEWPORT,
      priorityFeatureId: undefined,
    });
    const shapes = shapePrims(preview.primitives);
    const fills = shapes.map((s) => s.fill);
    expect(fills).toContain(PREVIEW_COLORS.neutral);
    expect(fills).toContain(PREVIEW_COLORS.overlap);
    // The holed feature keeps its piece with TWO rings (outer + hole) — no
    // minimap-only fill collapses the hole (FR-21 / 教訓 5.29).
    const holed = shapes.find((s) => s.pieces.some((piece) => piece.length === 2));
    expect(holed).toBeDefined();
  });

  it('after a choice: priority whole + remaining + overlap, by role colour', () => {
    const preview = buildConflictPreview(CONFLICT, SHAPES, {
      viewport: VIEWPORT,
      priorityFeatureId: FA,
    });
    const fills = shapePrims(preview.primitives).map((s) => s.fill);
    expect(fills).toContain(PREVIEW_COLORS.priority);
    expect(fills).toContain(PREVIEW_COLORS.remaining);
    expect(fills).toContain(PREVIEW_COLORS.overlap);
    expect(fills).not.toContain(PREVIEW_COLORS.neutral);
  });

  it('same inputs ⇒ same primitives (pure, 教訓 5.41)', () => {
    const a = buildConflictPreview(CONFLICT, SHAPES, {
      viewport: VIEWPORT,
      priorityFeatureId: FB,
    });
    const b = buildConflictPreview(CONFLICT, SHAPES, {
      viewport: VIEWPORT,
      priorityFeatureId: FB,
    });
    expect(a.primitives).toEqual(b.primitives);
    expect(a.camera).toEqual(b.camera);
  });
});
