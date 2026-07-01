// U40↔U24 wiring — the concrete {@link EditSessionPort} that drives U24's pure
// drag-session state machine from real pointer input (受け入れ基準9 / 教訓5.7).
//
// The review (教訓5.7「ロジックがあっても UI から呼ばれず機能しない状態を作らない」)
// requires that U24's completion trigger (`confirmRelease` → U13) is reached from
// the UI, not only re-exported from the domain barrel. This adapter is that wire:
// the {@link PointerDispatcher} calls begin / update / release / cancel, and this
// adapter translates each into the matching U24 call —
//   - begin   → beginDrag (open the transient session at the press world point)
//   - update  → updateDrag with the slide / snap LIGHT PATH (constrainSlide +
//               decideSnap when their deps are injected; no shared-state mutation)
//   - release → THE completion trigger, but ONLY when the gesture was a real drag.
//               A click (`wasDrag === false`) is discarded WITHOUT confirming, so
//               U24's click/drag verdict is the SAME single threshold the dispatcher
//               and U22 use (教訓5.30 / 5.24 — no ghost edit / ghost undo on a click).
//   - cancel  → discardDrag (drop the transient on every teardown path, 教訓5.2)
//
// It stays a thin接着層: all domain detail (screen→world conversion, the moved
// vertex body, the consistency ports, the after-state snapshot, the U10 near-
// candidate queries, the U16 snap distance, the world→screen transform) is
// INJECTED, so this unit owns sequencing only and the layer-crossing contract is
// fixed by type (教訓5.33 / 5.34). The pure U24 functions remain the single source
// of the rules.
//
// EDGE-ADD (FR-87): U22's {@link HitResult} now carries an Edge kind (an active-feature
// edge-midpoint hit), so this adapter ALSO drives {@link EDIT_TOOL.EdgeAdd}: an edge hit
// mints a new vertex id (injected {@link EditSessionAdapterDeps.nextVertexId}, the SAME
// shared minter add / knife use so ids never collide) and opens a drag whose reserved
// vertex is inserted onto the edge at confirm time (buildEditSnapshot →
// addVertexToLine / addVertexToLeafRing). The drag reuses the vertex-move light path
// (slide / snap / share) exactly, since the reserved id is the session's dragged vertex
// (drag-session beginDrag). This adapter therefore drives confirmRelease for the three
// tools the hit contract can express: VertexMove (a vertex-handle hit), FeatureMove (a
// feature-body hit on the active feature) and EdgeAdd (an active-feature edge-handle hit).

import {
  EDIT_TOOL,
  beginDrag,
  confirmRelease,
  constrainSlide,
  decideSnap,
  discardDrag,
  updateDrag,
  type BoundaryEdge,
  type CandidateTerminal,
  type DragSession,
  type DragTarget,
  type FeatureSnapshot,
  type ParentContainment,
  type ReleaseOutcome,
  type SnapCandidate,
  type SnapDecision,
  type WorldToScreen,
} from '../../domain/editing';
import {
  HIT_KIND,
  type HitResult,
} from '../../domain/selection';
import type { ConsistencyPorts } from '../../domain/consistency';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { TimePoint } from '../../domain/time';
import type { RingId, VertexId } from '../../domain/ids';
import type { ScreenPoint } from '../../render';
import type { EditSessionPort } from './ports';

/**
 * The U10-narrowed near-candidate sets for the slide / snap LIGHT PATH of one drag
 * frame. The host queries U10's spatial index around the current preview and hands
 * the narrowed sets here so the adapter never scans all features (教訓5.3 / 5.4).
 * Empty sets mean "nothing near this frame" — a real value, never null (教訓5.18).
 */
export interface SlideSnapNeighbours {
  /** Boundary edges of near terminals (for constrainSlide collision detection). */
  readonly edges: readonly BoundaryEdge[];
  /** Near terminal polygons (for the containment guard at t=0 / endpoints). */
  readonly candidates: readonly CandidateTerminal[];
  /** Near vertices that the dragged vertex could share with (for decideSnap). */
  readonly snapCandidates: readonly SnapCandidate[];
  /**
   * Inverse-containment constraint for a hole/enclave vertex of the dragged feature
   * (受け入れ基準6 第4項 / FR-89); absent for a plain outer-ring / line / point vertex.
   */
  readonly containment?: ParentContainment;
}

