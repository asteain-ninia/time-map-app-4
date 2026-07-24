// U22 selection — the selection STATE value (single source of truth).
//
// This is the pure, immutable value the selection reducer transforms. It is the
// one truth for "what is selected right now" (spec §目的). It holds the three
// selection states the unit owns, plus the transient pointer-interaction state
// the reducer drives through a press → move → release sequence (教訓 5.8). The
// transient parts are part of the value so they can be discarded on EVERY path
// (教訓 5.2) by simply replacing them with their cleared form.
//
// The state lives in `domain` (framework-free): the thin Zustand store mirrors
// the reducer's output (技術方針 2.5). Everything here is plain data so it maps
// directly to/from the store (教訓 5.20).

import type { WorldCoordinate } from '../coordinate';
import type { FeatureId, VertexId } from '../ids';

// --- Active feature (FR-79: always 0 or 1) ----------------------------------

/**
 * The active feature is `FeatureId | null` — 0 or 1, never more (FR-79). A
 * multi-active state is structurally unrepresentable (受け入れ基準 1).
 */
export type ActiveFeature = FeatureId | null;

// --- Transient pointer interaction (教訓 5.8 press → move → release) --------

export const POINTER_PHASE = {
  /** No pointer interaction in progress. */
  Idle: 'idle',
  /**
   * Pressed on EMPTY space → a rectangle-selection draft is forming. Becomes a
   * rectangle select on release (if moved) or a clear (if not moved).
   */
  RectangleDraft: 'rectangleDraft',
  /**
   * Pressed on a SELECTED vertex → a simultaneous-move drag is forming. Becomes
   * a move on release (if moved a non-zero vector) or a no-op (if not moved).
   */
  VertexDrag: 'vertexDrag',
} as const;

export type PointerPhase = (typeof POINTER_PHASE)[keyof typeof POINTER_PHASE];

/**
 * Transient interaction state. Every variant carries the press anchor so the
 * release path can decide "moved vs. not moved" from the SAME source the press
 * recorded (教訓 5.24: baseline from one source). `shiftHeld` is captured at
 * press time so a rectangle-draft remembers whether to add or replace on
 * release.
 */
export type Transient =
  | { readonly phase: typeof POINTER_PHASE.Idle }
  | {
      readonly phase: typeof POINTER_PHASE.RectangleDraft;
      /** Where the drag started (one corner of the rubber-band rectangle). */
      readonly origin: WorldCoordinate;
      /** Current opposite corner (updated on move; equals origin until moved). */
      readonly current: WorldCoordinate;
      /** Shift held at press → range select ADDS instead of REPLACES (FR-80). */
      readonly shiftHeld: boolean;
    }
  | {
      readonly phase: typeof POINTER_PHASE.VertexDrag;
      /** Feature owning the dragged vertices (single owner during a drag). */
      readonly ownerFeatureId: FeatureId;
      /**
       * The vertex actually pressed (教訓 5.8). On a not-moved release of a
       * plain press over an ALREADY-selected vertex, the set is REPLACED with
       * this single vertex (受け入れ基準 2 / FR-80) — the "click=replace"
       * decision is made at release, not press, so a drag is never mis-clicked.
       */
      readonly pressedVertexId: VertexId;
      /** Where the drag started (the move baseline, 教訓 5.24). */
      readonly origin: WorldCoordinate;
      /** Current pointer position (updated on move; equals origin until moved). */
      readonly current: WorldCoordinate;
    };

export const IDLE_TRANSIENT: Transient = { phase: POINTER_PHASE.Idle };

// --- Selection state (the whole value) --------------------------------------

/**
 * The complete selection value. `activeFeature` (FR-79) and `vertexIds`
 * (FR-80) are the persistent selection; `vertexOwner` records the feature that
 * owns the current vertex set (one owner, FR-81); `transient` is the in-flight
 * pointer interaction discarded on every reset path (教訓 5.2).
 *
 * Invariant: `vertexOwner` is non-null iff `vertexIds` is non-empty. The
 * constructors below maintain it so the raw value never drifts (教訓 5.18:
 * emptiness decided by the set, owner kept in lockstep).
 */
export interface SelectionState {
  readonly activeFeature: ActiveFeature;
  /** The selected vertex IDs (FR-80). Empty set = no vertex selection. */
  readonly vertexIds: ReadonlySet<VertexId>;
  /** Owner of the vertex set (FR-81). `null` exactly when `vertexIds` empty. */
  readonly vertexOwner: FeatureId | null;
  readonly transient: Transient;
}

/** The empty selection: nothing active, no vertices, idle. */
export const EMPTY_SELECTION: SelectionState = {
  activeFeature: null,
  vertexIds: new Set<VertexId>(),
  vertexOwner: null,
  transient: IDLE_TRANSIENT,
};

// --- Builders (keep the owner/non-empty invariant) --------------------------

/** Replace the vertex set + owner, dropping the owner when the set is empty. */
export function withVertexSet(
  state: SelectionState,
  ownerFeatureId: FeatureId,
  vertexIds: ReadonlySet<VertexId>,
): SelectionState {
  if (vertexIds.size === 0) {
    return { ...state, vertexIds: new Set<VertexId>(), vertexOwner: null };
  }
  return { ...state, vertexIds, vertexOwner: ownerFeatureId };
}

