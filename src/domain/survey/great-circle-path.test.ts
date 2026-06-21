import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createGeoParams } from '../geo/geo-params';
import { greatCircleDistanceKm, lineLengthKm } from '../geo/geodesy';
import { DISTANCE_MEASURE } from '../geo/geodesy';
import {
  DEGREES_PER_SEGMENT,
  MAX_PATH_SEGMENTS,
  MIN_PATH_SEGMENTS,
  equirectangularPath,
  greatCirclePath,
  segmentCountForAngle,
} from './great-circle-path';

const EARTH = createGeoParams(40075, 0); // ~Earth equator, true sphere

describe('segmentCountForAngle (adaptive subdivision)', () => {
  it('returns the minimum for a zero / degenerate angle', () => {
    expect(segmentCountForAngle(0)).toBe(MIN_PATH_SEGMENTS);
    expect(segmentCountForAngle(-5)).toBe(MIN_PATH_SEGMENTS);
    expect(segmentCountForAngle(NaN)).toBe(MIN_PATH_SEGMENTS);
  });

  it('scales with the arc and clamps to the maximum', () => {
    expect(segmentCountForAngle(DEGREES_PER_SEGMENT)).toBe(1);
    expect(segmentCountForAngle(180)).toBeLessThanOrEqual(MAX_PATH_SEGMENTS);
    expect(segmentCountForAngle(100000)).toBe(MAX_PATH_SEGMENTS);
  });
});

describe('greatCirclePath endpoints (AC-3 端点一致)', () => {
  it('begins exactly at the start and ends exactly at the end', () => {
    const a = { lon: 10, lat: 20 };
    const b = { lon: 80, lat: -15 };
    const path = greatCirclePath(a, b);
    const first = path[0];
    const last = path[path.length - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    expect(first?.lon).toBeCloseTo(a.lon, 9);
    expect(first?.lat).toBeCloseTo(a.lat, 9);
    // End longitude is continuous (shortest-delta from start); lat is exact.
    expect(last?.lat).toBeCloseTo(b.lat, 9);
  });

  it('handles identical endpoints without NaN (退化入力)', () => {
    const a = { lon: 30, lat: 40 };
    const path = greatCirclePath(a, a);
    expect(path.length).toBeGreaterThanOrEqual(2);
    for (const p of path) {
      expect(Number.isFinite(p.lon)).toBe(true);
      expect(Number.isFinite(p.lat)).toBe(true);
    }
  });

  // L8 root fix: a near-antipodal pair gives ω ≈ π, where `Math.sin(π) ≈ 1.22e-16`
  // is NON-ZERO — so the old exact-zero guard `omega === 0 || sinOmega === 0` never
  // fired, and slerp divided by a ~1e-10 denominator (an ill-conditioned op: a
  // near-antipodal great circle has no unique shortest path, so the bow is
  // arbitrary). The tolerance guard `|sin(ω)| < SLERP_MIN_SIN` now catches this and
  // returns the deterministic straight endpoint pair instead, the SAME safe
  // degenerate result the exact-zero case already gave. We assert that contract: a
  // near-antipodal request degrades to the 2-point fallback, with finite, pole-free
  // coordinates (never NaN, never a division blow-up).
  it('near-antipodal endpoints degrade to the stable 2-point fallback, not an ill-conditioned slerp (L8)', () => {
    const a = { lon: 0, lat: 10 };
    // Exact antipode of a is (180, −10); nudge so the EXACT-π branch is NOT taken
    // but ω is within ~1e-8° of π (sin(ω) ~ 2.4e-10, below SLERP_MIN_SIN = 1e-9).
    const b = { lon: 180 - 1e-8, lat: -10 };
    const path = greatCirclePath(a, b);
    // Fallback is the two endpoints only — no interior slerp points to blow up.
    expect(path).toHaveLength(2);
    for (const p of path) {
      expect(Number.isFinite(p.lon)).toBe(true);
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Math.abs(p.lat)).toBeLessThanOrEqual(90);
    }
    const first = path[0];
    const last = path[path.length - 1];
    expect(first?.lat).toBeCloseTo(a.lat, 9);
    expect(last?.lat).toBeCloseTo(b.lat, 9);
  });

  it('exact antipode is finite and stable (退化入力)', () => {
    const a = { lon: 0, lat: 10 };
    const b = { lon: 180, lat: -10 }; // exact antipode of a.
    const path = greatCirclePath(a, b);
    expect(path).toHaveLength(2);
    for (const p of path) {
      expect(Number.isFinite(p.lat)).toBe(true);
      expect(Number.isFinite(p.lon)).toBe(true);
    }
  });
});

