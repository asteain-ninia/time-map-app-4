// U24 — the press→move→release drag-session state machine (教訓5.8 / 5.7 / 5.2).
//
// LAYER: pure `domain` logic. A drag session is a TRANSIENT value object that
// captures everything one gesture needs: the tool, the dragged element, the start
// world position, the current preview position, the live slide state, and the live
// snap candidate. It is created on PRESS, updated on MOVE, and discarded on RELEASE
// / CANCEL / tool-change / mode-change (受け入れ基準9 全パス破棄, 教訓5.2).
//
// The session NEVER mutates shared domain state during the drag (教訓5.22): MOVE
// only updates the transient preview / slide / snap. The actual commit (assembling
// the edit proposal and driving U13) is the RELEASE step, implemented in
// ./edit-flow against this session — separated so the light per-frame path (MOVE)
// and the full-integrity confirm path (RELEASE) are distinct (技術方針 R5 / R12).
//
// 教訓5.8 (click vs drag): a PRESS followed by a RELEASE at the SAME position (no
// MOVE, or a zero-delta MOVE) is a click; `isNoOp` reports it so the release path
// runs the no-op guard rather than committing a ghost edit (教訓5.24). Both paths
// (click and drag) terminate the transient — release/cancel always return to idle.

import type { WorldCoordinate } from '../coordinate';
import { coordinatesEqual } from '../coordinate';
import { quantizeCoordinate } from '../geometry/quantize';
import type { FeatureId, RingId, VertexId } from '../ids';
import type { SlideBoundary } from './slide';
import type { SnapDecision } from './snap';

// --- tool kinds (the press→move→release applies per tool) -------------------

export const EDIT_TOOL = {
  /** Move the WHOLE active feature by one vector (FR-88, all vertices). */
  FeatureMove: 'feature-move',
  /** Move ONE vertex (point / line / leaf vertex handle, FR-88). */
  VertexMove: 'vertex-move',
  /** Drag an edge handle to ADD a new vertex on that edge (FR-87 / FR-89). */
  EdgeAdd: 'edge-add',
} as const;

export type EditTool = (typeof EDIT_TOOL)[keyof typeof EDIT_TOOL];

// --- the dragged target (discriminated by tool) -----------------------------

/**
 * What a gesture is dragging. A discriminated union so the wrong field cannot be
 * read for the wrong tool (a feature-move has no single vertex; an edge-add has an
 * edge, not yet a vertex). 教訓5.19 / 技術方針 2.1.
 */
export type DragTarget =
  | { readonly tool: typeof EDIT_TOOL.FeatureMove; readonly featureId: FeatureId }
  | {
      readonly tool: typeof EDIT_TOOL.VertexMove;
      readonly featureId: FeatureId;
      readonly vertexId: VertexId;
      /** The ring the vertex belongs to (leaf only). */
      readonly ringId?: RingId;
      /**
       * FR-80 複数頂点同時移動: the OTHER selected vertices that move RIGIDLY with
       * `vertexId` by the same vector, as ONE edit operation. Excludes `vertexId`
       * itself (the primary is named once, by `vertexId` — 教訓 5.29 単一真実源).
       *
       * COMMITTED IDS ONLY (HB4-2 SCOPE): these ids widen the per-frame "moves with
       * this drag" set that {@link createNeighboursQuery} uses to drop non-obstacle
       * edges. A RESERVED id (an edge-add's not-yet-materialised vertex) must never
       * appear here — it names no committed ring, and mixing reservations into that
       * set would start erasing static edges of neighbouring features.
       *
       * The primary alone stays the single truth for snap / slide / 共有化候補
       * ({@link DragSession.draggedVertexId}); companions never snap or slide on
       * their own (see the adapter's applyMove).
       */
      readonly companionVertexIds?: ReadonlySet<VertexId>;
    }
  | {
      readonly tool: typeof EDIT_TOOL.EdgeAdd;
      readonly featureId: FeatureId;
      readonly startVertexId: VertexId;
      readonly endVertexId: VertexId;
      readonly ringId?: RingId;
      /**
       * The id RESERVED at press for the vertex this edge-add gesture creates (FR-87
       * / FR-89 / 受け入れ基準6 最終項). The new vertex is materialised on the edge at
       * confirm time ({@link addVertexToLine} / {@link addVertexToLeafRing} take this
       * same id), but its identity is fixed here so the in-flight drag can treat it as
       * the dragged vertex — enabling snap / 共有化候補 just like a vertex-move. Without
       * a reserved id the generated vertex could never become a share pair (it had no
       * id until release, so {@link DragSession.draggedVertexId} stayed undefined and
       * `decideSharePairAtRelease` always returned undefined).
       */
      readonly newVertexId: VertexId;
    };

