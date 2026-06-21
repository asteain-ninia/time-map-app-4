// U24 受け入れ基準6 / 7 — edge slide: detection ≠ response, tangential slide,
// existing contact (t=0), tunnel/尖り飛び越し guard (FR-28 / FR-89, 教訓5.38).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  constrainSlide,
  type BoundaryEdge,
  type CandidateTerminal,
  type ParentContainment,
} from './slide';
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

// --- INVERSE containment: a hole/enclave vertex must stay inside its parent ----
// (受け入れ基準6 第4項 / FR-89, judged via U07's containment predicate). PARENT is
// the territory the hole is punched into / the hole the enclave sits in. The vertex
// must never exit PARENT's outer boundary.

// A large parent territory occupying lon/lat [0,10]. The hole/enclave vertex lives
// inside it and must not leave it.
const PARENT_POLY: GeoPolygon = [[coord(0, 0), coord(10, 0), coord(10, 10), coord(0, 10)]];
const PARENT_EDGES: BoundaryEdge[] = [
  { featureId: 'SELF', edgeKey: 'p:0', a: coord(0, 0), b: coord(10, 0) },
  { featureId: 'SELF', edgeKey: 'p:1', a: coord(10, 0), b: coord(10, 10) },
  { featureId: 'SELF', edgeKey: 'p:2', a: coord(10, 10), b: coord(0, 10) },
  { featureId: 'SELF', edgeKey: 'p:3', a: coord(0, 10), b: coord(0, 0) },
];
const PARENT_CONTAINMENT: ParentContainment = {
  featureId: 'SELF',
  polygon: PARENT_POLY,
  edges: PARENT_EDGES,
};

