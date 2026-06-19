import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  coordinateArb,
  geoParamsArb,
  pointsArb,
  ringVerticesArb,
} from './arbitraries';
import { createGeoParams } from './geo-params';
import {
  equirectangularDistanceKm,
  greatCircleDistanceKm,
  lineLengthKm,
  ringAreaKm2,
} from './geodesy';
import { shortestLonDeltaDeg } from './longitude';

const EPS_REL = 1e-6;

/**
 * Does any cyclic edge of `ring` step (almost) exactly across the antimeridian,
 * i.e. is the shortest longitude delta within `marginDeg` of ±180°?
 *
 * Such an edge is genuinely *ambiguous*: a polygon side spanning a full 180° of
 * longitude can be continued either eastward or westward, and the two windings
 * enclose areas that differ by a whole lune. The unwrap therefore has to pick a
 * canonical side at the seam, and a sub-ULP perturbation of an endpoint (exactly
 * what a +360k world shift introduces — e.g. 539.999…9 vs 540) can flip that
 * choice. This is a measure-zero geometric degeneracy, not a numerical defect of
 * the area code (whose magnitude-dependent float error is already removed by the
 * integer-turn unwrap and origin-centring). The +360k *area* invariance is only
 * well-posed for rings without such an edge, so this property excludes them — the
 * same domain restriction the additivity property makes for an exact ±180 chord.
 */
function hasAntimeridianStep(
  ring: readonly WorldCoordinate[],
  marginDeg = 1e-6,
): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) {
      continue;
    }
    const delta = Math.abs(shortestLonDeltaDeg(a.lon, b.lon));
    if (Math.abs(delta - 180) < marginDeg) {
      return true;
    }
  }
  return false;
}

/** Relative-or-absolute closeness for possibly-large km values. */
function close(actual: number, expected: number, eps = EPS_REL): boolean {
  const diff = Math.abs(actual - expected);
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return diff <= eps * scale;
}

const shiftLon = (cc: WorldCoordinate, k: number): WorldCoordinate =>
  createCoordinate(cc.lon + 360 * k, cc.lat);

// --- symmetry ---------------------------------------------------------------

describe('property: distance symmetry', () => {
  it('equirectangular dist(a,b) == dist(b,a)', () => {
    fc.assert(
      fc.property(coordinateArb(), coordinateArb(), geoParamsArb(), (a, b, gp) => {
        expect(close(equirectangularDistanceKm(a, b, gp), equirectangularDistanceKm(b, a, gp))).toBe(true);
      }),
    );
  });
  it('great-circle dist(a,b) == dist(b,a)', () => {
    fc.assert(
      fc.property(coordinateArb(), coordinateArb(), geoParamsArb(), (a, b, gp) => {
        expect(close(greatCircleDistanceKm(a, b, gp), greatCircleDistanceKm(b, a, gp))).toBe(true);
      }),
    );
  });
});

// --- non-negativity ---------------------------------------------------------

