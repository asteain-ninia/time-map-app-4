// U24 受け入れ基準6 / 7 — edge slide: detection ≠ response, tangential slide,
// existing contact (t=0), tunnel/尖り飛び越し guard (FR-28 / FR-89, 教訓5.38).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { constrainSlide, type BoundaryEdge, type CandidateTerminal } from './slide';
import { coord } from './fixtures';
import { isPointStrictlyInside } from '../geometry/predicates';
import type { GeoPolygon } from '../geometry/types';

// A unit square terminal occupying lon [0,4] × lat [0,4].
const SQUARE: GeoPolygon = [[coord(0, 0), coord(4, 0), coord(4, 4), coord(0, 4)]];

// Its four boundary edges (closed ring), keyed for highlight identity.
const SQUARE_EDGES: BoundaryEdge[] = [
  { featureId: 'T', edgeKey: 'r:0', a: coord(0, 0), b: coord(4, 0) },
  { featureId: 'T', edgeKey: 'r:1', a: coord(4, 0), b: coord(4, 4) },
  { featureId: 'T', edgeKey: 'r:2', a: coord(4, 4), b: coord(0, 4) },
  { featureId: 'T', edgeKey: 'r:3', a: coord(0, 4), b: coord(0, 0) },
];

const SQUARE_CAND: CandidateTerminal = { featureId: 'T', polygon: SQUARE };