/**
 * Everything the adapter needs from the rest of the app, injected so the wiring is
 * testable in plain Node and no domain rule is re-implemented here.
 */
export interface EditSessionAdapterDeps<S> {
  /** Convert a screen point to a world coordinate (U17 inverse transform). */
  readonly screenToWorld: (point: ScreenPoint) => WorldCoordinate;
  /** The ring a leaf vertex belongs to (leaf vertex drag only); undefined otherwise. */
  readonly ringIdForVertex?: (hit: Extract<HitResult, { kind: typeof HIT_KIND.Vertex }>) => RingId | undefined;
  /**
   * Mint the id RESERVED for the vertex an {@link EDIT_TOOL.EdgeAdd} gesture creates
   * (FR-87). Called ONCE per edge-handle press; the same id is inserted onto the edge at
   * confirm time (buildEditSnapshot → addVertexToLine / addVertexToLeafRing), so the
   * in-flight drag can treat it as the dragged vertex (snap / 共有化候補 like a vertex-
   * move). Injected so the adapter shares the composition root's single project-wide
   * minter (add / knife use the same one) and a freshly reserved id can never collide
   * with stored data (教訓 5.37). When absent, an edge hit begins NO session (an edge-add
   * cannot be honestly started without a reserved id — 教訓 5.7 no silent half-feature).
   */
  readonly nextVertexId?: () => VertexId;
  /**
   * Whether a feature-body hit should start a WHOLE-FEATURE move (受け入れ基準2 /
   * FR-88). A body hit only begins a {@link EDIT_TOOL.FeatureMove} session when this
   * returns true (typically: the body belongs to the active/selected feature and the
   * editing mode permits a move). When absent or false, a body hit is plain U22
   * selection only — `begin` returns false and no completion trigger is owed.
   */
  readonly featureMoveAllowed?: (
    hit: Extract<HitResult, { kind: typeof HIT_KIND.FeatureBody }>,
  ) => boolean;
  /** The anchor time the edit confirms at (FR-59). */
  readonly anchorTime: () => TimePoint;
  /** The current domain state to validate the release against. */
  readonly currentState: () => S;
  /** The U13 consistency ports (fixed-order pipeline, FR-61). */
  readonly ports: ConsistencyPorts<S, FeatureSnapshot>;
  /**
   * Build the complete after-state snapshot for the confirming release from the
   * live session (the moved vertex body / feature record). Owned by the host
   * because only it holds the feature + vertex store; the adapter supplies the
   * session so the snapshot reflects the final preview position AND the live snap
   * (so a surviving snap can become a share pair, 受け入れ基準12).
   */
  readonly buildSnapshot: (session: DragSession) => FeatureSnapshot;
  /**
   * Receive the U24 release outcome (no-op or processed) so the host can apply the
   * committed result (re-resolve selection from it, 教訓5.11) or surface a conflict
   * / rejection. Not called for a press that never started a session, nor for a
   * click that the wasDrag guard discarded (no confirm runs on a click).
   */
  readonly onReleased: (outcome: ReleaseOutcome<S>) => void;
  /**
   * Notified with the LIVE drag session on EVERY transition (HB3-4): the new session
   * on `begin` / each `update`, and `null` on `release` / `cancel` (the transient is
   * gone). The host holds it as transient render state and schedules a frame so the
   * dragged vertex / feature is drawn at its preview position and FOLLOWS the cursor
   * during the gesture — without this the committed geometry kept drawing at the press
   * position for the whole drag and then JUMPED to the new place on release (診断
   * HB3-4 / 教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」). It carries NO truth
   * (the commit still happens via {@link onReleased}); it is a pure transient mirror so
   * the render layer can show the in-flight move (受け入れ基準8 共有状態は触らない). A
   * press that never started a session (selection-only) is never previewed; a click
   * that the wasDrag guard discards ends with a `null` preview like any release.
   */
  readonly onPreview?: (session: DragSession | null) => void;