describe('polyline length ≈ U04 great-circle distance (定義のドリフト防止, AC-3)', () => {
  it('the interpolated polyline total length matches U04 within tolerance', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -170, max: 170, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: -170, max: 170, noNaN: true }),
        fc.double({ min: -80, max: 80, noNaN: true }),
        (lonA, latA, lonB, latB) => {
          const a = { lon: lonA, lat: latA };
          const b = { lon: lonB, lat: latB };
          const path = greatCirclePath(a, b);
          const polylineKm = lineLengthKm(path, EARTH, DISTANCE_MEASURE.GreatCircle);
          const directKm = greatCircleDistanceKm(a, b, EARTH);
          // Chord-vs-arc error of the slerp polyline is tiny at ~2°/segment.
          const tol = Math.max(1, directKm * 0.001);
          expect(Math.abs(polylineKm - directKm)).toBeLessThanOrEqual(tol);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('continuous longitude across the seam (FR-14 折り返し非分断, AC-2)', () => {
  it('an east-edge<->west-edge line stays one connected run (no 359° jump)', () => {
    const a = { lon: 179, lat: 0 };
    const b = { lon: -179, lat: 0 };
    const path = greatCirclePath(a, b);
    // Adjacent longitude gaps must all be small (< ~3°), never a ~358° spring.
    for (let i = 1; i < path.length; i += 1) {
      const prev = path[i - 1];
      const curr = path[i];
      expect(prev).toBeDefined();
      expect(curr).toBeDefined();
      if (prev && curr) {
        expect(Math.abs(curr.lon - prev.lon)).toBeLessThan(3);
      }
    }
  });

  it('start longitude is anchored exactly to the clicked scalar', () => {
    const a = { lon: 179, lat: 10 };
    const b = { lon: -170, lat: 10 };
    const path = greatCirclePath(a, b);
    expect(path[0]?.lon).toBe(179);
  });
});

describe('equirectangularPath (FR-15 直線, distinct from the curve)', () => {
  it('is the two endpoints with a continuous (shortest-delta) longitude run', () => {
    const a = { lon: 179, lat: 0 };
    const b = { lon: -179, lat: 0 };
    const path = equirectangularPath(a, b);
    expect(path.length).toBe(2);
    expect(path[0]?.lon).toBe(179);
    // End lon = start + shortest delta (+2°), i.e. 181 — continuous, not -179.
    expect(path[1]?.lon).toBeCloseTo(181, 9);
    expect(path[1]?.lat).toBe(0);
  });
});

describe('±360k wrap-invariance of the drawn path shape (AC-2)', () => {
  it('shifting both endpoints by +360k shifts the whole run by the same amount', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        fc.double({ min: -150, max: 150, noNaN: true }),
        fc.double({ min: -70, max: 70, noNaN: true }),
        fc.integer({ min: -2, max: 2 }),
        (lonA, latA, lonB, latB, k) => {
          const base = greatCirclePath({ lon: lonA, lat: latA }, { lon: lonB, lat: latB });
          const shifted = greatCirclePath(
            { lon: lonA + 360 * k, lat: latA },
            { lon: lonB + 360 * k, lat: latB },
          );
          expect(shifted.length).toBe(base.length);
          for (let i = 0; i < base.length; i += 1) {
            const b0 = base[i];
            const s0 = shifted[i];
            if (b0 && s0) {
              expect(s0.lon - b0.lon).toBeCloseTo(360 * k, 3);
              expect(s0.lat).toBeCloseTo(b0.lat, 6);
            }
          }
        },
      ),
    );
  });
});
