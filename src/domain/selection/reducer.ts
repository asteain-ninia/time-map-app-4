// U22 selection — the pure selection REDUCER (NFR 5.8, 教訓 5.8 / 5.2 / 5.24).
//
// A single pure function: (state, event) → new state. It has NO side effects, no
// framework dependency, and is exhaustively `switch`-checked over the event
// kinds (教訓 5.19). The thin Zustand store mirrors its output (技術方針 2.5);
// the Canvas subscribes to the store, never the reducer (技術方針 2.3).
//
// The reducer drives the FULL press → move → release sequence (教訓 5.8):
//   - press   : record where, on what (vertex / empty), with which modifier.
//   - move    : update the transient (rectangle corner / drag position).
//   - release : decide moved-vs-not from the SAME anchor the press recorded
//               (教訓 5.24) and commit: click=replace/toggle, drag=rectangle/
//               move. Transient state is ALWAYS reset on release (教訓 5.2).
//
// Simultaneous-move COMMIT does not mutate vertex coordinates here — it returns a
// SimultaneousMoveSpec the caller hands to U24 (spec スコープ「やらないこと」).
// The reducer therefore returns BOTH the next state and an optional emitted
// move spec, so a confirmed drag flows out as exactly one move intent.

import { assertNever } from '../assert-never';
import type { WorldCoordinate } from '../coordinate';
import type { FeatureId, VertexId } from '../ids';

import {
  deltaBetween,
  isZeroDelta,
  type HitResult,
  type SimultaneousMoveSpec,
} from './contracts';
import { HIT_KIND } from './contracts';
import {
  EMPTY_SELECTION,
  IDLE_TRANSIENT,
  POINTER_PHASE,
  type SelectionState,
  addVertices,
  discardTransient,
  replaceVertices,
  toggleVertex,
  withActiveFeature,
  withTransient,
  withoutVertexSet,
} from './state';

// --- Events -----------------------------------------------------------------

export const SELECTION_EVENT = {
  /** Pointer pressed at a world position; carries the hit-test result. */
  PointerDown: 'pointerDown',
  /** Pointer moved to a world position (drives the in-flight transient). */
  PointerMove: 'pointerMove',
  /** Pointer released; finalizes click / rectangle / move. */
  PointerUp: 'pointerUp',
  /** Escape pressed: clears selection + discards transient (FR-79). */
  Escape: 'escape',
  /** Tool or mode changed (U20): discards transient + selection (教訓 5.2). */
  Reset: 'reset',
} as const;

export type SelectionEventKind =
  (typeof SELECTION_EVENT)[keyof typeof SELECTION_EVENT];

export type SelectionEvent =
  | {
      readonly kind: typeof SELECTION_EVENT.PointerDown;
      readonly at: WorldCoordinate;
      readonly hit: HitResult;
      readonly shiftHeld: boolean;
    }
  | { readonly kind: typeof SELECTION_EVENT.PointerMove; readonly at: WorldCoordinate }
  | { readonly kind: typeof SELECTION_EVENT.PointerUp; readonly at: WorldCoordinate }
  | { readonly kind: typeof SELECTION_EVENT.Escape }
  | { readonly kind: typeof SELECTION_EVENT.Reset };

// --- Rectangle hit supply ---------------------------------------------------
//
// When a rectangle-select is committed, the vertices INSIDE the rectangle are
// hit-tested by U24, not by this unit (spec スコープ「やらないこと」). The
// reducer asks for them through this resolver so it never reaches into geometry
// itself (単一の真実源). The resolver returns the owner + the contained vertices.

export interface RectangleHit {
  readonly ownerFeatureId: FeatureId;
  readonly vertexIds: ReadonlySet<VertexId>;
}

export interface RectangleResolver {
  /**
   * Vertices contained in the world-space rectangle [a, b] (any two opposite
   * corners). Returns `null` when the rectangle contains no vertices (教訓 5.18:
   * a real "nothing inside" answer, distinct from a single owner).
   */
  verticesInRectangle(a: WorldCoordinate, b: WorldCoordinate): RectangleHit | null;
}

/** A resolver that always finds nothing (default for click-only flows). */
export const EMPTY_RECTANGLE_RESOLVER: RectangleResolver = {
  verticesInRectangle: () => null,
};

// --- Reducer result ---------------------------------------------------------

/**
 * The reducer's output: the next state, plus an optional move spec EMITTED when
 * a vertex drag is confirmed with a non-zero vector (受け入れ基準 3). The caller
 * hands `emittedMove` to U24's vertex-move command as ONE edit operation; a
 * zero-vector confirm emits nothing (the no-op guard, 教訓 5.24).
 */
export interface ReduceResult {
  readonly state: SelectionState;
  readonly emittedMove: SimultaneousMoveSpec | null;
}

