// U10 bounding boxes — the minimal-enclosing-rectangle of a terminal feature's
// shape, in the SAME `{minX, minY, maxX, maxY}` shape RBush consumes (spec
// §実装方針「{minX, minY, maxX, maxY, ref}」). Coordinates are the continuous
// longitude scalar (U05) on X and world latitude on Y; this unit never folds
// longitude itself — seam handling is delegated to U05 (单一真实源).
//
// All functions are pure. An empty shape has no finite extent; we surface that
// as `undefined` rather than a degenerate zero/Infinity box (教訓5.18: absence
// is explicit, never a falsy sentinel hidden inside a number).

import type { WorldCoordinate } from '../coordinate';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';

/** An axis-aligned bounding box in continuous (lon=X, lat=Y) coordinates. */
export interface BBox {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

/** True iff `a` and `b` overlap or touch (inclusive — RBush `search` semantics). */
export function bboxesIntersect(a: BBox, b: BBox): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

/** Grow a box by a uniform margin on every side (used to widen query rectangles). */
export function expandBBox(box: BBox, margin: number): BBox {
  return {
    minX: box.minX - margin,
    minY: box.minY - margin,
    maxX: box.maxX + margin,
    maxY: box.maxY + margin,
  };
}

function foldCoordinate(
  acc: { minX: number; minY: number; maxX: number; maxY: number } | undefined,
  c: WorldCoordinate,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (acc === undefined) {
    return { minX: c.lon, minY: c.lat, maxX: c.lon, maxY: c.lat };
  }
  return {
    minX: Math.min(acc.minX, c.lon),
    minY: Math.min(acc.minY, c.lat),
    maxX: Math.max(acc.maxX, c.lon),
    maxY: Math.max(acc.maxY, c.lat),
  };
}

/**
 * Bounding box of a single ring, or undefined for an empty ring. The ring's
 * coordinates are read verbatim (longitude already continuous via U05); we do
 * not re-derive any seam logic here.
 */
export function ringBBox(ring: GeoRing): BBox | undefined {
  let acc: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  for (const c of ring) acc = foldCoordinate(acc, c);
  return acc;
}

/**
 * Bounding box of a whole multi-polygon (every piece, every ring — including
 * hole rings, which never extend beyond their outer ring but are folded in for
 * a single uniform pass). Returns undefined when the shape has no vertices at
 * all (教訓5.18). Holes do not shrink the box; a bbox is a conservative
 * superset and that is exactly what the candidate pre-filter wants.
 */
export function multiPolygonBBox(mp: GeoMultiPolygon): BBox | undefined {
  let acc: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const c of ring) acc = foldCoordinate(acc, c);
    }
  }
  return acc;
}
