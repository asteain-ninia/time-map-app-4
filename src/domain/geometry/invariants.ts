// U06 post-op invariant re-check (technical policy R2, back half of the defense
// layer). After `polygon-clipping` returns, the result multi-polygon is
// re-validated against this app's domain invariants before it is allowed back
// into the domain. A violation is NOT thrown and NOT swallowed: the caller gets
// a discriminated rejection result (see ./boolean-ops) carrying the reason, so
// FR-32 / FR-25 禁止条件 are testable return values, not exceptions
// (spec §実装方針「結果型の設計（判別共用体）」/ 教訓5.26).
//
// Invariants enforced (acceptance criterion 2):
//   - every ring has >= 3 vertices,
//   - no ring has a zero-length edge (post-quantization),
//   - no ring self-intersects,
//   - the territory→hole ring hierarchy is coherent: each polygon piece's hole
//     rings lie inside its outer ring (the result is a flat list of outer+holes
//     per piece; we verify holes are actually contained, not stray rings).
//
// Pure: no mutation, no side effects.

import {
  pointInPolygon,
  POINT_LOCATION,
  ringHasZeroLengthEdge,
  ringSelfIntersects,
  segmentsIntersect,
  SEGMENT_RELATION,
} from './predicates';
import type { GeoMultiPolygon, GeoPolygon, GeoRing } from './types';

export const INVARIANT_VIOLATION = {
  /** A ring has fewer than 3 vertices (cannot bound an area). */
  TooFewVertices: 'too-few-vertices',
  /** A ring has a zero-length edge after quantization. */
  ZeroLengthEdge: 'zero-length-edge',
  /** A ring crosses itself (non-simple). */
  SelfIntersection: 'self-intersection',
  /** A hole ring is not contained within its polygon's outer ring. */
  HoleNotContained: 'hole-not-contained',
  /** A polygon piece has no outer ring. */
  MissingOuterRing: 'missing-outer-ring',
} as const;

export type InvariantViolationKind =
  (typeof INVARIANT_VIOLATION)[keyof typeof INVARIANT_VIOLATION];

export interface InvariantViolation {
  readonly kind: InvariantViolationKind;
  /** Index of the offending polygon piece within the multi-polygon. */
  readonly polygonIndex: number;
  /** Index of the offending ring within its polygon (0 = outer), if applicable. */
  readonly ringIndex?: number;
}

function checkRing(ring: GeoRing): InvariantViolationKind | undefined {
  if (ring.length < 3) return INVARIANT_VIOLATION.TooFewVertices;
  if (ringHasZeroLengthEdge(ring)) return INVARIANT_VIOLATION.ZeroLengthEdge;
  if (ringSelfIntersects(ring)) return INVARIANT_VIOLATION.SelfIntersection;
  return undefined;
}

/**
 * True iff the hole ring is genuinely contained within the outer ring.
 *
 * Vertex-only containment is UNSOUND for concave outers (slot/notch shapes that
 * polygon-clipping or hand edits can produce): every hole vertex can land in
 * solid material while a hole EDGE crosses out through a notch into space that is
 * outside the outer ring. So this combines three checks:
 *
 *   1. No hole vertex is strictly Outside the outer ring.
 *   2. No hole EDGE properly crosses an outer EDGE. A proper crossing means the
 *      hole boundary leaves and re-enters the outer ring (it dips through a notch
 *      / slot), so the hole is not contained even though its vertices sit inside.
 *      We reuse the existing `segmentsIntersect` predicate (单一真实源) rather
 *      than re-deriving a crossing test.
 *   3. The hole has some real interior inside the outer ring (a degenerate hole
 *      laid entirely ON the outer edge, sharing only boundary, has zero real
 *      interior and is not a real hole).
 *
 * On check (3): once (1) and (2) hold, no part of the hole boundary lies outside
 * the outer ring (no vertex outside, no edge dipping out through a notch), so the
 * hole IS contained — *unless* it is the degenerate all-on-boundary case. We must
 * NOT probe the hole's vertex-centroid for this: for a CONCAVE hole the centroid
 * can fall in the hole's own empty region, which for a hole hugging a notched
 * outer can be the outer's Outside space, wrongly rejecting a valid containment.
 * Instead we look for any witness of real interior: a hole vertex strictly Inside
 * the outer, or (when every vertex sits on the outer boundary) a hole-edge
 * midpoint strictly Inside the outer. Only when NO such witness exists is the
 * hole degenerate-on-boundary and rejected.
 *
 * Collinear/endpoint contacts between a hole edge and an outer edge are NOT
 * treated as crossings here: a hole edge that runs along or merely touches the
 * outer boundary does not exit the outer ring. Only a Proper crossing does, and
 * that is what closes the slot/notch gap (FR-25 hand-edited rings).
 */
