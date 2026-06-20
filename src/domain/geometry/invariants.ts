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

import type { WorldCoordinate } from '../coordinate';
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
  /**
   * Two outer rings of distinct polygon pieces overlap, OR two hole rings within
   * the same polygon overlap. The multi-polygon type契约 (types.ts) requires
   * disjoint polygon pieces and non-overlapping holes; an overlap means the kernel
   * (or a hand edit) produced a self-inconsistent multi-polygon.
   */
  OverlappingPieces: 'overlapping-pieces',
} as const;

export type InvariantViolationKind =
  (typeof INVARIANT_VIOLATION)[keyof typeof INVARIANT_VIOLATION];

export interface InvariantViolation {
  readonly kind: InvariantViolationKind;
  /** Index of the offending polygon piece within the multi-polygon. */
  readonly polygonIndex: number;
  /** Index of the offending ring within its polygon (0 = outer), if applicable. */
  readonly ringIndex?: number;
  /**
   * For a relational violation (OverlappingPieces) the index of the SECOND
   * polygon piece / ring involved. Absent for single-ring violations.
   */
  readonly otherPolygonIndex?: number;
  readonly otherRingIndex?: number;
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
 * Endpoint/collinear contacts that merely TOUCH the outer boundary do not on
 * their own exit the outer ring — but a hole edge can leave the solid through a
 * concave VERTEX (a notch mouth) while only ever touching the outer ring at
 * endpoints (never a Proper crossing). The old Proper-only test missed that
 * (Codex反例: a hole edge between two on-boundary vertices sweeping across a notch
 * mouth). So check (2) is now a SUB-SEGMENT test: split each hole edge at every
 * point where it meets the outer ring (Proper or Endpoint) and require every
 * sub-segment midpoint to be Inside or on the Boundary — never strictly Outside.
 * A midpoint that is Outside means that stretch of the hole boundary runs through
 * empty space outside the outer ring, so the hole is not contained.
 */
function holeContainedInOuter(hole: GeoRing, outer: GeoRing): boolean {
  const outerPoly: GeoPolygon = [outer];
  // (1) No hole vertex may be strictly outside the outer ring.
  for (const v of hole) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Outside) return false;
  }
  // (2) No stretch of any hole edge may run outside the outer ring (catches both
  // a Proper crossing through a slot AND a sweep out through a notch-mouth vertex).
  // Both rings are treated as implicitly closed (last → first edge included).
  if (holeEdgeExitsOuter(hole, outer, outerPoly)) return false;
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
 * True iff any stretch of a hole edge runs strictly OUTSIDE the outer ring.
 *
 * For each hole edge [h1,h2] we collect the parameter t∈[0,1] of every point
 * where the edge meets the outer ring — both Proper crossings and Endpoint
 * touches (a touch at a notch-mouth vertex is exactly the case the old
 * Proper-only test missed). With the edge split at those parameters (plus the
 * endpoints 0 and 1), each consecutive sub-interval lies wholly Inside, wholly
 * Outside, or wholly on the Boundary of the outer ring (it cannot change side
 * without meeting the boundary, which would be another split point). We sample
 * each sub-interval at its midpoint: if any midpoint is strictly Outside, that
 * stretch of the hole boundary leaves the outer ring and the hole is NOT
 * contained.
 *
 * O(holeEdges × outerEdges), exact, reusing `segmentsIntersect` so the crossing
 * convention matches the rest of the geometry layer. Both rings are implicitly
 * closed.
 */
