// U06 geometric predicates — small, self-implemented pure functions (spec
// §実装方針「幾何述語の独立実装」). NOT delegated to polygon-clipping: these are
// the cheap, exact, boundary-explicit primitives the upper layers use for
// real-time edit-constraint checks (FR-25 / FR-32) and per-frame collision
// (FR-89 / 教訓5.38) where calling the boolean kernel would be wrong.
//
// Boundary conventions are fixed here and frozen by tests:
//   - pointInPolygon: a point exactly on an edge or vertex is reported via an
//     explicit `boundary` classification, so callers choose whether the boundary
//     counts as inside (FR-26「境界の接触は重なりに含めない」needs this distinction).
//   - segmentsIntersect: proper crossing, endpoint touch and collinear overlap
//     are returned as distinct cases (教訓5.38: 衝突検出と応答を分ける).
//
// Coordinates are plain continuous scalars; seam unwrap (U05) is applied
// upstream so these predicates operate on a single continuous coordinate system
// (单一真实源). All functions are pure.

import { orient2d } from 'robust-predicates';

import { coordinatesEqual, type WorldCoordinate } from '../coordinate';
import { quantizeCoordinate } from './quantize';
import type { GeoPolygon, GeoRing } from './types';

// --- point-in-polygon -------------------------------------------------------

export const POINT_LOCATION = {
  Inside: 'inside',
  Outside: 'outside',
  Boundary: 'boundary',
} as const;

export type PointLocation = (typeof POINT_LOCATION)[keyof typeof POINT_LOCATION];

/**
 * 2D orientation of a→b→c: the SIGN of the cross product (b - a) × (c - a),
 * computed with `robust-predicates`' adaptive `orient2d`. The naive float
 * expression `(bx-ax)(cy-ay) - (by-ay)(cx-ax)` is NOT sign-exact: for a point
 * that lies on the line through a,b the residual can be a tiny non-zero float
 * (e.g. ~1e-18) AND its sign flips when a,b are swapped, which makes every
 * predicate built on it (`pointOnSegment`, `segmentsIntersect`, self-intersection,
 * hole containment) orientation-dependent and wrong on collinear grid points
 * (Codex反例: 点 (.2,.4) on (.1,.1)-(.3,.7)). orient2d returns a value whose
 * SIGN is exact and orientation-symmetric, so collinearity is detected as exactly
 * 0 regardless of vertex order. A fixed epsilon would be coordinate-scale
 * dependent and is therefore deliberately NOT used (单一真实源: one robust sign
 * shared by every predicate below).
 *
 * Only the sign is contractually meaningful; callers compare against 0 / use the
 * returned magnitude solely as that sign.
 */
function cross(a: WorldCoordinate, b: WorldCoordinate, c: WorldCoordinate): number {
  return orient2d(a.lon, a.lat, b.lon, b.lat, c.lon, c.lat);
}

/** True iff point p lies on the closed segment [a, b] (collinear and within). */
function pointOnSegment(p: WorldCoordinate, a: WorldCoordinate, b: WorldCoordinate): boolean {
  if (cross(a, b, p) !== 0) return false;
  // Collinear: p is on the segment iff it is within the bounding box of [a, b].
  const withinLon = p.lon >= Math.min(a.lon, b.lon) && p.lon <= Math.max(a.lon, b.lon);
  const withinLat = p.lat >= Math.min(a.lat, b.lat) && p.lat <= Math.max(a.lat, b.lat);
  return withinLon && withinLat;
}

/**
 * Classify a point against a single closed ring (the ray-casting / crossing-
 * number test). Returns `boundary` when the point lies on any edge, otherwise
 * `inside` / `outside` by odd/even crossing count. The ring is implicitly closed
 * (last vertex → first vertex edge included). A ring with fewer than 3 vertices
 * has no interior, so any on-edge point is `boundary` and everything else is
 * `outside`.
 */
function locateInRing(point: WorldCoordinate, ring: GeoRing): PointLocation {
  const n = ring.length;
  if (n === 0) return POINT_LOCATION.Outside;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
    const a = ring[i];
    const b = ring[j];
    if (a === undefined || b === undefined) continue;
    if (pointOnSegment(point, a, b)) {
      return POINT_LOCATION.Boundary;
    }
    // Standard crossing test on the latitude axis; strict-below avoids double-
    // counting a vertex that the ray passes exactly through.
    const intersects =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lon < ((b.lon - a.lon) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lon;
    if (intersects) inside = !inside;
  }
  return inside ? POINT_LOCATION.Inside : POINT_LOCATION.Outside;
}

