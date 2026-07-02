// U23 — the add-tool INTEGRATION component (FR-76 / FR-77 / FR-78, 教訓 5.2 / 5.7
// / 5.11 / 5.15).
//
// This is the layer-crossing wiring the spec's 実装方針「完了トリガーの明示配線」
// demands: the pure {@link useAddTool} hook + the pure {@link buildAddPrimitives}
// render-batch builder are USELESS until the UI actually calls them. This
// component is that call site. It binds to the single-truth session store (U16),
// and:
//   - starts / discards a session from the toolbar tool + mode (教訓 5.2 全経路):
//     a change of the active add-tool kind, leaving 追加モード, or clearing the
//     tool all funnel through the hook's `start` / `resetForSwitch`;
//   - turns map-input pointer events into `placeAt` (click) / `preview` (move),
//     converting screen→world through the injected transform port (U17);
//   - wires the line/face COMPLETE trigger (a button) and the property-form SAVE
//     trigger to the hook (教訓 5.7 完了トリガー);
//   - wires Escape→cancel and Ctrl+Z→undo (FR-78);
//   - feeds `buildAddPrimitives(session)` to the injected render sink on every
//     session change so the provisional shape is drawn (FR-78 仮表示).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import {
  ADD_TOOL_KIND,
  PARENT_TOP_LEVEL,
  parentSelection,
  type AddProperties,
  type AddProposal,
  type AddIdPorts,
  type AddToolKind,
  type ParentCandidate,
} from '../../domain/add/index';
import type { WorldCoordinate } from '../../domain/coordinate';
import { PROCESS_STATUS, type ProcessResult } from '../../domain/consistency/index';
import type { FeatureId, RingId } from '../../domain/ids';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';

import { coerceGridSpacing } from '../../domain/basemap/grid';
import { buildAddPrimitives, type AddStyle } from '../../render/add-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';

import { AddPropertyForm } from './AddPropertyForm';
import { ADD_STRINGS } from './strings';
import { addToolKindFor } from './tool-kind';
import { ADD_PHASE, useAddTool, type StartAddProcess } from './useAddTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/**
 * The render sink the provisional add primitives are pushed into. Backed by the
 * U17 `MapRenderer` (a thin closure over `drawBatch`) in the app, and by a spy
 * in tests. Kept minimal so the controller depends on a draw capability, not the
 * whole Canvas backend (受け入れ基準: render 接続 without coupling).
 */
export interface AddDrawSink {
  /** Draw (replace) the provisional add layer with these primitives (FR-78). */
  drawAdd(primitives: readonly DrawPrimitive[]): void;
}

/** Convert a pointer event's client position to a world coordinate (U17 transform). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

export interface AddToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** The U13 process-start adapter (host-bound; spec §依存 U13). */
  readonly startProcess: StartAddProcess<S>;
  /** Injected id minting (NFR 5.8). */
  readonly ids: AddIdPorts;
  /** Mint a fresh ring id (face only). */
  readonly nextRingId: () => RingId;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** The provisional-add render sink (U17). */
  readonly drawSink: AddDrawSink;
  /**
   * Forward the camera-only raw events (wheel + non-left pointer) from the add
   * input bridge to the live map dispatcher (bughunt: 追加描画中の中ボタンパン/
   * ホイールズーム). The bridge covers the whole map while drawing (教訓 5.14), so
   * without this the wheel / middle-button events it captures never reach the
   * dispatcher and 地図のパン/ズームが死ぬ. Optional: defaults to a no-op so a test
   * that mounts the controller without a renderer is unaffected.
   */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /**
   * Host commit handler (教訓 5.11): swap the new domain state in and re-resolve
   * selection from the new feature id. The controller forwards `applyCommandResult`
   * by default if the host omits this.
   */
  readonly onCommitted?:
    | ((result: ProcessResult<S>, newFeatureId: FeatureId) => void)
    | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?: ((result: ProcessResult<S>, proposal: AddProposal) => void) | undefined;
  /**
   * Report whether an add session is in progress (bughunt3). The host raises the
   * global-shortcut suspension while this is true so the controller's OWN Ctrl+Z
   * (vertex-undo, FR-78) is the only handler — the global EditUndo no longer also
   * fires (H2 二重undo). Fires `true` whenever the session is past Idle (Drawing /
   * PropertyForm / transient), `false` when it returns to Idle. The window keydown
   * listener for Ctrl+Z is registered only in Drawing, but suspending across the
   * whole non-Idle session also keeps a stray global Delete from hitting the active
   * feature while the add chrome owns the interaction (single-source boundary).
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
  /** Face parent candidates at the current time (FR-77); host-resolved (U10/U08). */
  readonly parentCandidates?: readonly ParentCandidate[] | undefined;
  /** Nearest existing-vertex proximity resolver (FR-31; U10/U24). */
  readonly resolveProximity?: AddToolControllerOptionalPorts['resolveProximity'];
  /** Whether a coordinate is inside a terminal feature (FR-29; U10). */
  readonly isInsideTerminal?: AddToolControllerOptionalPorts['isInsideTerminal'];
  /** Provisional draw style override (e.g. project theme). */
  readonly style?: AddStyle | undefined;
}