function holeEdgeExitsOuter(hole: GeoRing, outer: GeoRing, outerPoly: GeoPolygon): boolean {
  const hn = hole.length;
  const on = outer.length;
  for (let i = 0; i < hn; i += 1) {
    const h1 = hole[i];
    const h2 = hole[(i + 1) % hn];
    if (h1 === undefined || h2 === undefined) continue;
    // Parameters along [h1,h2] at which it meets the outer ring. Endpoints (0,1)
    // are always present so the whole edge is covered by sub-intervals.
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

// --- ring overlap (piece-vs-piece, hole-vs-hole) ----------------------------

interface Bbox {
  readonly minLon: number;
  readonly minLat: number;
  readonly maxLon: number;
  readonly maxLat: number;
}

function ringBbox(ring: GeoRing): Bbox | undefined {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const v of ring) {
    if (v.lon < minLon) minLon = v.lon;
    if (v.lat < minLat) minLat = v.lat;
    if (v.lon > maxLon) maxLon = v.lon;
    if (v.lat > maxLat) maxLat = v.lat;
  }
  if (!Number.isFinite(minLon)) return undefined;
  return { minLon, minLat, maxLon, maxLat };
}

/** True iff two AABBs share interior area (touching edges/corners do not count). */
function bboxesOverlap(a: Bbox, b: Bbox): boolean {
  return a.minLon < b.maxLon && b.minLon < a.maxLon && a.minLat < b.maxLat && b.minLat < a.maxLat;
}

/**
 * True iff two simple rings have OVERLAPPING INTERIORS (not merely boundary
 * contact). Used to enforce the multi-polygon type契约 (types.ts): polygon pieces
 * are disjoint and holes within one piece do not overlap. A boundary-only touch
 * (shared edge / vertex) is NOT an overlap. Detection:
 *   - any Proper edge crossing means the boundaries cross → interiors overlap;
 *   - otherwise (no crossing) one ring is either disjoint from or nested in the
 *     other: a vertex of one strictly Inside the other witnesses nesting/overlap.
 * Both rings are assumed already validated as simple (caller checks checkRing).
 */
function ringsOverlap(a: GeoRing, b: GeoRing): boolean {
  const an = a.length;
  const bn = b.length;
  for (let i = 0; i < an; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % an];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = 0; j < bn; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % bn];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsIntersect(a1, a2, b1, b2).relation === SEGMENT_RELATION.Proper) {
        return true;
      }
    }
  }
  // No proper crossing: check nesting. A vertex of one ring strictly inside the
  // other means one contains the other (overlapping interiors).
  const aPoly: GeoPolygon = [a];
  const bPoly: GeoPolygon = [b];
  for (const v of a) {
    if (pointInPolygon(v, bPoly) === POINT_LOCATION.Inside) return true;
  }
  for (const v of b) {
    if (pointInPolygon(v, aPoly) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/**
 * Validate the whole result multi-polygon. Returns the list of violations (empty
 * = valid). All pieces and all rings are checked — no piece is skipped (教訓5.1).
 * An empty multi-polygon is valid (教訓5.18: an empty result is a true value).
 *
 * Each ring's structural check (`checkRing`, which includes the O(n²) self-
 * intersection scan) is computed exactly ONCE and cached, then reused by the
 * containment and overlap passes (Codex perf指摘: it was previously run two or
 * three times per ring).
 */
export function checkMultiPolygonInvariants(mp: GeoMultiPolygon): InvariantViolation[] {
  const violations: InvariantViolation[] = [];
  // Per-(piece,ring) cache of the structural check result, computed once.
  const ringStatus: (InvariantViolationKind | undefined)[][] = [];

  for (let p = 0; p < mp.length; p += 1) {
    const poly = mp[p];
    if (poly === undefined) {
      ringStatus.push([]);
      continue;
    }
    const statuses: (InvariantViolationKind | undefined)[] = [];
    for (let r = 0; r < poly.length; r += 1) {
      const ring = poly[r];
      const status = ring === undefined ? undefined : checkRing(ring);
      statuses.push(status);
      if (status !== undefined) {
        violations.push({ kind: status, polygonIndex: p, ringIndex: r });
      }
    }
    ringStatus.push(statuses);

    const outer = poly[0];
    if (outer === undefined) {
      violations.push({ kind: INVARIANT_VIOLATION.MissingOuterRing, polygonIndex: p });
      continue;
    }

    // Containment: each hole (index >= 1) must sit inside the outer ring. Only
    // run when the outer ring is itself well-formed (containment is meaningless
    // for a self-intersecting outer). Reuses the cached ring statuses.
    if (statuses[0] === undefined) {
      for (let r = 1; r < poly.length; r += 1) {
        const hole = poly[r];
        if (hole === undefined || statuses[r] !== undefined) continue;
        if (!holeContainedInOuter(hole, outer)) {
          violations.push({
            kind: INVARIANT_VIOLATION.HoleNotContained,
            polygonIndex: p,
            ringIndex: r,
          });
        }
      }
    }

    // Holes within this piece must not overlap each other (disjoint-hole契约).
    checkHolesDisjoint(poly, p, statuses, violations);
  }

  // Distinct polygon pieces must have disjoint interiors (disjoint-piece契约).
  checkPiecesDisjoint(mp, ringStatus, violations);

  return violations;
}

/** Flag any two holes of one polygon whose interiors overlap. bbox-prefiltered. */
function checkHolesDisjoint(
  poly: GeoPolygon,
  polygonIndex: number,
  statuses: (InvariantViolationKind | undefined)[],
  violations: InvariantViolation[],
): void {
  for (let r = 1; r < poly.length; r += 1) {
    const hole = poly[r];
    if (hole === undefined || statuses[r] !== undefined) continue;
    const bb = ringBbox(hole);
    if (bb === undefined) continue;
    for (let s = r + 1; s < poly.length; s += 1) {
      const other = poly[s];
      if (other === undefined || statuses[s] !== undefined) continue;
      const obb = ringBbox(other);
      if (obb === undefined || !bboxesOverlap(bb, obb)) continue;
      if (ringsOverlap(hole, other)) {
        violations.push({
          kind: INVARIANT_VIOLATION.OverlappingPieces,
          polygonIndex,
          ringIndex: r,
          otherPolygonIndex: polygonIndex,
          otherRingIndex: s,
        });
      }
    }
  }
}

/**
 * Flag any two distinct polygon pieces whose SOLID regions overlap. bbox-
 * prefiltered on the outer rings.
 *
 * Crucially this is hole-aware so it does NOT reject a legal ENCLAVE — a piece
 * whose outer ring is nested inside a HOLE of another piece (飛び地; see types.ts
 * / predicates.ts). Two pieces overlap iff their outer boundaries Proper-cross, or
 * a vertex of one piece's outer ring lies strictly inside the *solid* of the other
 * (i.e. inside its outer AND outside all of its holes). An enclave's outer
 * vertices fall inside the parent's HOLE → outside the parent's solid → not
 * flagged.
 */
function checkPiecesDisjoint(
  mp: GeoMultiPolygon,
  ringStatus: (InvariantViolationKind | undefined)[][],
  violations: InvariantViolation[],
): void {
  // Precompute, once, the pieces with a well-formed outer ring + its bbox.
  const pieces: { index: number; poly: GeoPolygon; outer: GeoRing; bbox: Bbox }[] = [];
  for (let p = 0; p < mp.length; p += 1) {
    const poly = mp[p];
    if (poly === undefined) continue;
    const outer = poly[0];
    if (outer === undefined || ringStatus[p]?.[0] !== undefined) continue;
    const bbox = ringBbox(outer);
    if (bbox === undefined) continue;
    pieces.push({ index: p, poly, outer, bbox });
  }
  for (let i = 0; i < pieces.length; i += 1) {
    const a = pieces[i]!;
    for (let j = i + 1; j < pieces.length; j += 1) {
      const b = pieces[j]!;
      if (!bboxesOverlap(a.bbox, b.bbox)) continue;
      if (piecesSolidOverlap(a.poly, a.outer, b.poly, b.outer)) {
        violations.push({
          kind: INVARIANT_VIOLATION.OverlappingPieces,
          polygonIndex: a.index,
          ringIndex: 0,
          otherPolygonIndex: b.index,
          otherRingIndex: 0,
        });
      }
    }
  }
}

/**
 * True iff the SOLID regions (outer minus holes) of two polygon pieces overlap.
 * A Proper crossing of the two outer boundaries means the outer-bounded regions
 * interleave; otherwise nesting is witnessed by an outer vertex of one piece lying
 * strictly inside the other piece's solid (hole-aware `pointInPolygon`).
 */
function piecesSolidOverlap(
  polyA: GeoPolygon,
  outerA: GeoRing,
  polyB: GeoPolygon,
  outerB: GeoRing,
): boolean {
  const an = outerA.length;
  const bn = outerB.length;
  for (let i = 0; i < an; i += 1) {
    const a1 = outerA[i];
    const a2 = outerA[(i + 1) % an];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = 0; j < bn; j += 1) {
      const b1 = outerB[j];
      const b2 = outerB[(j + 1) % bn];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsIntersect(a1, a2, b1, b2).relation === SEGMENT_RELATION.Proper) {
        return true;
      }
    }
  }
  for (const v of outerA) {
    if (pointInPolygon(v, polyB) === POINT_LOCATION.Inside) return true;
  }
  for (const v of outerB) {
    if (pointInPolygon(v, polyA) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/** True iff the multi-polygon satisfies every invariant. */
export function isMultiPolygonValid(mp: GeoMultiPolygon): boolean {
  return checkMultiPolygonInvariants(mp).length === 0;
}
