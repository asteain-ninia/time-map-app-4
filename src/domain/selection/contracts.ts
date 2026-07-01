// U22 selection — layer-crossing contracts (教訓 5.33 / 5.34).
//
// These types fix the API between the selection unit (domain) and its
// dependencies:
//   - U24 (edit-tool foundation): the HIT RESULT a pointer interaction produced
//     (which feature / which vertex / empty space was hit) and the VERTEX MOVE
//     SPEC the selection unit hands back for a simultaneous move. The selection
//     unit never re-implements hit-testing or the actual coordinate update; it
//     maps a hit result into selection state and assembles the "selection-set ×
//     one vector" move intent (spec スコープ「やらないこと」, 教訓 5.30).
//   - U20 (mode管理): the edit mode the selection runs under. The selection unit
//     drives only while editing and is reset on mode change (consumed via the
//     reducer's reset paths).
//   - The OWNER lookup: the single source that resolves "which feature owns this
//     vertex" from the displayed feature data (単一の真実源). The selection unit
//     never scans the whole data source itself (教訓 5.3 / 5.4); it asks this
//     injected port, which a caller backs with the U24/U03 feature store.
//
// All of these are EXPRESSED with the domain's branded IDs (教訓 5.19), so an
// ID mix-up between layers is a compile error. Both sides test against these
// types so the two layers never rely on accidental structural agreement.

import type { WorldCoordinate } from '../coordinate';
import type { FeatureId, RingId, VertexId } from '../ids';

// --- Hit result (produced by U24, consumed here) ----------------------------

export const HIT_KIND = {
  /** The pointer hit a feature BODY (selects it as the active feature, FR-79). */
  FeatureBody: 'featureBody',
  /** The pointer hit a vertex HANDLE (drives the vertex-selection set, FR-80). */
  Vertex: 'vertex',
  /**
   * The pointer hit an EDGE-midpoint HANDLE of the active feature (starts an
   * add-a-new-vertex gesture, FR-87). Unlike a vertex / body hit it does NOT change
   * the selection set — it only names the edge U24 inserts a new vertex onto when the
   * handle is dragged / clicked (edit-session-adapter → EDIT_TOOL.EdgeAdd).
   */
  Edge: 'edge',
  /** The pointer hit nothing selectable (empty space → clears selection). */
  Empty: 'empty',
} as const;

export type HitKind = (typeof HIT_KIND)[keyof typeof HIT_KIND];

/**
 * The result of a pointer hit-test (FR-79 / FR-80). A discriminated union so a
 * feature-body hit and a vertex hit cannot be confused, and "hit nothing" is an
 * explicit value rather than `null` (教訓 5.18: emptiness is a real value).
 *
 * 教訓 5.9: a position where a feature body AND a vertex both lie is resolved by
 * U24 into ONE hit result before it reaches the selection unit — the priority is
 * decided once, at the hit-test, so the selection reducer never re-decides it.
 */
export type HitResult =
  | { readonly kind: typeof HIT_KIND.FeatureBody; readonly featureId: FeatureId }
  | {
      readonly kind: typeof HIT_KIND.Vertex;
      readonly featureId: FeatureId;
      readonly vertexId: VertexId;
    }
  | {
      readonly kind: typeof HIT_KIND.Edge;
      readonly featureId: FeatureId;
      /** The ring the edge belongs to (leaf only); absent for a line edge. */
      readonly ringId?: RingId;
      /** The two endpoint vertex ids of the edge a new vertex is inserted between. */
      readonly startVertexId: VertexId;
      readonly endVertexId: VertexId;
    }
  | { readonly kind: typeof HIT_KIND.Empty };

export function featureBodyHit(featureId: FeatureId): HitResult {
  return { kind: HIT_KIND.FeatureBody, featureId };
}

export function vertexHit(featureId: FeatureId, vertexId: VertexId): HitResult {
  return { kind: HIT_KIND.Vertex, featureId, vertexId };
}

/**
 * An edge-midpoint hit (FR-87): the active feature's edge from `startVertexId` to
 * `endVertexId` (on `ringId` for a leaf). U24 turns this into an
 * {@link EDIT_TOOL.EdgeAdd} drag that inserts a new vertex on that edge. `ringId` is
 * dropped when undefined (a line edge) so the branded-optional field stays exact.
 */
export function edgeHit(
  featureId: FeatureId,
  startVertexId: VertexId,
  endVertexId: VertexId,
  ringId?: RingId,
): HitResult {
  return ringId === undefined
    ? { kind: HIT_KIND.Edge, featureId, startVertexId, endVertexId }
    : { kind: HIT_KIND.Edge, featureId, ringId, startVertexId, endVertexId };
}

export const EMPTY_HIT: HitResult = { kind: HIT_KIND.Empty };

// --- Owner lookup (the single source for context analysis) ------------------

/**
 * Resolves the owning feature of a vertex from the currently displayed feature
 * data (単一の真実源, 教訓 5.3). Returns `null` when the owner cannot be
 * resolved (a dangling / unknown vertex) — that `null` is what drives the
 * "unknown" context classification (受け入れ基準 5). A caller backs this with
 * the U03/U24 feature store; the selection unit never scans features itself.
 */
export interface VertexOwnerLookup {
  ownerOf(vertexId: VertexId): FeatureId | null;
}

/** Build an owner lookup from a plain map (used by tests and thin adapters). */
export function ownerLookupFromMap(
  owners: ReadonlyMap<VertexId, FeatureId>,
): VertexOwnerLookup {
  return {
    ownerOf: (vertexId) => owners.get(vertexId) ?? null,
  };
}

// --- Vertex move spec (handed back to U24's vertex-move command) ------------

/**
 * The simultaneous-move intent the selection unit assembles (FR-80 / FR-94):
 * "move EVERY selected vertex by the SAME vector, as ONE edit operation". The
 * selection unit decides WHICH vertices and HOW FAR; U24's vertex-move command
 * performs the actual coordinate update, collision (edge-slide) and shared-
 * vertex linkage (spec スコープ「やらないこと」, 教訓 5.30). The vector is a
 * world-coordinate delta (Δlon, Δlat).
 */
export interface VertexMoveDelta {
  readonly dLon: number;
  readonly dLat: number;
}

export interface SimultaneousMoveSpec {
  /** Every vertex in the selection set (the move applies to all of them). */
  readonly vertexIds: ReadonlySet<VertexId>;
  /** The single shared move vector (the same Δ for every vertex). */
  readonly delta: VertexMoveDelta;
}

/** Zero vector: a no-op move (used by the confirm-time no-op guard, 教訓 5.24). */
export const ZERO_DELTA: VertexMoveDelta = { dLon: 0, dLat: 0 };

/** Δ from a drag's start coordinate to its current coordinate. */
export function deltaBetween(
  from: WorldCoordinate,
  to: WorldCoordinate,
): VertexMoveDelta {
  return { dLon: to.lon - from.lon, dLat: to.lat - from.lat };
}

/** True iff the delta is exactly the zero vector (no movement). */
export function isZeroDelta(delta: VertexMoveDelta): boolean {
  return delta.dLon === 0 && delta.dLat === 0;
}
