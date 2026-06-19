// Great-circle (geodesic) shortest-path polyline for the survey line (U37,
// FR-15). Pure, framework-free domain logic.
//
// The survey line FR-15 *must* draw is the GREAT-CIRCLE shortest path. On the
// equirectangular map that geodesic is a curve (it bows toward the pole), so we
// approximate it by interpolating points along the great circle (spherical
// linear interpolation = slerp) and drawing the result as a polyline. The
// segment count is chosen adaptively from the arc length so short lines stay
// cheap and long lines stay smooth (spec §4.3).
//
// Single source of truth (教訓 §4 / §5.30): this unit does NOT compute the
// great-circle DISTANCE — that is U04's `greatCircleDistanceKm`. It only places
// intermediate points on the same great circle. A test fixes "polyline length ≈
// U04 great-circle distance" so the two definitions cannot drift (spec §4.3 定義
// のドリフト防止). It also does NOT re-derive the ±360° seam fold; the continuous
// longitude run for drawing is produced by U04's `unwrapLonSequence`
// (技術方針 R3).
//
// Latitude is non-periodic (FR-05): only longitude carries the seam; latitude is
// interpolated as an ordinary spherical coordinate, never wrapped.

import type { WorldCoordinate } from '../coordinate';
import { shortestLonDeltaDeg, unwrapLonSequence, wrapLonDeg } from '../geo/longitude';

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

/** Default upper bound on interpolation segments for a near-antipodal arc. */
export const MAX_PATH_SEGMENTS = 256;
/** Minimum segments so even a tiny line is at least one drawn segment. */
export const MIN_PATH_SEGMENTS = 1;
/** Degrees of central angle per segment used to pick the adaptive count. */
export const DEGREES_PER_SEGMENT = 2;

/**
 * Adaptive segment count for an arc spanning `centralAngleDeg` degrees: roughly
 * one segment per {@link DEGREES_PER_SEGMENT}°, clamped to
 * [{@link MIN_PATH_SEGMENTS}, {@link MAX_PATH_SEGMENTS}]. A 0° arc (identical
 * endpoints) still yields the minimum so the caller always has a valid polyline.
 */
export function segmentCountForAngle(centralAngleDeg: number): number {
  if (!Number.isFinite(centralAngleDeg) || centralAngleDeg <= 0) {
    return MIN_PATH_SEGMENTS;
  }
  const n = Math.ceil(centralAngleDeg / DEGREES_PER_SEGMENT);
  return Math.min(MAX_PATH_SEGMENTS, Math.max(MIN_PATH_SEGMENTS, n));
}

/** Convert a lon/lat (degrees) to a unit vector on the sphere. */
function toUnitVector(coord: WorldCoordinate): [number, number, number] {
  const lat = coord.lat * DEG_TO_RAD;
  const lon = coord.lon * DEG_TO_RAD;
  const cosLat = Math.cos(lat);
  return [cosLat * Math.cos(lon), cosLat * Math.sin(lon), Math.sin(lat)];
}

