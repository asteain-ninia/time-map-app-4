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
import { createCommandResult, type CommandResult } from '../command/result';
import type { DomainId, FeatureId, RingId, VertexId } from '../ids';

/**
 * The selection re-resolution delta of a structural edit (受け入れ基準11 /
 * 教訓5.11). After a vertex add / delete / ring removal / feature deletion the
 * selection is NOT decided by a fixed blanket clear: U22 re-resolves it from THIS
 * delta — surviving vertex ids stay selectable, a created vertex can be promoted
 * to the selection, and removed vertices / rings / a deleted feature drop out.
 *
 * This is the layer-crossing contract U24 publishes so U22 (via
 * {@link reresolveAfterStructureChange}) re-resolves from the RESULT, never from a
 * fixed clear (開発ガイド §4 層をまたぐ契約の固定, 教訓5.33 / 5.34). It is mapped to
 * U12's {@link CommandResult} by {@link commandResultFromEditResult} so the same
 * survived / created / deleted contract the rest of the app already consumes
 * carries U24's structural edits too.
 */
export interface SelectionDelta {
  /** Vertex ids that no longer exist after the edit (deleted vertex; vertices of a removed ring / feature). */
  readonly removedVertexIds: readonly VertexId[];
  /** Vertex ids newly created by the edit (a new vertex on an edge handle). */
  readonly addedVertexIds: readonly VertexId[];
  /**
   * Ring ids removed by the edit (3点未満 → U07 reorganization). Deleting a vertex
   * can absorb MORE than one ring at once: removing a hole can re-organize away its
   * child enclaves too, so this is the full before/after ring-set difference, not a
   * single id (otherwise a multi-ring removal left stale ring ids in the selection).
   */
  readonly removedRingIds: readonly RingId[];
  /** Set when the feature itself was deleted (line<2 / leaf no-territory / point). */
  readonly deletedFeatureId?: FeatureId;
}

/**
 * The outcome of a structural edit: either a surviving feature (its new complete
 * state) or a signal that the feature itself must be deleted (line < 2 pts, leaf
 * with no territory ring). 教訓5.18: the deletion case is an explicit value.
 *
 * Both cases carry a {@link SelectionDelta} so the caller re-resolves selection
 * from the result (残る/新規/削除 ID) rather than a fixed clear (受け入れ基準11 /
 * 教訓5.11). The delta is part of the result — not an optional add-on — so the
 * selection contract can never be silently dropped.
 */
export type FeatureEditResult =
  | { readonly kind: 'feature'; readonly feature: Feature; readonly selection: SelectionDelta }
  | { readonly kind: 'delete-feature'; readonly featureId: FeatureId; readonly selection: SelectionDelta };

function survives(feature: Feature, selection: SelectionDelta): FeatureEditResult {
  return { kind: 'feature', feature, selection };
}
function deleteFeature(featureId: FeatureId, selection: SelectionDelta): FeatureEditResult {
  return { kind: 'delete-feature', featureId, selection };
}

// --- the selection-delta → CommandResult mapping (受け入れ基準11 / 教訓5.11) ---

/**
 * Map a {@link FeatureEditResult} to U12's {@link CommandResult} so the selection
 * is re-resolved from the structural change via U22's
 * `reresolveAfterStructureChange` — NOT a blanket clear (受け入れ基準11 / 教訓5.11).
 *
 *   - removed vertices, a removed ring, and a deleted feature → `deleted`
 *     (they drop out of the selection).
 *   - added vertices → `created` (they may be promoted to the new selection).
 *   - the surviving feature id → `survived` (it stays the active target).
 *
 * The sets are disjoint by construction (a removed id is never also added /
 * surviving). Pure (NFR 5.8).
 */
