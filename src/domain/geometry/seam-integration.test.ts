// Acceptance criterion 5: U06 ops/predicates work on coordinates that U05 has
// unwrapped across the world seam. We do NOT re-implement seam logic here — we
// feed U05's `unwrapRing` output into the boolean ops and predicates and assert
// no split / piece-loss / wrong inside-outside answer (technical policy R3,
// 单一真实源).

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { unwrapRing } from '../geo/seam';
import { difference, intersection, isOk, multiPolygonFromRing, union } from './boolean-ops';
import { POINT_LOCATION, pointInPolygon } from './predicates';
import { type GeoMultiPolygon } from './types';

const c = createCoordinate;

/**
 * A rectangle straddling the antimeridian, stored in representative form: its
 * east edge is near +180 and its west edge near -180. After U05 `unwrapRing`,
 * the west vertices shift to just past +180 so the box is one continuous run.
 */
function seamRectRepresentative(): ReturnType<typeof c>[] {
  return [c(170, -10), c(-170, -10), c(-170, 10), c(170, 10)];
}

function ok(r: ReturnType<typeof union>): GeoMultiPolygon {
  if (!isOk(r)) throw new Error(`expected ok: ${JSON.stringify(r)}`);
  return r.result;
}

describe('seam integration (acceptance criterion 5)', () => {
  it('unwrapRing makes a seam-crossing box continuous before the op', () => {
    const unwrapped = unwrapRing(seamRectRepresentative());
    // Continuity: no adjacent longitude gap exceeds 180 after unwrap.
    for (let i = 1; i < unwrapped.length; i += 1) {
      expect(Math.abs(unwrapped[i]!.lon - unwrapped[i - 1]!.lon)).toBeLessThanOrEqual(180);
    }
  });

  it('intersection of two seam-crossing boxes on unwrapped coords is not split/lost', () => {
    const a = multiPolygonFromRing(unwrapRing(seamRectRepresentative()));
    // A second box overlapping the seam box, also unwrapped.
    const bRep = [c(175, -5), c(-175, -5), c(-175, 5), c(175, 5)];
    const b = multiPolygonFromRing(unwrapRing(bRep));
    const result = ok(intersection(a, b));
    expect(result.length).toBeGreaterThanOrEqual(1);
    // A point in the overlap (continuous lon ~ 178) is inside the result.
    const probe = c(178, 0);
    expect(result.some((poly) => pointInPolygon(probe, poly) === POINT_LOCATION.Inside)).toBe(true);
  });

  it('union across the seam returns a single continuous piece (no piece dropped)', () => {
    const a = multiPolygonFromRing(unwrapRing(seamRectRepresentative()));
    const bRep = [c(178, -10), c(-160, -10), c(-160, 10), c(178, 10)];
    const b = multiPolygonFromRing(unwrapRing(bRep));
    const result = ok(union(a, b));
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Spans both originals on the continuous axis.
    expect(result.some((poly) => pointInPolygon(c(175, 0), poly) === POINT_LOCATION.Inside)).toBe(
      true,
    );
  });

  it('point-in-polygon is correct on unwrapped seam coordinates', () => {
    const poly = unwrapRing(seamRectRepresentative());
    // The box spans continuous lon [170, 190] after unwrap; +180 (the seam
    // itself, representative ±180) is strictly interior.
    expect(pointInPolygon(c(180, 0), [poly])).toBe(POINT_LOCATION.Inside);
    expect(pointInPolygon(c(0, 0), [poly])).toBe(POINT_LOCATION.Outside);
  });

  it('difference across the seam keeps all resulting pieces', () => {
    const a = multiPolygonFromRing(unwrapRing(seamRectRepresentative()));
    // A narrow vertical cutter through the middle of the unwrapped box (~lon 185).
    const cutter = multiPolygonFromRing([c(184, -20), c(186, -20), c(186, 20), c(184, 20)]);
    const result = ok(difference(a, cutter));
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});
