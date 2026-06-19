// Geodesic calculations for the equirectangular map (U04): equirectangular &
// great-circle distance, line length, polygon area. Pure functions, no external
// library (技術方針 §2.9), domain layer only.
//
// Three definitions are FIXED here and must not drift (spec §6 数値定義のドリフト防止):
//   1. equirectangular distance = flat map-plane distance (plate carrée),
//      NO latitude shortening on the longitude axis. Flattening enters only via
//      the latitude-axis scalar kmPerLatDeg.
//   2. great-circle distance = spherical haversine on radius equatorKm / (2π).
//   3. polygon area = planar shoelace (territory +, hole −), absolute sum.
//
// World-seam handling (spec §4.4) is delegated to ./longitude — the single
// source of truth — so distance / length / area never re-derive the wrap rule.

import type { WorldCoordinate } from '../coordinate';
import type { Ring, Shape } from '../ring';
import { RING_KIND } from '../ring';
import { deriveScalars, type GeoParams } from './geo-params';
import { shortestLonDeltaDeg, unwrapLonSequence } from './longitude';

const DEG_TO_RAD = Math.PI / 180;

/** Distance measures selectable for line length (spec §4 item 3). */
export const DISTANCE_MEASURE = {
  Equirectangular: 'equirectangular',
  GreatCircle: 'greatCircle',
} as const;

export type DistanceMeasure =
  (typeof DISTANCE_MEASURE)[keyof typeof DISTANCE_MEASURE];

// --- 1. Equirectangular distance (map-plane / plate carrée) ------------------

/**
 * Flat map-plane distance between two points (km). The longitude difference is
 * the shortest signed seam delta (§4.4) so an east-edge <-> west-edge pair takes
 * the short way round. No latitude correction on the longitude axis — that is
 * the great-circle's job; flattening enters via kmPerLatDeg only (§4.3-1).
 */
export function equirectangularDistanceKm(
  a: WorldCoordinate,
  b: WorldCoordinate,
  geoParams: GeoParams,
): number {
  const { kmPerLonDegAtEquator, kmPerLatDeg } = deriveScalars(geoParams);
  const dLon = shortestLonDeltaDeg(a.lon, b.lon);
  const dx = dLon * kmPerLonDegAtEquator;
  const dy = (b.lat - a.lat) * kmPerLatDeg;
  return Math.sqrt(dx * dx + dy * dy);
}

// --- 2. Great-circle distance (spherical haversine) -------------------------

/**
 * Great-circle distance between two points (km) via the numerically stable
 * haversine formula on a sphere of radius equatorKm / (2π). Uses atan2 (not the
 * round-off-prone acos form) and the seam-normalized longitude delta (§4.3-2).
 */
export function greatCircleDistanceKm(
  a: WorldCoordinate,
  b: WorldCoordinate,
  geoParams: GeoParams,
): number {
  const { sphereRadiusKm } = deriveScalars(geoParams);
  const dLonDeg = shortestLonDeltaDeg(a.lon, b.lon);
  const lat1 = a.lat * DEG_TO_RAD;
  const lat2 = b.lat * DEG_TO_RAD;
  const dLat = (b.lat - a.lat) * DEG_TO_RAD;
  const dLon = dLonDeg * DEG_TO_RAD;
  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLon = Math.sin(dLon / 2);
  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1) * Math.cos(lat2) * sinHalfLon * sinHalfLon;
  // Clamp h into [0, 1] against tiny floating overshoot before sqrt.
  const hClamped = h < 0 ? 0 : h > 1 ? 1 : h;
  const centralAngle = 2 * Math.atan2(Math.sqrt(hClamped), Math.sqrt(1 - hClamped));
  return sphereRadiusKm * centralAngle;
}

// --- 3. Line length ---------------------------------------------------------

/**
 * Total length (km) of a polyline given by an ordered point list. Each segment
 * uses the seam-normalized shortest path so a path crossing the world edge is
 * continued, not split or double-counted (§4 item 3). Default measure is
 * equirectangular; great-circle is selectable for the survey line (FR-14).
 *
 * Lesson 5.18: fewer than 2 points is a true, valid input -> length 0. The < 2
 * guard also discharges noUncheckedIndexedAccess for the pair access below.
 */
