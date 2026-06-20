// U07: ring-hierarchy invariants + geometric validation + deletion reorganization.
//
// This unit is the single source of truth for *judging* and *reorganizing* the
// ring hierarchy of ONE leaf feature's shape. It is a pure-logic layer on top of
// the U06 model (Ring / Shape / VertexStore) and the U06 geometric predicates;
// it adds NO new geometry primitive of its own — containment / crossing /
// disjointness are delegated to `pointInPolygon` / `segmentsIntersect` (单一真实源,
// spec §依存). It does not touch rendering, UI, persistence, spatial index, or
// undo/redo history; upper units call these pure functions.
//
// Three responsibilities (spec §目的):
//   1. Alternation invariant (FR-24): along every parent→child path the role
//      flips territory ↔ hole, and every outermost (parentless) ring is a
//      territory. Validated with a *structured* result (violations enumerated),
//      so real-time and pre-commit checks share one return value (教訓5.26).
//   2. Geometric containment / non-crossing / non-overlap (FR-25): a hole fully
//      inside its parent without crossing it; siblings (same parent) not crossing;
//      enclaves (separate top-level territories) not overlapping each other.
//   3. Deletion reorganization (FR-24): deleting a hole or a territory ring and
//      re-attaching its descendants so the alternation is preserved — one pure
//      function `(Shape, RingId) -> Shape` whose return value alone captures the
//      before/after state (single-operation testability).
//
// Derived values (depth, role-alternation) are NEVER stored on a ring; they are
// computed from the parent links here (spec §データモデル / 教訓5.29趣旨).
//
// Coordinates are resolved through the SAME quantization grid U06 uses before any
// geometric predicate (R2 防御層): we quantize ring coordinates so boundary
// contact (touching but not overlapping) is not misjudged as overlap, matching
// the boundary conventions frozen in U06 predicates.

import { assertNever } from './assert-never';
import type { WorldCoordinate } from './coordinate';
import { unwrapRing, worldWrapReplicas } from './geo/index';
import {
  pointInPolygon,
  POINT_LOCATION,
  quantizeCoordinate,
  segmentsIntersect,
  SEGMENT_RELATION,
  type GeoPolygon,
  type GeoRing,
} from './geometry/index';
import type { RingId } from './ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  isTopLevelRing,
  RING_KIND,
  type HoleRing,
  type Ring,
  type Shape,
  type TerritoryRing,
} from './ring';
import { getVertex, type VertexStore } from './vertex';

// ---------------------------------------------------------------------------
// Hierarchy navigation (derived values: NOT stored on rings)
// ---------------------------------------------------------------------------

/** Index a shape's rings by ID for O(1) parent/child navigation. */
function indexById(shape: Shape): ReadonlyMap<RingId, Ring> {
  const byId = new Map<RingId, Ring>();
  for (const ring of shape.rings) {
    byId.set(ring.id, ring);
  }
  return byId;
}

/** The parent ID of a ring, or undefined for a top-level territory. */
function parentIdOf(ring: Ring): RingId | undefined {
  switch (ring.kind) {
    case RING_KIND.Territory:
      return ring.parentRingId;
    case RING_KIND.Hole:
      return ring.parentRingId;
    default:
      return assertNever(ring);
  }
}

/**
 * Direct children of a ring within a shape (rings whose parent is `ringId`).
 * Returns a fresh array; order follows the shape's ring order (deterministic).
 */
export function childrenOf(shape: Shape, ringId: RingId): readonly Ring[] {
  return shape.rings.filter((r) => parentIdOf(r) === ringId);
}

/** Top-level rings of a shape (no parent). Empty is a legal value (教訓5.18). */
export function topLevelRings(shape: Shape): readonly Ring[] {
  return shape.rings.filter((r) => parentIdOf(r) === undefined);
}

/**
 * Hierarchy depth of a ring, derived purely from parent links: an outermost
 * territory is 0, and each step inward (+1). Returns undefined when the parent
 * chain is broken (a dangling parent reference) or cyclic — callers treat that
 * as a structural defect rather than a depth. Never stored on the ring.
 */