/** The transient slide state carried during a drag (面 vertex/edge editing). */
export interface SlideState {
  readonly boundaries: readonly SlideBoundary[];
  readonly collided: boolean;
}

export const NO_SLIDE: SlideState = { boundaries: [], collided: false };

/**
 * The drag session: a transient value. `start` is the press world position;
 * `preview` is the current (constrained) world position; `slide` and `snap` are the
 * live per-frame states. All of it is discarded on release / cancel (教訓5.2).
 */
export interface DragSession {
  readonly target: DragTarget;
  /** The vertex being dragged for vertex-move / edge-add (undefined for feature-move). */
  readonly draggedVertexId?: VertexId;
  /**
   * FR-80: the COMMITTED vertex ids that ride along with {@link draggedVertexId} by the
   * same vector (never containing the primary itself). Absent when the gesture moves a
   * single vertex — the overwhelmingly common case, so every existing session value and
   * every reader that ignores this field behaves exactly as before.
   */
  readonly companionVertexIds?: ReadonlySet<VertexId>;
  readonly start: WorldCoordinate;
  readonly preview: WorldCoordinate;
  readonly slide: SlideState;
  /** Live snap candidate (null when none this frame). Dropped if it lapses (5.2). */
  readonly snap: SnapDecision | null;
}

// --- PRESS: open a session (教訓5.8 押下で開始状態を設定) ---------------------

/**
 * Begin a drag session at the press position. The preview starts AT the press
 * position (a no-move click is start === preview, reported by {@link isNoOp}).
 * No domain state is touched (教訓5.22).
 */
export function beginDrag(target: DragTarget, pressAt: WorldCoordinate): DragSession {
  const start = quantizeCoordinate(pressAt);
  const base = {
    target,
    start,
    preview: start,
    slide: NO_SLIDE,
    snap: null as SnapDecision | null,
  };
  // Carry the dragged vertex id. For a vertex-move it is the moved vertex. For an
  // edge-add it is the id RESERVED for the vertex this gesture creates (minted on
  // the edge at confirm time with the SAME id): fixing it here lets the in-flight
  // edge-add vertex participate in snap / 共有化候補 exactly like a vertex-move, so
  // decideSharePairAtRelease can promote a surviving snap to a share pair (受け入れ
  // 基準6 最終項 / FR-89). Feature-move has no single dragged vertex (undefined).
  if (target.tool === EDIT_TOOL.VertexMove) {
    // FR-80: normalise the companion set ONCE, here, so no downstream reader has to
    // re-check the two invariants it depends on (教訓 5.29): the primary is never also
    // a companion (it is already named by `draggedVertexId`, and double-counting it
    // would move it twice through the rigid-delta path), and an EMPTY set is absent
    // rather than an empty object — "no companions" is one value, not two.
    const companions = withoutPrimary(target.companionVertexIds, target.vertexId);
    return companions === undefined
      ? { ...base, draggedVertexId: target.vertexId }
      : { ...base, draggedVertexId: target.vertexId, companionVertexIds: companions };
  }
  if (target.tool === EDIT_TOOL.EdgeAdd) {
    return { ...base, draggedVertexId: target.newVertexId };
  }
  return base;
}

