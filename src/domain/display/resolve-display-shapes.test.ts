// U34 ↔ U08 ↔ U19 two-sided contract test (受け入れ基準5, 教訓5.29 / 5.1 / 5.33).
//
// 受け入れ基準5 demands the aggregate shape U34 decides to draw NOT drift from the
// shape U19 actually fills / hit-tests / labels. The single guarantee that fixes
// this is: the geometry behind an Aggregate decision is U08's `resolveFeatureArea`
// of the SAME `rollUpTargetId` U34 selected. These tests pin both sides of that
// seam:
//   - U34 side: `buildDisplayDecisions` chose `rollUpTargetId`.
//   - U08 side: `resolveFeatureArea(forest, store, rollUpTargetId)` is the ONLY
//     geometry source — `resolveDisplayShapes`' output is byte-for-byte that
//     resolution (no re-derivation, no separate selection, 教訓5.29).
// and the 飛び地 (multi-piece) invariant: a disjoint aggregate keeps every piece
// (教訓5.1 片落とし禁止), proving U34's roll-up never collapses the union.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type Feature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { buildForest, type Forest } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';

import {
  DISPLAY_VERDICT,
  buildDisplayDecisions,
} from './depth-focus';
import {
  geometrySourceFor,
  resolveDisplayShapes,
} from './resolve-display-shapes';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);
const fid = (s: string): FeatureId => asFeatureId(s);

// --- a forest whose aggregate union is DISJOINT (飛び地: two separate squares) -
//
// root(0) -> { sqA(1, leaf @ [0..1]²), sqB(1, leaf @ [10..11]²) }
// root's 集約形状 = union(sqA, sqB) = TWO disjoint polygon pieces (教訓5.1).

const VERTICES = [
  // square A: (0,0)-(1,0)-(1,1)-(0,1)
  createVertex(asVertexId('a0'), createCoordinate(0, 0)),
  createVertex(asVertexId('a1'), createCoordinate(1, 0)),
  createVertex(asVertexId('a2'), createCoordinate(1, 1)),
  createVertex(asVertexId('a3'), createCoordinate(0, 1)),
  // square B (far away, disjoint): (10,10)-(11,10)-(11,11)-(10,11)
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

// =============================================================================
// 1. The geometry source is EXACTLY U08's resolveFeatureArea of the U34 target
// =============================================================================
describe('resolveDisplayShapes — U34 roll-up target == U08 resolution source (教訓5.29)', () => {
  it('Aggregate geometry is resolveFeatureArea(rollUpTargetId), not re-derived', () => {
    const forest = disjointForest();
    const vs = store();

    // U34 side: N=0 rounds the whole forest to the root aggregate.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const rootDecision = decisions.get(fid('root'));
    expect(rootDecision?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
    expect(rootDecision?.rollUpTargetId).toBe(fid('root'));

    // Adapter side: resolve the drawable decisions through U08.
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const rootShape = resolved.shapes.find((s) => s.featureId === fid('root'));
    expect(rootShape).toBeDefined();
    expect(rootShape?.geometrySourceId).toBe(fid('root')); // == U34's roll-up target.

    // U08 side (the SAME resolution U19 would run): identical geometry, verbatim.
    const direct = resolveFeatureArea(forest, vs, fid('root'));
    expect(direct.status).toBe('ok');
    if (direct.status !== 'ok') return;
    expect(rootShape?.shape).toEqual(direct.area);
    // No other feature draws at N=0 (sqA / sqB are absorbed → 受け入れ基準1).
    expect(resolved.shapes.map((s) => s.featureId)).toEqual([fid('root')]);
  });

  it('geometrySourceFor returns the roll-up target for Aggregate, self for Real', () => {
    const forest = disjointForest();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });
    // root expands (Real, self source); sqA/sqB are terminal leaves (Real, self).
    expect(geometrySourceFor(decisions.get(fid('root'))!)).toBe(fid('root'));
    expect(geometrySourceFor(decisions.get(fid('sqA'))!)).toBe(fid('sqA'));
  });
});