export function lineLengthKm(
  points: readonly WorldCoordinate[],
  geoParams: GeoParams,
  measure: DistanceMeasure = DISTANCE_MEASURE.Equirectangular,
): number {
  if (points.length < 2) {
    return 0;
  }
  const distance =
    measure === DISTANCE_MEASURE.GreatCircle
      ? greatCircleDistanceKm
      : equirectangularDistanceKm;
  let total = 0;
  for (let i = 1; i < points.length; i += 1) {
    const prev = points[i - 1];
    const curr = points[i];
    // Both are defined here (1 <= i < length), but handle undefined to satisfy
    // noUncheckedIndexedAccess without an unsafe `!` assertion.
    if (prev === undefined || curr === undefined) {
      continue;
    }
    total += distance(prev, curr, geoParams);
  }
  return total;
}

// --- 4. Polygon area --------------------------------------------------------

/**
 * Absolute planar-shoelace area (km²) of a single ring's vertex list. The
 * longitudes are unwrapped into a continuous run first (§4.4) so a ring crossing
 * the seam is one continuous polygon. Then the plate-carrée planar shoelace is
 * applied with the longitude axis scaled by kmPerLonDegAtEquator and the
 * latitude axis by kmPerLatDeg (§4.3 / §4 item 4 option a).
 *
 * Lesson 5.18 / §4.5: fewer than 3 vertices is a valid input -> area 0.
 */
export function ringAreaKm2(
  vertices: readonly WorldCoordinate[],
  geoParams: GeoParams,
): number {
  if (vertices.length < 3) {
    return 0;
  }
  const { kmPerLonDegAtEquator, kmPerLatDeg } = deriveScalars(geoParams);
  const unwrappedLon = unwrapLonSequence(vertices.map((v) => v.lon));
  // Re-center the continuous longitudes on the first vertex before projecting.
  // The shoelace area is exactly translation-invariant, so subtracting a common
  // origin does not change the result mathematically — but it keeps the projected
  // x magnitudes small. Without this, a world-wrap shift (+k·360°, FR-07/FR-12)
  // grows every unwrapped lon by up to ~1080°·kmPerLonDeg, and the large `x1*y2`
  // shoelace products lose low-order bits, so the SAME ring shifted by a whole
  // world turn yields a slightly different area (breaking the ±360° invariance
  // U05 builds on). Centering removes that magnitude-dependent float error.
  const originLon = unwrappedLon[0] ?? 0;
  // Project to km in a flat plane; vertices and unwrappedLon are aligned 1:1.
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const v = vertices[i];
    const lon = unwrappedLon[i];
    if (v === undefined || lon === undefined) {
      continue;
    }
    xs.push((lon - originLon) * kmPerLonDegAtEquator);
    ys.push(v.lat * kmPerLatDeg);
  }
  let twiceSigned = 0;
  const n = xs.length;
  for (let i = 0; i < n; i += 1) {
    const x1 = xs[i];
    const y1 = ys[i];
    const x2 = xs[(i + 1) % n];
    const y2 = ys[(i + 1) % n];
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      continue;
    }
    twiceSigned += x1 * y2 - x2 * y1;
  }
  return Math.abs(twiceSigned) / 2;
}

/**
 * Total area (km²) of a shape's rings. Sign is decided by ring KIND, never by
 * winding order (§4 item 4): territory rings add, hole rings subtract, each via
 * its absolute ring area. Every ring is processed — no first-ring shortcut
 * (教訓 5.1). The result is `Σ|territory| − Σ|hole|`; if holes exceed territory
 * the raw difference is returned (validity is another unit's concern, §4.5).
 *
 * `resolve` maps a ring's vertex IDs to coordinates (the ring stores IDs, not
 * embedded vertices — U03 R6). A ring whose vertices cannot all be resolved
 * contributes 0 for the unresolved slots, mirroring the degenerate-ring rule.
 */
export function polygonAreaKm2(
  rings: readonly Ring[],
  resolve: (vertexId: Ring['vertexIds'][number]) => WorldCoordinate | undefined,
  geoParams: GeoParams,
): number {
  let territory = 0;
  let hole = 0;
  for (const ring of rings) {
    const coords: WorldCoordinate[] = [];
    for (const vid of ring.vertexIds) {
      const c = resolve(vid);
      if (c !== undefined) {
        coords.push(c);
      }
    }
    const area = ringAreaKm2(coords, geoParams);
    if (ring.kind === RING_KIND.Hole) {
      hole += area;
    } else {
      territory += area;
    }
  }
  return territory - hole;
}

/**
 * Convenience: total area (km²) of a whole Shape (§4 item 4). Resolves vertex
 * IDs through the supplied lookup and delegates to polygonAreaKm2.
 */
export function shapeAreaKm2(
  shape: Shape,
  resolve: (vertexId: Ring['vertexIds'][number]) => WorldCoordinate | undefined,
  geoParams: GeoParams,
): number {
  return polygonAreaKm2(shape.rings, resolve, geoParams);
}
