import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { rect } from './arbitraries';
import {
  POINT_LOCATION,
  SEGMENT_RELATION,
  pointInPolygon,
  ringHasZeroLengthEdge,
  ringSelfIntersects,
  ringStrictlyContains,
  segmentsIntersect,
} from './predicates';
import type { GeoPolygon } from './types';

const c = createCoordinate;

describe('pointInPolygon (acceptance criterion 3, holes + boundary)', () => {
  // 20x20 square with a central 4x4 hole.
  const outer = rect(0, 0, 20, 20);
  const hole = rect(8, 8, 4, 4);
  const polygon: GeoPolygon = [outer, hole];

  it('interior point is inside', () => {
    expect(pointInPolygon(c(2, 2), polygon)).toBe(POINT_LOCATION.Inside);
  });

  it('exterior point is outside', () => {
    expect(pointInPolygon(c(-5, -5), polygon)).toBe(POINT_LOCATION.Outside);
  });

  it('point inside the hole is outside', () => {
    expect(pointInPolygon(c(10, 10), polygon)).toBe(POINT_LOCATION.Outside);
  });

  it('point on the outer edge is boundary (explicit convention)', () => {
    expect(pointInPolygon(c(0, 5), polygon)).toBe(POINT_LOCATION.Boundary);
  });

  it('point on the hole edge is boundary', () => {
    expect(pointInPolygon(c(8, 10), polygon)).toBe(POINT_LOCATION.Boundary);
  });

  it('point on a vertex is boundary', () => {
    expect(pointInPolygon(c(0, 0), polygon)).toBe(POINT_LOCATION.Boundary);
  });
});

describe('predicates are robust against float residue / vertex order (Codex反例)', () => {
  // (.2,.4) is exactly on the segment (.1,.1)-(.3,.7); the naive float cross
  // product returns ~6.9e-18 (not 0) AND flips sign when a,b are swapped, which
  // made the result orientation-dependent. With the robust orientation it must be
  // boundary for BOTH vertex orders of a ring sharing that edge.
  it('a collinear grid point is classified boundary regardless of ring winding', () => {
    const ringCCW = [c(0.1, 0.1), c(0.3, 0.7), c(0.0, 0.7)];
    const ringCW = [c(0.0, 0.7), c(0.3, 0.7), c(0.1, 0.1)];
    const p = c(0.2, 0.4);
    expect(pointInPolygon(p, [ringCCW])).toBe(POINT_LOCATION.Boundary);
    expect(pointInPolygon(p, [ringCW])).toBe(POINT_LOCATION.Boundary);
  });

  it('a segment passing through (.2,.4) on (.1,.1)-(.3,.7) is not reported disjoint', () => {
    // A short segment that touches the line exactly at the on-line point.
    const r = segmentsIntersect(c(0.2, 0.4), c(0.5, 0.4), c(0.1, 0.1), c(0.3, 0.7));
    expect(r.relation).not.toBe(SEGMENT_RELATION.Disjoint);
  });
});