/**
 * `ids` without `primary`, or undefined when nothing is left (FR-80 normalisation).
 * Returns a defensive COPY so a caller's live selection set cannot mutate under the
 * transient session mid-gesture (教訓 5.17 値オブジェクト).
 */
function withoutPrimary(
  ids: ReadonlySet<VertexId> | undefined,
  primary: VertexId,
): ReadonlySet<VertexId> | undefined {
  if (ids === undefined || ids.size === 0) return undefined;
  const out = new Set<VertexId>();
  for (const id of ids) {
    if (id !== primary) out.add(id);
  }
  return out.size === 0 ? undefined : out;
}

/**
 * Every vertex id that MOVES with this drag frame (FR-80 / HB4-2 D56): the primary
 * dragged vertex plus its companions. The ONE place this union is formed, so the
 * slide/snap obstacle filter, the preview store and the drag-ring highlight can never
 * disagree about which points are in motion (教訓 5.29 単一真実源).
 *
 * Empty for a feature-move (no single dragged vertex). For an EDGE-ADD it holds only
 * the RESERVED id, which no committed ring references — unchanged from before, and the
 * reason companions are committed-only (see {@link DragTarget} companionVertexIds).
 */
export function movingVertexIds(session: DragSession): ReadonlySet<VertexId> {
  const primary = session.draggedVertexId;
  if (primary === undefined) return EMPTY_VERTEX_IDS;
  const companions = session.companionVertexIds;
  if (companions === undefined || companions.size === 0) return new Set<VertexId>([primary]);
  const out = new Set<VertexId>(companions);
  out.add(primary);
  return out;
}

const EMPTY_VERTEX_IDS: ReadonlySet<VertexId> = new Set<VertexId>();

// --- MOVE: update the transient preview (教訓5.22 軽量・破壊更新しない) --------

export interface DragUpdate {
  readonly preview: WorldCoordinate;
  readonly slide?: SlideState;
  readonly snap?: SnapDecision | null;
}

/**
 * Update a session with the frame's constrained preview, slide and snap. Returns a
 * NEW session (immutable, 教訓5.17). Shared domain state is untouched: the move is
 * a transient preview only (教訓5.22 / 受け入れ基準8).
 */
export function updateDrag(session: DragSession, update: DragUpdate): DragSession {
  return {
    ...session,
    preview: update.preview,
    slide: update.slide ?? session.slide,
    snap: update.snap === undefined ? session.snap : update.snap,
  };
}

// --- no-op detection (教訓5.24 / 5.8 click) ---------------------------------

/**
 * True iff the gesture produced no movement (a click, or a drag back to start):
 * the preview equals the start after quantization. The release path uses this to
 * skip the consistency process and history push (no ghost undo). 受け入れ基準10.
 */
export function isNoOp(session: DragSession): boolean {
  return coordinatesEqual(quantizeCoordinate(session.preview), session.start);
}

/** The world-space delta from the session's start to its current preview. */
export function dragDelta(session: DragSession): { readonly dLon: number; readonly dLat: number } {
  return {
    dLon: session.preview.lon - session.start.lon,
    dLat: session.preview.lat - session.start.lat,
  };
}

// --- RELEASE / CANCEL: return to idle (教訓5.2 全経路破棄) --------------------

/**
 * Discard the session's transient state. There is no "idle session" object — the
 * caller drops the session reference; this returns the sentinel `null` so EVERY
 * termination path (release-confirm, cancel/Escape, tool-change, mode-change)
 * funnels through one discard (教訓5.2 受け入れ基準9). The actual commit on a
 * confirming release is done by ./edit-flow BEFORE the caller discards.
 */
export function discardDrag(): null {
  return null;
}