function result(
  state: SelectionState,
  emittedMove: SimultaneousMoveSpec | null = null,
): ReduceResult {
  return { state, emittedMove };
}

// --- Options ----------------------------------------------------------------

export interface ReduceOptions {
  /** Resolves vertices inside a rubber-band rectangle (U24-backed). */
  readonly rectangle?: RectangleResolver;
}

// --- The reducer ------------------------------------------------------------

/**
 * Pure selection transition. `state` is never mutated. Press → move → release is
 * handled across PointerDown / PointerMove / PointerUp; Escape and Reset clear.
 */
export function reduceSelection(
  state: SelectionState,
  event: SelectionEvent,
  options: ReduceOptions = {},
): ReduceResult {
  switch (event.kind) {
    case SELECTION_EVENT.PointerDown:
      return result(onPointerDown(state, event.at, event.hit, event.shiftHeld));
    case SELECTION_EVENT.PointerMove:
      return result(onPointerMove(state, event.at));
    case SELECTION_EVENT.PointerUp:
      return onPointerUp(state, event.at, options);
    case SELECTION_EVENT.Escape:
      // FR-79: Escape clears active feature + vertex set + transient.
      return result(EMPTY_SELECTION);
    case SELECTION_EVENT.Reset:
      // 教訓 5.2: tool/mode switch discards transient AND selection.
      return result(EMPTY_SELECTION);
    default:
      return assertNever(event);
  }
}

// --- Press ------------------------------------------------------------------

function onPointerDown(
  state: SelectionState,
  at: WorldCoordinate,
  hit: HitResult,
  shiftHeld: boolean,
): SelectionState {
  // Any new press starts from a clean transient (教訓 5.2: never carry one over).
  const base = discardTransient(state);

  switch (hit.kind) {
    case HIT_KIND.FeatureBody:
      // FR-79: a feature-body press makes it the (sole) active feature. It also
      // clears any vertex selection — selecting a feature body is a distinct
      // gesture from selecting vertices (教訓 5.9: the priority is fixed). No
      // transient: a feature-body click is committed immediately on press; a
      // following move is treated as a feature move by U24, not by this unit.
      return withoutVertexSet(withActiveFeature(base, hit.featureId));

    case HIT_KIND.Vertex: {
      // A vertex press. If the pressed vertex is ALREADY selected (and the owner
      // matches), start a simultaneous-move drag (教訓 5.8: press on selected
      // vertex → move). Otherwise the click/shift-click is finalized on RELEASE
      // (so a drag that started elsewhere is not mis-finalized); we still record
      // a vertex-drag transient anchored here for the not-moved → click path.
      // Shift+click is ALWAYS a toggle, committed immediately, never a drag — a
      // shift gesture adjusts the set rather than moving it (FR-80, 教訓 5.9: the
      // shift branch is not skipped by the "already selected → drag" path).
      if (shiftHeld) {
        return applyVertexClick(base, hit.featureId, hit.vertexId, true);
      }
      // Plain press on an ALREADY-selected vertex (owner matches): ARM a drag,
      // but DEFER the move-vs-click decision to release (教訓 5.8 / 5.24). The
      // selection set is left UNCHANGED here; on release a zero-delta (=click)
      // REPLACES the set with this single vertex (受け入れ基準 2 / FR-80), while
      // a non-zero delta moves the whole set. Deciding at press would drop the
      // "did not move → replace" path for an already-selected vertex.
      const pressedSelected =
        state.vertexOwner === hit.featureId && state.vertexIds.has(hit.vertexId);
      if (pressedSelected) {
        return withTransient(base, {
          phase: POINTER_PHASE.VertexDrag,
          ownerFeatureId: hit.featureId,
          pressedVertexId: hit.vertexId,
          origin: at,
          current: at,
        });
      }
      // Plain press on a not-yet-selected vertex: REPLACE the set with it NOW,
      // and arm a drag from this vertex so a subsequent move moves the new
      // selection (教訓 5.8 全パス: press→move on a freshly clicked vertex drags).
      const afterClick = applyVertexClick(base, hit.featureId, hit.vertexId, false);
      // Only arm a drag if the pressed vertex ended up selected (toggle-off
      // should not start a drag of a now-unselected vertex).
      const stillSelected =
        afterClick.vertexOwner === hit.featureId &&
        afterClick.vertexIds.has(hit.vertexId);
      if (!stillSelected) {
        return afterClick;
      }
      return withTransient(afterClick, {
        phase: POINTER_PHASE.VertexDrag,
        ownerFeatureId: hit.featureId,
        pressedVertexId: hit.vertexId,
        origin: at,
        current: at,
      });
    }

    case HIT_KIND.Empty:
      // Press on empty space: start a rectangle draft (教訓 5.8: empty press +
      // move = rectangle). If it does not move, release clears the selection.
      return withTransient(base, {
        phase: POINTER_PHASE.RectangleDraft,
        origin: at,
        current: at,
        shiftHeld,
      });

    default:
      return assertNever(hit);
  }
}