/**
 * Classify a point against a polygon (outer ring at index 0, holes at 1..),
 * honouring holes: a point inside the outer ring but inside a hole is `outside`;
 * a point on any ring (outer or hole) is `boundary`. This is the穴を考慮した内外
 * 判定 of acceptance criterion 3 — it backs FR-25's containment checks.
 *
 * Enclaves (a territory ring nested inside a hole) are represented as a *separate*
 * polygon piece in the multi-polygon model, so a single `GeoPolygon` here is one
 * outer + its direct holes; callers test each polygon piece in turn.
 */
export function pointInPolygon(point: WorldCoordinate, polygon: GeoPolygon): PointLocation {
  const outer = polygon[0];
  if (outer === undefined) return POINT_LOCATION.Outside;

  const outerLoc = locateInRing(point, outer);
  if (outerLoc !== POINT_LOCATION.Inside) {
    // On the outer boundary => boundary; outside the outer ring => outside.
    return outerLoc;
  }
  // Inside the outer ring: a hole flips it back to outside, a hole edge is boundary.
  for (let i = 1; i < polygon.length; i += 1) {
    const hole = polygon[i];
    if (hole === undefined) continue;
    const holeLoc = locateInRing(point, hole);
    if (holeLoc === POINT_LOCATION.Boundary) return POINT_LOCATION.Boundary;
    if (holeLoc === POINT_LOCATION.Inside) return POINT_LOCATION.Outside;
  }
  return POINT_LOCATION.Inside;
}

/** Convenience boolean: strictly interior (not on boundary). */
export function isPointStrictlyInside(point: WorldCoordinate, polygon: GeoPolygon): boolean {
  return pointInPolygon(point, polygon) === POINT_LOCATION.Inside;
}

// --- segment intersection ---------------------------------------------------

export const SEGMENT_RELATION = {
  /** No common point at all. */
  Disjoint: 'disjoint',
  /** Interiors cross at a single point (a proper crossing). */
  Proper: 'proper',
  /** They meet only at a shared endpoint (touch, no interior crossing). */
  Endpoint: 'endpoint',
  /** Collinear and sharing more than a point (overlapping run). */
  Collinear: 'collinear',
} as const;

export type SegmentRelation = (typeof SEGMENT_RELATION)[keyof typeof SEGMENT_RELATION];

export interface SegmentIntersection {
  readonly relation: SegmentRelation;
  /**
   * The single intersection point for a `proper` crossing, or the touch point
   * for an `endpoint` contact. Absent for `disjoint` and `collinear` (a
   * collinear overlap is a run, not a single point — 教訓5.18: absence is
   * explicit, not a falsy sentinel).
   */
  readonly point?: WorldCoordinate;
}

function onSegmentBox(p: WorldCoordinate, a: WorldCoordinate, b: WorldCoordinate): boolean {
  return (
    p.lon >= Math.min(a.lon, b.lon) &&
    p.lon <= Math.max(a.lon, b.lon) &&
    p.lat >= Math.min(a.lat, b.lat) &&
    p.lat <= Math.max(a.lat, b.lat)
  );
}

/**
 * Classify the intersection of two segments [p1,p2] and [p3,p4], distinguishing
 * a proper crossing, an endpoint-only touch, a collinear overlap, and disjoint
 * (acceptance criterion 3 / 教訓5.38). This lets upper-layer collision response
 * treat an existing edge contact (t=0) differently from a new crossing, and lets
 * FR-26 keep boundary contact out of "overlap".
 */
