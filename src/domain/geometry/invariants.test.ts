import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { rect } from './arbitraries';
import {
  INVARIANT_VIOLATION,
  checkMultiPolygonInvariants,
  isMultiPolygonValid,
} from './invariants';
import { POINT_LOCATION, pointInPolygon } from './predicates';
import type { GeoMultiPolygon } from './types';

const c = createCoordinate;

describe('invariants (R2 back-half, acceptance criterion 2)', () => {
  it('a valid rectangle multi-polygon has no violations', () => {
    const mp: GeoMultiPolygon = [[rect(0, 0, 10, 10)]];
    expect(isMultiPolygonValid(mp)).toBe(true);
  });

  it('an empty multi-polygon is valid (教訓5.18)', () => {
    expect(isMultiPolygonValid([])).toBe(true);
  });

  it('flags a ring with fewer than 3 vertices', () => {
    const mp: GeoMultiPolygon = [[[c(0, 0), c(1, 1)]]];
    const v = checkMultiPolygonInvariants(mp);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.TooFewVertices)).toBe(true);
  });

  it('flags a self-intersecting (bowtie) ring', () => {
    const bowtie = [c(0, 0), c(10, 10), c(10, 0), c(0, 10)];
    const v = checkMultiPolygonInvariants([[bowtie]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.SelfIntersection)).toBe(true);
  });

  it('flags a zero-length edge after quantization', () => {
    const ring = [c(0, 0), c(0 + 1e-12, 0), c(10, 0), c(10, 10)];
    const v = checkMultiPolygonInvariants([[ring]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.ZeroLengthEdge)).toBe(true);
  });

  it('flags a missing outer ring', () => {
    const v = checkMultiPolygonInvariants([[]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.MissingOuterRing)).toBe(true);
  });

  it('flags a hole not contained in its outer ring', () => {
    const outer = rect(0, 0, 10, 10);
    const strayHole = rect(50, 50, 4, 4); // entirely outside the outer
    const v = checkMultiPolygonInvariants([[outer, strayHole]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.HoleNotContained)).toBe(true);
  });

  it('accepts a hole properly contained in its outer ring', () => {
    const outer = rect(0, 0, 20, 20);
    const hole = rect(8, 8, 4, 4);
    expect(isMultiPolygonValid([[outer, hole]])).toBe(true);
  });

  it('flags a hole whose vertices are all in solid material but whose edge crosses out through a notch', () => {
    // Outer: 40x40 square (CCW) with a slot cut from its RIGHT edge at y in
    // [18,22], cut inward to x=25 — a concave outer with a notch of empty space
    // at x in [25,40], y in [18,22].
    const outer = [
      c(0, 0),
      c(40, 0),
      c(40, 18),
      c(25, 18), // into the slot
      c(25, 22),
      c(40, 22), // back out of the slot
      c(40, 40),
      c(0, 40),
    ];
    // Hole [10,30] x [10,30]: all 4 vertices land in solid material, yet its
    // right edge (x=30, y in [10,30]) passes through the empty slot (x in
    // [25,30] is outside the solid), so the hole is genuinely NOT contained.
    const hole = rect(10, 10, 20, 20);
    const v = checkMultiPolygonInvariants([[outer, hole]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.HoleNotContained)).toBe(true);
  });

  it('accepts a hole contained inside a concave (notched) outer when it stays clear of the notch', () => {
    // Same notched outer as above.
    const outer = [
      c(0, 0),
      c(40, 0),
      c(40, 18),
      c(25, 18),
      c(25, 22),
      c(40, 22),
      c(40, 40),
      c(0, 40),
    ];
    // A small hole well inside the solid region, not touching the notch.
    const hole = rect(5, 5, 6, 6);
    expect(isMultiPolygonValid([[outer, hole]])).toBe(true);
  });

  it('accepts a CONCAVE hole that hugs a notched outer boundary (no false rejection)', () => {
    // Regression for the vertex-centroid false positive: the hole is concave and
    // traces the solid material around the outer's right-side notch (empty at
    // x in [25,40], y in [18,22]). Every hole vertex is on/inside the outer and
    // no hole edge properly crosses an outer edge, so the hole IS contained — but
    // the hole's vertex-centroid (27.5, 20) sits in the empty notch (Outside),
    // which the old check (3) probe wrongly used to reject it.
    const outer = [
      c(0, 0),
      c(40, 0),
      c(40, 18),
      c(25, 18),
      c(25, 22),
      c(40, 22),
      c(40, 40),
      c(0, 40),
    ];
    const hole = [
      c(5, 5),
      c(40, 5),
      c(40, 18),
      c(25, 18),
      c(25, 22),
      c(40, 22),
      c(40, 35),
      c(5, 35),
    ];
    // Confirm the would-be probe point really is in the notch (Outside): its
    // centroid is (27.5, 20), the exact spot that triggered the false positive.
    expect(isMultiPolygonValid([[outer, hole]])).toBe(true);
  });

  it('flags a hole whose edge sweeps out through a notch MOUTH between two on-boundary vertices', () => {
    // Concave outer with a re-entrant notch: the tip is the single vertex (20,20)
    // and the notch mouth (x>20, y in (18,22)) is OUTSIDE the solid. A hole with
    // two vertices ON the outer boundary edges ((30,19) and (30,21)) and the edge
    // between them running across the notch mouth at (30,20) — which is Outside.
    // Every hole vertex is inside/on-boundary and NO hole edge Proper-crosses an
    // outer edge (contacts are endpoint-only), so the old Proper-only test passed
    // it as valid. The sub-segment midpoint test must now reject it.
    const outer = [
      c(0, 0),
      c(40, 0),
      c(40, 18),
      c(20, 20),
      c(40, 22),
      c(40, 40),
      c(0, 40),
    ];
    const hole = [c(10, 19.5), c(30, 19), c(30, 21), c(10, 20.5)];
    const v = checkMultiPolygonInvariants([[outer, hole]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.HoleNotContained)).toBe(true);
  });

  it('flags two polygon pieces whose solids overlap (disjoint-piece契约)', () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(5, 5, 10, 10);
    const v = checkMultiPolygonInvariants([[a], [b]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('accepts two disjoint polygon pieces', () => {
    const a = rect(0, 0, 10, 10);
    const b = rect(50, 50, 10, 10);
    expect(isMultiPolygonValid([[a], [b]])).toBe(true);
  });

  it('accepts a legal ENCLAVE: a piece nested inside another piece HOLE (飛び地)', () => {
    // piece0 = big outer with a central hole; piece1 = an island whose outer ring
    // sits entirely inside that hole. Solids do not overlap, so it is valid — the
    // overlap check must be hole-aware and NOT reject this.
    const outer = rect(0, 0, 100, 100);
    const hole = rect(30, 30, 40, 40);
    const island = rect(40, 40, 20, 20);
    expect(isMultiPolygonValid([[outer, hole], [island]])).toBe(true);
  });

  it('flags a piece poking through a CONCAVE hole notch: all its vertices lie in the hole (outside solid) but an edge crosses the notch wall into solid', () => {
    // Regression for the cross-piece overlap that the vertex-in-solid + outer-vs-
    // outer probes structurally miss. piece0 (B) is a 100x100 square with a
    // U-shaped (concave) hole: the hole box is [30,70]x[30,70] MINUS a right-side
    // solid tongue at [60,70]x[40,60] that juts into the hole. piece1 (A) is a
    // triangle whose three vertices all sit in the EMPTY part of the hole — so
    // every A vertex is OUTSIDE B's solid — yet one edge sweeps across the tongue
    // (x=65 from y=35 to y=65) into B's solid. The solids therefore overlap.
    const outer = rect(0, 0, 100, 100);
    const hole = [
      c(30, 30),
      c(70, 30),
      c(70, 40),
      c(60, 40),
      c(60, 60),
      c(70, 60),
      c(70, 70),
      c(30, 70),
    ];
    // Fixture sanity: the tongue interior is B's solid; the mouth is empty hole.
    expect(pointInPolygon(c(65, 50), [outer, hole])).toBe(POINT_LOCATION.Inside);
    expect(pointInPolygon(c(50, 50), [outer, hole])).toBe(POINT_LOCATION.Outside);

    // A triangle wholly inside the empty hole region (no edge crosses the tongue)
    // must remain VALID — guards against a false positive from the new probe.
    const clear = [c(40, 45), c(40, 55), c(58, 50)];
    for (const v of clear) {
      expect(pointInPolygon(v, [outer, hole])).toBe(POINT_LOCATION.Outside);
    }
    expect(isMultiPolygonValid([[outer, hole], [clear]])).toBe(true);

    // The intruder: every vertex is in the empty hole (outside B's solid), but the
    // edge (65,35)->(65,65) runs through the tongue solid (y in [40,60] at x=65).
    const intruder = [c(65, 35), c(65, 65), c(50, 50)];
    for (const v of intruder) {
      expect(pointInPolygon(v, [outer, hole])).toBe(POINT_LOCATION.Outside);
    }
    const v = checkMultiPolygonInvariants([[outer, hole], [intruder]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
    // Symmetric: order of pieces must not matter.
    const v2 = checkMultiPolygonInvariants([[intruder], [outer, hole]]);
    expect(v2.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('flags two overlapping holes within one polygon (disjoint-hole契约)', () => {
    const outer = rect(0, 0, 100, 100);
    const h1 = rect(10, 10, 30, 30);
    const h2 = rect(25, 25, 30, 30);
    const v = checkMultiPolygonInvariants([[outer, h1, h2]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('accepts two disjoint holes within one polygon', () => {
    const outer = rect(0, 0, 100, 100);
    const h1 = rect(10, 10, 20, 20);
    const h2 = rect(60, 60, 20, 20);
    expect(isMultiPolygonValid([[outer, h1, h2]])).toBe(true);
  });

  it('flags two IDENTICAL outer rings (duplicate polygon piece, 100% overlap)', () => {
    // Regression: for two coincident outers every edge pair is Collinear (never
    // Proper) and every vertex lies on the other ring's boundary (pointInPolygon
    // → Boundary, never Inside), so the proper-crossing + strictly-Inside-vertex
    // probes both miss it. A fully-coincident duplicate piece must NOT pass the
    // disjoint-piece契约.
    const piece = rect(0, 0, 10, 10);
    const dup = rect(0, 0, 10, 10);
    const v = checkMultiPolygonInvariants([[piece], [dup]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('flags a duplicate outer ring with extra COLLINEAR vertices (coincident area, no shared vertices strictly inside)', () => {
    // Same square, but the duplicate has an extra collinear midpoint vertex on the
    // bottom edge. Areas are identical, no vertex of one is strictly inside the
    // other, no edge Proper-crosses — only the boundary-coincidence test catches it.
    const piece = rect(0, 0, 10, 10);
    const dup = [c(0, 0), c(5, 0), c(10, 0), c(10, 10), c(0, 10)];
    const v = checkMultiPolygonInvariants([[piece], [dup]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('flags two IDENTICAL holes within one polygon (duplicate hole, 100% overlap)', () => {
    const outer = rect(0, 0, 100, 100);
    const h1 = rect(20, 20, 30, 30);
    const h2 = rect(20, 20, 30, 30);
    const v = checkMultiPolygonInvariants([[outer, h1, h2]]);
    expect(v.some((x) => x.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(true);
  });

  it('does NOT flag two legal edge-adjacent pieces sharing a border (boundary touch is not overlap)', () => {
    // Two squares sharing the full vertical edge x=10. Both CCW, so they traverse
    // the shared edge in OPPOSITE directions → interiors on OPPOSITE sides → the
    // coincidence test must NOT report overlap (FR-26 境界の接触は重なりに含めない).
    const left = rect(0, 0, 10, 10);
    const right = rect(10, 0, 10, 10);
    expect(isMultiPolygonValid([[left], [right]])).toBe(true);
  });

  it('does NOT flag a legal enclave even when probed by the coincidence test', () => {
    // The enclave's outer is nested inside the parent HOLE: outers share no
    // boundary run, so the coincidence test returns false (no false positive).
    const outer = rect(0, 0, 100, 100);
    const hole = rect(30, 30, 40, 40);
    const island = rect(40, 40, 20, 20);
    expect(isMultiPolygonValid([[outer, hole], [island]])).toBe(true);
  });

  it('property: a duplicate of any rectangle piece is always flagged as overlapping', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -160, max: 0, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: -80, max: 0, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
        fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
        (x, y, w, h) => {
          const a = rect(x, y, w, h);
          const b = rect(x, y, w, h);
          // As duplicate pieces.
          const piecesV = checkMultiPolygonInvariants([[a], [b]]);
          expect(piecesV.some((vi) => vi.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(
            true,
          );
          // As duplicate holes inside a large enclosing outer.
          const big = rect(-170, -85, 339, 169);
          const holesV = checkMultiPolygonInvariants([[big, a, b]]);
          expect(holesV.some((vi) => vi.kind === INVARIANT_VIOLATION.OverlappingPieces)).toBe(
            true,
          );
        },
      ),
    );
  });

  it('property: a hole built strictly inside a concave (notched) outer is always valid', () => {
    // Concave outer: a 40x40 square with a right-side rectangular notch removed
    // at y in [yLo, yHi], cut inward to xNotch. A hole built strictly within the
    // LEFT solid sub-rectangle [margin, xNotch-margin] x [margin, 40-margin] is
    // always contained, regardless of the hole's concavity, so isMultiPolygonValid
    // must never reject it.
    fc.assert(
      fc.property(
        fc.double({ min: 6, max: 18, noNaN: true }), // xNotch (>= margin+1)
        fc.double({ min: 5, max: 17, noNaN: true }), // yLo of notch
        fc.double({ min: 1, max: 4, noNaN: true }), // hole x offset within solid
        fc.double({ min: 1, max: 4, noNaN: true }), // hole y offset
        fc.double({ min: 1, max: 6, noNaN: true }), // hole width
        fc.double({ min: 1, max: 6, noNaN: true }), // hole height
        (xNotch, yLo, hx, hy, hw, hh) => {
          const yHi = yLo + 4;
          const outer = [
            c(0, 0),
            c(40, 0),
            c(40, yLo),
            c(xNotch, yLo),
            c(xNotch, yHi),
            c(40, yHi),
            c(40, 40),
            c(0, 40),
          ];
          // Hole confined to the left solid column x in [hx, hx+hw] with
          // hx+hw <= xNotch - 1, comfortably clear of the notch and outer edges.
          const x0 = hx;
          const x1 = Math.min(hx + hw, xNotch - 1);
          const y0 = 2 + hy;
          const y1 = Math.min(2 + hy + hh, 38);
          if (x1 - x0 < 0.5 || y1 - y0 < 0.5) return; // skip degenerate draws
          const hole = rect(x0, y0, x1 - x0, y1 - y0);
          expect(isMultiPolygonValid([[outer, hole]])).toBe(true);
        },
      ),
    );
  });
});