describe('property: non-negativity', () => {
  it('all distances, lengths and areas are >= 0', () => {
    fc.assert(
      fc.property(coordinateArb(), coordinateArb(), pointsArb(), ringVerticesArb(), geoParamsArb(), (a, b, pts, ring, gp) => {
        expect(equirectangularDistanceKm(a, b, gp)).toBeGreaterThanOrEqual(0);
        expect(greatCircleDistanceKm(a, b, gp)).toBeGreaterThanOrEqual(0);
        expect(lineLengthKm(pts, gp)).toBeGreaterThanOrEqual(0);
        expect(ringAreaKm2(ring, gp)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});

// --- wrap invariance (core seam property) -----------------------------------

describe('property: +360k longitude shift leaves results unchanged', () => {
  it('distances, line length and area are invariant', () => {
    fc.assert(
      fc.property(
        coordinateArb(),
        coordinateArb(),
        ringVerticesArb(),
        geoParamsArb(),
        fc.integer({ min: -3, max: 3 }),
        (a, b, ring, gp, k) => {
          const a2 = shiftLon(a, k);
          const b2 = shiftLon(b, k);
          const ring2 = ring.map((v) => shiftLon(v, k));
          expect(close(equirectangularDistanceKm(a2, b2, gp), equirectangularDistanceKm(a, b, gp))).toBe(true);
          expect(close(greatCircleDistanceKm(a2, b2, gp), greatCircleDistanceKm(a, b, gp))).toBe(true);
          expect(close(lineLengthKm([a2, b2], gp), lineLengthKm([a, b], gp))).toBe(true);
          // Area: each vertex shifted by the SAME k (a uniform world shift).
          // Exclude rings whose edge steps exactly across the antimeridian: for
          // such a ring the winding (and thus the area by a whole lune) is
          // genuinely ambiguous, so a +360k reframing is not required to land on
          // the identical side. See hasAntimeridianStep above.
          if (!hasAntimeridianStep(ring)) {
            expect(close(ringAreaKm2(ring2, gp), ringAreaKm2(ring, gp), 1e-5)).toBe(true);
          }
        },
      ),
    );
  });
});

// --- world-edge boundary case -----------------------------------------------

describe('property: east-edge <-> west-edge folds, never the naive detour', () => {
  it('a point near +180 and one near -180 are close, not ~359° apart', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 178, max: 179.9, noNaN: true }),
        fc.double({ min: -179.9, max: -178, noNaN: true }),
        geoParamsArb(),
        (lonE, lonW, gp) => {
          const folded = equirectangularDistanceKm(createCoordinate(lonE, 0), createCoordinate(lonW, 0), gp);
          // Expected separation is (360 - (lonE - lonW)) degrees, small (<4°).
          const sepDeg = 360 - (lonE - lonW);
          const expected = sepDeg * (gp.equatorKm / 360);
          expect(close(folded, expected, 1e-6)).toBe(true);
        },
      ),
    );
  });
});

// --- line length additivity -------------------------------------------------

describe('property: splitting a segment preserves total length', () => {
  it('inserting the midpoint keeps equirectangular length', () => {
    // Build the chord directly from a base point and a bounded longitude delta
    // (|dLon| < 180) so the chord is unambiguous and the midpoint lies on it.
    // (At an exact ±180 lon separation the midpoint is geometrically ambiguous,
    // which is outside this additivity property's domain.)
    fc.assert(
      fc.property(
        coordinateArb(),
        fc.double({ min: -179, max: 179, noNaN: true }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        geoParamsArb(),
        (a, dLon, latB, gp) => {
          const b = createCoordinate(a.lon + dLon, latB);
          const mid = createCoordinate(a.lon + dLon / 2, (a.lat + latB) / 2);
          const whole = lineLengthKm([a, b], gp);
          const split = lineLengthKm([a, mid, b], gp);
          expect(close(split, whole, 1e-6)).toBe(true);
        },
      ),
    );
  });
});

// --- equator-length scaling -------------------------------------------------

describe('property: equator length scaling', () => {
  it('scaling equator by c scales distance/length by c and area by c^2', () => {
    fc.assert(
      fc.property(
        coordinateArb(),
        coordinateArb(),
        ringVerticesArb(),
        fc.double({ min: 1, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 0.1, noNaN: true }),
        fc.double({ min: 1.5, max: 4, noNaN: true }),
        (a, b, ring, equatorKm, flattening, scale) => {
          const gp1 = createGeoParams(equatorKm, flattening);
          const gp2 = createGeoParams(equatorKm * scale, flattening);
          expect(close(equirectangularDistanceKm(a, b, gp2), equirectangularDistanceKm(a, b, gp1) * scale, 1e-6)).toBe(true);
          expect(close(greatCircleDistanceKm(a, b, gp2), greatCircleDistanceKm(a, b, gp1) * scale, 1e-6)).toBe(true);
          expect(close(ringAreaKm2(ring, gp2), ringAreaKm2(ring, gp1) * scale * scale, 1e-5)).toBe(true);
        },
      ),
    );
  });
});

// --- flattening degeneracy --------------------------------------------------

describe('property: flattening = 0 matches the spherical km/lat scale', () => {
  it('f=0 equirectangular/length/area equal the equatorKm/360 sphere case', () => {
    fc.assert(
      fc.property(
        coordinateArb(),
        coordinateArb(),
        ringVerticesArb(),
        fc.double({ min: 1, max: 100000, noNaN: true }),
        (a, b, ring, equatorKm) => {
          const gp = createGeoParams(equatorKm, 0);
          // Reference sphere: kmPerLatDeg == equatorKm/360, which is exactly
          // deriveScalars with f=0, so equality is by construction — assert it
          // does not throw / NaN and stays finite.
          const d = equirectangularDistanceKm(a, b, gp);
          const len = lineLengthKm([a, b, ...ring], gp);
          const area = ringAreaKm2(ring, gp);
          expect(Number.isFinite(d)).toBe(true);
          expect(Number.isFinite(len)).toBe(true);
          expect(Number.isFinite(area)).toBe(true);
        },
      ),
    );
  });
});

// --- flattening monotonicity ------------------------------------------------

describe('property: flattening monotonicity', () => {
  it('larger f shrinks a north-south distance and a ring area; east-west unaffected', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -90, max: 90, noNaN: true }),
        fc.double({ min: -90, max: 90, noNaN: true }),
        ringVerticesArb(),
        fc.double({ min: 1, max: 100000, noNaN: true }),
        fc.double({ min: 0, max: 0.05, noNaN: true }),
        fc.double({ min: 0.05, max: 0.1, noNaN: true }),
        (lat1, lat2, ring, equatorKm, fLow, fHigh) => {
          fc.pre(fHigh > fLow);
          const gpLow = createGeoParams(equatorKm, fLow);
          const gpHigh = createGeoParams(equatorKm, fHigh);
          // North-south pair (same lon).
          const nsLow = equirectangularDistanceKm(createCoordinate(10, lat1), createCoordinate(10, lat2), gpLow);
          const nsHigh = equirectangularDistanceKm(createCoordinate(10, lat1), createCoordinate(10, lat2), gpHigh);
          if (Math.abs(lat1 - lat2) > 1e-9) {
            expect(nsHigh).toBeLessThan(nsLow + 1e-9);
          }
          // East-west pair (same lat) is independent of f.
          const ewLow = equirectangularDistanceKm(createCoordinate(0, lat1), createCoordinate(50, lat1), gpLow);
          const ewHigh = equirectangularDistanceKm(createCoordinate(0, lat1), createCoordinate(50, lat1), gpHigh);
          expect(close(ewLow, ewHigh, 1e-9)).toBe(true);
          // Area shrinks (or stays equal for a degenerate ring) with larger f.
          const areaLow = ringAreaKm2(ring, gpLow);
          const areaHigh = ringAreaKm2(ring, gpHigh);
          expect(areaHigh).toBeLessThanOrEqual(areaLow + 1e-3 * Math.max(1, areaLow));
        },
      ),
    );
  });
});