/** Convert a unit vector back to lon/lat (degrees). */
function toLonLat(v: [number, number, number]): WorldCoordinate {
  const [x, y, z] = v;
  const lat = Math.asin(clamp(z, -1, 1)) * RAD_TO_DEG;
  const lon = Math.atan2(y, x) * RAD_TO_DEG;
  return { lon, lat };
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Central angle (radians) between two coordinates, numerically stable. */
function centralAngleRad(a: WorldCoordinate, b: WorldCoordinate): number {
  const va = toUnitVector(a);
  const vb = toUnitVector(b);
  const dot = clamp(va[0] * vb[0] + va[1] * vb[1] + va[2] * vb[2], -1, 1);
  // Cross-product magnitude gives a stable angle for both small and large arcs.
  const cx = va[1] * vb[2] - va[2] * vb[1];
  const cy = va[2] * vb[0] - va[0] * vb[2];
  const cz = va[0] * vb[1] - va[1] * vb[0];
  const crossMag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return Math.atan2(crossMag, dot);
}

/**
 * Interpolated great-circle points from `a` to `b` (inclusive of both
 * endpoints). The longitudes are kept as CONTINUOUS scalars: each interpolated
 * longitude is unwrapped (via U04's `unwrapLonSequence`) so the run starts near
 * `a.lon` and steps by the shortest delta — i.e. the path that crosses the world
 * edge stays one continuous line (FR-14 折り返し非分断) rather than springing
 * back at ±180°. The renderer's wrap-replication (U17) then makes it visible at
 * every scroll position.
 *
 * Slerp degeneracies are handled (spec §4.6 退化入力):
 *   - identical endpoints (0° arc) -> the two endpoints, no NaN.
 *   - the result always begins exactly at `a` and ends exactly at `b` so the
 *     polyline endpoints match the clicked points (受け入れ基準 3 / §4.7).
 *
 * `segments` defaults to the adaptive count; callers may override (e.g. tests).
 */
export function greatCirclePath(
  a: WorldCoordinate,
  b: WorldCoordinate,
  segments?: number,
): WorldCoordinate[] {
  // Work in a frame anchored at the start: fold the endpoints' longitudes to the
  // representative range so the angle / slerp are computed on SMALL longitude
  // magnitudes. This makes the result wrap-invariant — shifting both endpoints by
  // +360k must not change the path's SHAPE or its segment COUNT (AC-2). Computing
  // the central angle on raw values like 800° loses float precision and can flip
  // the adaptive segment count by one; folding first removes that sensitivity.
  // The turn offset is re-applied to every output longitude at the end so the
  // drawn start longitude equals the clicked scalar `a.lon` exactly.
  const aFoldLon = wrapLonDeg(a.lon);
  const turnOffset = a.lon - aFoldLon; // an integer multiple of 360 (± float)
  const aLocal: WorldCoordinate = { lon: aFoldLon, lat: a.lat };
  const bLocalLon = aFoldLon + shortestLonDeltaDeg(aFoldLon, b.lon);
  const bLocal: WorldCoordinate = { lon: bLocalLon, lat: b.lat };

  const omega = centralAngleRad(aLocal, bLocal);
  const n =
    segments !== undefined && segments >= MIN_PATH_SEGMENTS
      ? Math.floor(segments)
      : segmentCountForAngle(omega * RAD_TO_DEG);

  // Degenerate / antipodal-near-zero: slerp's sin(omega) denominator vanishes.
  // Fall back to the two endpoints (a straight, zero-bow line); the path is then
  // exactly [a, b] with a's longitude as the continuous base.
  const sinOmega = Math.sin(omega);
  if (omega === 0 || sinOmega === 0) {
    return continuousLon([aLocal, bLocal], aFoldLon, turnOffset);
  }

  const va = toUnitVector(aLocal);
  const vb = toUnitVector(bLocal);
  const raw: WorldCoordinate[] = [];
  for (let i = 0; i <= n; i += 1) {
    const t = i / n;
    if (i === 0) {
      raw.push(aLocal);
      continue;
    }
    if (i === n) {
      raw.push(bLocal);
      continue;
    }
    const f0 = Math.sin((1 - t) * omega) / sinOmega;
    const f1 = Math.sin(t * omega) / sinOmega;
    const v: [number, number, number] = [
      f0 * va[0] + f1 * vb[0],
      f0 * va[1] + f1 * vb[1],
      f0 * va[2] + f1 * vb[2],
    ];
    raw.push(toLonLat(v));
  }
  return continuousLon(raw, aFoldLon, turnOffset);
}

/**
 * Re-express a point list (computed in the start-anchored representative frame)
 * as a CONTINUOUS longitude run, then re-apply `turnOffset` so the output is in
 * the ORIGINAL clicked frame. Steps:
 *   1. anchor the first longitude at `baseLon` (the folded start, exact) and
 *      unwrap the rest by U04's `unwrapLonSequence` so adjacent steps are the
 *      shortest signed delta — one connected polyline across the seam (FR-14);
 *   2. add `turnOffset` (an integer multiple of 360° = the start's whole-turn
 *      count) to every longitude, so the drawn start longitude equals the
 *      clicked scalar `a.lon` exactly (no off-by-360° label/drawing mismatch and
 *      full ±360k wrap-invariance of the SHAPE, AC-2).
 * Latitudes pass through unchanged.
 */
function continuousLon(
  points: readonly WorldCoordinate[],
  baseLon: number,
  turnOffset: number,
): WorldCoordinate[] {
  if (points.length === 0) {
    return [];
  }
  const seq: number[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    if (p === undefined) {
      continue;
    }
    seq.push(i === 0 ? baseLon : p.lon);
  }
  const unwrapped = unwrapLonSequence(seq);
  const out: WorldCoordinate[] = [];
  for (let i = 0; i < points.length; i += 1) {
    const p = points[i];
    const lon = unwrapped[i];
    if (p === undefined || lon === undefined) {
      continue;
    }
    out.push({ lon: lon + turnOffset, lat: p.lat });
  }
  return out;
}

/**
 * The straight map-plane (equirectangular) polyline between two points: just the
 * two endpoints with a continuous longitude run (the start anchored, the end one
 * shortest-delta step away). This is the line corresponding to the
 * EQUIRECTANGULAR distance — drawn in a distinct style from the great-circle
 * curve (spec §4.3 / FR-15). Crossing the seam, it is still one connected
 * segment, never a wrap-around detour, because the end longitude is the shortest
 * delta from the start.
 */
export function equirectangularPath(
  a: WorldCoordinate,
  b: WorldCoordinate,
): WorldCoordinate[] {
  const endLon = a.lon + shortestLonDeltaDeg(a.lon, b.lon);
  return [
    { lon: a.lon, lat: a.lat },
    { lon: endLon, lat: b.lat },
  ];
}
