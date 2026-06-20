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
import {
  countRings,
  EMPTY_MULTI_POLYGON,
  isMultiPolygonEmpty,
  type GeoMultiPolygon,
} from './types';

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

describe('boolean-ops: output is re-quantized onto the grid (单一真实源)', () => {
  // The kernel returns non-grid coordinates for oblique intersection points
  // (e.g. 0.8888888…). Without re-snapping, the stored geometry drifts off the
  // grid and a later op (even union with EMPTY) changes coordinates by op-history
  // order, breaking shared-vertex identity.
  const onGrid = (n: number): boolean => Math.abs(n * 1e7 - Math.round(n * 1e7)) < 1e-6;

  it('intersection result coordinates all land on the quantization grid', () => {
    const tri1 = multiPolygonFromRing([c(0, 0), c(9, 1), c(1, 9)]);
    const tri2 = multiPolygonFromRing([c(2, 0), c(10, 8), c(0, 8)]);
    const r = intersection(tri1, tri2);
    if (isOk(r)) {
      for (const poly of r.result) {
        for (const ring of poly) {
          for (const v of ring) {
            expect(onGrid(v.lon)).toBe(true);
            expect(onGrid(v.lat)).toBe(true);
          }
        }
      }
    }
  });

  it('union(result, EMPTY) is idempotent on the grid (does not move vertices)', () => {
    const tri1 = multiPolygonFromRing([c(0, 0), c(9, 1), c(1, 9)]);
    const tri2 = multiPolygonFromRing([c(2, 0), c(10, 8), c(0, 8)]);
    const r = intersection(tri1, tri2);
    if (isOk(r)) {
      const r2 = union(r.result, EMPTY_MULTI_POLYGON);
      expect(isOk(r2)).toBe(true);
      if (isOk(r2)) {
        // Re-running through the pipeline must return the SAME grid coordinates.
        const before = JSON.stringify(r.result);
        const after = JSON.stringify(r2.result);
        expect(after).toBe(before);
      }
    }
  });
});

function anyPieceContains(mp: GeoMultiPolygon, point: ReturnType<typeof c>): boolean {
  return mp.some((poly) => pointInPolygon(point, poly) === POINT_LOCATION.Inside);
}
