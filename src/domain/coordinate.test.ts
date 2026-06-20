import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { createCoordinate, withLat, withLon } from './coordinate';

// Regression for the bug-hunt finding:
//   "save->load identity collapses negative-zero (-0) coordinates to +0 under
//    JSON serialization"
//
// `-0` and `+0` denote the same geographic point (`-0 === 0`), but JSON drops the
// sign (`JSON.stringify(-0) === '0'`), so a JSON-based save->load round-trip is
// NOT a strict (Object.is) identity unless the construction seam normalizes the
// sign. `createCoordinate` (and the `withXxx` mutators that route through it) is
// that single seam: it must mint `+0` so the in-memory form matches the persisted
// form. `-0` is reachable from ordinary upstream arithmetic, e.g. `(-180) % 180`.

describe('createCoordinate — signed-zero normalization (JSON round-trip identity)', () => {
  it('normalizes a -0 longitude to +0 at construction', () => {
    const c = createCoordinate(-0, 5);
    expect(Object.is(c.lon, 0)).toBe(true); // +0, not -0
    expect(Object.is(c.lon, -0)).toBe(false);
    expect(c.lat).toBe(5);
  });

  it('normalizes a -0 latitude to +0 at construction', () => {
    const c = createCoordinate(5, -0);
    expect(Object.is(c.lat, 0)).toBe(true);
    expect(Object.is(c.lat, -0)).toBe(false);
    expect(c.lon).toBe(5);
  });

  it('normalizes -0 produced by upstream arithmetic (e.g. (-180) % 180)', () => {
    // The arbitrary fixture mints lon = seed % 180; for seed = -180 this is -0.
    const lon = -180 % 180; // -0
    const lat = -90 % 90; //   -0
    expect(Object.is(lon, -0)).toBe(true); // sanity: arithmetic really yields -0
    expect(Object.is(lat, -0)).toBe(true);
    const c = createCoordinate(lon, lat);
    expect(Object.is(c.lon, 0)).toBe(true);
    expect(Object.is(c.lat, 0)).toBe(true);
  });

  it('withLon / withLat also normalize -0 to +0 (same seam)', () => {
    const base = createCoordinate(1, 2);
    expect(Object.is(withLon(base, -0).lon, 0)).toBe(true);
    expect(Object.is(withLat(base, -0).lat, 0)).toBe(true);
  });

  it('leaves every other finite value, including +0, unchanged', () => {
    expect(createCoordinate(0, 0)).toEqual({ lon: 0, lat: 0 });
    expect(createCoordinate(180, -90)).toEqual({ lon: 180, lat: -90 });
    expect(createCoordinate(123.456, -7.89)).toEqual({ lon: 123.456, lat: -7.89 });
  });

  it('property: JSON save->load is a strict structural identity for any value', () => {
    // Including -0: because the factory normalized it, the in-memory coordinate
    // equals (Object.is on the zero sign) its JSON round-trip.
    fc.assert(
      fc.property(
        // fc.double can generate -0; include it explicitly to exercise the seam.
        fc.oneof(fc.constant(-0), fc.double({ noNaN: true, noDefaultInfinity: true })),
        fc.oneof(fc.constant(-0), fc.double({ noNaN: true, noDefaultInfinity: true })),
        (lon, lat) => {
          const c = createCoordinate(lon, lat);
          const roundTripped = JSON.parse(JSON.stringify(c)) as typeof c;
          // toEqual uses Object.is on numbers, so -0 vs +0 would FAIL here.
          expect(roundTripped).toEqual(c);
        },
      ),
      { numRuns: 500 },
    );
  });
});
