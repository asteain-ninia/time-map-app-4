// REGRESSION (bug-hunt 3): spatial/terminals.ts — extractTerminalShapes must NOT
// re-resolve every leaf's full area on each consistency check.
//
// The defect: extractTerminalShapes resolved EVERY terminal leaf's shape from
// scratch (resolveFeatureArea → O(R×V) ring→vertex lookup, plus a possible union)
// on EVERY call. The consistency orchestrator rebuilds this list on every edit
// confirm, so at the spec's 5,000-terminal scale a single vertex move re-resolved
// all 5,000 shapes even though only one feature changed (NFR 5.x hot-path
// regression — no incremental update).
//
// Root fix: an optional TerminalShapeCache keyed by feature identity. Because
// features and vertices are IMMUTABLE value objects with structural sharing, an
// edit produces a new object ONLY for the touched entities; a terminal whose
// feature object AND every referenced vertex object are reference-identical to the
// cached snapshot is provably unchanged and reuses its prior resolved shape.
//
// This test pins BOTH correctness (cached output equals from-scratch output, the
// moved terminal reflects the new geometry) AND the incremental property (an
// untouched terminal's resolved shape object is REUSED, a moved one is freshly
// resolved). It must NOT be relaxed: weakening the identity assertions would let
// the O(n × geometry) hot path silently return.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature, type Feature, type LeafFeature } from '../feature';
import { buildForest } from '../hierarchy/forest';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import {
  createVertex,
  createVertexStore,
  setVertex,
  withVertexCoordinate,
  type Vertex,
  type VertexStore,
} from '../vertex';
import { detectTerminalOverlaps } from './overlap';
import {
  createTerminalShapeCache,
  extractTerminalShapes,
} from './terminals';

