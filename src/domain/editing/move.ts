// U24 — move helpers: whole-feature平行移動 and single/selection vertex move
// (FR-88 / FR-30 / FR-80). Pure computation of the new vertex bodies; the shared-
// vertex linkage (every shape citing a moved vertex follows) is U11's job — this
// module yields the move spec / new bodies, and the session forwards a linked move
// to U11 so共有頂点 connect (spec §依存 U11). 教訓5.30: we do not re-derive sharing.
//
// LAYER: pure `domain` logic on the U06 feature / vertex model.

import { withVertexCoordinate, type Vertex, type VertexStore, getVertex } from '../vertex';
import {
  FEATURE_KIND,
  type Feature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
import type { VertexId } from '../ids';
import type { WorldCoordinate } from '../coordinate';
import type { VertexMoveDelta } from '../selection/contracts';

function shift(coord: WorldCoordinate, delta: VertexMoveDelta): WorldCoordinate {
  return { lon: coord.lon + delta.dLon, lat: coord.lat + delta.dLat };
}

/** The distinct vertex ids a feature owns (point / line / every ring of a leaf). */
export function featureVertexIds(feature: Feature): readonly VertexId[] {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return [(feature as PointFeature).vertexId];
    case FEATURE_KIND.Line:
      return dedupe((feature as LineFeature).vertexIds);
    case FEATURE_KIND.Leaf: {
      const ids: VertexId[] = [];
      for (const ring of (feature as LeafFeature).shape.rings) ids.push(...ring.vertexIds);
      return dedupe(ids);
    }
    case FEATURE_KIND.Aggregate:
      return []; // no own shape (FR-35).
    default:
      return [];
  }
}

function dedupe(ids: readonly VertexId[]): VertexId[] {
  const seen = new Set<VertexId>();
  const out: VertexId[] = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Compute the new vertex bodies for moving EVERY vertex of `feature` by one
 * vector (FR-88 全頂点同一ベクトル平行移動). Shared vertices appear once (deduped),
 * so a shared vertex is moved once and all citing shapes follow via U11 (FR-30).
 * Returns the moved bodies; unresolved ids are skipped (noUncheckedIndexedAccess
 * discipline — the caller already validated the feature exists at this time).
 */
export function moveFeatureVertices(
  feature: Feature,
  store: VertexStore,
  delta: VertexMoveDelta,
): readonly Vertex[] {
  const out: Vertex[] = [];
  for (const id of featureVertexIds(feature)) {
    const v = getVertex(store, id);
    if (v === undefined) continue;
    out.push(withVertexCoordinate(v, shift(v.coordinate, delta)));
  }
  return out;
}

/**
 * Compute the new bodies for moving a SET of selected vertices by one vector
 * (FR-80 複数頂点同一ベクトル移動 — a single edit operation). The session receives
 * the set from U22 and treats the move as one operation.
 */
export function moveVertexSet(
  vertexIds: Iterable<VertexId>,
  store: VertexStore,
  delta: VertexMoveDelta,
): readonly Vertex[] {
  const out: Vertex[] = [];
  for (const id of vertexIds) {
    const v = getVertex(store, id);
    if (v === undefined) continue;
    out.push(withVertexCoordinate(v, shift(v.coordinate, delta)));
  }
  return out;
}

/** Move a single vertex to an absolute target coordinate (vertex-move tool). */
export function moveVertexTo(
  vertexId: VertexId,
  store: VertexStore,
  target: WorldCoordinate,
): Vertex | undefined {
  const v = getVertex(store, vertexId);
  if (v === undefined) return undefined;
  return withVertexCoordinate(v, target);
}
