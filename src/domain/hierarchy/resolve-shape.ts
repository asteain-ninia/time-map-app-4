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
import { alignMultiPolygon, referenceLonForMultiPolygon } from '../geo/index';
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
  // Every territory ring's id — the only ids a hole may legitimately hang under.
  // A hole is bucketed by parentRingId below and re-attached to its territory by
  // territory.id; if its parentRingId names NO territory ring (a dangling parent,
  // or a parent that is itself a hole — both ring-hierarchy defects U07 reports as
  // DanglingParent / HoleParentNotTerritory) the bucket is never consumed and the
  // hole would be SILENTLY DROPPED, emitting the leaf as a wrongly-solid area. That
  // phantom solid then drives false-positive overlap detection (U10 terminal /
  // anchor-spatial exclusion: a feature sitting in what should be a hole is reported
  // as overlapping). We refuse to resolve such a shape — undefined signals an
  // unresolvable leaf (same contract as a missing vertex), so callers (U10
  // extractTerminalShapes, hit-test, render) skip it rather than treat a fake solid
  // as real area; the actual ring-hierarchy defect is surfaced separately by U07.
  const territoryIds = new Set<string>();
  for (const ring of shape.rings) {
    if (ring.kind === RING_KIND.Territory) territoryIds.add(ring.id);
  }
  for (const ring of shape.rings) {
    if (ring.kind === RING_KIND.Territory) {
      territories.push(ring);
    } else {
      const key = ring.parentRingId;
      // A hole whose parent is not an existing territory ring would be dropped:
      // treat the whole leaf as unresolvable rather than emit a phantom solid.
      if (!territoryIds.has(key)) return undefined;
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
 *
 * A feature that BOTH owns an explicit shape (a declared leaf) AND has children —
 * the「末端→集約」transition state the add / affiliation flow can leave behind when
 * a child is attached to an existing leaf (FR-35 末端→集約 is owned by another unit
 * and need not have run) — is NOT treated as a pure aggregate that throws away its
 * own footprint. Its derived area is the union of its OWN leaf shape with its
 * children's areas, so a parent that gained a child never silently loses its own
 * territory on the map / in hit-test (one resolution drives both — 教訓5.29; pieces
 * intact — 教訓5.1). A pure aggregate (kind === Aggregate, no shape field — FR-35)
 * has no own area, so its derived area stays exactly the union of children.
 */
export function resolveFeatureArea(
  forest: Forest,
  store: VertexStore,
  featureId: FeatureId,
): ShapeResolution {
  // EXPLICIT-STACK post-order traversal (children first, then union at the
  // parent), so resolution depth is bounded by the heap, NOT the call stack: a
  // deep but valid (non-cyclic) chain — the spec's 5,000-object scale can nest
  // deeply — can no longer overflow the call stack (was mutually-recursive
  // resolveAreaInner ⇄ resolveAggregateArea). Cycle handling is preserved exactly
  // (教訓5.28): an id re-entered while already on the DFS contributes EMPTY rather
  // than recursing, via the shared `visited` set added in pre-order.
  const visited = new Set<FeatureId>();

  interface Frame {
    readonly featureId: FeatureId;
    readonly childIds: readonly FeatureId[];
    childIndex: number;
    acc: GeoMultiPolygon;
  }

  const feature0 = forest.byId.get(featureId);
  if (feature0 === undefined) {
    return failed({ kind: SHAPE_RESOLUTION_FAILURE.MissingChild, featureId });
  }
  visited.add(featureId);
  const root0Children = directChildIds(forest, featureId);
  if (root0Children.length === 0) {
    return resolveOwnLeafArea(feature0, store);
  }

  // A declared leaf that has children still owns its footprint: seed the union
  // with its own area so the parent's territory is not dropped (FR-35 末端→集約
  // transition state). A pure aggregate seeds EMPTY (resolveOwnLeafArea returns
  // EMPTY for it), so the union of children is unchanged.
  const root0Own = resolveOwnLeafArea(feature0, store);
  if (root0Own.status === 'failed') return root0Own;

  const stack: Frame[] = [
    { featureId, childIds: root0Children, childIndex: 0, acc: root0Own.area },
  ];
  // The area a just-completed child frame contributes to its parent's union.
  let completedArea: GeoMultiPolygon | undefined;

  while (stack.length > 0) {
    const frame = stack[stack.length - 1]!;

    // Fold a child's completed area into this frame's running union (片落とし禁止).
    if (completedArea !== undefined) {
      // R3 seam alignment (audit root cause A): each leaf area is resolved from RAW
      // stored representatives, so a child whose territory straddles the seam (or
      // whose vertex list merely starts on the opposite seam side from the
      // accumulator) sits ~360° away from the running union. Unioned as-is, two
      // seam-adjacent children (e.g. +179 and −179, geometrically ~2° apart) are
      // ~358° apart and the union scatters them across the whole map instead of
      // joining them. Anchor BOTH operands onto ONE common branch (the accumulator's
      // outer-ring reference, falling back to the child's when the accumulator is
      // empty) through the single alignment source of truth before the op. For
      // single-branch (non-seam) inputs the alignment is the identity.
      const ref =
        frame.acc.length > 0
          ? referenceLonForMultiPolygon(frame.acc)
          : referenceLonForMultiPolygon(completedArea);
      const merged = union(alignMultiPolygon(frame.acc, ref), alignMultiPolygon(completedArea, ref));
      completedArea = undefined;
      if (merged.status === BOOLEAN_OP_STATUS.Rejected) {
        return failed({
          kind: SHAPE_RESOLUTION_FAILURE.UnionRejected,
          featureId: frame.featureId,
          violations: merged.violations,
        });
      }
      frame.acc = merged.result;
    }

    if (frame.childIndex >= frame.childIds.length) {
      // All children unioned: this frame's area is done; hand it to the parent.
      stack.pop();
      completedArea = frame.acc;
      continue;
    }

    const childId = frame.childIds[frame.childIndex]!;
    frame.childIndex += 1;

    if (visited.has(childId)) {
      // Re-entry on a cycle: contribute no area rather than recurse forever.
      completedArea = EMPTY_MULTI_POLYGON;
      continue;
    }
    const childFeature = forest.byId.get(childId);
    if (childFeature === undefined) {
      return failed({ kind: SHAPE_RESOLUTION_FAILURE.MissingChild, featureId: childId });
    }
    visited.add(childId);

    const grandChildren = directChildIds(forest, childId);
    if (grandChildren.length > 0) {
      // Aggregate child: push a frame; its area unions its own children. A
      // declared leaf that has children seeds its own footprint into the union
      // too (same 末端→集約 transition rule as the root above); a pure aggregate
      // seeds EMPTY.
      const childOwn = resolveOwnLeafArea(childFeature, store);
      if (childOwn.status === 'failed') return childOwn;
      stack.push({
        featureId: childId,
        childIds: grandChildren,
        childIndex: 0,
        acc: childOwn.area,
      });
      continue;
    }
    // Leaf child: resolve its own area immediately (no further descent).
    const leafRes = resolveOwnLeafArea(childFeature, store);
    if (leafRes.status === 'failed') return leafRes;
    completedArea = leafRes.area;
  }

  // The root frame's accumulated area is the final result.
  return ok(completedArea ?? EMPTY_MULTI_POLYGON);
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