describe('constrainSlide — no collision (受け入れ基準8 軽量 passthrough)', () => {
  it('passes the target through unchanged when nothing is contacted', () => {
    const r = constrainSlide({
      start: coord(-5, 2),
      target: coord(-3, 2),
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    expect(r.collided).toBe(false);
    expect(r.boundaries).toHaveLength(0);
    expect(r.position).toEqual({ lon: -3, lat: 2 });
  });
});

describe('constrainSlide — detection by segment crossing, not target inclusion (受け入れ基準7)', () => {
  it('detects a crossing when the START→TARGET segment crosses an edge', () => {
    // Move from outside (left) to inside the square: the segment crosses the left edge.
    const r = constrainSlide({
      start: coord(-1, 2),
      target: coord(2, 2), // target is INSIDE the square
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    expect(r.collided).toBe(true);
    expect(r.boundaries.length).toBeGreaterThan(0);
    // The final position must NOT be strictly inside the square.
    expect(r.position.lon).toBeLessThanOrEqual(0.0001);
  });

  it('尖り飛び越し: a fast move whose target lands back OUTSIDE still cannot pass through', () => {
    // Start left of the square, target right of it: the straight segment would
    // tunnel through. Detection must catch the crossing and slide, not let it pass.
    const r = constrainSlide({
      start: coord(-1, 2),
      target: coord(6, 2), // both endpoints outside, segment passes through interior
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    expect(r.collided).toBe(true);
    // The vertex is stopped at / slides along the entry edge (left edge lon≈0),
    // never emerging on the far side at lon 6.
    expect(r.position.lon).toBeLessThan(4);
  });
});

// A diamond (rotated square) terminal whose convex tips lie ON the axes, so a
// horizontal sweep passes EXACTLY through the left tip (0,2) and right tip (4,2).
// Every edge is oblique, so a path through a tip touches two edges only at that
// shared VERTEX (Endpoint relation, never Proper) — the 尖り飛び越し gap.
const DIAMOND: GeoPolygon = [[coord(2, 0), coord(4, 2), coord(2, 4), coord(0, 2)]];
const DIAMOND_EDGES: BoundaryEdge[] = [
  { featureId: 'D', edgeKey: 'r:0', a: coord(2, 0), b: coord(4, 2) },
  { featureId: 'D', edgeKey: 'r:1', a: coord(4, 2), b: coord(2, 4) },
  { featureId: 'D', edgeKey: 'r:2', a: coord(2, 4), b: coord(0, 2) },
  { featureId: 'D', edgeKey: 'r:3', a: coord(0, 2), b: coord(2, 0) },
];
const DIAMOND_CAND: CandidateTerminal = { featureId: 'D', polygon: DIAMOND };

describe('constrainSlide — 尖り飛び越し through a convex VERTEX (受け入れ基準6 / FR-28)', () => {
  it('tunnel-through: a sweep whose target lands back OUTSIDE cannot pass through a tip', () => {
    // Start left of the diamond, target right of it: the straight path passes
    // exactly through the left tip (0,2) and the interior. Both endpoints outside.
    const r = constrainSlide({
      start: coord(-1, 2),
      target: coord(5, 2),
      edges: DIAMOND_EDGES,
      candidates: [DIAMOND_CAND],
    });
    expect(r.collided).toBe(true);
    expect(r.boundaries.length).toBeGreaterThan(0);
    // Must NOT emerge on the far side at lon 5: the tip contact stops/slides it.
    expect(r.position.lon).toBeLessThan(5);
    // And it must not be left strictly inside the diamond.
    expect(isPointStrictlyInside(r.position, DIAMOND)).toBe(false);
  });

  it('target-inside: a sweep toward an interior point through a tip is constrained', () => {
    const r = constrainSlide({
      start: coord(-1, 2),
      target: coord(2, 2), // centre of the diamond (interior), path enters via left tip
      edges: DIAMOND_EDGES,
      candidates: [DIAMOND_CAND],
    });
    expect(r.collided).toBe(true);
    expect(isPointStrictlyInside(r.position, DIAMOND)).toBe(false);
  });

  // Regression for the FRESH-CROSSING tangential-slide leak: on an OBLIQUE edge the
  // tangential slide projects along the edge LINE, which re-enters the interior past
  // the shared convex vertex, so the committed position landed STRICTLY INSIDE the
  // diamond. The two axis-aligned/horizontal cases above miss it; only oblique entry
  // angles trigger it. These three are concrete reproductions from a 40000-move fuzz.
  it.each([
    { start: coord(1.8745, -0.9784), target: coord(2.1761, 2.7848) },
    { start: coord(-1.0746, 6.5471), target: coord(2.272, -0.2547) },
    { start: coord(4.8237, -0.0648), target: coord(-1.407, 6.2188) },
  ])('oblique entry never leaves the vertex strictly inside (start=$start)', ({ start, target }) => {
    // Precondition shared by every frame: the start is outside the candidate.
    expect(isPointStrictlyInside(start, DIAMOND)).toBe(false);
    const r = constrainSlide({ start, target, edges: DIAMOND_EDGES, candidates: [DIAMOND_CAND] });
    expect(isPointStrictlyInside(r.position, DIAMOND)).toBe(false);
  });

  it('property: a randomized oblique move from outside is never left strictly inside', () => {
    fc.assert(
      fc.property(
        // Start strictly OUTSIDE the diamond (its bounding box is lon/lat [0,4], the
        // diamond occupies |lon-2|+|lat-2| <= 2). Sample a wide box and reject the
        // few starts that fall inside so every case respects the frame precondition.
        fc.record({
          sx: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
          tx: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          fc.pre(!isPointStrictlyInside(start, DIAMOND));
          const target = coord(tx, ty);
          const r = constrainSlide({
            start,
            target,
            edges: DIAMOND_EDGES,
            candidates: [DIAMOND_CAND],
          });
          // The committed final position must never be strictly inside (FR-28 / FR-89).
          expect(isPointStrictlyInside(r.position, DIAMOND)).toBe(false);
        },
      ),
      { numRuns: 5000 },
    );
  });
});

describe('constrainSlide — tangential response (受け入れ基準6)', () => {
  it('drops the normal component and keeps tangential motion along the edge', () => {
    // Start just left of the left edge, move diagonally into the square (right+up).
    // The left edge is vertical (lat axis); tangential = vertical motion only.
    const r = constrainSlide({
      start: coord(-0.001, 1),
      target: coord(2, 3), // +2 lon (normal, into square), +2 lat (tangential, up)
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    expect(r.collided).toBe(true);
    // Slid along the vertical left edge: lon stays ~0 (no penetration), lat rises.
    expect(r.position.lon).toBeLessThanOrEqual(0.01);
    expect(r.position.lat).toBeGreaterThan(1);
  });
});

describe('constrainSlide — existing contact t=0 (受け入れ基準7, 教訓5.38)', () => {
  it('does NOT re-stop a move that starts already touching; allows tangential motion', () => {
    // Start ON the left edge (t=0 pre-existing contact), move diagonally: +lon
    // penetrates (dropped) and +lat is tangential along the vertical edge (kept).
    const r = constrainSlide({
      start: coord(0, 1), // on the left edge
      target: coord(1, 3), // +1 lon (into square, normal) +2 lat (along edge)
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    // It is allowed to slide UP along the edge rather than frozen, and reports the
    // boundary it is sliding along (highlight). 教訓5.38: existing contact not re-stopped.
    expect(r.collided).toBe(true);
    expect(r.boundaries.length).toBeGreaterThan(0);
    expect(r.position.lat).toBeGreaterThan(1); // moved tangentially up
    expect(r.position.lon).toBeLessThanOrEqual(0.01); // no penetration
  });
});

describe('constrainSlide — boundary identity for highlight (受け入れ基準6)', () => {
  it('outputs the contacted boundary edge id so the render layer can highlight', () => {
    const r = constrainSlide({
      start: coord(-1, 2),
      target: coord(1, 2),
      edges: SQUARE_EDGES,
      candidates: [SQUARE_CAND],
    });
    expect(r.boundaries[0]).toMatchObject({ featureId: 'T' });
    expect(typeof r.boundaries[0]!.edgeKey).toBe('string');
  });
});
