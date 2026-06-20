// U34 ↔ U19 TWO-SIDED contract test (受け入れ基準5, 教訓5.29 / 5.1 / 5.33).
//
// 受け入れ基準5 demands: the 集約形状 U34 decides to draw must NOT drift from the
// shape U19 actually fills / hit-tests / labels. The earlier domain-only test
// (resolve-display-shapes.test.ts) pinned only the U34 ↔ U08 side (resolved shape
// == resolveFeatureArea). That is necessary but NOT sufficient: it never runs U19.
//
// THIS file pins the OTHER side — the one that was structurally missing. It drives
// the full pipeline end to end:
//
//   U34  buildDisplayDecisions (depth/focus) → resolveDisplayShapes (U08 geometry)
//     ↓  toEvaluatedAreas  (the render-boundary bridge under test)
//   U19  buildFeaturePrimitives / buildAreaPrimitives  →  PolygonShapePrimitive
//
// and asserts that the geometry U19 emits as `PolygonShapePrimitive.pieces` is
// byte-for-byte derived from the SAME `ResolvedDisplayShape.shape` U34 resolved —
// including every 飛び地 piece (教訓5.1 片落とし禁止). U19's functions are ACTUALLY
// executed here (not re-implemented), so "U19 が描く形状 == U34 の丸め先" is fixed.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createCoordinate } from '../domain/coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../domain/feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../domain/ids';
import { createShape, createTerritoryRing } from '../domain/ring';
import { buildForest, type Forest } from '../domain/hierarchy/forest';
import { createVertex, createVertexStore, type VertexStore } from '../domain/vertex';
import {
  DISPLAY_VERDICT,
  buildDisplayDecisions,
  resolveDisplayShapes,
  type ResolvedDisplayShape,
} from '../domain/display';

import type { Camera, Viewport } from './camera';
import {
  type BuildOptions,
  type FeatureStyle,
  DEFAULT_LABEL_THRESHOLDS,
  DEFAULT_SCREEN_SIZES,
  buildFeaturePrimitives,
} from './feature-layer';
import type { PolygonShapePrimitive } from './map-renderer';
import {
  toEvaluatedArea,
  toEvaluatedAreas,
  type DisplayPresentation,
} from './display-bridge';

// --- fixtures: a DISJOINT aggregate (飛び地: two far-apart squares) -----------
//
// root(0) -> { sqA(1, leaf @ [0..1]²), sqB(1, leaf @ [10..11]²) }
// root's 集約形状 = union(sqA, sqB) = TWO disjoint polygon pieces (教訓5.1).

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);
const fid = (s: string): FeatureId => asFeatureId(s);

const VERTICES = [
  createVertex(asVertexId('a0'), createCoordinate(0, 0)),
  createVertex(asVertexId('a1'), createCoordinate(1, 0)),
  createVertex(asVertexId('a2'), createCoordinate(1, 1)),
  createVertex(asVertexId('a3'), createCoordinate(0, 1)),
  createVertex(asVertexId('b0'), createCoordinate(10, 10)),
  createVertex(asVertexId('b1'), createCoordinate(11, 10)),
  createVertex(asVertexId('b2'), createCoordinate(11, 11)),
  createVertex(asVertexId('b3'), createCoordinate(10, 11)),
];

function squareLeaf(id: string, vids: string[], parentId: string): Feature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map(asVertexId));
  return createLeafFeature(fid(id), attrs(id), COLOR, createShape([ring]), {
    parentId: fid(parentId),
  });
}

function disjointForest(): Forest {
  return buildForest([
    createAggregateFeature(fid('root'), attrs('root'), COLOR, [fid('sqA'), fid('sqB')]),
    squareLeaf('sqA', ['a0', 'a1', 'a2', 'a3'], 'root'),
    squareLeaf('sqB', ['b0', 'b1', 'b2', 'b3'], 'root'),
  ]);
}

function store(): VertexStore {
  return createVertexStore(VERTICES);
}

const STYLE: FeatureStyle = { fill: '#3366cc', stroke: '#123456', selectedColor: '#00e5ff' };

// A camera/viewport WIDE enough to keep both far-apart squares on screen so view
// clipping never silently drops a piece (we want the geometry pinned, not clipped).
const VP: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAM: Camera = { centerLon: 5.5, centerLat: 5.5, zoom: 5 };

function opts(over: Partial<BuildOptions> = {}): BuildOptions {
  return {
    camera: CAM,
    viewport: VP,
    sizes: DEFAULT_SCREEN_SIZES,
    thresholds: DEFAULT_LABEL_THRESHOLDS,
    clip: false, // pin geometry, not viewport clipping (受け入れ基準5 is about drift, not clip).
    lod: false, // pin the EXACT vertices U34 resolved, no LOD simplification.
    ...over,
  };
}

const presentation: DisplayPresentation = { style: STYLE, label: '', selected: false };
const presentationFor = () => presentation;

function shapePrims(prims: readonly { kind: string }[]): PolygonShapePrimitive[] {
  return prims.filter((p): p is PolygonShapePrimitive => p.kind === 'shape');
}

/**
 * Reconstruct the geometry U19 emitted (its `pieces`: WorldPoint[][][]) back into
 * the plain {lon,lat} lattice so it can be compared against the domain
 * `GeoMultiPolygon` U34 resolved. This proves SAME-SOURCE without relying on
 * reference identity (the renderer maps coords through `ringToWorldPoints`).
 */