interface AddToolControllerOptionalPorts {
  readonly resolveProximity?:
    | ((raw: WorldCoordinate) => import('../../domain/add/index').ProximityCandidate | null)
    | undefined;
  readonly isInsideTerminal?: ((coordinate: WorldCoordinate) => boolean) | undefined;
}

/**
 * The add-tool controller. Mount it once inside the shell overlay; it renders the
 * provisional-add chrome (complete button / property form) and drives the whole
 * add interaction. It returns the map-input handlers the host wires onto the map
 * input layer (教訓 5.14 — the input layer owns pointer events).
 */
export function AddToolController<S>(props: AddToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    nextRingId,
    screenToWorld,
    drawSink,
    onConflicts,
    parentCandidates,
    resolveProximity,
    isInsideTerminal,
    style,
  } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  const currentTime = useStore(store, (s) => s.currentTime);
  const gridSpacingRaw = useStore(store, (s) => s.projectSettings.gridSpacingDeg);
  const gridSpacing = coerceGridSpacing(gridSpacingRaw);

  // The host commit handler: default to the store's own command-result path so
  // selection is re-resolved from the new feature id (教訓 5.11). The store write
  // stays the single path (単一の真実源). U13's committed result carries the new
  // state AND the single composite command; we replay the command against the
  // PRE-commit domain to derive the touched/created CommandResult, then swap in
  // the committed state and promote the new feature as the next active target.
  const onCommitted = useCallback(
    (result: ProcessResult<S>, newFeatureId: FeatureId) => {
      if (props.onCommitted) {
        props.onCommitted(result, newFeatureId);
        return;
      }
      if (result.status === PROCESS_STATUS.Committed) {
        const commandResult = result.command.execute(store.getState().domain).result;
        store.getState().applyCommandResult(result.state, commandResult, {
          featureId: newFeatureId,
        });
      }
    },
    [props, store],
  );

  const add = useAddTool<S>({
    currentTime,
    gridSpacing,
    ids,
    nextRingId,
    startProcess,
    onCommitted,
    onConflicts,
    ...(resolveProximity ? { resolveProximity } : {}),
    ...(isInsideTerminal ? { isInsideTerminal } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the active add-tool kind is derived from the toolbar
  // tool + the mode. When it CHANGES (tool switch / mode switch / clear), funnel
  // through start / resetForSwitch so no transient state leaks across the
  // transition. A single effect keyed on the resolved kind is the one place this
  // decision lives.
  const activeKind: AddToolKind | null =
    mode === EDIT_MODE.Add ? addToolKindFor(activeTool) : null;
  const prevKindRef = useRef<AddToolKind | null>(null);

  useEffect(() => {
    const prev = prevKindRef.current;
    if (activeKind === prev) return;
    prevKindRef.current = activeKind;
    if (activeKind === null) {
      // Left 追加モード or cleared the tool: discard the session (教訓 5.2 (d)/(e)).
      add.resetForSwitch();
    } else {
      // Entered / switched to an add tool: start a fresh session (start replaces
      // any 残存 — 教訓 5.2 (a) / (d)).
      add.start(activeKind);
    }
    // We key on the resolved kind only so the start/reset fires exactly on a kind
    // transition, never on every render (`add`'s callbacks are stable enough here).
  }, [activeKind]);

  // --- Re-arm after a commit (受け入れ基準 6「保存（確定）→ 再度追加開始」). A
  // successful save discards the session (教訓 5.2) but the add tool stays
  // selected, so the user is still in "adding面 mode" and expects a FRESH empty
  // session to draw the next feature. When the flow has returned to Idle with no
  // session yet an add tool is still active, start anew — the re-start clears any
  // 残存, so the next session begins with zero vertices.
  useEffect(() => {
    if (activeKind === null) return;
    if (add.phase === ADD_PHASE.Idle && add.session === null) {
      add.start(activeKind);
    }
  }, [activeKind, add.phase, add.session, add.start]);

  // --- 教訓 5.5: re-validate the chosen face parent when the candidate set changes
  // (a time change can drop a covering parent). Runs only while a session exists.
  useEffect(() => {
    if (add.session === null) return;
    if (parentCandidates === undefined) return;
    add.revalidateParentSelection(parentCandidates);
    // Keyed on the candidate set only: re-validation must run when the candidates
    // change (a time change), not on unrelated re-renders.
  }, [parentCandidates, add.session, add.revalidateParentSelection]);

  // --- Feed the provisional add primitives to the render sink on every session
  // change (FR-78 仮表示; the render layer subscribes to the session, not React's
  // re-render path, but the controller is the bridge that pushes the batch).
  useEffect(() => {
    drawSink.drawAdd(buildAddPrimitives(add.session, style));
  }, [add.session, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo (FR-78). Active only while drawing.
  useEffect(() => {
    if (add.phase !== ADD_PHASE.Drawing) return;
    const onKey = (e: KeyboardEvent) => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        add.cancel();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
        e.preventDefault();
        add.undo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [add.phase, add.cancel, add.undo]);

  // --- bughunt3 (H2): report the in-progress add to the host so it suspends the
  // GLOBAL shortcut dispatcher while this controller owns Ctrl+Z. The global
  // useShortcuts listener registers BEFORE this controller's (mount vs. phase-change),
  // so it would fire EditUndo FIRST and a tool-side stopImmediatePropagation could not
  // unwind it — suspending the global path entirely is the only robust fix (教訓 5.29
  // 単一真実源: the host derives shortcutsSuspended = modalOpen || toolDrawing). The
  // session phase here is that single truth; we only mirror it up (no duplicate state).
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    const drawing = add.phase !== ADD_PHASE.Idle;
    onDrawingChange(drawing);
    // On unmount, clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [add.phase, onDrawingChange]);

  // --- Map-input handlers the host wires onto the input layer (教訓 5.14). A click
  // places a vertex (placeAt); pointer move updates the cursor-follow preview.
  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (add.phase !== ADD_PHASE.Drawing) return;
      // Left button only (button 0 / unspecified in synthetic events).
      if (e.button !== undefined && e.button !== 0) return;
      add.placeAt(screenToWorld(e.clientX, e.clientY));
    },
    [add.phase, add.placeAt, screenToWorld],
  );

  const onMapPointerMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      if (add.phase !== ADD_PHASE.Drawing) return;
      add.preview(screenToWorld(e.clientX, e.clientY));
    },
    [add.phase, add.preview, screenToWorld],
  );

  // --- Camera passthrough (bughunt: 追加描画中の中ボタンパン/ホイールズーム). The input
  // bridge captures every pointer/wheel event over the map; forward the camera-only
  // ones (wheel + non-left pointer) to the live map dispatcher so 中ボタンパン /
  // ホイールズーム keep working while drawing. The LEFT button is consumed by
  // placeAt / preview above and is NOT forwarded — the dispatcher would ignore it
  // anyway (add-mode left is not a pan button), but we keep the surfaces cleanly
  // separated so the two paths can never both act on one press (教訓 5.9).
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = tool placement (handled by onMapPointerDown)
      mapCameraInput.pointerDown(e, e.clientX, e.clientY);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerMove = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerMove(e, e.clientX, e.clientY),
    [mapCameraInput],
  );
  const onMapCameraPointerUp = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerUp(e, e.clientX, e.clientY),
    [mapCameraInput],
  );
  const onMapCameraPointerCancel = useCallback(
    (e: PointerEvent) => mapCameraInput.pointerCancel(e.pointerId),
    [mapCameraInput],
  );

  // Render the provisional-add chrome (complete trigger + property form) plus the
  // transient map-input layer, which sits in the shell overlay ABOVE the map and
  // captures pointer events while an add is in progress (教訓 5.14): the input
  // layer forwards press→placeAt and move→preview, and is removed the moment the
  // session ends, so it never steals input outside an add.
  return (
    <AddToolChrome
      add={add}
      parentCandidates={parentCandidates ?? []}
      onMapPointerDown={onMapPointerDown}
      onMapPointerMove={onMapPointerMove}
      onMapWheel={onMapWheel}
      onMapCameraPointerDown={onMapCameraPointerDown}
      onMapCameraPointerMove={onMapCameraPointerMove}
      onMapCameraPointerUp={onMapCameraPointerUp}
      onMapCameraPointerCancel={onMapCameraPointerCancel}
    />
  );
}