describe('segmentsIntersect (acceptance criterion 3 / FR-26 / 教訓5.38)', () => {
  it('proper crossing reports a point', () => {
    const r = segmentsIntersect(c(0, 0), c(10, 10), c(0, 10), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Proper);
    expect(r.point).toEqual(c(5, 5));
  });

  it('disjoint segments do not intersect', () => {
    expect(segmentsIntersect(c(0, 0), c(1, 1), c(5, 5), c(6, 6)).relation).toBe(
      SEGMENT_RELATION.Disjoint,
    );
  });

  it('endpoint touch is distinguished from a proper crossing', () => {
    const r = segmentsIntersect(c(0, 0), c(5, 5), c(5, 5), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Endpoint);
    expect(r.point).toEqual(c(5, 5));
  });

  it('collinear overlap is its own case', () => {
    const r = segmentsIntersect(c(0, 0), c(10, 0), c(5, 0), c(15, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Collinear);
    expect(r.point).toBeUndefined();
  });

  it('collinear end-to-end touch is an endpoint, not an overlap', () => {
    const r = segmentsIntersect(c(0, 0), c(5, 0), c(5, 0), c(10, 0));
    expect(r.relation).toBe(SEGMENT_RELATION.Endpoint);
  });
});

describe('ringSelfIntersects (acceptance criterion 3)', () => {
  it('a simple rectangle does not self-intersect', () => {
    expect(ringSelfIntersects(rect(0, 0, 10, 10))).toBe(false);
  });

  it('a bowtie self-intersects', () => {
    const bowtie = [c(0, 0), c(10, 10), c(10, 0), c(0, 10)];
    expect(ringSelfIntersects(bowtie)).toBe(true);
  });

  it('a triangle does not self-intersect', () => {
    expect(ringSelfIntersects([c(0, 0), c(10, 0), c(5, 10)])).toBe(false);
  });
});

describe('ringHasZeroLengthEdge (acceptance criterion 3, shared quantization)', () => {
  it('false for a valid ring', () => {
    expect(ringHasZeroLengthEdge(rect(0, 0, 10, 10))).toBe(false);
  });

  it('true when consecutive vertices coincide after quantization', () => {
    const ring = [c(0, 0), c(0 + 1e-12, 0), c(10, 0), c(10, 10)];
    expect(ringHasZeroLengthEdge(ring)).toBe(true);
  });

  it('true when the implicit closing edge is zero length (first == last)', () => {
    const ring = [c(0, 0), c(10, 0), c(10, 10), c(0 + 1e-12, 0 - 1e-12)];
    expect(ringHasZeroLengthEdge(ring)).toBe(true);
  });
});

describe('ringStrictlyContains (boundary-robust nesting — U06 holes / U26 re-parenting)', () => {
  const outer = rect(0, 0, 20, 20);

  it('a fully-interior inner ring is contained', () => {
    expect(ringStrictlyContains(outer, rect(5, 5, 10, 10))).toBe(true);
  });

  it('an inner ring whose vertices are all outside is not contained', () => {
    expect(ringStrictlyContains(outer, rect(30, 30, 5, 5))).toBe(false);
  });

  // Regression for the split re-parenting bug: a probe over only inner[0] is
  // fragile because, after a split, a seam vertex of a genuinely-nested enclave/
  // hole frequently lands exactly ON the candidate's shared boundary, where
  // pointInPolygon returns Boundary (not Inside). A lone inner[0] probe would
  // then report "not contained" and reparentByContainment would mis-promote the
  // ring to a top-level territory (FR-91). The robust predicate must still see
  // the ring as contained because it has real interior strictly inside.
  it('an inner ring nested but with its FIRST vertex ON the outer boundary is contained', () => {
    // inner[0] == (0,5) sits exactly on the outer's left edge (a seam vertex);
    // the rest of the ring lies strictly inside the outer. pointInPolygon(inner[0])
    // is Boundary, so the old inner[0]-only probe wrongly returned false.
    const inner = [c(0, 5), c(10, 5), c(10, 15), c(0, 15)];
    expect(pointInPolygon(inner[0]!, [outer])).toBe(POINT_LOCATION.Boundary);
    expect(ringStrictlyContains(outer, inner)).toBe(true);
  });

  it('an inner ring sharing an entire edge with the outer (all-on-boundary-on-one-side) is still contained', () => {
    // Two vertices ride the outer's left edge; the ring still has real interior
    // strictly inside, so it is contained despite the shared seam edge.
    const inner = [c(0, 4), c(0, 16), c(8, 16), c(8, 4)];
    expect(ringStrictlyContains(outer, inner)).toBe(true);
  });

  it('a degenerate ring lying entirely ON the outer boundary is NOT contained (no real interior)', () => {
    // A sliver collapsed onto the outer's left edge has zero interior inside.
    const degenerate = [c(0, 4), c(0, 8), c(0, 12)];
    expect(ringStrictlyContains(outer, degenerate)).toBe(false);
  });

  it('an inner ring that dips out through a concave notch is NOT contained', () => {
    // C-shaped (concave) outer with a notch cut into its right side; an inner ring
    // straddles the notch mouth so an edge stretch runs outside the outer solid.
    const notched = [
      c(0, 0),
      c(20, 0),
      c(20, 8),
      c(12, 10),
      c(20, 12),
      c(20, 20),
      c(0, 20),
    ];
    const straddling = rect(10, 9, 6, 2); // crosses the notch mouth into empty space
    expect(ringStrictlyContains(notched, straddling)).toBe(false);
  });
});
