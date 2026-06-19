// Domain (geometry): fast-check generators for U06 boolean-op / invariant
// property tests (R7). Defined once and reused by the property tests so the
// degenerate, multi-piece and boundary shapes are generated consistently.
// Coordinates go through the real `createCoordinate` factory (lesson 5.39).
//
// Imports fast-check (a devDependency); consumed exclusively by *.test.ts files.

import fc from 'fast-check';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import type { GeoMultiPolygon, GeoRing } from './types';

/** A coordinate on a modest integer-ish grid so quantization is exercised. */
export function coordArb(): fc.Arbitrary<WorldCoordinate> {
  return fc
    .tuple(
      fc.double({ min: -170, max: 170, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -85, max: 85, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([lon, lat]) => createCoordinate(lon, lat));
}

/**
 * An axis-aligned rectangle ring (always simple, CCW), parameterized by its two
 * corners. A reliably-valid input so a property can assert "ok results are
 * always valid" without being starved by mostly-degenerate random rings.
 */
export function rectRingArb(): fc.Arbitrary<GeoRing> {
  return fc
    .tuple(
      fc.double({ min: -160, max: 0, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: -80, max: 0, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
      fc.double({ min: 1, max: 80, noNaN: true, noDefaultInfinity: true }),
    )
    .map(([x, y, w, h]) => rect(x, y, w, h));
}

/** Build a CCW axis-aligned rectangle ring (open, no repeated first vertex). */
export function rect(x: number, y: number, w: number, h: number): GeoRing {
  return [
    createCoordinate(x, y),
    createCoordinate(x + w, y),
    createCoordinate(x + w, y + h),
    createCoordinate(x, y + h),
  ];
}

/** A single-rectangle multi-polygon (one outer ring, no holes). */
export function rectMultiPolygonArb(): fc.Arbitrary<GeoMultiPolygon> {
  return rectRingArb().map((ring) => [[ring]]);
}
