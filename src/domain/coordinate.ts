// World coordinate value object (equirectangular projection, tech policy R3).
//
// Longitude is a *continuous* scalar: it may exceed [-180, 180) so that a path
// crossing the antimeridian is representable as a monotonically increasing
// value rather than wrapping (the periodic-seam normalization is a separate
// unit's concern). The coordinate type therefore deliberately allows any finite
// scalar and does not normalize on construction.
//
// Immutable value object: equality is by attribute value, mutation returns a
// new instance via `withXxx` (lesson 5.17). Plain shape so it maps directly
// to/from persisted data (lesson 5.20 / 5.31).
//
// FINITE GUARD (不正状態を表現不能に, 技術方針 2.10): a coordinate's scalars MUST
// be finite. NaN / ±Infinity is NOT a representable geographic point and — fatal
// for persistence — cannot survive the JSON boundary: `JSON.stringify(NaN)` and
// `JSON.stringify(Infinity)` are both `'null'`, so a save→load round-trip would
// corrupt the scalar to `null`, which the schema's `finiteNumber` (.finite())
// then rejects, failing the WHOLE manifest (total data loss for that project).
// A non-finite scalar can arise from upstream arithmetic (a divide-by-zero in a
// projection / drag computation) or a corrupted import; we fail loudly at the
// SINGLE construction seam — the same fail-loud stance `quantizeCoordinate`
// already takes downstream — so the bad value can never be born, persisted, or
// silently differ from itself (NaN !== NaN) in an identity check.

export interface WorldCoordinate {
  /** Continuous longitude scalar (degrees); may lie outside [-180, 180). */
  readonly lon: number;
  /** Latitude (degrees). */
  readonly lat: number;
}

/**
 * Normalize signed-zero (`-0`) to `+0`.
 *
 * `-0` and `+0` denote the identical geographic point (`-0 === 0`), but they are
 * NOT interchangeable across a JSON persistence boundary nor under structural /
 * `Object.is` comparison: `JSON.stringify(-0) === '0'`, so a save→load round-trip
 * collapses `-0` to `+0` and a strict identity assertion (or a hashing / Map-key
 * / dedup path that keys on the raw scalar) would spuriously report a change.
 *
 * Normalizing here — the single construction seam for every coordinate — keeps
 * the in-memory form byte-identical to the persisted form. `-0` can arise
 * legitimately from upstream arithmetic (e.g. `(-180) % 180` yields `-0`).
 */
function normalizeZero(n: number): number {
  // `n + 0` maps -0 to +0 while leaving every other finite value, NaN, and
  // ±Infinity unchanged. (Object.is(-0 + 0, 0) === true; n stays n otherwise.)
  return n === 0 ? 0 : n;
}

export function createCoordinate(lon: number, lat: number): WorldCoordinate {
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
    // Fail loudly: a NaN / ±Infinity coordinate is not a representable point and
    // would silently corrupt to `null` across the JSON+Zod persistence boundary,
    // making the entire manifest un-loadable. Reject it at birth (see header).
    throw new RangeError(
      `createCoordinate: coordinates must be finite, got (${lon}, ${lat})`,
    );
  }
  return { lon: normalizeZero(lon), lat: normalizeZero(lat) };
}

/** Attribute-value equality (lon and lat both equal). */
export function coordinatesEqual(a: WorldCoordinate, b: WorldCoordinate): boolean {
  return a.lon === b.lon && a.lat === b.lat;
}

// --- withXxx (every attribute covered: lon, lat) ----------------------------

export function withLon(coord: WorldCoordinate, lon: number): WorldCoordinate {
  return createCoordinate(lon, coord.lat);
}

export function withLat(coord: WorldCoordinate, lat: number): WorldCoordinate {
  return createCoordinate(coord.lon, lat);
}