  // --- slide / snap LIGHT PATH deps (受け入れ基準6 / 12) ---------------------
  //
  // Optional: when all three are present, `update` runs the per-frame slide + snap
  // light path so the dragged preview is edge-constrained and a screen-proximity
  // snap candidate is carried into the session (and thence into confirmRelease's
  // share-pair decision). When absent, `update` is preview-only (the legacy path) —
  // the adapter never silently claims a slide/snap it cannot compute.

  /** Project a world coordinate to screen px (U17 forward transform, for decideSnap). */
  readonly worldToScreen?: WorldToScreen;
  /** The snap distance in screen px (U16 settings, FR-110). Non-positive ⇒ no snap. */
  readonly snapDistancePx?: () => number;
  /**
   * Query U10's spatial index for the near-candidate edge / terminal / vertex sets
   * around the current preview world position (the slide & snap inputs for one
   * frame). Called per move only when a session is live AND the dragged element is a
   * single vertex (feature-move has no single dragged vertex to slide / snap).
   */
  readonly neighboursAt?: (preview: WorldCoordinate, session: DragSession) => SlideSnapNeighbours;
}

/**
 * Build an {@link EditSessionPort} backed by U24's pure drag-session functions.
 * A VERTEX hit starts a vertex-move session (FR-88); a FEATURE-BODY hit on the
 * active feature starts a whole-feature move session (受け入れ基準2 / FR-88) when
 * {@link EditSessionAdapterDeps.featureMoveAllowed} permits; any other hit is a
 * plain U22 selection — `begin` returns false and no completion trigger is owed.
 * The single live session is held here as transient state and dropped on every
 * teardown path (教訓5.2).
 */
