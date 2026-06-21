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
//
// MAGNITUDE BOUND (病的入力の落とし穴): "finite" is not sufficient. A finite but
// astronomically large scalar (e.g. lon = 1e302) is not a representable map point
// AND it silently breaks the U06 quantization grid: `quantizeScalar` snaps via
// `Math.round(value * 1e7) / 1e7`, and `1e302 * 1e7` overflows IEEE-754 to
// +Infinity, so a *finite* coordinate would be turned into a *non-finite* one by
// pure quantization — `createCoordinate` would then throw deeper in the boolean-op
// pipeline, escaping the R2 "never throw, always a discriminated rejection"
// contract. We close that at the SAME birth seam: a coordinate scalar must be
// small enough that quantizing it stays an exact, finite, safe integer on the
// grid. The ceiling is the largest magnitude whose grid index
// (|value| * QUANTIZE_SCALE) is still ≤ Number.MAX_SAFE_INTEGER, so rounding is
// exact and never overflows. At ~9.0e8 degrees this is orders of magnitude beyond
// any legitimate continuous longitude (even many antimeridian wraps) or latitude,
// so it rejects only pathological / corrupted input, never real geometry.

export interface WorldCoordinate {
  /** Continuous longitude scalar (degrees); may lie outside [-180, 180). */
  readonly lon: number;
  /** Latitude (degrees). */
  readonly lat: number;
}

/**
 * The U06 quantization grid resolution (cells/degree), restated here so this seam
 * can bound coordinates against the grid WITHOUT importing the geometry layer
 * (which already imports this module — importing back would be a cycle / layer
 * inversion). It MUST equal `QUANTIZE_SCALE` in geometry/quantize.ts; that module
 * asserts the two agree at import time (单一真实源, fail-loud on drift).
 */
const COORDINATE_QUANTIZE_SCALE = 1e7;

/**
 * Maximum allowed magnitude (degrees) for a coordinate scalar.
 *
 * Defined so the quantization grid index `|value| * COORDINATE_QUANTIZE_SCALE`
 * stays ≤ Number.MAX_SAFE_INTEGER and therefore FINITE for every accepted scalar
 * (Number.MAX_SAFE_INTEGER ≪ Number.MAX_VALUE, so the product never overflows to
 * ±Infinity, and `Math.round` of a finite value is finite). This is the exact
 * guarantee that stops a finite input becoming a non-finite grid value — the bug
 * this bound closes (see header). ~9.0e8 degrees: orders of magnitude beyond any
 * legitimate continuous longitude/latitude, so only pathological input is rejected.
 */
export const MAX_COORDINATE_MAGNITUDE =
  Number.MAX_SAFE_INTEGER / COORDINATE_QUANTIZE_SCALE;

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
  if (Math.abs(lon) > MAX_COORDINATE_MAGNITUDE || Math.abs(lat) > MAX_COORDINATE_MAGNITUDE) {
    // Fail loudly: a finite-but-astronomical scalar is not a representable point
    // and would overflow the quantization grid to ±Infinity (see header), which
    // would later throw deep inside the boolean-op pipeline and break the R2
    // "never throw" contract. Reject it at the same birth seam as non-finite.
    throw new RangeError(
      `createCoordinate: coordinates must have magnitude <= ${MAX_COORDINATE_MAGNITUDE}, got (${lon}, ${lat})`,
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