function holeContainedInOuter(hole: GeoRing, outer: GeoRing): boolean {
  const outerPoly: GeoPolygon = [outer];
  // (1) No hole vertex may be strictly outside the outer ring.
  for (const v of hole) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Outside) return false;
  }
  // (2) No hole edge may properly cross an outer edge. Both rings are treated as
  // implicitly closed (last → first edge included).
  if (holeEdgeCrossesOuter(hole, outer)) return false;
  // (3) Reject only the degenerate hole that lies entirely ON the outer boundary
  // (zero real interior). After (1) and (2), the hole is contained iff it has any
  // real interior inside the outer; witness it with a point strictly Inside.
  return holeHasInteriorInsideOuter(hole, outerPoly);
}

/**
 * True iff the hole has some point strictly inside the outer ring — i.e. real
 * interior, not merely boundary contact. A hole vertex strictly Inside is the
 * direct witness; when every hole vertex sits on the outer boundary, a hole-edge
 * midpoint strictly Inside witnesses interior that runs through the outer ring.
 * If neither exists the hole lies entirely on the outer boundary (degenerate).
 *
 * This deliberately AVOIDS any vertex-centroid probe: for a concave hole the
 * centroid is not guaranteed to lie inside the hole and can land in the outer's
 * Outside region (e.g. a hole hugging a notched outer), which would wrongly
 * reject a genuinely-contained hole.
 */
function holeHasInteriorInsideOuter(hole: GeoRing, outerPoly: GeoPolygon): boolean {
  for (const v of hole) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Inside) return true;
  }
  // No vertex strictly inside: every vertex is on the outer boundary (vertices
  // outside were already rejected in check (1)). Probe edge midpoints, which for
  // a hole with real interior cut a chord through the outer's interior.
  const n = hole.length;
  for (let i = 0; i < n; i += 1) {
    const a = hole[i];
    const b = hole[(i + 1) % n];
    if (a === undefined || b === undefined) continue;
    const mid = { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
    if (pointInPolygon(mid, outerPoly) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/**
 * True iff any edge of the hole ring properly crosses any edge of the outer ring.
 * O(holeEdges × outerEdges), exact, reusing `segmentsIntersect` so the crossing
 * convention matches the rest of the geometry layer. Both rings are implicitly
 * closed. Only a `Proper` relation counts as a crossing — an endpoint touch or a
 * collinear overlap is the hole boundary meeting (not exiting) the outer ring.
 */
function holeEdgeCrossesOuter(hole: GeoRing, outer: GeoRing): boolean {
  const hn = hole.length;
  const on = outer.length;
  for (let i = 0; i < hn; i += 1) {
    const h1 = hole[i];
    const h2 = hole[(i + 1) % hn];
    if (h1 === undefined || h2 === undefined) continue;
    for (let j = 0; j < on; j += 1) {
      const o1 = outer[j];
      const o2 = outer[(j + 1) % on];
      if (o1 === undefined || o2 === undefined) continue;
      if (segmentsIntersect(h1, h2, o1, o2).relation === SEGMENT_RELATION.Proper) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Validate the whole result multi-polygon. Returns the list of violations (empty
 * = valid). All pieces and all rings are checked — no piece is skipped (教訓5.1).
 * An empty multi-polygon is valid (教訓5.18: an empty result is a true value).
 */
export function checkMultiPolygonInvariants(mp: GeoMultiPolygon): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  for (let p = 0; p < mp.length; p += 1) {
    const poly = mp[p];
    if (poly === undefined) continue;
    const outer = poly[0];
    if (outer === undefined) {
      violations.push({ kind: INVARIANT_VIOLATION.MissingOuterRing, polygonIndex: p });
      continue;
    }
    for (let r = 0; r < poly.length; r += 1) {
      const ring = poly[r];
      if (ring === undefined) continue;
      const ringViolation = checkRing(ring);
      if (ringViolation !== undefined) {
        violations.push({ kind: ringViolation, polygonIndex: p, ringIndex: r });
      }
    }
    // Containment: each hole (index >= 1) must sit inside the outer ring. Only
    // run when the outer ring is itself well-formed (containment is meaningless
    // for a self-intersecting outer).
    if (checkRing(outer) === undefined) {
      for (let r = 1; r < poly.length; r += 1) {
        const hole = poly[r];
        if (hole === undefined || checkRing(hole) !== undefined) continue;
        if (!holeContainedInOuter(hole, outer)) {
          violations.push({
            kind: INVARIANT_VIOLATION.HoleNotContained,
            polygonIndex: p,
            ringIndex: r,
          });
        }
      }
    }
  }
  return violations;
}

/** True iff the multi-polygon satisfies every invariant. */
export function isMultiPolygonValid(mp: GeoMultiPolygon): boolean {
  return checkMultiPolygonInvariants(mp).length === 0;
}
