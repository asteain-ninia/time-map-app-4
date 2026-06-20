// U24 — pure feature-edit operations: the RESULTING complete-state computation
// for move / vertex-move / vertex-add / vertex-delete on point / line / leaf
// (FR-88 / FR-89). These produce the confirmed-after state a release assembles
// into an edit proposal; they do NOT drive U13 (that is ./edit-flow) and do NOT
// touch shared app state until commit (教訓5.22).
//
// LAYER: pure `domain` logic on the U06 feature / ring / vertex model. Ring
// deletion reorganization (3点未満) is DELEGATED to U07's deleteRingAndReorganize
// (spec §依存 U07); the geometric containment / alternation checks are U07's; the
// shared-vertex linked move is U11's (the session passes a shared move spec). This
// module only performs the structural feature/ring/vertex list edits and decides
// the删除 thresholds (2 for line, 3 for ring), then signals feature-level deletion.
//
// Thresholds (spec §スコープ):
//   - line vertex delete → if remaining < 2, delete the LINE feature itself.
//   - leaf ring vertex delete → if a ring drops below 3, delete that ring via U07
//     reorganization; if the leaf then has no territory ring, delete the LEAF.

import { deleteRingAndReorganize } from '../ring-hierarchy';
import {
  FEATURE_KIND,
  withLeafShape,
  withLineVertexIds,
  withPointVertexId,
  type Feature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
import { RING_KIND, type Ring, type Shape } from '../ring';
import type { FeatureId, RingId, VertexId } from '../ids';

/**
 * The outcome of a structural edit: either a surviving feature (its new complete
 * state) or a signal that the feature itself must be deleted (line < 2 pts, leaf
 * with no territory ring). 教訓5.18: the deletion case is an explicit value.
 */
export type FeatureEditResult =
  | { readonly kind: 'feature'; readonly feature: Feature }
  | { readonly kind: 'delete-feature'; readonly featureId: FeatureId };

function survives(feature: Feature): FeatureEditResult {
  return { kind: 'feature', feature };
}
function deleteFeature(featureId: FeatureId): FeatureEditResult {
  return { kind: 'delete-feature', featureId };
}

// --- vertex add on an edge (FR-87 edge handle) ------------------------------

/** Insert `newVertexId` between positions of `startVertexId`→`endVertexId`. */
function insertBetween(
  ids: readonly VertexId[],
  startVertexId: VertexId,
  endVertexId: VertexId,
  newVertexId: VertexId,
  closed: boolean,
): readonly VertexId[] | undefined {
  const n = ids.length;
  for (let i = 0; i < n; i += 1) {
    const a = ids[i];
    const next = closed ? ids[(i + 1) % n] : ids[i + 1];
    if (a === startVertexId && next === endVertexId) {
      const out = ids.slice();
      out.splice(i + 1, 0, newVertexId);
      return out;
    }
  }
  return undefined; // edge not found (stale input)
}

export function addVertexToLine(
  feature: LineFeature,
  startVertexId: VertexId,
  endVertexId: VertexId,
  newVertexId: VertexId,
): FeatureEditResult | undefined {
  const next = insertBetween(feature.vertexIds, startVertexId, endVertexId, newVertexId, false);
  if (next === undefined) return undefined;
  return survives(withLineVertexIds(feature, next));
}

export function addVertexToLeafRing(
  feature: LeafFeature,
  ringId: RingId,
  startVertexId: VertexId,
  endVertexId: VertexId,
  newVertexId: VertexId,
): FeatureEditResult | undefined {
  const rings: Ring[] = [];
  let found = false;
  for (const ring of feature.shape.rings) {
    if (ring.id !== ringId) {
      rings.push(ring);
      continue;
    }
    const next = insertBetween(ring.vertexIds, startVertexId, endVertexId, newVertexId, true);
    if (next === undefined) return undefined;
    found = true;
    rings.push(rewriteRingVertexIds(ring, next));
  }
  if (!found) return undefined;
  return survives(withLeafShape(feature, { rings }));
}

function rewriteRingVertexIds(ring: Ring, vertexIds: readonly VertexId[]): Ring {
  switch (ring.kind) {
    case RING_KIND.Territory:
      return ring.parentRingId === undefined
        ? { kind: RING_KIND.Territory, id: ring.id, vertexIds }
        : { kind: RING_KIND.Territory, id: ring.id, vertexIds, parentRingId: ring.parentRingId };
    case RING_KIND.Hole:
      return { kind: RING_KIND.Hole, id: ring.id, vertexIds, parentRingId: ring.parentRingId };
    default:
      return ring;
  }
}

// --- vertex delete (FR-88 thresholds) ---------------------------------------

/** Delete a vertex from a point feature → the point feature itself is deleted. */
export function deletePointVertex(feature: PointFeature): FeatureEditResult {
  // 点情報の頂点削除は点情報自体の削除 (a point with no vertex cannot exist).
  return deleteFeature(feature.id);
}

/**
 * Delete a vertex from a line. If the remaining vertex count is < 2 the LINE
 * itself is deleted (spec §スコープ 線情報の2点未満削除).
 */
export function deleteLineVertex(feature: LineFeature, vertexId: VertexId): FeatureEditResult {
  const remaining = feature.vertexIds.filter((id) => id !== vertexId);
  if (remaining.length < 2) return deleteFeature(feature.id);
  return survives(withLineVertexIds(feature, remaining));
}

/**
 * Delete a vertex from a leaf ring. If the affected ring drops below 3 vertices,
 * that ring is removed via U07's reorganization (交互構造再編を U07 へ委譲, spec
 * §依存 U07). If the leaf then has no TERRITORY ring left, the LEAF feature itself
 * is deleted (領土リングが0で面情報削除).
 */
export function deleteLeafVertex(
  feature: LeafFeature,
  ringId: RingId,
  vertexId: VertexId,
): FeatureEditResult {
  const rings: Ring[] = [];
  let droppedBelow3 = false;
  for (const ring of feature.shape.rings) {
    if (ring.id !== ringId) {
      rings.push(ring);
      continue;
    }
    const remaining = ring.vertexIds.filter((id) => id !== vertexId);
    if (remaining.length < 3) {
      droppedBelow3 = true;
      rings.push(ring); // keep for now; U07 reorganization removes it below.
    } else {
      rings.push(rewriteRingVertexIds(ring, remaining));
    }
  }

  let shape: Shape = { rings };
  if (droppedBelow3) {
    // Delegate ring removal + alternation re-organization to U07.
    shape = deleteRingAndReorganize(shape, ringId);
  }

  // If no territory ring remains, the leaf cannot define any area → delete it.
  const hasTerritory = shape.rings.some((r) => r.kind === RING_KIND.Territory);
  if (!hasTerritory) return deleteFeature(feature.id);
  return survives(withLeafShape(feature, shape));
}

// --- a uniform dispatch the session uses for "delete the selected vertex" ----

export interface VertexDeleteTarget {
  readonly feature: Feature;
  readonly vertexId: VertexId;
  /** Required for a leaf vertex (which ring owns it); ignored for point / line. */
  readonly ringId?: RingId;
}

/**
 * Delete one vertex from whichever feature variant owns it, applying the variant's
 * threshold rule. Returns undefined for an aggregate (no own shape — FR-35).
 */
export function deleteVertex(target: VertexDeleteTarget): FeatureEditResult | undefined {
  const { feature } = target;
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return deletePointVertex(feature);
    case FEATURE_KIND.Line:
      return deleteLineVertex(feature, target.vertexId);
    case FEATURE_KIND.Leaf:
      if (target.ringId === undefined) return undefined;
      return deleteLeafVertex(feature, target.ringId, target.vertexId);
    case FEATURE_KIND.Aggregate:
      return undefined;
    default:
      return undefined;
  }
}

// --- helper re-export for point vertex re-pointing (rare; used by tests) ------

export { withPointVertexId };
