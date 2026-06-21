// U06 coordinate quantization (technical policy R2, front half of the defense
// layer). Before any boolean op the input coordinates are snapped to a fixed
// integer grid so `polygon-clipping`'s float kernel cannot manufacture
// near-degenerate self-intersections / zero-length edges / micro-slivers from
// numerical residue. The same grid is reused by the zero-length-edge predicate
// (单一真实源 / 教訓5.30: one tolerance, shared everywhere).
//
// All functions are pure: inputs are never mutated, new values are returned.

import {
  createCoordinate,
  MAX_COORDINATE_MAGNITUDE,
  type WorldCoordinate,
} from '../coordinate';
import type { GeoMultiPolygon, GeoPolygon, GeoRing } from './types';

/**
 * Quantization grid resolution: the number of integer grid cells per degree.
 *
 * THE single tolerance constant for this whole unit (spec §実装方針「トレランス
 * 定数は本ユニット冒頭で一箇所に定義」). It is deliberately the only place a grid
 * scale appears; every op and the zero-length predicate import it from here.
 *
 * Design (spec 注意点): too coarse a grid swallows legitimate thin areas; too
 * fine a grid lets float residue survive and re-introduce degenerate cases.
 * 1e7 cells/degree ≈ 1.1 cm at the equator on an Earth-sized map — far finer
 * than any meaningful editing feature, yet coarse enough that two coordinates
 * differing only by double rounding (~1e-13 deg) collapse onto the same grid
 * node. This is the tolerance acceptance criterion 4 (極小スリバー) is tuned to:
 * a sliver thinner than one grid cell degenerates to a zero-width ring and is
 * rejected/removed rather than emitted as a pathological micro-polygon.
 */
export const QUANTIZE_SCALE = 1e7;

// 单一真实源 fail-loud: the coordinate construction seam (../coordinate) bounds a
// scalar's magnitude against THIS grid scale so quantization can never overflow a
// finite input to ±Infinity. It restates the scale locally to avoid a layer cycle;
// guard here that the two never drift. MAX_COORDINATE_MAGNITUDE is derived as
// Number.MAX_SAFE_INTEGER / scale, so re-deriving it must reproduce it.
const EXPECTED_MAX_COORDINATE_MAGNITUDE = Number.MAX_SAFE_INTEGER / QUANTIZE_SCALE;
if (MAX_COORDINATE_MAGNITUDE !== EXPECTED_MAX_COORDINATE_MAGNITUDE) {
  throw new Error(
    `quantize: QUANTIZE_SCALE (${QUANTIZE_SCALE}) disagrees with the coordinate ` +
      `magnitude bound (got ${MAX_COORDINATE_MAGNITUDE}, expected ` +
      `${EXPECTED_MAX_COORDINATE_MAGNITUDE}); the two MUST share one grid scale.`,
  );
}

/** Snap a single scalar to the integer grid, returning the grid-aligned value. */
export function quantizeScalar(value: number): number {
  // Math.round ties-to-+∞ for .5; that bias is irrelevant at grid scale and is
  // applied identically to every coordinate, so relative geometry is preserved.
  return Math.round(value * QUANTIZE_SCALE) / QUANTIZE_SCALE;
}

/**
 * Snap a coordinate's lon and lat onto the grid. Longitude is treated as a plain
 * continuous scalar here (seam unwrap is U05's job, applied upstream): we never
 * fold ±360° in this unit (单一真实源).
 */
export function quantizeCoordinate(coord: WorldCoordinate): WorldCoordinate {
  if (!Number.isFinite(coord.lon) || !Number.isFinite(coord.lat)) {
    // Fail loudly: a NaN/Infinity coordinate must never silently snap to 0 and
    // poison the boolean op (病的入力の落とし穴).
    throw new RangeError(
      `quantizeCoordinate: coordinates must be finite, got (${coord.lon}, ${coord.lat})`,
    );
  }
  return createCoordinate(quantizeScalar(coord.lon), quantizeScalar(coord.lat));
}

/** True iff two coordinates land on the same grid node after quantization. */
export function quantizedEqual(a: WorldCoordinate, b: WorldCoordinate): boolean {
  const qa = quantizeCoordinate(a);
  const qb = quantizeCoordinate(b);
  return qa.lon === qb.lon && qa.lat === qb.lat;
}

/**
 * Quantize a ring AND drop the zero-length edges quantization can create: when
 * two originally-distinct vertices snap onto the same grid node, the edge
 * between them collapses to zero length and the duplicate vertex is removed.
 *
 * The ring is treated as implicitly closed, so a trailing vertex equal to the
 * first (the closing duplicate, or one produced by snapping) is also removed —
 * this unit's ring model does not repeat the first vertex (see ./types).
 *
 * Lesson 5.18: an empty input yields an empty ring (decided by length), never a
 * falsy short-circuit. The input array is never mutated.
 */
export function quantizeRing(ring: GeoRing): WorldCoordinate[] {
  const out: WorldCoordinate[] = [];
  for (const coord of ring) {
    const q = quantizeCoordinate(coord);
    const prev = out[out.length - 1];
    // Skip a vertex that coincides with the immediately preceding one (a
    // zero-length edge born of snapping or already-duplicate input).
    if (prev !== undefined && prev.lon === q.lon && prev.lat === q.lat) {
      continue;
    }
    out.push(q);
  }
  // Remove a trailing vertex equal to the first: the closing edge is implicit,
  // so first == last would be a zero-length closing edge.
  while (out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first !== undefined && last !== undefined && first.lon === last.lon && first.lat === last.lat) {
      out.pop();
    } else {
      break;
    }
  }
  return out;
}

/** Quantize every ring of a polygon, dropping rings that collapse below 3 vertices? No —
 * collapsing is the invariant checker's decision; here we only snap + dedupe so the
 * checker can see (and reject) a degenerate ring rather than have it silently vanish. */
export function quantizePolygon(polygon: GeoPolygon): WorldCoordinate[][] {
  return polygon.map((ring) => quantizeRing(ring));
}

/** Quantize every ring of every polygon piece (no piece dropped — 教訓5.1). */
export function quantizeMultiPolygon(mp: GeoMultiPolygon): WorldCoordinate[][][] {
  return mp.map((poly) => quantizePolygon(poly));
}
