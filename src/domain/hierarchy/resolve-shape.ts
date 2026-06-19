// U08 derived-shape resolution (FR-35, domain layer, pure).
//
// The SINGLE resolution function that turns a feature into the GeoMultiPolygon a
// downstream consumer (render / hit-test / selection / label / this unit's
// 形状=和 check) should treat as its area (教訓5.29: 派生形状は単一の解決判定で
// 全経路を動かす). Two kinds of area:
//   - a LEAF owns an explicit `shape` (rings of vertex ids); we resolve those
//     ids through the vertex store into coordinate rings, grouping each top-level
//     territory ring with its hole rings into one GeoPolygon piece.
//   - an AGGREGATE has NO stored shape (FR-35); its area is the boolean UNION of
//     its direct sub-regions' resolved areas, computed via U06 (we never
//     re-implement boolean ops here — spec §依存 U06).
//
// All recursion goes through the cycle-safe forest helpers (教訓5.28). Union is
// delegated to U06's wrapper, which runs the R2 defense pipeline; a rejection is
// surfaced as a typed failure rather than a thrown exception (教訓5.26).

import type { Feature, LeafFeature } from '../feature';
import { FEATURE_KIND } from '../feature';
import { union, BOOLEAN_OP_STATUS } from '../geometry/boolean-ops';
import type { InvariantViolation as GeoInvariantViolation } from '../geometry/invariants';
import { EMPTY_MULTI_POLYGON, type GeoMultiPolygon, type GeoRing } from '../geometry/types';
import type { FeatureId } from '../ids';
import { RING_KIND, type Ring, type Shape } from '../ring';
import { getVertex, type VertexStore } from '../vertex';
import { directChildIds, type Forest } from './forest';

/**
 * Outcome of resolving a feature's derived shape. `ok` carries the multi-polygon
 * (possibly empty). `failed` carries a reason so callers can react by type
 * (教訓5.26) instead of catching an exception. Failures are the union defense
 * layer rejecting a degenerate intermediate, or an unresolvable vertex id.
 */
export type ShapeResolution =
  | { readonly status: 'ok'; readonly area: GeoMultiPolygon }
  | { readonly status: 'failed'; readonly reason: ShapeResolutionFailure };

export const SHAPE_RESOLUTION_FAILURE = {
  /** A ring referenced a vertex id absent from the store. */
  MissingVertex: 'missing-vertex',
  /** A child's sub-region referenced a feature id absent from the forest. */
  MissingChild: 'missing-child',
  /** U06's union rejected an intermediate result (R2 defense). */
  UnionRejected: 'union-rejected',
} as const;

export type ShapeResolutionFailureKind =
  (typeof SHAPE_RESOLUTION_FAILURE)[keyof typeof SHAPE_RESOLUTION_FAILURE];

export interface ShapeResolutionFailure {
  readonly kind: ShapeResolutionFailureKind;
  /** The feature whose resolution failed. */
  readonly featureId: FeatureId;
  /** Boolean-op invariant violations, when kind === UnionRejected. */
  readonly violations?: readonly GeoInvariantViolation[];
}

function ok(area: GeoMultiPolygon): ShapeResolution {
  return { status: 'ok', area };
}

function failed(reason: ShapeResolutionFailure): ShapeResolution {
  return { status: 'failed', reason };
}

// --- leaf shape (rings of vertex ids) -> GeoMultiPolygon --------------------

/**
 * Resolve one ring's vertex ids into a coordinate ring. Returns undefined if any
 * referenced vertex is missing from the store (the caller turns this into a
 * MissingVertex failure rather than silently dropping vertices).
 */
function resolveRingCoords(ring: Ring, store: VertexStore): GeoRing | undefined {
  const coords: GeoRing[number][] = [];
  for (const vid of ring.vertexIds) {
    const vertex = getVertex(store, vid);
    if (vertex === undefined) return undefined;
    coords.push(vertex.coordinate);
  }
  return coords;
}

/**
 * Resolve a leaf's `Shape` into a GeoMultiPolygon: each top-level TERRITORY ring
 * becomes a polygon piece whose outer ring is that territory and whose holes are
 * its direct HOLE children. Enclaves (a territory nested inside a hole) become
 * their OWN polygon piece — they are positive area, so they are separate outer
 * rings, never merged into the parent's outer (教訓5.1: all pieces kept).
 *
 * This intentionally does not attempt deep enclave-of-enclave nesting beyond the
 * flat parentRingId graph U03 defines; each territory ring contributes one piece
 * with its immediate hole children, which is sufficient for the area set the
 * 形状=和 check unions over.
 */