export function createEditSessionPort<S>(deps: EditSessionAdapterDeps<S>): EditSessionPort {
  // The single in-flight session (null = idle). 受け入れ基準9 全パス破棄: it is set
  // on begin and cleared on release / cancel — never left dangling.
  let session: DragSession | null = null;

  // HB3-4: notify the host of the live session on every transition so it can draw the
  // dragged geometry at its preview position (follows the cursor) and clear it on
  // teardown (release / cancel). A pure transient mirror — never the commit (教訓 5.7).
  function notifyPreview(): void {
    deps.onPreview?.(session);
  }

  function targetFromHit(hit: HitResult): DragTarget | null {
    if (hit.kind === HIT_KIND.Vertex) {
      const ringId = deps.ringIdForVertex?.(hit);
      return {
        tool: EDIT_TOOL.VertexMove,
        featureId: hit.featureId,
        vertexId: hit.vertexId,
        ...(ringId !== undefined ? { ringId } : {}),
      };
    }
    if (hit.kind === HIT_KIND.FeatureBody) {
      // A body hit on the active feature is a WHOLE-FEATURE move (受け入れ基準2 /
      // FR-88). Gated by the host so a body hit that is merely selecting (not on the
      // active feature, or move not permitted) stays plain U22 selection.
      if (deps.featureMoveAllowed?.(hit) === true) {
        return { tool: EDIT_TOOL.FeatureMove, featureId: hit.featureId };
      }
      return null;
    }
    if (hit.kind === HIT_KIND.Edge) {
      // An active-feature edge-midpoint hit begins an add-a-new-vertex drag (FR-87). We
      // RESERVE the new vertex id now (the SAME id inserted onto the edge at confirm
      // time, buildEditSnapshot → addVertexToLine / addVertexToLeafRing) so the in-flight
      // vertex can slide / snap / share exactly like a vertex-move (drag-session treats
      // it as the dragged vertex). Without a minter an edge-add cannot be honestly
      // started (no reserved id) — stay plain selection rather than claim a half edit.
      if (deps.nextVertexId === undefined) return null;
      const newVertexId = deps.nextVertexId();
      return {
        tool: EDIT_TOOL.EdgeAdd,
        featureId: hit.featureId,
        startVertexId: hit.startVertexId,
        endVertexId: hit.endVertexId,
        newVertexId,
        ...(hit.ringId !== undefined ? { ringId: hit.ringId } : {}),
      };
    }
    return null; // empty / unsupported → U22 selection only.
  }

  /**
   * Compute the slide / snap light path for one frame (受け入れ基準6 / 12), or fall
   * back to a preview-only update. Returns the next session. The slide/snap path is
   * taken only when the deps are injected AND the gesture drags a single vertex with
   * a known id (constrainSlide / decideSnap are vertex-relative; feature-move shifts
   * every vertex by one vector and has no single dragged point to slide / snap).
   */
  function applyMove(live: DragSession, preview: WorldCoordinate): DragSession {
    const canSlideSnap =
      deps.neighboursAt !== undefined &&
      deps.worldToScreen !== undefined &&
      deps.snapDistancePx !== undefined &&
      live.draggedVertexId !== undefined;

    if (!canSlideSnap) {
      // Light per-frame preview update only (教訓5.22: no shared-state mutation).
      return updateDrag(live, { preview });
    }

    const neighbours = deps.neighboursAt!(preview, live);
    // Edge slide: constrain the raw preview against near boundaries (FR-28 / FR-89).
    const slid = constrainSlide({
      start: live.start,
      target: preview,
      edges: neighbours.edges,
      candidates: neighbours.candidates,
      ...(neighbours.containment !== undefined ? { containment: neighbours.containment } : {}),
    });
    // Screen-proximity snap on the CONSTRAINED position (FR-31): the dragged vertex
    // itself is excluded so it never snaps to its own pre-move id.
    const snap: SnapDecision | null = decideSnap({
      draggedPosition: slid.position,
      candidates: neighbours.snapCandidates,
      snapDistancePx: deps.snapDistancePx!(),
      toScreen: deps.worldToScreen!,
      exclude: new Set([live.draggedVertexId!]),
    });
    return updateDrag(live, {
      preview: slid.position,
      slide: { boundaries: slid.boundaries, collided: slid.collided },
      snap,
    });
  }

  return {
    begin(hit: HitResult, point: ScreenPoint): boolean {
      const target = targetFromHit(hit);
      if (target === null) {
        session = null;
        return false;
      }
      session = beginDrag(target, deps.screenToWorld(point));
      notifyPreview(); // HB3-4: open the transient preview at the press position.
      return true;
    },

    update(point: ScreenPoint): void {
      if (session === null) return; // no live session (a selection-only press).
      session = applyMove(session, deps.screenToWorld(point));
      notifyPreview(); // HB3-4: the geometry follows the cursor this frame.
    },

    release(point: ScreenPoint, wasDrag: boolean): void {
      if (session === null) return;
      // SINGLE click/drag verdict (教訓5.30): the dispatcher already decided this
      // gesture against DRAG_THRESHOLD_PX. A click (wasDrag === false) is NOT a
      // geometry edit — discard WITHOUT confirming so a 1–3px sub-threshold jitter,
      // which quantizes to a non-zero world delta, can never commit a ghost edit /
      // ghost undo (受け入れ基準9 / 教訓5.24). Only a real drag reaches confirmRelease.
      if (!wasDrag) {
        session = discardDrag(); // 全経路破棄 (教訓5.2) — click leaves no transient.
        notifyPreview(); // HB3-4: clear any preview the press opened (null).
        return;
      }
      // Land the final sample on the slide/snap light path, then run THE completion
      // trigger (受け入れ基準9 / 教訓5.7): confirmRelease assembles the proposal and
      // drives U13. confirmRelease's own no-op guard (a drag back to start) still
      // applies, but a click never gets this far.
      session = applyMove(session, deps.screenToWorld(point));
      const outcome = confirmRelease<S>({
        session,
        anchorTime: deps.anchorTime(),
        snapshot: deps.buildSnapshot(session),
        current: deps.currentState(),
        ports: deps.ports,
      });
      // HB3-4: clear the live preview BEFORE applying the committed outcome, so the
      // host stops drawing the transient and the committed geometry (now updated by
      // onReleased → recordCommit) is what draws next — no double-draw, no jump.
      session = discardDrag(); // 全経路破棄 (教訓5.2).
      notifyPreview(); // preview is gone (null).
      deps.onReleased(outcome);
    },

    cancel(): void {
      session = discardDrag(); // drop the transient, run no confirm (教訓5.2).
      notifyPreview(); // HB3-4: clear the preview (null) on abandon / mode switch.
    },
  };
}