// --- The provisional-add chrome (complete trigger + property form) -----------

interface AddToolChromeProps {
  readonly add: ReturnType<typeof useAddTool>;
  readonly parentCandidates: readonly ParentCandidate[];
  readonly onMapPointerDown: (e: { clientX: number; clientY: number; button?: number }) => void;
  readonly onMapPointerMove: (e: { clientX: number; clientY: number }) => void;
  /** Forward a wheel notch over the bridge to the camera (bughunt: 描画中のズーム). */
  readonly onMapWheel: (e: {
    clientX: number;
    clientY: number;
    deltaY: number;
    deltaMode: number;
  }) => void;
  /** Forward a non-left press over the bridge to the camera (描画中の中ボタンパン). */
  readonly onMapCameraPointerDown: (e: PointerEvent) => void;
  readonly onMapCameraPointerMove: (e: PointerEvent) => void;
  readonly onMapCameraPointerUp: (e: PointerEvent) => void;
  readonly onMapCameraPointerCancel: (e: PointerEvent) => void;
}

/**
 * The transparent map-input bridge mounted while drawing (教訓 5.14). It forwards
 * LEFT-button press / move to the add hook (placeAt / preview) via React handlers,
 * AND forwards the camera-only events (wheel + non-left pointer) to the live map
 * dispatcher (bughunt: 追加描画中の中ボタンパン/ホイールズーム).
 *
 * The wheel + pointer listeners are attached NATIVELY through a ref rather than as
 * React props because React registers `onWheel` as a PASSIVE root listener, so a
 * React handler cannot `preventDefault()` the page scroll — the host's own map
 * listener uses `{ passive: false }` for exactly this reason, and we mirror it so a
 * notch becomes a zoom, not a scroll. The native pointer listeners additionally let
 * a middle-button pan use the bridge's own `setPointerCapture` for the drag
 * (受け入れ基準 3 連続保証), which the camera port performs via `e.currentTarget`.
 */