export function segmentsIntersect(
  p1: WorldCoordinate,
  p2: WorldCoordinate,
  p3: WorldCoordinate,
  p4: WorldCoordinate,
): SegmentIntersection {
  const d1 = cross(p3, p4, p1);
  const d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3);
  const d4 = cross(p1, p2, p4);

  // Proper crossing: each segment straddles the other's supporting line.
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) {
    // Intersection point via parametric form.
    const denom = (p1.lon - p2.lon) * (p3.lat - p4.lat) - (p1.lat - p2.lat) * (p3.lon - p4.lon);
    const t =
      ((p1.lon - p3.lon) * (p3.lat - p4.lat) - (p1.lat - p3.lat) * (p3.lon - p4.lon)) / denom;
    const point = quantizeCoordinate({
      lon: p1.lon + t * (p2.lon - p1.lon),
      lat: p1.lat + t * (p2.lat - p1.lat),
    });
    return { relation: SEGMENT_RELATION.Proper, point };
  }

  // Collinear cases: all four cross products zero AND the bounding boxes overlap
  // on the shared line beyond a single point.
  if (d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0) {
    const touching =
      onSegmentBox(p1, p3, p4) ||
      onSegmentBox(p2, p3, p4) ||
      onSegmentBox(p3, p1, p2) ||
      onSegmentBox(p4, p1, p2);
    if (!touching) return { relation: SEGMENT_RELATION.Disjoint };
    // Distinguish a shared-endpoint-only collinear touch from a real overlap.
    const sharedOnly = collinearSharedEndpointOnly(p1, p2, p3, p4);
    if (sharedOnly !== undefined) {
      return { relation: SEGMENT_RELATION.Endpoint, point: sharedOnly };
    }
    return { relation: SEGMENT_RELATION.Collinear };
  }

  // Non-proper but a zero cross product means an endpoint lies on the other
  // segment (a touch). Report the touching endpoint.
  if (d1 === 0 && onSegmentBox(p1, p3, p4)) return { relation: SEGMENT_RELATION.Endpoint, point: p1 };
  if (d2 === 0 && onSegmentBox(p2, p3, p4)) return { relation: SEGMENT_RELATION.Endpoint, point: p2 };
  if (d3 === 0 && onSegmentBox(p3, p1, p2)) return { relation: SEGMENT_RELATION.Endpoint, point: p3 };
  if (d4 === 0 && onSegmentBox(p4, p1, p2)) return { relation: SEGMENT_RELATION.Endpoint, point: p4 };

  return { relation: SEGMENT_RELATION.Disjoint };
}

/**
 * For two collinear segments, return the single shared point iff they touch at
 * exactly one common endpoint and do not otherwise overlap; otherwise undefined
 * (they overlap along a run, or are disjoint). Used to keep "two edges that meet
 * end-to-end" classified as an endpoint touch, not a collinear overlap.
 */
function collinearSharedEndpointOnly(
  p1: WorldCoordinate,
  p2: WorldCoordinate,
  p3: WorldCoordinate,
  p4: WorldCoordinate,
): WorldCoordinate | undefined {
  // Project onto the dominant axis to order the four points along the line.
  const horizontal = Math.abs(p2.lon - p1.lon) >= Math.abs(p2.lat - p1.lat);
  const key = (c: WorldCoordinate): number => (horizontal ? c.lon : c.lat);
  const aMin = Math.min(key(p1), key(p2));
  const aMax = Math.max(key(p1), key(p2));
  const bMin = Math.min(key(p3), key(p4));
  const bMax = Math.max(key(p3), key(p4));
  // Overlap interval on the shared line.
  const lo = Math.max(aMin, bMin);
  const hi = Math.min(aMax, bMax);
  if (lo > hi) return undefined; // disjoint
  if (lo < hi) return undefined; // genuine overlapping run
  // lo === hi: they meet at exactly one point. Identify it among the endpoints.
  for (const c of [p1, p2, p3, p4]) {
    if (key(c) === lo) return c;
  }
  return undefined;
}

// --- self-intersection ------------------------------------------------------

/**
 * True iff the ring's edges cross one another (a non-simple polygon).
 * Adjacent edges share an endpoint by construction; that shared endpoint is NOT
 * counted as a self-intersection. A proper crossing between non-adjacent edges,
 * or a collinear overlap between non-adjacent edges, IS a self-intersection.
 *
 * O(n²) over edges — exact, no spatial index (that pre-filtering is the upper
 * layer's job, spec §やらないこと). Rings with < 3 edges cannot self-intersect.
 *
 * A cheap per-edge AABB reject runs before the (now robust, hence costlier)
 * `segmentsIntersect` call: two edges whose bounding boxes do not overlap cannot
 * intersect, so the expensive exact predicate is skipped. This is a constant-
 * factor optimization only — it builds NO index and keeps the O(n²) contract — so
 * it stays within the spec boundary while cutting the dominant cost on large rings.
 */