// =============================================================================
// 2. 飛び地 (multi-piece) preservation through the roll-up (教訓5.1 片落とし禁止)
// =============================================================================
describe('resolveDisplayShapes — disjoint aggregate keeps every piece (教訓5.1)', () => {
  it('rounded root carries BOTH disjoint squares (pieces.length === 2)', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });

    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const rootShape = resolved.shapes.find((s) => s.featureId === fid('root'));
    expect(rootShape).toBeDefined();

    // The union of two far-apart squares is TWO pieces; neither is dropped.
    expect(rootShape!.shape.length).toBe(2);

    // And this is precisely what a direct U08 resolution yields (single source).
    const direct = resolveFeatureArea(forest, vs, fid('root'));
    if (direct.status !== 'ok') throw new Error('expected ok');
    expect(direct.area.length).toBe(2);
    expect(rootShape!.shape).toEqual(direct.area);
  });
});

// =============================================================================
// 3. Real leaves resolve their OWN area through the same single source
// =============================================================================
describe('resolveDisplayShapes — Real decisions use the same single source', () => {
  it('a drawable leaf carries resolveFeatureArea(self), one piece each', () => {
    const forest = disjointForest();
    const vs = store();
    // N=1: root expands; sqA, sqB draw their own shapes.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);

    const a = resolved.shapes.find((s) => s.featureId === fid('sqA'));
    expect(a?.verdict).toBe(DISPLAY_VERDICT.Real);
    expect(a?.geometrySourceId).toBe(fid('sqA'));
    const directA = resolveFeatureArea(forest, vs, fid('sqA'));
    if (directA.status !== 'ok') throw new Error('expected ok');
    expect(a?.shape).toEqual(directA.area);
    expect(a?.shape.length).toBe(1);
  });
});

// =============================================================================
// 4. Omitted decisions never appear; failures surface as data (教訓5.18 / 5.26)
// =============================================================================
describe('resolveDisplayShapes — omission & failure handling', () => {
  it('Omitted decisions produce no drawable (受け入れ基準1)', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    // sqA / sqB are Omitted at N=0 → absent from shapes and failures.
    const ids = resolved.shapes.map((s) => s.featureId);
    expect(ids).not.toContain(fid('sqA'));
    expect(ids).not.toContain(fid('sqB'));
    expect(resolved.failures).toEqual([]);
  });

  it('a missing vertex surfaces as a failure, not a throw, and is omitted from shapes', () => {
    const forest = disjointForest();
    const emptyStore = createVertexStore([]); // no vertices → MissingVertex.
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });
    const resolved = resolveDisplayShapes(forest, emptyStore, decisions);
    expect(resolved.shapes).toEqual([]);
    expect(resolved.failures.length).toBeGreaterThan(0);
    for (const f of resolved.failures) {
      expect(f.reason.kind).toBe('missing-vertex');
    }
  });
});