const ATTRS = createBasicAttributes('n', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0ff', '#000');

/** A single-territory-ring square leaf at (ox, oy) and its 4 vertices. */
function squareLeaf(
  name: string,
  ox: number,
  oy: number,
  size: number,
): { feature: LeafFeature; vertices: Vertex[] } {
  const vertices = [
    createVertex(asVertexId(`${name}-0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${name}-1`), createCoordinate(ox + size, oy)),
    createVertex(asVertexId(`${name}-2`), createCoordinate(ox + size, oy + size)),
    createVertex(asVertexId(`${name}-3`), createCoordinate(ox, oy + size)),
  ];
  const ring = createTerritoryRing(
    asRingId(`${name}-rt`),
    vertices.map((v) => v.id),
  );
  const feature = createLeafFeature(asFeatureId(name), ATTRS, COLOR, createShape([ring]));
  return { feature, vertices };
}

describe('extractTerminalShapes incremental cache (bug-hunt 3 regression)', () => {
  it('reuses an untouched terminal shape and re-resolves only the moved one', () => {
    // Three disjoint terminals; we will move ONLY C's geometry between calls.
    const a = squareLeaf('A', 0, 0, 10);
    const b = squareLeaf('B', 100, 0, 10);
    const c = squareLeaf('C', 200, 0, 10);

    const features: Feature[] = [a.feature, b.feature, c.feature];
    const store0 = createVertexStore([...a.vertices, ...b.vertices, ...c.vertices]);
    const forest0 = buildForest(features);

    const cache = createTerminalShapeCache();
    const first = extractTerminalShapes(forest0, store0, cache);

    const byId = (list: ReturnType<typeof extractTerminalShapes>, id: string) =>
      list.find((t) => String(t.id) === id);

    const aShape0 = byId(first, 'A')!.shape;
    const bShape0 = byId(first, 'B')!.shape;
    const cShape0 = byId(first, 'C')!.shape;
    expect(aShape0).toBeDefined();

    // --- simulate ONE vertex move on C (structural sharing: A and B keep their
    //     exact feature + vertex objects; only C's moved vertex is a new object).
    const movedVertex = withVertexCoordinate(c.vertices[0]!, createCoordinate(205, 5));
    const store1: VertexStore = setVertex(store0, movedVertex);
    // The forest is rebuilt from the SAME feature objects (a move edits vertices,
    // not the leaf's ring structure) — exactly what the live lookup does for an
    // untouched feature: same Feature object reference survives.
    const forest1 = buildForest(features);

    const second = extractTerminalShapes(forest1, store1, cache);

    const aShape1 = byId(second, 'A')!.shape;
    const bShape1 = byId(second, 'B')!.shape;
    const cShape1 = byId(second, 'C')!.shape;

    // Incremental property: A and B were untouched, so their resolved shape OBJECT
    // is reused verbatim (no re-resolution). C's referenced vertex changed, so it
    // is freshly resolved — a different object.
    expect(aShape1).toBe(aShape0);
    expect(bShape1).toBe(bShape0);
    expect(cShape1).not.toBe(cShape0);

    // Correctness: the cached run equals a from-scratch (no-cache) run over the
    // SAME post-move inputs — the cache changes performance, never the result.
    const scratch = extractTerminalShapes(forest1, store1);
    const norm = (list: ReturnType<typeof extractTerminalShapes>) =>
      [...list]
        .sort((x, y) => String(x.id).localeCompare(String(y.id)))
        .map((t) => ({ id: String(t.id), shape: t.shape }));
    expect(norm(second)).toEqual(norm(scratch));

    // C's new shape reflects the moved vertex (it really was re-resolved, not stale).
    expect(JSON.stringify(cShape1)).toContain('205');
  });

  it('drops a terminal that vanished from the forest (no stale shape retained)', () => {
    const a = squareLeaf('A', 0, 0, 10);
    const b = squareLeaf('B', 100, 0, 10);
    const store = createVertexStore([...a.vertices, ...b.vertices]);

    const cache = createTerminalShapeCache();
    const both = extractTerminalShapes(buildForest([a.feature, b.feature]), store, cache);
    expect(both.map((t) => String(t.id)).sort()).toEqual(['A', 'B']);

    // B removed from the forest: a subsequent run with the SAME cache must not
    // resurrect B from a stale entry.
    const onlyA = extractTerminalShapes(buildForest([a.feature]), store, cache);
    expect(onlyA.map((t) => String(t.id))).toEqual(['A']);
    // A is still reused (untouched), proving the drop did not blow the cache away.
    expect(onlyA[0]!.shape).toBe(both.find((t) => String(t.id) === 'A')!.shape);
  });

  it('cache run and no-cache run agree on detected overlaps after an edit', () => {
    // A overlaps B; after moving A away the overlap disappears. The cache must
    // track that — never report a stale overlap from a reused shape.
    const a = squareLeaf('A', 0, 0, 10);
    const b = squareLeaf('B', 5, 0, 10); // overlaps A
    const features: Feature[] = [a.feature, b.feature];
    const store0 = createVertexStore([...a.vertices, ...b.vertices]);

    const cache = createTerminalShapeCache();
    const t0 = extractTerminalShapes(buildForest(features), store0, cache);
    expect(detectTerminalOverlaps(t0, { seamTurns: [0] }).length).toBe(1);

    // Move ALL of A's vertices far away so it no longer overlaps B.
    let store1 = store0;
    for (const v of a.vertices) {
      store1 = setVertex(store1, withVertexCoordinate(v, createCoordinate(v.coordinate.lon + 500, v.coordinate.lat)));
    }
    const t1 = extractTerminalShapes(buildForest(features), store1, cache);
    expect(detectTerminalOverlaps(t1, { seamTurns: [0] }).length).toBe(0);

    // Equals the from-scratch result over the same inputs.
    const scratch = extractTerminalShapes(buildForest(features), store1);
    expect(detectTerminalOverlaps(t1, { seamTurns: [0] })).toEqual(
      detectTerminalOverlaps(scratch, { seamTurns: [0] }),
    );
  });
});