export function ringDepth(shape: Shape, ringId: RingId): number | undefined {
  const byId = indexById(shape);
  let current = byId.get(ringId);
  if (current === undefined) return undefined;
  let depth = 0;
  const seen = new Set<RingId>();
  while (true) {
    if (seen.has(current.id)) return undefined; // cycle
    seen.add(current.id);
    const parentId = parentIdOf(current);
    if (parentId === undefined) return depth;
    const parent = byId.get(parentId);
    if (parent === undefined) return undefined; // dangling parent
    current = parent;
    depth += 1;
  }
}

// ---------------------------------------------------------------------------
// Structured validation result (shared by real-time + pre-commit; 教訓5.26)
// ---------------------------------------------------------------------------

export const RING_VIOLATION = {
  /** A top-level (parentless) ring is a hole — holes are never outermost. */
  HoleAtTopLevel: 'hole-at-top-level',
  /** A non-top-level territory's parent is not a hole (alternation broken). */
  TerritoryParentNotHole: 'territory-parent-not-hole',
  /** A hole's parent is not a territory (alternation broken). */
  HoleParentNotTerritory: 'hole-parent-not-territory',
  /** A ring references a parent ID that is not present in the shape. */
  DanglingParent: 'dangling-parent',
  /** The parent chain forms a cycle. */
  CyclicParent: 'cyclic-parent',
  /** A hole is not fully contained inside its parent territory. */
  HoleNotContained: 'hole-not-contained',
  /** A hole's boundary crosses its parent territory's boundary. */
  HoleCrossesParent: 'hole-crosses-parent',
  /** Two sibling rings (same parent) cross / overlap each other. */
  SiblingsOverlap: 'siblings-overlap',
  /** Two top-level territories (enclaves of the same feature) overlap. */
  EnclavesOverlap: 'enclaves-overlap',
} as const;

export type RingViolationKind = (typeof RING_VIOLATION)[keyof typeof RING_VIOLATION];

/**
 * One structured violation: the offending ring plus any related ring(s). The
 * value is machine-enumerable so the same result feeds real-time candidate
 * display AND pre-commit command rejection (FR-25 / 教訓5.26).
 */
export interface RingViolation {
  readonly kind: RingViolationKind;
  /** The ring the violation is attributed to. */
  readonly ringId: RingId;
  /** A related ring (parent / sibling / other enclave), when applicable. */
  readonly relatedRingId?: RingId;
}

export interface RingValidationResult {
  readonly valid: boolean;
  readonly violations: readonly RingViolation[];
}

function result(violations: readonly RingViolation[]): RingValidationResult {
  return { valid: violations.length === 0, violations };
}

function violation(
  kind: RingViolationKind,
  ringId: RingId,
  relatedRingId?: RingId,
): RingViolation {
  return relatedRingId === undefined
    ? { kind, ringId }
    : { kind, ringId, relatedRingId };
}

// ---------------------------------------------------------------------------
// 1. Alternation invariant (FR-24) — structured
// ---------------------------------------------------------------------------

/**
 * Validate the territory→hole→territory→… alternation for an entire shape,
 * returning every violation (not just the first). Checks, per ring:
 *   - a top-level ring must be a territory (a hole is never outermost);
 *   - a hole's parent must exist and be a territory;
 *   - a non-top-level territory's parent must exist and be a hole;
 *   - the parent chain must not be cyclic.
 *
 * Pure; the boolean `isAlternationValid` from U06 is the cheap predicate, this is
 * its detailed structured counterpart (same judgement, richer return; 教訓5.26).
 */
export function validateAlternation(shape: Shape): RingValidationResult {
  const byId = indexById(shape);
  const violations: RingViolation[] = [];

  for (const ring of shape.rings) {
    const parentId = parentIdOf(ring);

    if (parentId === undefined) {
      // Top-level: must be a territory (criterion 1: outermost are territories).
      if (ring.kind === RING_KIND.Hole) {
        violations.push(violation(RING_VIOLATION.HoleAtTopLevel, ring.id));
      }
      continue;
    }

    const parent = byId.get(parentId);
    if (parent === undefined) {
      violations.push(violation(RING_VIOLATION.DanglingParent, ring.id, parentId));
      continue;
    }

    // Cycle detection along this ring's parent chain.
    if (hasCycle(byId, ring.id)) {
      violations.push(violation(RING_VIOLATION.CyclicParent, ring.id));
      continue;
    }

    switch (ring.kind) {
      case RING_KIND.Territory:
        if (parent.kind !== RING_KIND.Hole) {
          violations.push(
            violation(RING_VIOLATION.TerritoryParentNotHole, ring.id, parent.id),
          );
        }
        break;
      case RING_KIND.Hole:
        if (parent.kind !== RING_KIND.Territory) {
          violations.push(
            violation(RING_VIOLATION.HoleParentNotTerritory, ring.id, parent.id),
          );
        }
        break;
      default:
        return assertNever(ring);
    }
  }

  return result(violations);
}

