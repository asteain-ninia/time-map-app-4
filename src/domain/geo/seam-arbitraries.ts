// Domain (geo): fast-check generators for periodic-seam ring tests (U05; R7).
//
// Defined ONCE here and reused by the seam property tests so the boundary cases
// (seam-crossing rings, multi-wind rings, representative-interval boundary
// vertices, extreme offsets) are generated consistently and can be reused by
// later units' property tests (技術方針 R7). Generators build coordinates
// through the real `createCoordinate` factory (lesson 5.39: fixtures go through
// factories, not bare literals).
//
// Kept separate from U04's `./arbitraries` (geodesy generators) to avoid name
// collisions while keeping the seam-specific shapes (seam-crossing, multi-wind,
// boundary-exact) co-located with the seam model they validate.
//
// Imports fast-check (a devDependency); consumed exclusively by *.test.ts files,
// never by production code.

import fc from 'fast-check';

import { createCoordinate, type WorldCoordinate } from '../coordinate';

/** A latitude in the valid equirectangular range [-90, 90] (never wrapped). */
export function seamLatArb(): fc.Arbitrary<number> {
  return fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true });
}

/**
 * A representative longitude in [-180, +180). Weights the interval boundaries
 * so round-trip and boundary properties are exercised often, not just by luck.
 */
export function representativeLonArb(): fc.Arbitrary<number> {
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.double({ min: -180, max: 179.999999, noNaN: true, noDefaultInfinity: true }),
    },
    { weight: 1, arbitrary: fc.constantFrom(-180, -179.999999, -90, 0, 90, 179.999999) },
  );
}

/**
 * A continuous (possibly out-of-range) longitude scalar, including extreme
 * multi-wind offsets (±1e6) and exact period boundaries (±180, ±360, ±540), so
 * normalization is tested against pathological input that must not loop, NaN or
 * Infinity (病的入力の落とし穴).
 */
export function continuousLonArb(): fc.Arbitrary<number> {
  return fc.oneof(
    {
      weight: 3,
      arbitrary: fc.double({ min: -1e6, max: 1e6, noNaN: true, noDefaultInfinity: true }),
    },
    { weight: 1, arbitrary: fc.constantFrom(-540, -450, -360, -180, 0, 180, 360, 540) },
  );
}

/** A representative coordinate (longitude in [-180, 180), latitude in range). */
export function representativeCoordinateArb(): fc.Arbitrary<WorldCoordinate> {
  return fc
    .tuple(representativeLonArb(), seamLatArb())
    .map(([lon, lat]) => createCoordinate(lon, lat));
}

/** An ordinary ring of representative coordinates (2..12 vertices). */
export function representativeRingArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  return fc.array(representativeCoordinateArb(), { minLength: 2, maxLength: 12 });
}

/**
 * A ring that deliberately crosses the seam: longitudes hop between the far-east
 * (near +180) and far-west (near -180) bands, forcing adjacent gaps that exceed
 * 180° before unwrapping.
 */
export function seamCrossingRingArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  const eastLon = fc.double({ min: 150, max: 179.999, noNaN: true, noDefaultInfinity: true });
  const westLon = fc.double({ min: -179.999, max: -150, noNaN: true, noDefaultInfinity: true });
  const eastVertex = fc.tuple(eastLon, seamLatArb()).map(([lon, lat]) => createCoordinate(lon, lat));
  const westVertex = fc.tuple(westLon, seamLatArb()).map(([lon, lat]) => createCoordinate(lon, lat));
  // Alternate east/west pairs to guarantee at least one seam crossing.
  return fc
    .array(fc.tuple(eastVertex, westVertex), { minLength: 1, maxLength: 6 })
    .map((pairs) => pairs.flatMap(([e, w]) => [e, w]));
}

/**
 * A multi-wind ring: a monotone walk that circles the world several times, built
 * as a continuous run then folded to representative form, so it is a legal
 * stored ring whose unwrap must rediscover the winding.
 */
export function multiWindRingArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  // step in [30, 170] keeps each adjacent representative gap below the seam
  // threshold while a long enough walk circles the world 2+ times.
  const stepArb = fc.double({ min: 30, max: 170, noNaN: true, noDefaultInfinity: true });
  return fc
    .tuple(stepArb, fc.integer({ min: 6, max: 30 }), seamLatArb())
    .map(([step, count, lat]) => {
      const out: WorldCoordinate[] = [];
      for (let i = 0; i < count; i++) {
        const continuous = i * step;
        const rep = (((continuous + 180) % 360) + 360) % 360 - 180;
        out.push(createCoordinate(rep, lat));
      }
      return out;
    });
}

/**
 * Union of the ring shapes that matter for seam tests: ordinary, seam-crossing,
 * and multi-wind. Reused so each property is checked against all three kinds.
 */
export function anyRingArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  return fc.oneof(representativeRingArb(), seamCrossingRingArb(), multiWindRingArb());
}
