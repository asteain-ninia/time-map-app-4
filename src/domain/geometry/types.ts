// U06 geometry primitives — shared multi-polygon shape model.
//
// The boolean-op wrappers (./boolean-ops) and the invariant checker
// (./invariants) operate on a *multi-polygon* model that can hold several
// polygons, each with an outer ring plus any number of hole rings. This mirrors
// `polygon-clipping`'s `MultiPolygon` (ring = array of [lon, lat] pairs) but is
// expressed in domain terms so callers never touch the library's tuple shape
// directly (spec §実装方針「ライブラリへの呼び出しを本ユニットのラッパに一元化」).
//
// 教訓5.1 (集合演算は複数片を返す前提): the type is multi-polygon at every public
// boundary; we never collapse a result down to a single polygon/ring, and never
// keep only the first piece. An *empty* multi-polygon (no pieces at all) is a
// legal value, not an error (教訓5.18: 空配列は真値).
//
// Coordinates flow in as U03 `WorldCoordinate`s (continuous longitude). Callers
// that cross the world seam pass coordinates already unwrapped by U05
// (`unwrapRing`) — this unit does not re-implement seam logic (単一真実源).

import { coordinatesEqual, type WorldCoordinate } from '../coordinate';

/**
 * A closed ring as an ordered list of world coordinates. The ring is implicitly
 * closed (first vertex is NOT repeated as the last); callers and the library
 * adapter handle the closing edge. May describe an outer boundary or a hole,
 * depending on its position within a {@link GeoPolygon}.
 */
export type GeoRing = readonly WorldCoordinate[];

/**
 * A single polygon: index 0 is the outer (territory) ring, indices 1.. are hole
 * rings punched into it. This matches `polygon-clipping`'s polygon convention so
 * the adapter is a straight value mapping.
 */
export type GeoPolygon = readonly GeoRing[];

/**
 * A multi-polygon: several disjoint polygons, each with its own outer ring and
 * holes. The single shape model used at every public boundary of this unit so a
 * boolean op can return all of its pieces (教訓5.1).
 */
export type GeoMultiPolygon = readonly GeoPolygon[];

/** The empty multi-polygon: a legal value meaning "no area" (教訓5.18). */
export const EMPTY_MULTI_POLYGON: GeoMultiPolygon = [];

/** True iff the multi-polygon holds no polygon pieces (decided by length). */
export function isMultiPolygonEmpty(mp: GeoMultiPolygon): boolean {
  return mp.length === 0;
}

/** Total number of rings across every polygon piece (outer + holes). */
export function countRings(mp: GeoMultiPolygon): number {
  let n = 0;
  for (const poly of mp) n += poly.length;
  return n;
}

/** Structural equality of two rings (same length, vertex-for-vertex equal). */
export function ringsEqual(a: GeoRing, b: GeoRing): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const ca = a[i];
    const cb = b[i];
    if (ca === undefined || cb === undefined) return false;
    if (!coordinatesEqual(ca, cb)) return false;
  }
  return true;
}
