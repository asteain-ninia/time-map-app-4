// Shared fast-check generators for the U04 geodesy property tests (技術方針 R7).
//
// Built ONCE here and reused by every geo property test so the world-seam,
// flattening-degenerate, and out-of-base-range cases are generated consistently.
// Per spec §4.6: NO year / time generators — this unit is time-independent. We
// generate only longitude, latitude, equator length, flattening and vertex
// lists. Generators build coordinates through the real createCoordinate factory
// (教訓 5.39: fixtures go through the entity factory, not bare literals).
//
// Imports fast-check (a devDependency); consumed only by *.test.ts files.

import fc from 'fast-check';

import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createGeoParams, type GeoParams } from './geo-params';

/**
 * Longitude scalar deliberately spanning beyond the base range [-180, 180) so
 * the seam-wrap logic is exercised (spec §4.6: include values like ±540).
 */
export function lonArb(): fc.Arbitrary<number> {
  return fc.double({ min: -540, max: 540, noNaN: true, noDefaultInfinity: true });
}

/** Latitude within the valid [-90, 90] band. */
export function latArb(): fc.Arbitrary<number> {
  return fc.double({ min: -90, max: 90, noNaN: true, noDefaultInfinity: true });
}

export function coordinateArb(): fc.Arbitrary<WorldCoordinate> {
  return fc.tuple(lonArb(), latArb()).map(([lon, lat]) => createCoordinate(lon, lat));
}

/** Equator length kept positive and at a realistic-ish magnitude. */
export function equatorKmArb(): fc.Arbitrary<number> {
  return fc.double({ min: 1, max: 1_000_000, noNaN: true, noDefaultInfinity: true });
}

/**
 * Flattening in [0, 0.1] — and crucially including the degenerate f = 0 (true
 * sphere) so the "flattening degenerates to spherical" property is exercised.
 */
export function flatteningArb(): fc.Arbitrary<number> {
  return fc.oneof(
    fc.constant(0),
    fc.double({ min: 0, max: 0.1, noNaN: true, noDefaultInfinity: true }),
  );
}

export function geoParamsArb(): fc.Arbitrary<GeoParams> {
  return fc
    .tuple(equatorKmArb(), flatteningArb())
    .map(([equatorKm, flattening]) => createGeoParams(equatorKm, flattening));
}

/** An ordered list of coordinates (for line-length properties). */
export function pointsArb(
  options: { minLength?: number; maxLength?: number } = {},
): fc.Arbitrary<readonly WorldCoordinate[]> {
  return fc.array(coordinateArb(), {
    minLength: options.minLength ?? 0,
    maxLength: options.maxLength ?? 8,
  });
}

/** A single ring's worth of vertices (≥ 3 for a non-degenerate polygon). */
export function ringVerticesArb(): fc.Arbitrary<readonly WorldCoordinate[]> {
  return fc.array(coordinateArb(), { minLength: 3, maxLength: 8 });
}