function AddInputBridge(props: {
  readonly onMapPointerDown: (e: { clientX: number; clientY: number; button?: number }) => void;
  readonly onMapPointerMove: (e: { clientX: number; clientY: number }) => void;
  readonly onMapWheel: (e: {
    clientX: number;
    clientY: number;
    deltaY: number;
    deltaMode: number;
  }) => void;
  readonly onMapCameraPointerDown: (e: PointerEvent) => void;
  readonly onMapCameraPointerMove: (e: PointerEvent) => void;
  readonly onMapCameraPointerUp: (e: PointerEvent) => void;
  readonly onMapCameraPointerCancel: (e: PointerEvent) => void;
}): JSX.Element {
  const ref = useRef<HTMLDivElement | null>(null);
  const {
    onMapPointerDown,
    onMapPointerMove,
    onMapWheel,
    onMapCameraPointerDown,
    onMapCameraPointerMove,
    onMapCameraPointerUp,
    onMapCameraPointerCancel,
  } = props;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onWheel = (e: WheelEvent): void => {
      // Suppress page scroll so a notch zooms (mirrors the host's passive:false
      // wheel listener); then forward to the cursor-anchored zoom.
      e.preventDefault();
      onMapWheel({
        clientX: e.clientX,
        clientY: e.clientY,
        deltaY: e.deltaY,
        deltaMode: e.deltaMode,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('pointerdown', onMapCameraPointerDown);
    el.addEventListener('pointermove', onMapCameraPointerMove);
    el.addEventListener('pointerup', onMapCameraPointerUp);
    el.addEventListener('pointercancel', onMapCameraPointerCancel);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('pointerdown', onMapCameraPointerDown);
      el.removeEventListener('pointermove', onMapCameraPointerMove);
      el.removeEventListener('pointerup', onMapCameraPointerUp);
      el.removeEventListener('pointercancel', onMapCameraPointerCancel);
    };
  }, [
    onMapWheel,
    onMapCameraPointerDown,
    onMapCameraPointerMove,
    onMapCameraPointerUp,
    onMapCameraPointerCancel,
  ]);
  return (
    <div
      ref={ref}
      className="add-tool__input"
      data-testid="add-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
      onPointerMove={(e) => onMapPointerMove({ clientX: e.clientX, clientY: e.clientY })}
    />
  );
}

