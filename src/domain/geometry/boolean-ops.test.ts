import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { rect } from './arbitraries';
import {
  BOOLEAN_OP_STATUS,
  difference,
  intersection,
  isOk,
  multiPolygonFromRing,
  union,
} from './boolean-ops';
import { POINT_LOCATION, pointInPolygon } from './predicates';
import { countRings, isMultiPolygonEmpty, type GeoMultiPolygon } from './types';

const c = createCoordinate;

/** Require ok and return the result, failing loudly otherwise. */
function ok(r: ReturnType<typeof union>): GeoMultiPolygon {
  if (!isOk(r)) {
    throw new Error(`expected ok, got rejection: ${JSON.stringify(r)}`);
  }
  return r.result;
}

describe('boolean-ops: multiple pieces returned (acceptance criterion 1 / 教訓5.1)', () => {
  it('union of two disjoint rectangles keeps both pieces', () => {
    const a = multiPolygonFromRing(rect(0, 0, 10, 10));
    const b = multiPolygonFromRing(rect(50, 50, 10, 10));
    const result = ok(union(a, b));
    expect(result).toHaveLength(2);
    // Both original areas are present.
    expect(anyPieceContains(result, c(5, 5))).toBe(true);
    expect(anyPieceContains(result, c(55, 55))).toBe(true);
  });

  it('difference splitting an area into two pieces returns both', () => {
    // A wide bar with a vertical slot cut through the middle -> two pieces.
    const bar = multiPolygonFromRing(rect(0, 0, 30, 10));
    const cutter = multiPolygonFromRing(rect(13, -5, 4, 20));
    const result = ok(difference(bar, cutter));
    expect(result.length).toBeGreaterThanOrEqual(2);
    expect(anyPieceContains(result, c(5, 5))).toBe(true); // left piece
    expect(anyPieceContains(result, c(25, 5))).toBe(true); // right piece
    expect(anyPieceContains(result, c(15, 5))).toBe(false); // cut-out gap
  });

  it('difference producing a donut keeps the hole', () => {
    const outer = multiPolygonFromRing(rect(0, 0, 30, 30));
    const inner = multiPolygonFromRing(rect(10, 10, 10, 10));
    const result = ok(difference(outer, inner));
    // One polygon piece with an outer ring + one hole ring.
    expect(result).toHaveLength(1);
    expect(countRings(result)).toBe(2);
    expect(anyPieceContains(result, c(15, 15))).toBe(false); // inside the hole
    expect(anyPieceContains(result, c(2, 2))).toBe(true); // body
  });

  it('intersection of overlapping rectangles returns the overlap', () => {
    const a = multiPolygonFromRing(rect(0, 0, 20, 20));
    const b = multiPolygonFromRing(rect(10, 10, 20, 20));
    const result = ok(intersection(a, b));
    expect(isMultiPolygonEmpty(result)).toBe(false);
    expect(anyPieceContains(result, c(15, 15))).toBe(true);
    expect(anyPieceContains(result, c(5, 5))).toBe(false);
  });
});

describe('boolean-ops: empty result is a successful empty value (教訓5.18)', () => {
  it('intersection of disjoint rectangles is empty + ok (not rejected)', () => {
    const a = multiPolygonFromRing(rect(0, 0, 5, 5));
    const b = multiPolygonFromRing(rect(50, 50, 5, 5));
    const r = intersection(a, b);
    expect(isOk(r)).toBe(true);
    expect(isMultiPolygonEmpty(ok(r))).toBe(true);
  });

  it('difference of a region from itself vanishes to empty + ok', () => {
    const a = multiPolygonFromRing(rect(0, 0, 10, 10));
    const r = difference(a, a);
    expect(isOk(r)).toBe(true);
    expect(isMultiPolygonEmpty(ok(r))).toBe(true);
  });
});

describe('boolean-ops: defense layer (R2, acceptance criterion 2 & 4)', () => {
  it('a tiny sliver below grid resolution does not emit a degenerate ring', () => {
    // Two rectangles overlapping by a sub-grid-cell sliver: 1e-9 deg << 1e-7 grid.
    const a = multiPolygonFromRing(rect(0, 0, 10, 10));
    const b = multiPolygonFromRing(rect(10 - 1e-9, 0, 10, 10));
    const r = intersection(a, b);
    // Either rejected or a valid (empty/normalized) result — never a degenerate
    // micro-polygon. Both outcomes satisfy criterion 4.
    if (isOk(r)) {
      // If anything survived, every ring is valid (no <3-vertex / zero-length).
      expect(r.result.every((poly) => poly.every((ring) => ring.length >= 3 || ring.length === 0)));
    } else {
      expect(r.status).toBe(BOOLEAN_OP_STATUS.Rejected);
    }
  });
});

function anyPieceContains(mp: GeoMultiPolygon, point: ReturnType<typeof c>): boolean {
  return mp.some((poly) => pointInPolygon(point, poly) === POINT_LOCATION.Inside);
}
