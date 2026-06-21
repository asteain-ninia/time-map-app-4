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
  ringStrictlyContains,
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
 * Delegates to the shared {@link ringStrictlyContains} predicate (单一真实源):
 * vertex-only containment is UNSOUND for concave outers (slot/notch shapes
 * polygon-clipping or hand edits produce) — every hole vertex can sit in solid
 * material while a hole EDGE crosses out through a notch — and a single on-boundary
 * vertex probe yields Boundary, not Inside. The predicate combines three robust
 * checks (no vertex strictly outside; no edge stretch outside; some real interior
 * strictly inside), avoiding any centroid probe. The same predicate backs U26
 * split re-parenting so both call sites agree on containment.
 */
function holeContainedInOuter(hole: GeoRing, outer: GeoRing): boolean {
  return ringStrictlyContains(outer, hole);
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
 * Twice the SIGNED area of a ring (shoelace). Sign encodes winding:
 * positive = counter-clockwise (interior on the LEFT of each directed edge),
 * negative = clockwise (interior on the RIGHT). Magnitude is unused — only the
 * sign is consumed (by {@link ringsBoundaryCoincidentSameSide}), so float
 * imprecision in the magnitude is irrelevant here.
 */
function ringSignedAreaX2(ring: GeoRing): number {
  const n = ring.length;
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const p = ring[i];
    const q = ring[(i + 1) % n];
    if (p === undefined || q === undefined) continue;
    acc += p.lon * q.lat - q.lon * p.lat;
  }
  return acc;
}

/**
 * True iff two rings share a positive-length boundary run AND keep their
 * interiors on the SAME geometric side of that shared line — the signature of a
 * coincident / boundary-overlapping pair (e.g. an identical duplicate piece, or a
 * duplicate hole) whose interiors therefore overlap.
 *
 * This is the case the proper-crossing + strictly-Inside-vertex witnesses in
 * {@link ringsOverlap} / {@link piecesSolidOverlap} structurally cannot see: for
 * two coincident rings every edge pair is Collinear (never Proper) and every
 * vertex lies on the other's boundary (pointInPolygon → Boundary, never Inside),
 * so without this check a fully-coincident duplicate would pass the disjoint
 * invariant. A legal edge-adjacent touch (two pieces sharing a border) is NOT
 * flagged: there the two rings traverse the shared edge in OPPOSITE winding
 * sense, putting their interiors on OPPOSITE sides → returns false.
 *
 * Robust & epsilon-free: the shared run is detected by `segmentsIntersect`'s
 * exact Collinear classification (orient2d signs); the interior side of each ring
 * is derived from its winding sign (signed area) and the directed edge — no
 * coordinate-scale-dependent offset probe.
 */
function ringsBoundaryCoincidentSameSide(a: GeoRing, b: GeoRing): boolean {
  const an = a.length;
  const bn = b.length;
  // Interior-side sign per ring: +1 if interior is on the LEFT of each directed
  // edge (CCW winding), -1 if on the RIGHT (CW winding). A degenerate (zero-area)
  // ring has no interior side and cannot coincide-overlap.
  const wa = ringSignedAreaX2(a);
  const wb = ringSignedAreaX2(b);
  if (wa === 0 || wb === 0) return false;
  const sideA = wa > 0 ? 1 : -1;
  const sideB = wb > 0 ? 1 : -1;

  for (let i = 0; i < an; i += 1) {
    const a1 = a[i];
    const a2 = a[(i + 1) % an];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = 0; j < bn; j += 1) {
      const b1 = b[j];
      const b2 = b[(j + 1) % bn];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsIntersect(a1, a2, b1, b2).relation !== SEGMENT_RELATION.Collinear) {
        continue;
      }
      // The two edges are collinear and overlap along a positive-length run.
      // Each ring's inward normal along its edge is leftNormal(dir) scaled by its
      // winding sign. The edges are parallel; if they point the SAME way the
      // shared direction is identical, if OPPOSITE the directions are negated.
      const dax = a2.lon - a1.lon;
      const day = a2.lat - a1.lat;
      const dbx = b2.lon - b1.lon;
      const dby = b2.lat - b1.lat;
      // Sign of the dot product tells whether the two edge directions are aligned
      // (+) or anti-aligned (-) along the shared line.
      const sameDir = dax * dbx + day * dby >= 0 ? 1 : -1;
      // Interiors land on the same geometric side of the shared line iff the
      // inward-normal directions agree once relative edge orientation is folded in.
      if (sideA === sideB * sameDir) return true;
    }
  }
  return false;
}

/**
 * True iff two simple rings have OVERLAPPING INTERIORS (not merely boundary
 * contact). Used to enforce the multi-polygon type契约 (types.ts): polygon pieces
 * are disjoint and holes within one piece do not overlap. A boundary-only touch
 * (shared edge / vertex) is NOT an overlap. Detection:
 *   - any Proper edge crossing means the boundaries cross → interiors overlap;
 *   - a vertex of one strictly Inside the other witnesses nesting/overlap;
 *   - a coincident boundary run with interiors on the same side witnesses a
 *     duplicate / fully-overlapping ring that the first two probes structurally
 *     miss (every edge Collinear, every vertex on the other's Boundary).
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
  // No proper crossing and no strictly-Inside vertex: a fully/partly coincident
  // boundary (identical duplicate ring) still overlaps — detect it explicitly.
  return ringsBoundaryCoincidentSameSide(a, b);
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
 *
 * Two pieces with COINCIDENT outer rings (an identical duplicate piece) are also
 * flagged: their outer-bounded regions are the same, which the proper-crossing and
 * strictly-Inside-vertex probes structurally miss (every outer edge Collinear,
 * every outer vertex on the other's Boundary). This cannot misfire on a legal
 * ENCLAVE — an enclave's outer ring is nested inside the parent's HOLE, so the two
 * outer rings are disjoint, share no boundary run, and {@link
 * ringsBoundaryCoincidentSameSide} returns false.
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
  return ringsBoundaryCoincidentSameSide(outerA, outerB);
}

/** True iff the multi-polygon satisfies every invariant. */
export function isMultiPolygonValid(mp: GeoMultiPolygon): boolean {
  return checkMultiPolygonInvariants(mp).length === 0;
}