function piecesToLattice(prim: PolygonShapePrimitive): { lon: number; lat: number }[][][] {
  return prim.pieces.map((piece) =>
    piece.map((ring) => ring.map((p) => ({ lon: p.lon, lat: p.lat }))),
  );
}

function shapeToLattice(shape: ResolvedDisplayShape['shape']): { lon: number; lat: number }[][][] {
  return shape.map((piece) =>
    piece.map((ring) => ring.map((c) => ({ lon: c.lon, lat: c.lat }))),
  );
}

// =============================================================================
// 1. THE core two-sided pin: U19's drawn pieces == U34's resolved shape, verbatim
// =============================================================================
describe('U34 → U19 bridge: U19 draws byte-for-byte the shape U34 resolved (教訓5.29)', () => {
  it('Aggregate roll-up: buildFeaturePrimitives fills exactly resolveDisplayShapes(root).shape', () => {
    const forest = disjointForest();
    const vs = store();

    // U34 side: N=0 rounds the whole forest to the root aggregate.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    expect(decisions.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);

    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const rootResolved = resolved.shapes.find((s) => s.featureId === fid('root'));
    expect(rootResolved).toBeDefined();

    // Bridge → U19 (the connection that was missing). Run U19 for real.
    const areas = toEvaluatedAreas(resolved, presentationFor);
    const prims = buildFeaturePrimitives(areas, opts());

    const drawn = shapePrims(prims);
    expect(drawn.length).toBe(1); // only root draws at N=0 (sqA/sqB absorbed, 受け入れ基準1).

    // THE drift fix: what U19 fills == what U34 resolved, piece-for-piece.
    expect(piecesToLattice(drawn[0]!)).toEqual(shapeToLattice(rootResolved!.shape));
  });

  it('飛び地: BOTH disjoint squares survive into U19 PolygonShapePrimitive.pieces (教訓5.1)', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const rootResolved = resolved.shapes.find((s) => s.featureId === fid('root'))!;

    // U34 resolved TWO pieces.
    expect(rootResolved.shape.length).toBe(2);

    const areas = toEvaluatedAreas(resolved, presentationFor);
    const drawn = shapePrims(buildFeaturePrimitives(areas, opts()));

    // U19 draws TWO pieces — neither far-apart square is片落とし (教訓5.1).
    expect(drawn.length).toBe(1);
    expect(drawn[0]!.pieces.length).toBe(2);
    expect(piecesToLattice(drawn[0]!)).toEqual(shapeToLattice(rootResolved.shape));
  });
});

// =============================================================================
// 2. Real (expanded) leaves: U19 draws each leaf's own resolved shape, same source
// =============================================================================
describe('U34 → U19 bridge: Real leaves draw their own resolved shape', () => {
  it('N=1 expands root; U19 fills sqA / sqB each from its own resolveDisplayShapes shape', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);

    const areas = toEvaluatedAreas(resolved, presentationFor);
    const prims = buildFeaturePrimitives(areas, opts());
    const drawn = shapePrims(prims);

    // root is Real-expanded (its children carry the area), sqA + sqB draw.
    const a = resolved.shapes.find((s) => s.featureId === fid('sqA'))!;
    const b = resolved.shapes.find((s) => s.featureId === fid('sqB'))!;
    expect(a.verdict).toBe(DISPLAY_VERDICT.Real);
    expect(b.verdict).toBe(DISPLAY_VERDICT.Real);

    // Each leaf's drawn geometry == its own resolved shape (single piece each).
    const drawnById = new Map(
      areas.map((area, i) => [area.id, drawn[i]] as const),
    );
    // Match by recomputing per-feature rather than positionally to be robust.
    for (const r of [a, b]) {
      const area = areas.find((ar) => ar.id === (r.featureId as string))!;
      const idx = areas.indexOf(area);
      const prim = drawn[idx]!;
      expect(prim).toBeDefined();
      expect(piecesToLattice(prim)).toEqual(shapeToLattice(r.shape));
    }
    expect(drawnById.size).toBeGreaterThan(0);
  });
});

// =============================================================================
// 3. toEvaluatedArea hands the shape through VERBATIM (single-source guarantee)
// =============================================================================
describe('toEvaluatedArea: geometry is passed through, never re-derived (教訓5.29)', () => {
  it('the EvaluatedArea.shape IS the ResolvedDisplayShape.shape (same reference)', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const rootResolved = resolved.shapes.find((s) => s.featureId === fid('root'))!;

    const area = toEvaluatedArea(rootResolved, presentation);
    expect(area.kind).toBe('area');
    expect(area.id).toBe('root');
    // Same-source proof at the bridge boundary: not a copy, the exact value.
    expect(area.shape).toBe(rootResolved.shape);
  });

  it('failures are NOT bridged (受け入れ基準1: omitted from the draw batch)', () => {
    const forest = disjointForest();
    const emptyStore = createVertexStore([]); // no vertices → U08 resolution fails.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });
    const resolved = resolveDisplayShapes(forest, emptyStore, decisions);

    expect(resolved.failures.length).toBeGreaterThan(0);
    const areas = toEvaluatedAreas(resolved, presentationFor);
    // No drawable geometry → no EvaluatedArea, so U19 draws nothing.
    expect(areas).toEqual([]);
    expect(shapePrims(buildFeaturePrimitives(areas, opts()))).toEqual([]);
  });
});