function AddToolChrome(props: AddToolChromeProps): JSX.Element | null {
  const { add, parentCandidates } = props;

  if (add.phase === ADD_PHASE.Idle || add.session === null) {
    return null;
  }

  const isFace = add.session.tool === ADD_TOOL_KIND.Face;
  const isLine = add.session.tool === ADD_TOOL_KIND.Line;

  return (
    <div className="add-tool" data-testid="add-tool" data-phase={add.phase}>
      {/* The map input bridge: a transparent layer that forwards pointer events
          to the hook. It sits in the overlay above the map (教訓 5.14) ONLY while
          an add is in progress, so it never steals input otherwise. It ALSO forwards
          the camera-only events (wheel + non-left pointer) to the live map dispatcher
          so 中ボタンパン / ホイールズーム keep working while drawing (bughunt). */}
      {add.phase === ADD_PHASE.Drawing && (
        <AddInputBridge
          onMapPointerDown={props.onMapPointerDown}
          onMapPointerMove={props.onMapPointerMove}
          onMapWheel={props.onMapWheel}
          onMapCameraPointerDown={props.onMapCameraPointerDown}
          onMapCameraPointerMove={props.onMapCameraPointerMove}
          onMapCameraPointerUp={props.onMapCameraPointerUp}
          onMapCameraPointerCancel={props.onMapCameraPointerCancel}
        />
      )}

      {/* COMPLETE trigger (line/face) — 教訓 5.7 完了トリガー. Point confirms on a
          single click, but we still expose complete for explicit confirmation. */}
      {add.phase === ADD_PHASE.Drawing && (
        <div className="add-tool__controls" data-testid="add-controls">
          <button
            type="button"
            data-testid="add-complete"
            disabled={!add.canComplete}
            onClick={() => add.completeShape()}
          >
            {isFace
              ? ADD_STRINGS.completeFace
              : isLine
                ? ADD_STRINGS.completeLine
                : ADD_STRINGS.completePoint}
          </button>
          <button
            type="button"
            data-testid="add-undo"
            disabled={add.session.vertices.length === 0}
            onClick={() => add.undo()}
          >
            {ADD_STRINGS.undoVertex}
          </button>
          <button type="button" data-testid="add-cancel" onClick={() => add.cancel()}>
            {ADD_STRINGS.cancel}
          </button>
          <label className="add-tool__grid">
            <input
              type="checkbox"
              data-testid="add-grid-snap"
              checked={add.session.gridSnap}
              onChange={(e) => add.toggleGridSnap(e.target.checked)}
            />
            {ADD_STRINGS.gridSnap}
          </label>
          {add.message !== null && (
            <p className="add-tool__message" data-testid="add-message" role="alert">
              {add.message}
            </p>
          )}
        </div>
      )}

      {/* SAVE trigger (property form) — 教訓 5.7 完了トリガー. */}
      {add.phase === ADD_PHASE.PropertyForm && (
        <AddPropertyForm
          showParent={isFace}
          parentCandidates={parentCandidates}
          onChooseParent={(featureId) =>
            add.chooseParent(featureId === null ? PARENT_TOP_LEVEL : parentSelection(featureId))
          }
          onSave={(properties: AddProperties) => add.save(properties)}
          onCancel={() => add.cancel()}
        />
      )}

      {add.phase === ADD_PHASE.ConflictPaused && (
        <p data-testid="add-conflict-paused" role="status">
          {ADD_STRINGS.conflictPaused}
        </p>
      )}

      {add.phase === ADD_PHASE.Rejected && add.message !== null && (
        <div data-testid="add-rejected">
          <p role="alert">{add.message}</p>
          <button type="button" data-testid="add-rejected-dismiss" onClick={() => add.cancel()}>
            {ADD_STRINGS.cancel}
          </button>
        </div>
      )}

      {/* Hidden marker used by integration tests to read the live vertex count. */}
      <span data-testid="add-vertex-count" hidden>
        {add.session.vertices.length}
      </span>
      {isLine && <span data-testid="add-is-line" hidden />}
    </div>
  );
}

// Re-export for callers that bind the input layer at the shell level.
export { useAddTool };

/** A no-op draw sink (for hosts that have not mounted a renderer yet). */
export const NO_DRAW_SINK: AddDrawSink = {
  drawAdd() {
    /* nothing to draw into yet */
  },
};

/** Build the default world-conversion port from a U17 renderer. Memo-friendly. */
export function useScreenToWorld(screenToWorld: ScreenToWorld): ScreenToWorld {
  return useMemo(() => screenToWorld, [screenToWorld]);
}