/** Apply a click on a vertex: shift = toggle, plain = replace (FR-80). */
function applyVertexClick(
  state: SelectionState,
  ownerFeatureId: FeatureId,
  vertexId: VertexId,
  shiftHeld: boolean,
): SelectionState {
  // Plain click REPLACES, shift+click TOGGLES (FR-80). Both delegate to the ONE
  // vertex-set implementation in state.ts so this gesture path and the thin
  // store share identical replace/toggle semantics (教訓 5.29 単一の真実源).
  return shiftHeld
    ? toggleVertex(state, ownerFeatureId, vertexId)
    : replaceVertices(state, ownerFeatureId, new Set([vertexId]));
}

// --- Move -------------------------------------------------------------------

function onPointerMove(state: SelectionState, at: WorldCoordinate): SelectionState {
  switch (state.transient.phase) {
    case POINTER_PHASE.Idle:
      // No interaction in progress: a move is a no-op for selection (hover is
      // not selection). 教訓 5.9: do not skip — explicitly return unchanged.
      return state;
    case POINTER_PHASE.RectangleDraft:
      return withTransient(state, { ...state.transient, current: at });
    case POINTER_PHASE.VertexDrag:
      return withTransient(state, { ...state.transient, current: at });
    default:
      return assertNever(state.transient);
  }
}

// --- Release ----------------------------------------------------------------

function onPointerUp(
  state: SelectionState,
  at: WorldCoordinate,
  options: ReduceOptions,
): ReduceResult {
  const t = state.transient;
  switch (t.phase) {
    case POINTER_PHASE.Idle:
      // Release with no transient: nothing to finalize (e.g. a feature-body
      // click already committed on press). Return unchanged.
      return result(state);

    case POINTER_PHASE.RectangleDraft: {
      // 教訓 5.2: clear the draft on EVERY release path before deciding outcome.
      const cleared = withTransient(state, IDLE_TRANSIENT);
      if (coordsEqual(t.origin, at)) {
        // Not moved → this was a click on empty space: clear selection (FR-79).
        return result(EMPTY_SELECTION);
      }
      // Moved → rectangle select. Ask U24 which vertices are inside.
      const resolver = options.rectangle ?? EMPTY_RECTANGLE_RESOLVER;
      const inside = resolver.verticesInRectangle(t.origin, at);
      if (inside === null) {
        // Empty rectangle: a replace selects nothing; a shift+rectangle leaves
        // the existing set untouched (教訓 5.18: nothing-inside is a real case).
        return result(t.shiftHeld ? cleared : EMPTY_SELECTION);
      }
      if (t.shiftHeld && cleared.vertexOwner === inside.ownerFeatureId) {
        // Shift + rectangle on the same owner: ADD to the existing set (FR-80).
        return result(
          addVertices(cleared, inside.ownerFeatureId, inside.vertexIds),
        );
      }
      // Plain rectangle (or shift across owners): REPLACE with the inside set.
      return result(
        replaceVertices(cleared, inside.ownerFeatureId, inside.vertexIds),
      );
    }

    case POINTER_PHASE.VertexDrag: {
      // 教訓 5.2: reset the drag transient on release no matter the outcome.
      const cleared = withTransient(state, IDLE_TRANSIENT);
      const delta = deltaBetween(t.origin, at);
      // 教訓 5.8 / 5.24: no move happened → this was a CLICK. REPLACE the set
      // with the single pressed vertex (受け入れ基準 2 / FR-80). This is what
      // collapses a multi-selection down to the one clicked vertex; it must be
      // decided HERE (at release), since at press we cannot yet tell click from
      // drag. No move spec is emitted on a click (no ghost undo entry).
      if (isZeroDelta(delta)) {
        return result(
          applyVertexClick(cleared, t.ownerFeatureId, t.pressedVertexId, false),
        );
      }
      // Defensive: nothing selected → nothing to move (should not happen for a
      // VertexDrag, but keeps the move emit guarded — 教訓 5.24 no-op).
      if (cleared.vertexIds.size === 0) {
        return result(cleared);
      }
      // Confirmed move: emit ONE spec covering the WHOLE selection set ×同一
      // ベクトル (FR-80 / FR-94). The reducer does not change coordinates; U24
      // applies the move as a single edit/undo unit.
      const spec: SimultaneousMoveSpec = {
        vertexIds: new Set(cleared.vertexIds),
        delta,
      };
      return result(cleared, spec);
    }

    default:
      return assertNever(t);
  }
}

function coordsEqual(a: WorldCoordinate, b: WorldCoordinate): boolean {
  return a.lon === b.lon && a.lat === b.lat;
}