/** Clear ONLY the vertex selection (keeps active feature + transient). */
export function withoutVertexSet(state: SelectionState): SelectionState {
  return { ...state, vertexIds: new Set<VertexId>(), vertexOwner: null };
}

// --- Vertex-set operations (FR-80 / FR-81: the ONE implementation) -----------
//
// replace / toggle / add are the three vertex-set mutations FR-80 names. They
// live HERE (not in the reducer and AGAIN in the store) so there is a single
// implementation both the reducer and the thin store mirror (教訓 5.29 単一の
// 真実源). All three keep the owner/non-empty invariant via `withVertexSet`, and
// all three enforce FR-81 (one owner): a mutation naming a DIFFERENT owner than
// the current set starts a fresh owned set rather than mixing owners.

/**
 * REPLACE the vertex set with `vertexIds` under `ownerFeatureId` (FR-80 plain
 * click / plain rectangle). An empty set resolves the context away.
 */
export function replaceVertices(
  state: SelectionState,
  ownerFeatureId: FeatureId,
  vertexIds: ReadonlySet<VertexId>,
): SelectionState {
  return withVertexSet(state, ownerFeatureId, new Set(vertexIds));
}

/**
 * TOGGLE a single vertex in/out of the set (FR-80 shift+click). A toggle naming
 * a different owner than the current set starts a fresh set for the new owner
 * (FR-81: one owner per vertex selection).
 */
export function toggleVertex(
  state: SelectionState,
  ownerFeatureId: FeatureId,
  vertexId: VertexId,
): SelectionState {
  const sameOwner = state.vertexOwner === ownerFeatureId;
  const next = sameOwner ? new Set(state.vertexIds) : new Set<VertexId>();
  if (next.has(vertexId)) next.delete(vertexId);
  else next.add(vertexId);
  return withVertexSet(state, ownerFeatureId, next);
}

/**
 * ADD vertices to the set (FR-80 shift+rectangle / range add). Adding under a
 * different owner than the current set starts a fresh owned set (FR-81).
 */
export function addVertices(
  state: SelectionState,
  ownerFeatureId: FeatureId,
  vertexIds: Iterable<VertexId>,
): SelectionState {
  const sameOwner = state.vertexOwner === ownerFeatureId;
  const next = sameOwner ? new Set(state.vertexIds) : new Set<VertexId>();
  for (const vid of vertexIds) next.add(vid);
  return withVertexSet(state, ownerFeatureId, next);
}

/**
 * FR-80 複数頂点同時移動 — the OTHER selected vertices that ride along when the vertex
 * `vertexId` of `featureId` is grabbed and dragged, or undefined when the gesture is a
 * plain single-vertex move.
 *
 * THE RULE (one place, so the live drag path and any future caller cannot drift —
 * 教訓 5.29): the set rides along ONLY when the grabbed vertex is itself IN the current
 * selection AND that selection is owned by the feature being grabbed (FR-81 一owner).
 * Grabbing an UNSELECTED vertex — even while other vertices are selected — is therefore
 * a plain single-vertex move, matching the release-time reducer, whose VertexDrag branch
 * is only ever armed by a press ON a selected vertex.
 *
 * WHY THE OWNER CHECK IS LOAD-BEARING, not defensive: a vertex id is a key in the GLOBAL
 * vertex store and FR-30 共有頂点 means a neighbouring feature cites the SAME id. Without
 * it, selecting 地物 B's vertices and then grabbing 地物 A's copy of a shared vertex would
 * drag B's whole selection along. `vertexOwner` is `FeatureId | null` — a selection can
 * never span two owners — so a "selection across several features" case cannot arise here.
 *
 * The primary is EXCLUDED from the result (it is named separately by the gesture), and an
 * otherwise-empty result is reported as undefined: "no companions" is ONE value (教訓 5.18).
 */
export function companionVertexIdsFor(
  state: SelectionState,
  featureId: FeatureId,
  vertexId: VertexId,
): ReadonlySet<VertexId> | undefined {
  if (state.vertexOwner !== featureId) return undefined;
  if (!state.vertexIds.has(vertexId)) return undefined;
  const out = new Set<VertexId>();
  for (const id of state.vertexIds) {
    if (id !== vertexId) out.add(id);
  }
  return out.size === 0 ? undefined : out;
}

/** Set the active feature (0/1; pass `null` to clear). */
export function withActiveFeature(
  state: SelectionState,
  activeFeature: ActiveFeature,
): SelectionState {
  return { ...state, activeFeature };
}

/** Replace the transient interaction state. */
export function withTransient(
  state: SelectionState,
  transient: Transient,
): SelectionState {
  return { ...state, transient };
}

/**
 * Discard ALL transient state (教訓 5.2). Called on confirm / cancel / tool
 * switch / mode switch. The persistent selection is untouched; only the
 * in-flight pointer interaction is reset to idle.
 */
export function discardTransient(state: SelectionState): SelectionState {
  return state.transient.phase === POINTER_PHASE.Idle
    ? state
    : { ...state, transient: IDLE_TRANSIENT };
}

/** True iff a pointer interaction (rectangle / drag) is in progress. */
export function isInteracting(state: SelectionState): boolean {
  return state.transient.phase !== POINTER_PHASE.Idle;
}
