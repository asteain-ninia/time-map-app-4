import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { rect } from './arbitraries';
import {
  INVARIANT_VIOLATION,
  checkMultiPolygonInvariants,
  isMultiPolygonValid,
} from './invariants';
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