/** True iff following `ringId`'s parent links revisits a ring (a cycle). */
function hasCycle(byId: ReadonlyMap<RingId, Ring>, ringId: RingId): boolean {
  const seen = new Set<RingId>();
  let current = byId.get(ringId);
  while (current !== undefined) {
    if (seen.has(current.id)) return true;
    seen.add(current.id);
    const parentId = parentIdOf(current);
    if (parentId === undefined) return false;
    current = byId.get(parentId);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 2. Geometric validation (FR-25) — containment / non-crossing / non-overlap
// ---------------------------------------------------------------------------

/**
 * Resolve a ring's vertex IDs to a quantized world-coordinate ring for geometric
 * tests. Returns undefined when any vertex ID is missing from the store (the
 * caller treats an unresolved ring as not-geometrically-checkable rather than
 * silently dropping vertices — noUncheckedIndexedAccess discipline).
 *
 * Pipeline (order is load-bearing):
 *   1. Seam unwrap (U05 `unwrapRing`): the U06 predicates operate on a single
 *      *continuous* coordinate system and explicitly delegate the ±180° seam fold
 *      to the caller (predicates.ts「seam unwrap (U05) is applied upstream」;
 *      tech policy R3 spec §技術方針 R3). A ring whose vertices straddle the
 *      east/west seam (e.g. lon +179 then −179) is stored as two representative
 *      values one world-turn apart; without unwrap the containment / crossing /
 *      non-overlap tests would treat that ~2° step as a ~358° jump and misjudge
 *      cross-seam holes and enclaves. We delegate to U05's single source of truth
 *      and do NOT re-invent any ±360° folding here (单一真实源 §4 / spec 行127).
 *   2. Quantization (U06 grid): boundary touch is judged consistently with the
 *      boolean ops and zero-length predicate (R2 / 单一真实源).
 *
 * IMPORTANT — this is a PER-RING unwrap only. `unwrapRing` anchors each ring to
 * its OWN first vertex, so two rings resolved separately are NOT guaranteed to
 * share a common world turn: a hole and its parent that both cross the seam but
 * whose vertex lists *start* on opposite seam sides land ~360° apart even though
 * they coincide geometrically. Cross-ring tests MUST therefore align the pair
 * into a shared seam frame with {@link alignRingTo} BEFORE comparing — never
 * compare two independently-resolved rings directly (that was the latent R3 bug).
 */
function resolveRing(store: VertexStore, ring: Ring): GeoRing | undefined {
  const representative: WorldCoordinate[] = [];
  for (const vid of ring.vertexIds) {
    const vertex = getVertex(store, vid);
    if (vertex === undefined) return undefined;
    representative.push(vertex.coordinate);
  }
  // Seam unwrap first (continuous longitude run), then quantize each vertex onto
  // U06's grid. Unwrap must precede quantization so the ±360° turn-counting sees
  // the original adjacency, not grid-snapped values.
  return unwrapRing(representative).map((c) => quantizeCoordinate(c));
}

/** Mean longitude of a ring (its anchor for cross-ring world-turn alignment).
 * A ring resolved by {@link resolveRing} always has ≥1 vertex when it reaches a
 * comparison site; 0 is returned for the empty case (lesson 5.18: length-decided,
 * never a falsy default) and simply yields the identity alignment. */
function ringLonAnchor(ring: GeoRing): number {
  if (ring.length === 0) return 0;
  let sum = 0;
  for (const c of ring) sum += c.lon;
  return sum / ring.length;
}

/**
 * Align `ring` into the SAME world turn as `reference` so two independently
 * unwrapped rings (see {@link resolveRing}) can be compared in one continuous
 * longitude frame. Returns `ring` shifted by the whole number of ±360° turns that
 * minimizes the longitude gap between the two rings' anchors.
 *
 * Single source of truth (技术方针 R3 / 单一真实源 §4): the ±360° replication is
 * U05's {@link worldWrapReplicas} (the canonical "hold A, shift B by world turns"
 * machinery U05 itself uses in `ringsShareVertexAcrossSeam`). We do NOT reinvent
 * any ±360° folding here — we only *select* the replica whose anchor is nearest
 * the reference's. The candidate turn span is widened enough that even a parent
 * and hole resolved a turn apart (and any incidental further turn introduced by
 * their independent per-ring unwrap) are brought together: ±2 turns bracket every
 * representative-input pair (each ring's own anchor is within one turn of any
 * representative value, so the inter-ring gap is < 2 turns).
 */
function alignRingTo(reference: GeoRing, ring: GeoRing): GeoRing {
  if (ring.length === 0 || reference.length === 0) return ring;
  const refAnchor = ringLonAnchor(reference);
  let best: GeoRing = ring;
  let bestGap = Number.POSITIVE_INFINITY;
  // ±2 turns: a hole/parent pair each unwrapped to its own first vertex can be up
  // to (just under) two world turns apart; bracketing ±2 guarantees the minimizer
  // is interior to the candidate set, not clamped at an edge.
  for (const replica of worldWrapReplicas(ring, [-2, -1, 0, 1, 2])) {
    const gap = Math.abs(ringLonAnchor(replica.ring) - refAnchor);
    if (gap < bestGap) {
      bestGap = gap;
      best = replica.ring;
    }
  }
  return best;
}

/**
 * Resolve a pair of rings AND align the second into the first's world turn, so
 * every cross-ring geometric test runs in one shared continuous frame (the R3
 * fix). Returns undefined when either ring is unresolvable (a vertex is missing),
 * mirroring {@link resolveRing}'s not-geometrically-checkable contract.
 */
function resolveAlignedPair(
  store: VertexStore,
  reference: Ring,
  other: Ring,
): readonly [GeoRing, GeoRing] | undefined {
  const refGeo = resolveRing(store, reference);
  const otherGeo = resolveRing(store, other);
  if (refGeo === undefined || otherGeo === undefined) return undefined;
  return [refGeo, alignRingTo(refGeo, otherGeo)];
}

/** True iff any edge of ring A properly crosses any edge of ring B. Both rings
 * are implicitly closed; only a Proper crossing counts (endpoint touch / collinear
 * contact is boundary contact, not an exit — FR-25 / FR-26 境界接触は重なりに含めない).
 *
 * The two rings MUST already share a world turn (align via {@link alignRingTo} at
 * the resolve site); this predicate does no ±360° folding of its own. */
function ringsProperlyCross(a: GeoRing, b: GeoRing): boolean {
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
  return false;
}

/**
 * True iff `inner` is fully contained inside `outer`: no inner vertex strictly
 * outside, and no inner edge properly crossing the outer boundary. Boundary
 * contact (a vertex on the outer edge, an edge running along it) is allowed —
 * a hole may share boundary with its parent without leaving it.
 */
function ringContains(outer: GeoRing, inner: GeoRing): boolean {
  const outerPoly: GeoPolygon = [outer];
  for (const v of inner) {
    if (pointInPolygon(v, outerPoly) === POINT_LOCATION.Outside) return false;
  }
  if (ringsProperlyCross(inner, outer)) return false;
  return true;
}

/**
 * True iff two rings are spatially separate (neither contains the other and their
 * boundaries do not properly cross). Boundary touching is NOT overlap (FR-25 /
 * FR-26 境界接触は重なりに含めない). Used for sibling / enclave non-overlap.
 *
 * Two rings overlap iff their boundaries cross, OR one lies inside the other
 * (a vertex of one strictly inside the other with no crossing). We detect both.
 */
function ringsOverlap(a: GeoRing, b: GeoRing): boolean {
  if (ringsProperlyCross(a, b)) return true;
  // No proper crossing: overlap only if one is nested inside the other. Probe a
  // strictly-interior witness vertex (a boundary-only vertex is mere contact).
  const aPoly: GeoPolygon = [a];
  const bPoly: GeoPolygon = [b];
  for (const v of b) {
    if (pointInPolygon(v, aPoly) === POINT_LOCATION.Inside) return true;
  }
  for (const v of a) {
    if (pointInPolygon(v, bPoly) === POINT_LOCATION.Inside) return true;
  }
  return false;
}

/**
 * Validate FR-25 geometry for an entire shape against a vertex store:
 *   - each hole fully contained in its parent territory and not crossing it;
 *   - sibling rings (same parent) do not overlap each other;
 *   - top-level territories (enclaves of one feature) do not overlap each other.
 *
 * Rings whose vertices cannot all be resolved are skipped for geometry (their
 * structural defects surface via {@link validateAlternation}). A high-frequency
 * single-call function: real-time validation calls this each interaction
 * (教訓5.26 same fn, same return for pre-commit rejection).
 */
export function validateGeometry(shape: Shape, store: VertexStore): RingValidationResult {
  const byId = indexById(shape);
  const violations: RingViolation[] = [];

  // (a) hole containment + non-crossing of parent.
  for (const ring of shape.rings) {
    if (ring.kind !== RING_KIND.Hole) continue;
    const parent = byId.get(ring.parentRingId);
    if (parent === undefined) continue; // structural defect, reported elsewhere
    // Resolve the pair in a SHARED world turn: the parent is the reference and the
    // hole is aligned to it, so a hole whose vertex list merely starts on the
    // opposite seam side from the parent is not judged ~360° away (R3 fix).
    const pair = resolveAlignedPair(store, parent, ring);
    if (pair === undefined) continue;
    const [parentGeo, holeGeo] = pair;
    if (ringsProperlyCross(holeGeo, parentGeo)) {
      violations.push(violation(RING_VIOLATION.HoleCrossesParent, ring.id, parent.id));
    } else if (!ringContains(parentGeo, holeGeo)) {
      violations.push(violation(RING_VIOLATION.HoleNotContained, ring.id, parent.id));
    }
  }

  // (b) sibling non-overlap: group rings by parent (including top-level group)
  //     and check each unordered pair within a group.
  const groups = groupBySharedParent(shape);
  for (const group of groups) {
    checkGroupPairsNonOverlap(group, store, violations);
  }

  return result(violations);
}

/**
 * Partition rings into sibling groups: rings sharing the same parent are one
 * group. The top-level group (parentless rings) is returned SEPARATELY so the
 * caller can attribute enclave-overlap distinctly from in-feature sibling
 * overlap. The first element of the returned array is always the top-level group
 * (possibly empty — empty is a true value, 教訓5.18).
 */
function groupBySharedParent(shape: Shape): readonly (readonly Ring[])[] {
  const topLevel: Ring[] = [];
  const byParent = new Map<RingId, Ring[]>();
  for (const ring of shape.rings) {
    const parentId = parentIdOf(ring);
    if (parentId === undefined) {
      topLevel.push(ring);
      continue;
    }
    const bucket = byParent.get(parentId);
    if (bucket === undefined) byParent.set(parentId, [ring]);
    else bucket.push(ring);
  }
  return [topLevel, ...byParent.values()];
}

/** Check every unordered pair in a sibling group for overlap, pushing structured
 * violations. Top-level pairs are reported as EnclavesOverlap, others as
 * SiblingsOverlap (FR-21 / FR-25 飛び地非重複 vs 兄弟非交差). */
function checkGroupPairsNonOverlap(
  group: readonly Ring[],
  store: VertexStore,
  out: RingViolation[],
): void {
  for (let i = 0; i < group.length; i += 1) {
    const ri = group[i];
    if (ri === undefined) continue;
    const topLevelI = isTopLevelRing(ri);
    for (let j = i + 1; j < group.length; j += 1) {
      const rj = group[j];
      if (rj === undefined) continue;
      // Align the pair into a shared world turn (ri is the reference, rj aligned
      // to it) so two seam-crossing siblings/enclaves ordered to start on opposite
      // seam sides are compared in one continuous frame, not ~360° apart (R3 fix).
      const pair = resolveAlignedPair(store, ri, rj);
      if (pair === undefined) continue;
      const [gi, gj] = pair;
      if (!ringsOverlap(gi, gj)) continue;
      const kind = topLevelI
        ? RING_VIOLATION.EnclavesOverlap
        : RING_VIOLATION.SiblingsOverlap;
      out.push(violation(kind, ri.id, rj.id));
    }
  }
}

/**
 * Validate both the structural alternation (FR-24) and the geometry (FR-25) in a
 * single call, concatenating their violations. The single high-frequency entry
 * point upper layers use for real-time and pre-commit validation alike (教訓5.26).
 */
export function validateRingHierarchy(
  shape: Shape,
  store: VertexStore,
): RingValidationResult {
  const structural = validateAlternation(shape);
  const geometric = validateGeometry(shape, store);
  return result([...structural.violations, ...geometric.violations]);
}

// ---------------------------------------------------------------------------
// 3. Deletion reorganization (FR-24) — one pure (Shape, RingId) -> Shape fn
// ---------------------------------------------------------------------------

/**
 * Delete a ring and reorganize so the territory↔hole alternation is preserved,
 * returning a NEW shape (immutable; 教訓5.17). Single operation: the return value
 * alone captures the after-state for before/after comparison (FR-24 単一操作テスト).
 *
 * Reparenting rules (mirror images — 対概念へ判断を反映 / 教訓2.10):
 *   - Deleting a HOLE: its children are territories (enclaves that sat inside the
 *     hole). Removing the hole merges the hole's empty area back into the SOLID
 *     of the parent territory, which geometrically *absorbs* those enclave
 *     islands: an enclave sat inside the hole, so once the hole is filled the
 *     enclave lies wholly within the parent territory's solid and can no longer be
 *     an independent outer ring without overlapping the parent (this is the
 *     correctness defect the old "promote enclave to top-level" rule produced —
 *     validateGeometry flagged enclaves-overlap on a shape this very unit
 *     reorganized; 教訓5.40). So each enclave is DROPPED (absorbed), and its own
 *     children — which are holes — are lifted UP to the hole's parent territory:
 *     those holes were inside the enclave ⊂ hole ⊂ parent, so they become holes
 *     punched directly in the parent (territory→hole alternation preserved AND
 *     geometrically contained). Deeper descendants ride along unchanged. This is
 *     the exact mirror of territory deletion below.
 *   - Deleting a TERRITORY: its children are holes; the holes are removed (a hole
 *     whose territory is gone has nothing to punch and cannot be top-level) and
 *     each hole's children (territories / enclaves) are lifted UP to the deleted
 *     territory's parent. The deleted territory's parent is a hole (when nested)
 *     or absent (top-level): lifting the grand-child territories to that hole
 *     keeps territory-under-hole; when the deleted territory was top-level the
 *     grand-children become top-level territories.
 *
 * Only the deleted ring is removed; descendants are RE-LINKED, never dropped
 * (except holes that would become top-level, which are structurally impossible
 * and are therefore removed while their territory children are lifted). No
 * dangling parent reference is left behind (削除は参照掃除まで含めて整合 / 教訓5.21).
 *
 * Deleting a ring not present in the shape returns the shape unchanged.
 */
export function deleteRingAndReorganize(shape: Shape, targetId: RingId): Shape {
  const byId = indexById(shape);
  const target = byId.get(targetId);
  if (target === undefined) return shape;

  switch (target.kind) {
    case RING_KIND.Hole:
      return sanitizeForest(deleteHole(shape, target));
    case RING_KIND.Territory:
      return sanitizeForest(deleteTerritory(shape, target));
    default:
      return assertNever(target);
  }
}

/**
 * Final referential-integrity pass over a reorganized forest (教訓5.21).
 *
 * The per-kind reorganizers ({@link deleteHole} / {@link deleteTerritory}) only
 * re-link rings within the DELETED ring's subtree. They cannot — and must not —
 * touch rings unrelated to the deletion. But malformed *input* may already carry
 * a parent reference that is dangling (points at a ring never present), SELF-
 * referential (a self-loop), or part of a longer cycle on a ring the deletion
 * never visited. The function's documented post-condition is that the RESULT is
 * always a referentially-integral, acyclic forest regardless of how broken the
 * input was, so we repair any such residual ring here by demoting it to a valid
 * top-level attachment (a hole cannot be top-level, so it becomes a territory).
 *
 * This pass is a NO-OP on an already-valid forest: it only rewrites a ring whose
 * parent reference is missing or whose parent chain revisits a ring. Well-formed
 * deletions are therefore unaffected.
 */
function sanitizeForest(shape: Shape): Shape {
  const byId = indexById(shape);

  const parentInvalid = (ring: Ring): boolean => {
    const parentId = parentIdOf(ring);
    if (parentId === undefined) return false; // top-level: fine
    if (!byId.has(parentId)) return true; // dangling
    return hasCycle(byId, ring.id); // self-loop or longer cycle
  };

  if (!shape.rings.some(parentInvalid)) return shape; // common case: nothing to fix

  const out: Ring[] = shape.rings.map((ring) =>
    parentInvalid(ring)
      ? // Re-root the ring: a parentless hole is impossible, so demote holes to
        // territories; territories simply become top-level.
        createTerritoryRing(ring.id, ring.vertexIds)
      : ring,
  );
  return createShape(out);
}

/**
 * Delete a hole ring. By alternation the hole's direct children are territories
 * (enclaves that sat inside the hole). Filling the hole absorbs those enclaves
 * into the parent territory's solid, so each enclave is DROPPED and its own
 * children (holes) are lifted UP to the hole's parent territory — the exact
 * mirror of {@link deleteTerritory}.
 *
 * The hole's parent is a territory (when well-formed) or absent (malformed
 * input). Lifting the grand-child holes to that territory keeps hole-under-
 * territory AND keeps them geometrically inside it (they were inside the enclave
 * ⊂ hole ⊂ parent). When the parent territory is absent we cannot produce a
 * parentless hole (a hole is never top-level), so such a grand-child is demoted
 * to a top-level territory to preserve referential integrity (教訓5.21).
 *
 * A direct (malformed) hole child of the deleted hole — which a valid alternation
 * never produces — is treated like an absorbed-then-removed layer too: it is
 * dropped and its own children lifted, so no dangling reference survives.
 */
function deleteHole(shape: Shape, hole: HoleRing): Shape {
  const parentId = hole.parentRingId; // a territory id (well-formed), or stale
  // A self-looping hole (parentId === hole.id, only reachable from corrupted /
  // hand-edited input) must NOT be treated as its own grandparent: the ring is
  // about to be dropped, so lifting a child onto it would leave a dangling
  // reference (教訓5.21). Exclude the deleted ring from the grandparent check.
  const parentExists = parentId !== hole.id && shape.rings.some((r) => r.id === parentId);
  const liftTarget = parentExists ? parentId : undefined;

  // Direct children of the deleted hole are removed (enclaves absorbed into the
  // parent's solid; a malformed hole child likewise). Their children must be
  // lifted to `liftTarget`.
  const removedChildren = new Set<RingId>();
  for (const ring of shape.rings) {
    if (parentIdOf(ring) === hole.id) {
      removedChildren.add(ring.id);
    }
  }

  const out: Ring[] = [];
  for (const ring of shape.rings) {
    if (ring.id === hole.id) continue; // drop the deleted hole
    if (parentIdOf(ring) === hole.id) continue; // drop direct children (absorbed)

    const ringParentId = parentIdOf(ring);
    // Grand-child of the deleted hole (child of an absorbed enclave): lift it to
    // the hole's parent territory.
    if (ringParentId !== undefined && removedChildren.has(ringParentId)) {
      out.push(liftChildOfAbsorbedEnclave(ring, liftTarget));
      continue;
    }

    out.push(ring);
  }
  return createShape(out);
}

/** Re-attach a grand-child of a deleted hole (a child of an absorbed enclave) to
 * `liftTarget` (the hole's parent territory id, or top-level when that territory
 * is absent). Grand-children are holes; lifting a hole to its grandparent
 * territory keeps hole-under-territory. When `liftTarget` is undefined a hole
 * cannot be parentless, so it is demoted to a territory; a (malformed) territory
 * grand-child is lifted as a territory under the same target. */
function liftChildOfAbsorbedEnclave(ring: Ring, liftTarget: RingId | undefined): Ring {
  switch (ring.kind) {
    case RING_KIND.Hole:
      return liftTarget === undefined
        ? // No parent territory to punch: a top-level hole is impossible, so the
          // hole now bounds area directly — demote to a top-level territory.
          createTerritoryRing(ring.id, ring.vertexIds)
        : createHoleRing(ring.id, ring.vertexIds, liftTarget);
    case RING_KIND.Territory:
      // A malformed territory grand-child (territory directly under an enclave):
      // lift it under the same target to preserve referential integrity.
      return createTerritoryRing(ring.id, ring.vertexIds, liftTarget);
    default:
      return assertNever(ring);
  }
}

/**
 * Delete a territory ring. Its direct children are holes (by alternation). For
 * each such hole we (a) drop the hole itself (a hole whose territory is gone has
 * no territory to punch, and a hole cannot be top-level) and (b) lift the hole's
 * own children — territories (enclaves) — UP to the deleted territory's parent.
 *
 * The deleted territory's parent is a hole (when nested) or absent (top-level):
 *   - nested territory: grand-children territories re-attach to that hole → still
 *     territory-under-hole (alternation preserved);
 *   - top-level territory: grand-children territories become top-level territories.
 *
 * A direct territory child of the deleted territory (an alternation defect that
 * could exist in malformed input) is lifted to the grandparent the same way so no
 * dangling reference remains (教訓5.21).
 */
function deleteTerritory(shape: Shape, territory: TerritoryRing): Shape {
  const grandParentId = territory.parentRingId; // a hole id, or undefined
  // A self-looping territory (grandParentId === territory.id, only reachable
  // from corrupted / hand-edited input) must NOT be treated as its own
  // grandparent: the ring is about to be dropped, so lifting a child onto it
  // would leave a dangling reference (教訓5.21). Exclude the deleted ring.
  const grandParentExists =
    grandParentId !== undefined &&
    grandParentId !== territory.id &&
    shape.rings.some((r) => r.id === grandParentId);
  const liftTarget = grandParentExists ? grandParentId : undefined;

  // Holes directly under the deleted territory are themselves removed; their
  // children must be lifted to `liftTarget`.
  const holesUnderTarget = new Set<RingId>();
  for (const ring of shape.rings) {
    if (ring.kind === RING_KIND.Hole && ring.parentRingId === territory.id) {
      holesUnderTarget.add(ring.id);
    }
  }

  const out: Ring[] = [];
  for (const ring of shape.rings) {
    if (ring.id === territory.id) continue; // drop the deleted territory
    if (ring.kind === RING_KIND.Hole && ring.parentRingId === territory.id) {
      continue; // drop holes directly under the deleted territory
    }

    const parentId = parentIdOf(ring);

    // Child of a removed hole (a grand-child enclave): lift to liftTarget.
    if (parentId !== undefined && holesUnderTarget.has(parentId)) {
      out.push(liftGrandChild(ring, liftTarget));
      continue;
    }

    // A direct (malformed) territory child of the deleted territory: lift it too.
    if (ring.kind === RING_KIND.Territory && ring.parentRingId === territory.id) {
      out.push(liftGrandChild(ring, liftTarget));
      continue;
    }

    out.push(ring);
  }
  return createShape(out);
}

/** Re-attach a grand-child of a deleted territory (lifted past a removed hole)
 * to `liftTarget` (a hole id, or top-level). Grand-children are territories
 * (enclaves); a malformed hole grand-child is demoted/kept analogously to keep
 * referential integrity. */
function liftGrandChild(ring: Ring, liftTarget: RingId | undefined): Ring {
  switch (ring.kind) {
    case RING_KIND.Territory:
      return createTerritoryRing(ring.id, ring.vertexIds, liftTarget);
    case RING_KIND.Hole:
      // Lifting under a hole would make hole-under-hole; keep it valid by
      // re-parenting to the hole target only when target is a hole is wrong, so:
      // a hole must sit under a territory. Since liftTarget is a hole (or none),
      // demote this (malformed) hole to a territory to preserve integrity.
      return createTerritoryRing(ring.id, ring.vertexIds, liftTarget);
    default:
      return assertNever(ring);
  }
}
