// REGRESSION (bug-hunt 2): hierarchy/resolve-shape.ts × spatial/overlap.ts —
// a dangling parentRingId hole must NOT be silently dropped into a phantom solid
// that drives a false-positive terminal-exclusion / anchor-spatial-overlap.
//
// The defect: resolveLeafShape bucketed hole rings under their parentRingId and
// re-attached each bucket by territory.id. A hole whose parentRingId names NO
// existing territory ring (dangling, or pointing at another hole — both U07
// ring-hierarchy defects) was bucketed under a key no territory carried, so the
// bucket was NEVER consumed and the hole was SILENTLY DROPPED. The leaf then
// resolved as a wrongly-SOLID area. extractTerminalShapes → detectTerminalOverlaps
// reported that phantom solid as overlapping a neighbour B that actually sat inside
// what should have been the hole — a false-positive terminal-exclusion AND
// anchor-spatial-overlap, and a bogus DropOverlappingFeature repair candidate.
// (RingHierarchyInvalid did fire in parallel, but the spatial false positives did
// not — they are the gap this fixes.)
//
// Root fix: resolveLeafShape now returns undefined (unresolvable, same contract as
// a missing vertex) when any hole's parent is not an existing territory ring, so no
// consumer ever treats the fake solid as real area. The actual ring-hierarchy
// defect is still surfaced separately by U07 / RingHierarchyInvalid.
//
// Permanent asset; must NOT be relaxed to paint over a real defect.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import { createLeafFeature } from '../feature';
import { buildForest } from '../hierarchy/forest';
import { resolveLeafShape } from '../hierarchy/resolve-shape';
import { asFeatureId, asRingId, asVertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing } from '../ring';
import { createVertex, createVertexStore } from '../vertex';
import { detectTerminalOverlaps } from './overlap';
import { extractTerminalShapes } from './terminals';

const ATTRS = createBasicAttributes('n', 0, 100);
const COLOR = createColorInfo(true, '#fff', '#0ff', '#000');

/** Build a square's 4 vertices with the given id prefix at (ox, oy). */
function squareVerts(prefix: string, ox: number, oy: number, size: number) {
  return [
    createVertex(asVertexId(`${prefix}-0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${prefix}-1`), createCoordinate(ox + size, oy)),
    createVertex(asVertexId(`${prefix}-2`), createCoordinate(ox + size, oy + size)),
    createVertex(asVertexId(`${prefix}-3`), createCoordinate(ox, oy + size)),
  ];
}

describe('resolveLeafShape refuses a dangling-parent hole (bug-hunt 2 regression)', () => {
  it('returns undefined when a hole parentRingId names no existing territory ring', () => {
    const outer = squareVerts('A-out', 0, 0, 30);
    const hole = squareVerts('A-hole', 5, 5, 20);
    const store = createVertexStore([...outer, ...hole]);

    const outerRing = createTerritoryRing(
      asRingId('A-rt'),
      outer.map((v) => v.id),
    );
    // parentRingId points at a ring id absent from the shape (dangling).
    const danglingHole = createHoleRing(
      asRingId('A-rh'),
      hole.map((v) => v.id),
      asRingId('A-MISSING'),
    );
    const shape = createShape([outerRing, danglingHole]);

    // Was: the hole was silently dropped and a single SOLID polygon (outer only)
    // was returned. Now: unresolvable, mirroring the missing-vertex contract.
    expect(resolveLeafShape(shape, store)).toBeUndefined();
  });

  it('returns undefined when a hole parent exists but is itself a hole (alternation broken)', () => {
    const outer = squareVerts('B-out', 0, 0, 40);
    const hole1 = squareVerts('B-h1', 5, 5, 30);
    const hole2 = squareVerts('B-h2', 8, 8, 10);
    const store = createVertexStore([...outer, ...hole1, ...hole2]);

    const outerRing = createTerritoryRing(
      asRingId('B-rt'),
      outer.map((v) => v.id),
    );
    const holeRing1 = createHoleRing(
      asRingId('B-rh1'),
      hole1.map((v) => v.id),
      asRingId('B-rt'),
    );
    // A hole whose parent is ANOTHER hole: no territory ring carries this id, so
    // the bucket would never be consumed → phantom-solid risk. Must be refused.
    const holeRing2 = createHoleRing(
      asRingId('B-rh2'),
      hole2.map((v) => v.id),
      asRingId('B-rh1'),
    );
    const shape = createShape([outerRing, holeRing1, holeRing2]);

    expect(resolveLeafShape(shape, store)).toBeUndefined();
  });

  it('still resolves a VALID holed leaf (no over-rejection)', () => {
    const outer = squareVerts('C-out', 0, 0, 30);
    const hole = squareVerts('C-hole', 10, 10, 8);
    const store = createVertexStore([...outer, ...hole]);
    const outerRing = createTerritoryRing(
      asRingId('C-rt'),
      outer.map((v) => v.id),
    );
    const holeRing = createHoleRing(
      asRingId('C-rh'),
      hole.map((v) => v.id),
      asRingId('C-rt'),
    );
    const mp = resolveLeafShape(createShape([outerRing, holeRing]), store);
    expect(mp).toBeDefined();
    expect(mp).toHaveLength(1);
    expect(mp?.[0]).toHaveLength(2); // outer + hole, hole NOT dropped.
  });
});

describe('no phantom overlap from a dangling-hole leaf (bug-hunt 2 cross-subsystem)', () => {
  it('A with a dangling hole and B inside the hole region produce NO terminal overlap', () => {
    // A: a big square 0..30 with a hole 5..25 whose parentRingId is dangling.
    const aOuter = squareVerts('A-out', 0, 0, 30);
    const aHole = squareVerts('A-hole', 5, 5, 20);
    const aOuterRing = createTerritoryRing(
      asRingId('A-rt'),
      aOuter.map((v) => v.id),
    );
    const aDanglingHole = createHoleRing(
      asRingId('A-rh'),
      aHole.map((v) => v.id),
      asRingId('A-MISSING'), // dangling
    );
    const aFeature = createLeafFeature(
      asFeatureId('A'),
      ATTRS,
      COLOR,
      createShape([aOuterRing, aDanglingHole]),
    );

    // B: a small square 10..18 that sits ENTIRELY inside A's (intended) hole, so
    // with the hole honoured there is NO positive-area overlap — only the dropped
    // hole would make A solid there and fabricate one.
    const bVerts = squareVerts('B', 10, 10, 8);
    const bRing = createTerritoryRing(
      asRingId('B-rt'),
      bVerts.map((v) => v.id),
    );
    const bFeature = createLeafFeature(
      asFeatureId('B'),
      ATTRS,
      COLOR,
      createShape([bRing]),
    );

    const forest = buildForest([aFeature, bFeature]);
    const store = createVertexStore([...aOuter, ...aHole, ...bVerts]);

    const terminals = extractTerminalShapes(forest, store);
    // A is unresolvable (dangling hole) → not a terminal; B remains a terminal.
    const ids = new Set(terminals.map((t) => t.id));
    expect(ids.has(asFeatureId('A'))).toBe(false);
    expect(ids.has(asFeatureId('B'))).toBe(true);

    const pairs = detectTerminalOverlaps(terminals, { seamTurns: [0] });
    // No phantom terminal-exclusion / anchor-spatial-overlap between A and B.
    expect(pairs).toHaveLength(0);
  });
});