export function commandResultFromEditResult(result: FeatureEditResult): CommandResult {
  const { selection } = result;
  const deleted: DomainId[] = [...selection.removedVertexIds, ...selection.removedRingIds];
  if (selection.deletedFeatureId !== undefined) deleted.push(selection.deletedFeatureId);

  const created: DomainId[] = [...selection.addedVertexIds];

  const survived: DomainId[] = [];
  if (result.kind === 'feature') survived.push(result.feature.id);

  return createCommandResult({ survived, created, deleted });
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
  return survives(withLineVertexIds(feature, next), {
    removedVertexIds: [],
    addedVertexIds: [newVertexId],
    removedRingIds: [],
  });
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
  return survives(withLeafShape(feature, { rings }), {
    removedVertexIds: [],
    addedVertexIds: [newVertexId],
    removedRingIds: [],
  });
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

/**
 * Delete a vertex from a point feature → the point feature itself is deleted.
 * When `vertexId` is supplied it MUST match the point's own vertex; a mismatch is a
 * stale target (the selection referenced a vertex no longer on this feature) and
 * returns `undefined` so the caller produces no ghost deletion (5.11 / 教訓5.24).
 */
export function deletePointVertex(
  feature: PointFeature,
  vertexId?: VertexId,
): FeatureEditResult | undefined {
  if (vertexId !== undefined && vertexId !== feature.vertexId) return undefined;
  // 点情報の頂点削除は点情報自体の削除 (a point with no vertex cannot exist). The
  // point's single vertex and the feature both drop out of the selection (5.11).
  return deleteFeature(feature.id, {
    removedVertexIds: [feature.vertexId],
    addedVertexIds: [],
    removedRingIds: [],
    deletedFeatureId: feature.id,
  });
}

/**
 * Delete a vertex from a line. If the remaining vertex count is < 2 the LINE
 * itself is deleted (spec §スコープ 線情報の2点未満削除). A `vertexId` that the line
 * does not reference is a stale target → `undefined` (no ghost edit): filtering an
 * absent id would otherwise return an unchanged 'surviving' line and a no-op
 * history entry (Codex true-positive).
 */
export function deleteLineVertex(
  feature: LineFeature,
  vertexId: VertexId,
): FeatureEditResult | undefined {
  if (!feature.vertexIds.includes(vertexId)) return undefined;
  const remaining = feature.vertexIds.filter((id) => id !== vertexId);
  if (remaining.length < 2) {
    // The line is deleted: ALL its vertices drop out, not just the one deleted
    // (教訓5.18: the whole set is removed — do not undercount the surviving ones).
    return deleteFeature(feature.id, {
      removedVertexIds: feature.vertexIds.slice(),
      addedVertexIds: [],
      removedRingIds: [],
      deletedFeatureId: feature.id,
    });
  }
  return survives(withLineVertexIds(feature, remaining), {
    removedVertexIds: [vertexId],
    addedVertexIds: [],
    removedRingIds: [],
  });
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
): FeatureEditResult | undefined {
  // Stale-target guard: the named ring must exist on this leaf AND must reference
  // the vertex. Otherwise filtering an absent id returns an unchanged shape and a
  // no-op 'surviving' result → a ghost history entry (Codex true-positive).
  const targetRing = feature.shape.rings.find((r) => r.id === ringId);
  if (targetRing === undefined || !targetRing.vertexIds.includes(vertexId)) return undefined;

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

  // Compute the precise selection delta by diffing the BEFORE / AFTER vertex and
  // ring sets, so the caller re-resolves selection from the result rather than a
  // blanket clear (受け入れ基準11 / 教訓5.11). A vertex absent from the after-shape —
  // whether the one deleted or any carried away with a removed ring — drops out.
  const afterVertexIds = collectShapeVertexIds(shape);
  const removedVertexIds: VertexId[] = [];
  for (const vid of collectShapeVertexIds(feature.shape)) {
    if (!afterVertexIds.has(vid)) removedVertexIds.push(vid);
  }
  const removedRingIds = ringsDroppedFrom(feature.shape, shape);

  // If no territory ring remains, the leaf cannot define any area → delete it. The
  // delta still reports the removed vertices / rings AND the deleted feature so the
  // selection re-resolution is driven by the full result (教訓5.18: not just the
  // feature id).
  const hasTerritory = shape.rings.some((r) => r.kind === RING_KIND.Territory);
  if (!hasTerritory) {
    return deleteFeature(feature.id, {
      removedVertexIds,
      addedVertexIds: [],
      removedRingIds,
      deletedFeatureId: feature.id,
    });
  }
  return survives(withLeafShape(feature, shape), {
    removedVertexIds,
    addedVertexIds: [],
    removedRingIds,
  });
}

/** All vertex ids referenced by any ring of a shape (set for O(1) membership). */
function collectShapeVertexIds(shape: Shape): Set<VertexId> {
  const out = new Set<VertexId>();
  for (const ring of shape.rings) for (const vid of ring.vertexIds) out.add(vid);
  return out;
}

/**
 * Every ring id present in `before` but absent from `after`. Deleting a vertex can
 * absorb MORE than one ring at once (the 3点未満 case + U07 reorganization can remove
 * a hole AND its child enclaves), so we report the FULL before/after ring-set
 * difference. Reporting only a single id (the old behaviour) left the other removed
 * ring ids stale in the selection while their vertices correctly dropped. Returns an
 * empty list when no ring was removed.
 */
function ringsDroppedFrom(before: Shape, after: Shape): RingId[] {
  const afterIds = new Set<RingId>(after.rings.map((r) => r.id));
  return before.rings.filter((r) => !afterIds.has(r.id)).map((r) => r.id);
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
      return deletePointVertex(feature, target.vertexId);
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