export function resolveLeafShape(shape: Shape, store: VertexStore): GeoMultiPolygon | undefined {
  const holesByParent = new Map<string, Ring[]>();
  const territories: Ring[] = [];
  for (const ring of shape.rings) {
    if (ring.kind === RING_KIND.Territory) {
      territories.push(ring);
    } else {
      const key = ring.parentRingId;
      const bucket = holesByParent.get(key);
      if (bucket === undefined) holesByParent.set(key, [ring]);
      else bucket.push(ring);
    }
  }

  const pieces: GeoRing[][] = [];
  for (const territory of territories) {
    const outer = resolveRingCoords(territory, store);
    if (outer === undefined) return undefined;
    const piece: GeoRing[] = [outer];
    const holes = holesByParent.get(territory.id) ?? [];
    for (const hole of holes) {
      const holeCoords = resolveRingCoords(hole, store);
      if (holeCoords === undefined) return undefined;
      piece.push(holeCoords);
    }
    pieces.push(piece);
  }
  return pieces;
}

// --- the single resolution entry point (教訓5.29) ---------------------------

/**
 * Resolve the derived area of `featureId`. Leaf → its own resolved shape;
 * aggregate (anything with children, by result state) → the U06 union of its
 * direct children's resolved areas. Cycle-safe and finite via a `visited` set
 * (教訓5.28): a child that loops back is skipped, never re-entered.
 */
export function resolveFeatureArea(
  forest: Forest,
  store: VertexStore,
  featureId: FeatureId,
): ShapeResolution {
  return resolveAreaInner(forest, store, featureId, new Set<FeatureId>());
}

function resolveAreaInner(
  forest: Forest,
  store: VertexStore,
  featureId: FeatureId,
  visited: Set<FeatureId>,
): ShapeResolution {
  if (visited.has(featureId)) {
    // Re-entry on a cycle: contribute no area rather than recurse forever.
    return ok(EMPTY_MULTI_POLYGON);
  }
  visited.add(featureId);

  const feature = forest.byId.get(featureId);
  if (feature === undefined) {
    return failed({ kind: SHAPE_RESOLUTION_FAILURE.MissingChild, featureId });
  }

  const childIds = directChildIds(forest, featureId);
  // RESULT-STATE branch (教訓5.6): children present => aggregate area = union.
  if (childIds.length > 0) {
    return resolveAggregateArea(forest, store, featureId, childIds, visited);
  }
  return resolveOwnLeafArea(feature, store);
}

/** Resolve a childless feature's own area (only a leaf carries an explicit shape). */
function resolveOwnLeafArea(feature: Feature, store: VertexStore): ShapeResolution {
  if (feature.kind === FEATURE_KIND.Leaf) {
    const area = resolveLeafShape((feature as LeafFeature).shape, store);
    if (area === undefined) {
      return failed({ kind: SHAPE_RESOLUTION_FAILURE.MissingVertex, featureId: feature.id });
    }
    return ok(area);
  }
  // Point / line / a childless aggregate contribute no area to the 形状=和 set.
  return ok(EMPTY_MULTI_POLYGON);
}

/** Union the direct children's resolved areas via U06 (片落とし禁止, 教訓5.1). */
function resolveAggregateArea(
  forest: Forest,
  store: VertexStore,
  featureId: FeatureId,
  childIds: readonly FeatureId[],
  visited: Set<FeatureId>,
): ShapeResolution {
  let acc: GeoMultiPolygon = EMPTY_MULTI_POLYGON;
  for (const childId of childIds) {
    const childRes = resolveAreaInner(forest, store, childId, visited);
    if (childRes.status === 'failed') return childRes;
    const merged = union(acc, childRes.area);
    if (merged.status === BOOLEAN_OP_STATUS.Rejected) {
      return failed({
        kind: SHAPE_RESOLUTION_FAILURE.UnionRejected,
        featureId,
        violations: merged.violations,
      });
    }
    acc = merged.result;
  }
  return ok(acc);
}