// =============================================================================
// 6. Seam-crossing AREA leaves ARE longitude-unwrapped (parity with the LINE path)
//    Regression: a leaf ring stored with FOLDED representatives across ±180 (e.g.
//    lon 179 next to lon -179) must come out of the display pipeline as a
//    CONTINUOUS run (span ~2°), NOT the false ~358° "long way round" span that
//    made the renderer / hit-test tile wrap replicas across the whole map.
//    (HB-14 / FR-07 / 技術方針 R3 単一真実源; mirrors committed-features.ts line unwrap.)
// =============================================================================
describe('resolveDisplayShapes — seam-crossing area is unwrapped (HB-14 parity)', () => {
  // A 2°-wide square straddling the antimeridian, stored FOLDED: the east edge at
  // lon 179, the west edge at lon -179 (the representative fold of 181). Raw, this
  // ring's lon span is 179 − (−179) = 358°; unwrapped it is a 2° continuous run.
  const SEAM_VERTICES = [
    createVertex(asVertexId('s0'), createCoordinate(179, 0)),
    createVertex(asVertexId('s1'), createCoordinate(-179, 0)), // == 181 folded
    createVertex(asVertexId('s2'), createCoordinate(-179, 1)),
    createVertex(asVertexId('s3'), createCoordinate(179, 1)),
  ];

  function seamForest(): Forest {
    // A single TOP-LEVEL leaf (no parent → drawn Real at N=0).
    const ring = createTerritoryRing(
      asRingId('r-seam'),
      ['s0', 's1', 's2', 's3'].map(asVertexId),
    );
    return buildForest([
      createLeafFeature(fid('seam'), attrs('seam'), COLOR, createShape([ring])),
    ]);
  }

  function seamStore(): VertexStore {
    return createVertexStore(SEAM_VERTICES);
  }

  function lonSpan(shape: { lon: number }[][][]): number {
    let min = Infinity;
    let max = -Infinity;
    for (const poly of shape)
      for (const ring of poly)
        for (const c of ring) {
          if (c.lon < min) min = c.lon;
          if (c.lon > max) max = c.lon;
        }
    return max - min;
  }

  it('the drawn shape spans ~2° (continuous), NOT the false ~358° long-way span', () => {
    const forest = seamForest();
    const vs = seamStore();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const seam = resolved.shapes.find((s) => s.featureId === fid('seam'));
    expect(seam).toBeDefined();

    const span = lonSpan(seam!.shape as unknown as { lon: number }[][][]);
    // Unwrapped: the short way (~2°). The pre-fix bug produced ~358°.
    expect(span).toBeCloseTo(2, 6);
    expect(span).toBeLessThan(180);

    // The raw U08 resolution (no unwrap) DOES show the false ~358° span — proving
    // the pipeline's unwrap is what closes the gap (not the resolver itself).
    const raw = resolveFeatureArea(forest, vs, fid('seam'));
    if (raw.status !== 'ok') throw new Error('expected ok');
    expect(lonSpan(raw.area as unknown as { lon: number }[][][])).toBeCloseTo(358, 6);
  });

  it('every adjacent in-ring longitude gap is ≤ 180° after unwrap (continuity)', () => {
    const forest = seamForest();
    const vs = seamStore();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const seam = resolved.shapes.find((s) => s.featureId === fid('seam'))!;
    for (const poly of seam.shape)
      for (const ring of poly)
        for (let i = 1; i < ring.length; i += 1) {
          const gap = Math.abs(ring[i]!.lon - ring[i - 1]!.lon);
          expect(gap).toBeLessThanOrEqual(180);
        }
  });

  it('a NON-seam leaf is unchanged (unwrap is a no-op away from the seam)', () => {
    // 受け入れ基準: the disjoint forest (squares at [0..1]² and [10..11]²) has no
    // ring gap ≥ 180°, so unwrapping must leave its geometry byte-for-byte.
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const resolved = resolveDisplayShapes(forest, vs, decisions);
    const root = resolved.shapes.find((s) => s.featureId === fid('root'))!;
    const direct = resolveFeatureArea(forest, vs, fid('root'));
    if (direct.status !== 'ok') throw new Error('expected ok');
    expect(root.shape).toEqual(direct.area);
  });
});

// =============================================================================
// 5. Purity (受け入れ基準6)
// =============================================================================
describe('resolveDisplayShapes — purity', () => {
  it('same input → equal output; inputs untouched', () => {
    const forest = disjointForest();
    const vs = store();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const first = resolveDisplayShapes(forest, vs, decisions);
    const second = resolveDisplayShapes(forest, vs, decisions);
    expect(first).toEqual(second);
    // The decision map is not mutated.
    expect(decisions.get(fid('root'))?.verdict).toBe(DISPLAY_VERDICT.Aggregate);
  });
});