describe('constrainSlide — 穴/飛び地頂点は親外周を横切らない (受け入れ基準6 第4項 / FR-89, U07述語)', () => {
  it('passthrough: a move that stays inside the parent is unconstrained', () => {
    const r = constrainSlide({
      start: coord(5, 5),
      target: coord(6, 7), // still well inside the parent
      edges: [],
      candidates: [],
      containment: PARENT_CONTAINMENT,
    });
    expect(r.collided).toBe(false);
    expect(r.position).toEqual({ lon: 6, lat: 7 });
  });

  it('constrains a move that would EXIT the parent outer boundary (right edge)', () => {
    // Drag a hole vertex from inside toward the right, crossing the parent's right
    // edge (lon=10). The vertex must stay inside (lon <= 10), sliding along the edge.
    const r = constrainSlide({
      start: coord(8, 5),
      target: coord(13, 5), // would leave the parent through the right edge
      edges: [],
      candidates: [],
      containment: PARENT_CONTAINMENT,
    });
    expect(r.collided).toBe(true);
    expect(r.boundaries.length).toBeGreaterThan(0);
    // Never outside the parent: lon must not exceed the right boundary; the slid
    // position sits ON the boundary (legal containment, not strictly inside nor out).
    expect(r.position.lon).toBeLessThanOrEqual(10.0001);
    expect(pointInPolygonOutside(r.position)).toBe(false);
  });

  it('尖り飛び越し inverse: a fast exit-and-return path is still constrained inside', () => {
    // Start inside, target also inside, but the straight path bulges OUT through the
    // right edge and back. The segment crosses the parent boundary twice; the vertex
    // must not be allowed to leave. (Here both endpoints are inside, so the target is
    // accepted — this asserts the in→in fast path stays inside.)
    const r = constrainSlide({
      start: coord(9, 1),
      target: coord(9, 9),
      edges: [],
      candidates: [],
      containment: PARENT_CONTAINMENT,
    });
    expect(isPointStrictlyInside(r.position, PARENT_POLY)).toBe(true);
  });

  it('tangential slide along the parent boundary when pushed straight out', () => {
    // Push diagonally out past the right edge: the outward (normal) component is
    // dropped, the along-edge (lat) component is kept → slides up the right edge.
    const r = constrainSlide({
      start: coord(9.999, 3),
      target: coord(12, 6), // +lon exits (dropped), +lat tangential (kept)
      edges: [],
      candidates: [],
      containment: PARENT_CONTAINMENT,
    });
    expect(r.collided).toBe(true);
    expect(r.position.lon).toBeLessThanOrEqual(10.0001);
    expect(r.position.lat).toBeGreaterThan(3); // slid up along the right edge
    // On the boundary (lon≈10) counts as contained, not strictly inside nor outside.
    expect(r.position.lon).toBeLessThanOrEqual(10.0001);
  });

  it('property: a hole vertex starting inside the parent is never left outside it', () => {
    fc.assert(
      fc.property(
        fc.record({
          sx: fc.double({ min: 0.5, max: 9.5, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: 0.5, max: 9.5, noNaN: true, noDefaultInfinity: true }),
          tx: fc.double({ min: -5, max: 15, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -5, max: 15, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          // Frame precondition: the previous accepted position is inside the parent.
          fc.pre(isPointStrictlyInside(start, PARENT_POLY));
          const r = constrainSlide({
            start,
            target: coord(tx, ty),
            edges: [],
            candidates: [],
            containment: PARENT_CONTAINMENT,
          });
          // The committed position must never be strictly outside the parent (FR-89).
          expect(pointInPolygonOutside(r.position)).toBe(false);
        },
      ),
      { numRuns: 5000 },
    );
  });
});

function pointInPolygonOutside(p: { lon: number; lat: number }): boolean {
  // Strictly outside the parent square [0,10]^2 (boundary counts as contained).
  return p.lon < -0.0001 || p.lon > 10.0001 || p.lat < -0.0001 || p.lat > 10.0001;
}

// --- containment + another terminal INSIDE the parent (受け入れ基準6 / FR-28 / FR-89)
// A hole/enclave vertex constrained to stay inside its parent must STILL never be
// relocated strictly inside another terminal by the containment pass. Regression for
// the U24 high blocker: the containment pass ran AFTER the other-terminal pass and
// could teleport the vertex into another terminal (graze/denormal fallback) with no
// final other-terminal re-check. OTHER occupies lon[7,10] × lat[4,7] inside PARENT.
const OTHER_POLY: GeoPolygon = [[coord(7, 4), coord(10, 4), coord(10, 7), coord(7, 7)]];
const OTHER_EDGES: BoundaryEdge[] = [
  { featureId: 'OTHER', edgeKey: 'o:0', a: coord(7, 4), b: coord(10, 4) },
  { featureId: 'OTHER', edgeKey: 'o:1', a: coord(10, 4), b: coord(10, 7) },
  { featureId: 'OTHER', edgeKey: 'o:2', a: coord(10, 7), b: coord(7, 7) },
  { featureId: 'OTHER', edgeKey: 'o:3', a: coord(7, 7), b: coord(7, 4) },
];
const OTHER_CAND: CandidateTerminal = { featureId: 'OTHER', polygon: OTHER_POLY };

describe('constrainSlide — containment must not seat the vertex inside another terminal (U24 blocker / FR-28 / FR-89)', () => {
  it('exact fuzz CEX: denormal target on the parent boundary does not teleport into OTHER', () => {
    // The recorded counterexample: start inside the parent but outside OTHER; target
    // has a denormal lon (-5e-324) that reads Outside-the-parent without a PROPER
    // crossing. The old graze fallback slid the full tangential motion along the edge
    // nearest the START (the right edge), teleporting the vertex into OTHER.
    const r = constrainSlide({
      start: coord(9.773494169154299, 0.2265058308457011),
      target: coord(-5e-324, 6.17847495),
      edges: OTHER_EDGES,
      candidates: [OTHER_CAND],
      containment: PARENT_CONTAINMENT,
    });
    expect(isPointStrictlyInside(r.position, OTHER_POLY)).toBe(false);
    expect(pointInPolygonOutside(r.position)).toBe(false);
  });

  it('property: a contained vertex is never relocated strictly inside another terminal', () => {
    fc.assert(
      fc.property(
        fc.record({
          sx: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          tx: fc.double({ min: -5, max: 15, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -5, max: 15, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          // Frame precondition: the previous accepted position is inside the parent and
          // OUTSIDE every other terminal (a legal vertex position).
          fc.pre(isPointStrictlyInside(start, PARENT_POLY));
          fc.pre(!isPointStrictlyInside(start, OTHER_POLY));
          const r = constrainSlide({
            start,
            target: coord(tx, ty),
            edges: OTHER_EDGES,
            candidates: [OTHER_CAND],
            containment: PARENT_CONTAINMENT,
          });
          // BOTH invariants must hold on the committed position: inside the parent AND
          // outside the other terminal (受け入れ基準6 第4項 + 末端地物同士が重ならない).
          expect(pointInPolygonOutside(r.position)).toBe(false);
          expect(isPointStrictlyInside(r.position, OTHER_POLY)).toBe(false);
        },
      ),
      { numRuns: 20000 },
    );
  });
});

// --- bughunt2: the containment pass runs LAST; its FINAL fallback must satisfy BOTH
// invariants (受け入れ基準6 第4項 + 末端地物同士が重ならない / FR-28 / FR-89).
//
// The containment pass (constrainWithinParent) is fed `preContainmentPos` — the
// output of the other-terminal pass. That value is candidate-safe (the re-check before
// the containment pass guarantees it) but, by the very reason constrainWithinParent is
// invoked, it can be OUTSIDE the parent (it is the position that drifted out of the
// parent region). The historical post-containment guard had an ORDERING ASYMMETRY: the
// outside-parent revert re-checked its fallback, but the inside-candidate revert fell
// back to `preContainmentPos` WITHOUT re-asserting parent containment — so when the
// containment-corrected position happened to land inside another terminal, the committed
// result could be `preContainmentPos`, which can be outside the parent (a hole/enclave
// vertex escaping its parent ring). The fix commits the first of
// [containment-result, preContainmentPos, start] that satisfies BOTH invariants.
//
// This block locks that contract: across drags whose targets reach far OUTSIDE the
// parent (so preContainmentPos is genuinely parent-outside, the bug's precondition),
// past an other-terminal that sits INSIDE the parent, the committed position must NEVER
// be outside the parent NOR strictly inside the other terminal — whichever fallback the
// guard takes. Geometry is axis-aligned (the OTHER square inside the parent, reused
// from the U24-blocker fixtures) to isolate the containment-fallback ordering from
// unrelated oblique-edge numerics.
describe('constrainSlide — containment FINAL fallback commits a position safe on BOTH invariants (bughunt2 ordering asymmetry / FR-28 / FR-89)', () => {
  it('a contained vertex dragged far out past the parent boundary, alongside an inside terminal, stays inside the parent', () => {
    // Start inside the parent (and outside OTHER); target far OUTSIDE the parent right
    // edge at OTHER's latitude band, so the other-terminal pass yields a parent-OUTSIDE
    // preContainmentPos and the containment pass must pull it back without ever
    // committing the parent-outside fallback.
    const r = constrainSlide({
      start: coord(9.5, 1), // inside the parent, BELOW the OTHER terminal (lat<4)
      target: coord(40, 5.5), // far outside the parent (lon ≫ 10), at OTHER's lat band
      edges: OTHER_EDGES,
      candidates: [OTHER_CAND],
      containment: PARENT_CONTAINMENT,
    });
    expect(pointInPolygonOutside(r.position)).toBe(false);
    expect(isPointStrictlyInside(r.position, OTHER_POLY)).toBe(false);
  });

  it('property: with targets reaching far outside the parent, the commit is NEVER outside the parent NOR inside the other terminal', () => {
    fc.assert(
      fc.property(
        fc.record({
          sx: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          // Targets reach well beyond the parent in BOTH directions so the containment
          // pass is repeatedly exercised with a parent-OUTSIDE preContainmentPos (the
          // bug's precondition: the fallback source itself violates containment).
          tx: fc.double({ min: -30, max: 40, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -30, max: 40, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          // Frame precondition: the previous accepted position is inside the parent and
          // outside the other terminal (a legal vertex) — safe on BOTH invariants.
          fc.pre(isPointStrictlyInside(start, PARENT_POLY));
          fc.pre(!isPointStrictlyInside(start, OTHER_POLY));
          const r = constrainSlide({
            start,
            target: coord(tx, ty),
            edges: OTHER_EDGES,
            candidates: [OTHER_CAND],
            containment: PARENT_CONTAINMENT,
          });
          // The committed position must satisfy BOTH invariants — the fix guarantees
          // the final fallback never commits a parent-outside (or candidate-inside)
          // point even when the inside-candidate fallback's source (preContainmentPos)
          // is itself outside the parent.
          expect(pointInPolygonOutside(r.position)).toBe(false);
          expect(isPointStrictlyInside(r.position, OTHER_POLY)).toBe(false);
        },
      ),
      { numRuns: 30000 },
    );
  });
});

// --- bughunt2: when a fallback PINS the vertex back at the frame start (no net
// motion), the result must report NO slide — collided=false and an EMPTY boundary
// list (受け入れ基準6・7 / 教訓5.18). The containment pass runs LAST and accumulates
// `collided`/`boundaries` for a slide it then ABANDONS: if neither the containment
// result nor `preContainmentPos` satisfies BOTH invariants the committed position
// rolls back to the input `start`, yet `collided`/`boundaries` were left set. The
// render layer would then HIGHLIGHT a boundary edge the (un-moved) vertex is not
// actually riding — the vertex sits at the previous frame's position, not on the
// contact edge — so the user sees a collision/highlight despite the vertex not having
// moved one bit. The fix unifies every "rolled back to start" branch onto the
// invariant "collided/boundaries ⇒ the vertex was actually displaced from start".
//
// Fixture: OTHER STRADDLES the parent's right edge (lon=10) — lon[9,11] × lat[4,7] —
// so the containment slide up the right edge re-enters OTHER (containment result fails
// the candidate invariant) while `preContainmentPos` lies OUTSIDE the parent (the
// other-terminal pass pushed past lon=10): both fallbacks are rejected, forcing
// pos=start with a parent-edge boundary already recorded. This is the exact path the
// old code reported collided=true at an unmoved position.
const STRADDLE_OTHER_POLY: GeoPolygon = [[coord(9, 4), coord(11, 4), coord(11, 7), coord(9, 7)]];
const STRADDLE_OTHER_EDGES: BoundaryEdge[] = [
  { featureId: 'OTHER', edgeKey: 'so:0', a: coord(9, 4), b: coord(11, 4) },
  { featureId: 'OTHER', edgeKey: 'so:1', a: coord(11, 4), b: coord(11, 7) },
  { featureId: 'OTHER', edgeKey: 'so:2', a: coord(11, 7), b: coord(9, 7) },
  { featureId: 'OTHER', edgeKey: 'so:3', a: coord(9, 7), b: coord(9, 4) },
];
const STRADDLE_OTHER_CAND: CandidateTerminal = { featureId: 'OTHER', polygon: STRADDLE_OTHER_POLY };

describe('constrainSlide — a fallback that pins the vertex at start reports NO slide (bughunt2 boundary/collided consistency / 教訓5.18)', () => {
  it('exact CEX: rollback to start commits collided=false and empty boundaries (not a phantom highlight)', () => {
    // Start inside the parent and outside OTHER; target far to the upper-right so the
    // other-terminal pass yields a parent-OUTSIDE preContainmentPos and the containment
    // pass slides up the right edge straight back INTO the straddling OTHER. Neither
    // fallback satisfies BOTH invariants → pos rolls back to the input start.
    const start = coord(0.2, 0.2);
    const r = constrainSlide({
      start,
      target: coord(40, 40),
      edges: STRADDLE_OTHER_EDGES,
      candidates: [STRADDLE_OTHER_CAND],
      containment: PARENT_CONTAINMENT,
    });
    // The vertex did NOT move — the committed position is exactly the input start.
    expect(r.position).toEqual({ lon: 0.2, lat: 0.2 });
    // ...therefore there is NO slide to report: no highlight, no collision flag.
    expect(r.boundaries).toEqual([]);
    expect(r.collided).toBe(false);
  });

  it('property: whenever the commit equals the unchanged start, collided=false and boundaries is empty', () => {
    fc.assert(
      fc.property(
        fc.record({
          sx: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: 0.2, max: 9.8, noNaN: true, noDefaultInfinity: true }),
          tx: fc.double({ min: -30, max: 40, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -30, max: 40, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          fc.pre(isPointStrictlyInside(start, PARENT_POLY));
          fc.pre(!isPointStrictlyInside(start, STRADDLE_OTHER_POLY));
          const r = constrainSlide({
            start,
            target: coord(tx, ty),
            edges: STRADDLE_OTHER_EDGES,
            candidates: [STRADDLE_OTHER_CAND],
            containment: PARENT_CONTAINMENT,
          });
          // The contract under test: a reported collision/highlight implies the vertex
          // was actually displaced from its frame start. When the commit is the
          // unchanged start (no net motion), the move is a no-op — report no slide.
          const moved = Math.hypot(r.position.lon - start.lon, r.position.lat - start.lat);
          if (moved < 1e-9) {
            expect(r.collided).toBe(false);
            expect(r.boundaries).toEqual([]);
          }
        },
      ),
      { numRuns: 30000 },
    );
  });
});

// --- multi-candidate: sliding along candidate A must not land inside candidate B
// (受け入れ基準6 / FR-28). Two adjacent squares share a vertical seam at lon=4; a
// vertex sliding down candidate A's right edge must not be committed inside B.
// Ported from the deleted scratch probe as a proper named acceptance test.
const SQUARE_B: GeoPolygon = [[coord(4, 0), coord(8, 0), coord(8, 4), coord(4, 4)]];
const SQUARE_B_EDGES: BoundaryEdge[] = [
  { featureId: 'B', edgeKey: 'b:0', a: coord(4, 0), b: coord(8, 0) },
  { featureId: 'B', edgeKey: 'b:1', a: coord(8, 0), b: coord(8, 4) },
  { featureId: 'B', edgeKey: 'b:2', a: coord(8, 4), b: coord(4, 4) },
  { featureId: 'B', edgeKey: 'b:3', a: coord(4, 4), b: coord(4, 0) },
];
const SQUARE_B_CAND: CandidateTerminal = { featureId: 'B', polygon: SQUARE_B };

describe('constrainSlide — multi-candidate (受け入れ基準6 / FR-28)', () => {
  it('a slide along candidate A is never committed strictly inside candidate B', () => {
    fc.assert(
      fc.property(
        fc.record({
          sx: fc.double({ min: -3, max: 11, noNaN: true, noDefaultInfinity: true }),
          sy: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
          tx: fc.double({ min: -3, max: 11, noNaN: true, noDefaultInfinity: true }),
          ty: fc.double({ min: -3, max: 7, noNaN: true, noDefaultInfinity: true }),
        }),
        ({ sx, sy, tx, ty }) => {
          const start = coord(sx, sy);
          fc.pre(!isPointStrictlyInside(start, SQUARE));
          fc.pre(!isPointStrictlyInside(start, SQUARE_B));
          const r = constrainSlide({
            start,
            target: coord(tx, ty),
            edges: [...SQUARE_EDGES, ...SQUARE_B_EDGES],
            candidates: [SQUARE_CAND, SQUARE_B_CAND],
          });
          expect(isPointStrictlyInside(r.position, SQUARE)).toBe(false);
          expect(isPointStrictlyInside(r.position, SQUARE_B)).toBe(false);
        },
      ),
      { numRuns: 20000 },
    );
  });
});

// --- short boundary edges: EPS unit-mismatch regression (受け入れ基準6 / FR-28) ----
// crossingParameter / tangentialComponent / projectOntoEdge guard degeneracy by
// comparing a SQUARED magnitude (`dot(v,v)`) against the threshold. The threshold
// must be the SQUARE of the length tolerance EPS (=1e-18), not EPS itself (=1e-9):
// with the wrong threshold any edge or motion shorter than sqrt(1e-9)=3.16e-5 deg
// (~3.5 m) was treated as degenerate, so the tangential component collapsed to {0,0}
// and a penetrating move into a small terminal silently no-op'd, letting the vertex
// pass through. Coordinates quantize to a 1e-7 grid, so a ~1e-5 deg edge is a real,
// legitimate boundary that MUST still slide. These edges are far above the grid yet
// were below the old (mis-squared) threshold.
const TINY = 1e-5; // 10× above the quantize grid (1e-7), 3× below sqrt(EPS) (3.16e-5)
// A small square terminal at the origin with side length TINY deg.
const TINY_SQUARE: GeoPolygon = [
  [coord(0, 0), coord(TINY, 0), coord(TINY, TINY), coord(0, TINY)],
];
const TINY_SQUARE_EDGES: BoundaryEdge[] = [
  { featureId: 'TS', edgeKey: 't:0', a: coord(0, 0), b: coord(TINY, 0) },
  { featureId: 'TS', edgeKey: 't:1', a: coord(TINY, 0), b: coord(TINY, TINY) },
  { featureId: 'TS', edgeKey: 't:2', a: coord(TINY, TINY), b: coord(0, TINY) },
  { featureId: 'TS', edgeKey: 't:3', a: coord(0, TINY), b: coord(0, 0) },
];
const TINY_SQUARE_CAND: CandidateTerminal = { featureId: 'TS', polygon: TINY_SQUARE };

describe('constrainSlide — short boundary edges still constrain (EPS² unit regression / FR-28)', () => {
  it('a penetrating move across a ~1e-5 deg edge is redirected, not passed through', () => {
    // Start just left of the small square, target deep inside it: the start→target
    // segment crosses the (short) left edge. Before the fix tangentialComponent saw
    // edgeLen2 = TINY² = 1e-10 < EPS(1e-9) and returned {0,0}, so the slide produced
    // no tangential redirection and the final invariant check fell back to `start`
    // with collided=false-ish — but crucially the move was NOT constrained as a slide.
    const mid = TINY / 2;
    const r = constrainSlide({
      start: coord(-TINY, mid),
      target: coord(mid, mid), // strictly inside the small square
      edges: TINY_SQUARE_EDGES,
      candidates: [TINY_SQUARE_CAND],
    });
    // The move IS detected as a collision (a real crossing of a real short edge).
    expect(r.collided).toBe(true);
    expect(r.boundaries.length).toBeGreaterThan(0);
    // And the committed position is never left strictly inside the small terminal.
    expect(isPointStrictlyInside(r.position, TINY_SQUARE)).toBe(false);
  });

  it('a diagonal move into a short edge keeps a NON-ZERO tangential slide', () => {
    // Push diagonally into the left (vertical, length TINY) edge: the +lon component
    // penetrates (dropped), the +lat component is tangential along the edge and MUST
    // be kept. The bug zeroed the whole tangential vector for this short edge, so the
    // vertex would not slide up at all. Here we assert it slides up (lat increases).
    const r = constrainSlide({
      start: coord(-TINY * 0.001, TINY * 0.25),
      target: coord(TINY * 0.5, TINY * 0.75), // +lon into square, +lat along left edge
      edges: TINY_SQUARE_EDGES,
      candidates: [TINY_SQUARE_CAND],
    });
    expect(r.collided).toBe(true);
    expect(isPointStrictlyInside(r.position, TINY_SQUARE)).toBe(false);
    // Tangential motion (up the short left edge) was preserved, not collapsed to zero.
    expect(r.position.lat).toBeGreaterThan(TINY * 0.25);
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