export function ringSelfIntersects(ring: GeoRing): boolean {
  const n = ring.length;
  if (n < 3) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = ring[i];
    const a2 = ring[(i + 1) % n];
    if (a1 === undefined || a2 === undefined) continue;
    const aMinLon = a1.lon < a2.lon ? a1.lon : a2.lon;
    const aMaxLon = a1.lon > a2.lon ? a1.lon : a2.lon;
    const aMinLat = a1.lat < a2.lat ? a1.lat : a2.lat;
    const aMaxLat = a1.lat > a2.lat ? a1.lat : a2.lat;
    for (let j = i + 1; j < n; j += 1) {
      // Skip edges that share a vertex (adjacent edges, and the wrap-around pair
      // joining the last edge to the first).
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      const b1 = ring[j];
      const b2 = ring[(j + 1) % n];
      if (b1 === undefined || b2 === undefined) continue;
      // AABB reject: non-overlapping edge boxes cannot intersect. Adjacent edges
      // (handled specially below) always share a vertex so their boxes touch —
      // never skipped here.
      if (!adjacent) {
        if (
          (b1.lon < b2.lon ? b1.lon : b2.lon) > aMaxLon ||
          (b1.lon > b2.lon ? b1.lon : b2.lon) < aMinLon ||
          (b1.lat < b2.lat ? b1.lat : b2.lat) > aMaxLat ||
          (b1.lat > b2.lat ? b1.lat : b2.lat) < aMinLat
        ) {
          continue;
        }
      }
      const rel = segmentsIntersect(a1, a2, b1, b2).relation;
      if (adjacent) {
        // Adjacent edges legitimately meet at the shared vertex (endpoint). Only
        // a collinear overlap (edges fold back on each other) is a defect.
        if (rel === SEGMENT_RELATION.Collinear) return true;
        continue;
      }
      if (rel === SEGMENT_RELATION.Proper || rel === SEGMENT_RELATION.Collinear) {
        return true;
      }
      // Non-adjacent edges touching at an endpoint also breaks simplicity
      // (a pinch point where the ring revisits a vertex).
      if (rel === SEGMENT_RELATION.Endpoint) return true;
    }
  }
  return false;
}

// --- zero-length edge -------------------------------------------------------

/**
 * True iff the ring (treated as implicitly closed) contains an edge whose two
 * endpoints coincide *after quantization* — a zero-length edge (FR-32 / 教訓R2).
 * Uses the SAME quantization grid as the boolean-op front half (单一真实源),
 * so "what the op snaps away" and "what this predicate flags" agree exactly.
 */
export function ringHasZeroLengthEdge(ring: GeoRing): boolean {
  const n = ring.length;
  if (n < 2) return false;
  for (let i = 0; i < n; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    const qa = quantizeCoordinate(a);
    const qb = quantizeCoordinate(b);
    if (coordinatesEqual(qa, qb)) return true;
  }
  return false;
}

/**
 * True iff `inner` ring lies strictly inside `outer` ring — i.e. `inner` has real
 * interior inside `outer` and no part of `inner`'s boundary runs outside `outer`.
 * Both rings are implicitly closed (last → first edge included).
 *
 * This is the robust, boundary-aware containment used both for the U06 hole↔outer
 * hierarchy invariant and for U26 split re-parenting (knife/proposal). A single
 * vertex probe is fragile after quantization: a shared/seam vertex frequently
 * lands exactly ON the other ring's boundary, where `pointInPolygon` returns
 * Boundary (not Inside), so a lone `inner[0]` probe would wrongly report "not
 * contained" for a genuinely nested ring. We therefore test three conditions
 * (单一真实源 — both call sites share this one predicate):
 *
 *   1. No `inner` vertex is strictly OUTSIDE `outer`.
 *   2. No stretch of any `inner` edge runs strictly OUTSIDE `outer` (catches both
 *      a Proper crossing through a slot AND a sweep out through a notch-mouth
 *      vertex). Reuses {@link segmentsIntersect} rather than re-deriving crossing.
 *   3. `inner` has some real interior strictly inside `outer` (a degenerate ring
 *      lying entirely ON the `outer` boundary has zero real interior and is NOT
 *      contained).
 *
 * Deliberately AVOIDS any centroid probe: for a concave `inner` the centroid can
 * fall in `inner`'s own empty region, which for a ring hugging a notched `outer`
 * can be `outer`'s Outside space, wrongly rejecting a valid containment.
 */
