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
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { shortestLonDeltaDeg } from '../geo/longitude';
import { LONGITUDE_PERIOD } from '../geo/seam';
import type { VertexMoveDelta } from '../selection/contracts';

// Route through `createCoordinate` (not a raw literal) so the move shares the
// single construction seam: it gets the -0 normalization AND the finite-guard,
// so a delta that drives a vertex to NaN / ±Infinity (e.g. an Infinity dLon from
// an upstream divide-by-zero) fails loudly here instead of silently producing a
// coordinate that later corrupts the save→load round-trip.
function shift(coord: WorldCoordinate, delta: VertexMoveDelta): WorldCoordinate {
  return createCoordinate(coord.lon + delta.dLon, coord.lat + delta.dLat);
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

/**
 * FR-80 複数頂点同時移動 — the vertex bodies ONE live vertex-move gesture produces:
 * the PRIMARY dragged vertex placed at `target` (its slid / snapped final position),
 * plus every companion shifted by the SAME vector as one rigid body.
 *
 * THE VECTOR IS THE PRIMARY'S OWN DISPLACEMENT (target − primary's committed position),
 * NOT the pointer displacement. A press lands up to the handle radius away from the
 * vertex it grabs, and the single-vertex rule has always been "the vertex jumps to the
 * cursor" (moveVertexTo above); reusing the pointer delta for the companions would
 * therefore shear the selection by that grab offset on the very first frame. Deriving
 * it from the primary keeps 「選択セット全体を同一ベクトル」 literally true — and it makes
 * a slide (FR-28/89) or a snap (FR-31) that displaces the primary carry the whole set,
 * so the shape never deforms mid-drag.
 *
 * KNOWN CONSEQUENCE (FR-80 fix-forward review, 要件が規定しない — open decision): because
 * the primary jumps TO the cursor, the first MOVE frame of a gesture displaces the whole
 * set by the GRAB OFFSET (up to the handle hit radius, 8px) even though the pointer moved
 * only past the 4px drag threshold. For a single vertex this has always been the rule and
 * reads as 「掴んだ点がカーソルに吸い付く」; with a selection the same jump carries N−1
 * vertices the user is not pointing at. The alternative (translate the whole set — primary
 * included — by the POINTER displacement) removes the lurch but breaks the long-standing
 * single-vertex rule and detaches the primary from the cursor that slide / snap are
 * measured against. Left as-is deliberately so 1 頂点 and N 頂点 stay ONE rule; revisit
 * only as a UX decision, not a silent implementation change.
 *
 * LONGITUDE is measured as the SHORTEST wrapped delta (R3 seam): a primary at 179.9°
 * dragged to −179.9° has moved 0.2° east, not 359.8° west, and the companions must not
 * be flung around the globe.
 *
 * ONE ±360° FRAME FOR THE WHOLE SET: because the companions take that shortest delta,
 * the PRIMARY must be placed on the same branch — otherwise a gesture whose RAW Δlon
 * exceeds 180° (this system's longitude is a CONTINUOUS scalar, and the hit-test
 * deliberately lets the user grab a ±360° wrap REPLICA, so a raw delta of ~360° is a
 * normal input, not a pathology) leaves the primary exactly 360°k away from the
 * companions it is supposed to be rigid with. The stored geometry of ONE feature would
 * then straddle two frames: its bbox degenerates to ~360° wide, the R-tree broad phase
 * stops narrowing, and the wrap-replica enumeration inflates. So the primary is placed
 * at `primary + shortestDelta` when the raw delta is not already the shortest one.
 *
 * EXACTNESS in the overwhelmingly common case (|Δlon| ≤ 180): the primary is placed at
 * `target` ITSELF, bit-for-bit — never recomputed as `lon + (target.lon − lon)`, whose
 * rounding would nudge a SNAPPED position (FR-31, which must land exactly on the
 * candidate) or a slid position (FR-28, exactly on the obstacle edge) off by ULPs.
 *
 * Returns undefined when the PRIMARY cannot be resolved — the caller must then produce
 * NO partial edit (片落とし禁止, 教訓 5.18). A companion that cannot be resolved is
 * skipped exactly as {@link moveVertexSet} skips one.
 */
export function moveDraggedVertexSet(
  primaryId: VertexId,
  companionIds: Iterable<VertexId> | undefined,
  store: VertexStore,
  target: WorldCoordinate,
): readonly Vertex[] | undefined {
  const primary = getVertex(store, primaryId);
  if (primary === undefined) return undefined;
  const rawDLon = target.lon - primary.coordinate.lon;
  const wrappedDLon = shortestLonDeltaDeg(primary.coordinate.lon, target.lon);
  // Did the gesture's RAW longitude delta carry a whole ±360° turn? Compared with a
  // half-period tolerance, NOT with `===`: `shortestLonDeltaDeg` folds through a modulo,
  // so even a plainly-in-range delta comes back a few ULPs off its raw self, and an
  // exact comparison would mistake that rounding for a seam crossing.
  const wholeTurns = Math.abs(rawDLon - wrappedDLon) >= LONGITUDE_PERIOD / 2;
  const delta: VertexMoveDelta = {
    // No turn ⇒ use the RAW delta: it is already the shortest one, and it is EXACT, so
    // the companions shift by bit-for-bit the primary's displacement (perfect rigidity).
    dLon: wholeTurns ? wrappedDLon : rawDLon,
    dLat: target.lat - primary.coordinate.lat,
  };
  // Same branch ⇒ keep `target` verbatim (see EXACTNESS above); otherwise re-place the
  // primary on the branch its own shortest delta names, so 1 頂点 and N 頂点 obey ONE rule.
  const moved = wholeTurns
    ? withVertexCoordinate(
        primary,
        createCoordinate(primary.coordinate.lon + delta.dLon, target.lat),
      )
    : withVertexCoordinate(primary, target);
  if (companionIds === undefined) return [moved];
  const out: Vertex[] = [moved];
  for (const id of companionIds) {
    if (id === primaryId) continue; // the primary is placed absolutely, never shifted twice.
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
