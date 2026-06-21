// Regression (bughunt3): resolveDisplayShapes re-derived EVERY drawable aggregate's
// 集約形状 — a full bottom-up boolean UNION from the leaves — on EVERY display-pipeline
// run, including a slider tick that changes only the display control while the forest
// and vertices stay byte-identical. The shared (root, time, control) memo misses on a
// control change, so the entire union tree was rebuilt from scratch each tick.
//
// THE FIX adds an optional incremental geometry cache to resolveDisplayShapes, keyed by
// geometrySourceId and validated by reference identity of the source's whole subtree
// (feature objects) and every referenced vertex object. A control-only re-run reuses the
// prior run's resolved geometry and skips the boolean union entirely; a real geometry /
// structure edit (a new feature/vertex object) is an identity miss and re-resolves.
//
// These tests pin BOTH halves of the contract:
//   1. CORRECTNESS — a cached run yields byte-for-byte the un-cached output, across a
//      slider change AND after a vertex edit (no stale geometry, no behaviour change).
//   2. INCREMENTALITY — on a control-only re-run the boolean-union library is NOT called
//      again (the union work the finding flagged is genuinely skipped), while a vertex
//      edit DOES trigger a re-union of exactly the affected subtree.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

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
import { createVertex, createVertexStore, type Vertex } from '../vertex';
import * as booleanOps from '../geometry/boolean-ops';

import { buildDisplayDecisions } from './depth-focus';
import { createDisplayShapeCache, resolveDisplayShapes } from './resolve-display-shapes';

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');
const attrs = (name: string) => createBasicAttributes(name, 0, 1);
const fid = (s: string): FeatureId => asFeatureId(s);

// root(0) -> { sqA(1, leaf @ [0..1]²), sqB(1, leaf @ [10..11]²) }
// The root's 集約形状 is union(sqA, sqB) — TWO disjoint pieces. At N=0 only the root
// draws (Aggregate), so resolving it forces the boolean union over both leaves.
function buildVertices(): Vertex[] {
  return [
    createVertex(asVertexId('a0'), createCoordinate(0, 0)),
    createVertex(asVertexId('a1'), createCoordinate(1, 0)),
    createVertex(asVertexId('a2'), createCoordinate(1, 1)),
    createVertex(asVertexId('a3'), createCoordinate(0, 1)),
    createVertex(asVertexId('b0'), createCoordinate(10, 10)),
    createVertex(asVertexId('b1'), createCoordinate(11, 10)),
    createVertex(asVertexId('b2'), createCoordinate(11, 11)),
    createVertex(asVertexId('b3'), createCoordinate(10, 11)),
  ];
}

function squareLeaf(id: string, vids: string[], parentId: string): Feature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map(asVertexId));
  return createLeafFeature(fid(id), attrs(id), COLOR, createShape([ring]), {
    parentId: fid(parentId),
  });
}

function forestOf(): Forest {
  return buildForest([
    createAggregateFeature(fid('root'), attrs('root'), COLOR, [fid('sqA'), fid('sqB')]),
    squareLeaf('sqA', ['a0', 'a1', 'a2', 'a3'], 'root'),
    squareLeaf('sqB', ['b0', 'b1', 'b2', 'b3'], 'root'),
  ]);
}

// Spy on the boolean-union library through the module namespace. resolve-shape.ts
// imports `union` as a live ESM binding, so a namespace spy intercepts its calls —
// letting us count exactly when the expensive union work runs vs. is skipped.
function spyOnUnion() {
  return vi.spyOn(booleanOps, 'union');
}

describe('resolveDisplayShapes incremental geometry cache (bughunt3)', () => {
  let unionSpy: ReturnType<typeof spyOnUnion>;

  beforeEach(() => {
    unionSpy = spyOnUnion();
  });
  afterEach(() => {
    unionSpy.mockRestore();
  });

  it('a control-only re-run skips the boolean union yet returns byte-for-byte the same shapes', () => {
    const forest = forestOf();
    const store = createVertexStore(buildVertices());
    const cache = createDisplayShapeCache();

    // First run at N=0 → root drawn as Aggregate → forces union(sqA, sqB).
    const decisionsN0 = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const first = resolveDisplayShapes(forest, store, decisionsN0, cache);
    expect(first.shapes.map((s) => s.featureId)).toEqual([fid('root')]);
    expect(first.shapes[0]!.shape.length).toBe(2); // two disjoint pieces preserved.
    const unionCallsAfterFirst = unionSpy.mock.calls.length;
    expect(unionCallsAfterFirst).toBeGreaterThan(0); // the root union actually ran.

    // A SLIDER TICK that lands back on a decision rolling up to the SAME root geometry
    // (a fresh decision map — what the pipeline rebuilds each tick — but forest + store
    // are reference-identical). The cached root geometry must be reused: ZERO new unions.
    unionSpy.mockClear();
    const decisionsAgain = buildDisplayDecisions({ forest, globalThreshold: 0 });
    const second = resolveDisplayShapes(forest, store, decisionsAgain, cache);
    expect(unionSpy.mock.calls.length).toBe(0); // <-- the union work the finding flagged is skipped.

    // CORRECTNESS: identical to the un-cached resolution (no stale geometry).
    const uncached = resolveDisplayShapes(forest, store, decisionsAgain);
    expect(second).toEqual(uncached);
    // And the reused shape is the very same object the first run produced.
    expect(second.shapes[0]!.shape).toBe(first.shapes[0]!.shape);
  });

  it('a moved vertex (new vertex object) invalidates the entry and re-unions, with correct geometry', () => {
    const forest = forestOf();
    const store1 = createVertexStore(buildVertices());
    const cache = createDisplayShapeCache();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 0 });

    resolveDisplayShapes(forest, store1, decisions, cache); // prime the cache.

    // Edit a vertex of sqA (a NEW vertex object via a new store) — the rest unchanged.
    // Structural sharing in the real app produces exactly this: one new vertex object.
    const moved = buildVertices().map((v) =>
      (v.id as string) === 'a2'
        ? createVertex(asVertexId('a2'), createCoordinate(2, 2))
        : v,
    );
    const store2 = createVertexStore(moved);

    unionSpy.mockClear();
    const after = resolveDisplayShapes(forest, store2, decisions, cache);
    // The root's subtree references the moved vertex → entry invalidated → re-union.
    expect(unionSpy.mock.calls.length).toBeGreaterThan(0);

    // CORRECTNESS: equals the un-cached resolution against the NEW store (not stale).
    const uncached = resolveDisplayShapes(forest, store2, decisions);
    expect(after).toEqual(uncached);
    // The geometry genuinely changed from the pre-edit shape (proves no stale reuse).
    const before = resolveDisplayShapes(forest, store1, decisions);
    expect(after.shapes[0]!.shape).not.toEqual(before.shapes[0]!.shape);
  });

  it('with no cache argument the result is identical (cache is purely an optimization)', () => {
    const forest = forestOf();
    const store = createVertexStore(buildVertices());
    const cache = createDisplayShapeCache();
    const decisions = buildDisplayDecisions({ forest, globalThreshold: 1 });

    const cached = resolveDisplayShapes(forest, store, decisions, cache);
    const plain = resolveDisplayShapes(forest, store, decisions);
    expect(cached).toEqual(plain);
  });
});