export function ringStrictlyContains(outer: GeoRing, inner: GeoRing): boolean {
  if (inner.length < 3 || outer.length < 3) return false;
  const outerPoly: GeoPolygon = [outer];
  // (1) No inner vertex may be strictly outside the outer ring.
  for (const v of inner) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Outside) return false;
  }
  // (2) No stretch of any inner edge may run outside the outer ring.
  if (innerEdgeExitsOuter(inner, outer, outerPoly)) return false;
  // (3) The inner ring must have real interior inside the outer ring.
  return innerHasInteriorInsideOuter(inner, outerPoly);
}

/**
 * True iff `inner` has some point strictly inside `outer` — real interior, not
 * merely boundary contact. An inner vertex strictly Inside is the direct witness;
 * when every inner vertex sits on the outer boundary, an inner-edge midpoint
 * strictly Inside witnesses interior that runs through the outer ring.
 */
function innerHasInteriorInsideOuter(inner: GeoRing, outerPoly: GeoPolygon): boolean {
  for (const v of inner) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Inside) return true;
  }
  const n = inner.length;
  for (let i = 0; i < n; i += 1) {
    const a = inner[i];
    const b = inner[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    if (pointInPolygon(mid, outerPoly) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/**
 * True iff any stretch of an `inner` edge runs strictly OUTSIDE `outer`.
 *
 * For each inner edge [i1,i2] we collect the parameter t∈[0,1] of every point
 * where the edge meets the outer ring (Proper crossing OR Endpoint touch). With
 * the edge split at those parameters (plus 0 and 1), each consecutive sub-interval
 * lies wholly Inside, wholly Outside, or wholly on the Boundary of the outer ring
 * (it cannot change side without meeting the boundary, which would be another
 * split point). We sample each sub-interval at its midpoint: any midpoint strictly
 * Outside means that stretch of the inner boundary leaves the outer ring.
 *
 * O(innerEdges × outerEdges), exact, reusing {@link segmentsIntersect}. Both
 * rings are implicitly closed.
 */
function innerEdgeExitsOuter(inner: GeoRing, outer: GeoRing, outerPoly: GeoPolygon): boolean {
  const hn = inner.length;
  const on = outer.length;
  for (let i = 0; i < hn; i += 1) {
    const h1 = inner[i];
    const h2 = inner[(i + 1) % hn];
    if (h1 === undefined || h2 === undefined) continue;
    const ts: number[] = [0, 1];
    for (let j = 0; j < on; j += 1) {
      const o1 = outer[j];
      const o2 = outer[(j + 1) % on];
      if (o1 === undefined || o2 === undefined) continue;
      const rel = segmentsIntersect(h1, h2, o1, o2);
      if (rel.point !== undefined) {
        const t = paramOnSegment(h1, h2, rel.point);
        if (t !== undefined) ts.push(t);
      }
    }
    ts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < ts.length; k += 1) {
      const lo = ts[k]!;
      const hi = ts[k + 1]!;
      if (hi - lo < 1e-12) continue; // zero-width sub-interval, nothing to sample
      const tm = (lo + hi) / 2;
      const mid = { lon: h1.lon + tm * (h2.lon - h1.lon), lat: h1.lat + tm * (h2.lat - h1.lat) };
      if (pointInPolygon(mid, outerPoly) === POINT_LOCATION.Outside) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Parameter t∈[0,1] of point p along the segment [a,b], or undefined if the
 * segment is degenerate. p is assumed (by construction) to lie on the segment;
 * the dominant axis is used to avoid division by a near-zero component.
 */
function paramOnSegment(
  a: WorldCoordinate,
  b: WorldCoordinate,
  p: WorldCoordinate,
): number | undefined {
  const dLon = b.lon - a.lon;
  const dLat = b.lat - a.lat;
  if (Math.abs(dLon) >= Math.abs(dLat)) {
    if (dLon === 0) return undefined;
    return (p.lon - a.lon) / dLon;
  }
  if (dLat === 0) return undefined;
  return (p.lat - a.lat) / dLat;
}
