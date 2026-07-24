// U25 — the ring-edit (穴 / 飛び地 の追加・削除) INTEGRATION component (FR-22 / FR-24 /
// FR-94, 教訓 5.2 / 5.7 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the integration lens flags: the pure U25 domain
// (auto-mode / draft / commands / confirm) + the pure {@link useRingEditTool} hook +
// the {@link buildRingEditPrimitives} render batch are UNREACHABLE until the UI calls
// them. This component is that call site — the消費する ui コンシューマ. It binds to the
// single-truth session store (U16), and:
//   - arms / discards a ring-edit session from the toolbar tool + mode (教訓 5.2 全経路):
//     selecting `edit.ring` in 編集モード starts; leaving the tool / mode funnels through
//     `resetForSwitch` so no一時状態 leaks;
//   - turns map-input LEFT clicks into target-face selection / vertex placement (add) or
//     ring hit-test deletion (delete), with the controller owning `featureAtPoint`
//     (教訓 5.14) exactly as the knife/merge controllers do;
//   - wires every COMPLETE trigger (confirm add / click-delete) to the hook (教訓 5.7);
//     確定 assembles the snapshot and runs U24 → U13 through the injected startProcess;
//   - wires Escape→cancel and Ctrl+Z→undo vertex (FR-78);
//   - feeds `buildRingEditPrimitives(draft)` to the injected render sink on every draft
//     change so the overlay / markers / preview / closing line are drawn (FR-22); an
//     idle draft yields [] so the overlay self-clears (教訓 5.2).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { FeatureSnapshot } from '../../domain/editing/index';
import type { RingIdPorts } from '../../domain/ring-edit/index';
import { coerceGridSpacing } from '../../domain/basemap/grid';

import { buildRingEditPrimitives, type RingEditStyle } from '../../render/ring-edit-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';

import { RING_EDIT_STRINGS } from './strings';
import {
  RING_EDIT_FLOW,
  RING_EDIT_SUBMODE,
  useRingEditTool,
  type ResolveAnchorTime,
  type ResolveCurrent,
  type ResolveFeature,
  type ResolveVertexStore,
  type StartRingEditProcess,
} from './useRingEditTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** The render sink the provisional ring-edit primitives are pushed into (U17). It
 * shares the renderer's single tool-overlay slot (like the knife/merge sinks). */
export interface RingEditDrawSink {
  drawRingEdit(primitives: readonly DrawPrimitive[]): void;
}

/** A no-op draw sink (for hosts / tests that have not mounted a renderer yet). */
export const NO_RING_EDIT_DRAW_SINK: RingEditDrawSink = {
  drawRingEdit() {
    /* nothing to draw into yet */
  },
};

/** Convert a pointer event's client position to a world coordinate (U17). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Resolve the feature id under a click (host hit-test; U22/U10). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

export interface RingEditToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U24→U13 confirm adapter (host-bound; createLiveEditBinding + confirmRingEdit). */
  readonly startProcess: StartRingEditProcess<S>;
  /** Injected id minting (NFR 5.8; shared minter so ids never collide). */
  readonly ids: RingIdPorts;
  /** Resolve a clicked feature id → domain Feature (LEAF gate is in the hook). */
  readonly resolveFeature: ResolveFeature;
  /** Resolve the live vertex store for geometry. */
  readonly resolveStore: ResolveVertexStore;
  /** The anchor time the ring edit confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** The current domain state the U13 pipeline validates against (live-lookup). */
  readonly current: ResolveCurrent<S>;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test, individual leaf). */
  readonly featureAtPoint: FeatureAtPoint;
  /** The provisional ring-edit render sink (U17). Defaults to a no-op. */
  readonly drawSink?: RingEditDrawSink | undefined;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection. */
  readonly onCommitted?:
    | ((result: ProcessResult<S>, snapshot: FeatureSnapshot) => void)
    | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<FeatureSnapshot>) => void)
    | undefined;
  /**
   * Report whether a ring-edit session is in progress (教訓 c1e5534). The host raises
   * the global-shortcut suspension while this is true so the controller's OWN Ctrl+Z
   * (undo vertex, FR-78) is the only handler (no double undo) AND a stray global Delete
   * cannot hit the target face while a ring-delete is in progress (H1). Fires `true`
   * whenever the flow is past Idle, `false` on return to Idle.
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
  /** Provisional draw style override. */
  readonly style?: RingEditStyle | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function RingEditToolController<S>(
  props: RingEditToolControllerProps<S>,
): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    resolveFeature,
    resolveStore,
    anchorTime,
    current,
    screenToWorld,
    featureAtPoint,
    onConflicts,
    style,
  } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;
  const drawSink = props.drawSink ?? NO_RING_EDIT_DRAW_SINK;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);
  // FR-78 グリッドスナップ: the project grid spacing, read + coerced from the SAME
  // project setting the add tool reads (単一の真実源), so an add-hole vertex snaps to
  // the identical graticule an add-tool vertex would (mirrors AddToolController).
  const gridSpacingRaw = useStore(store, (s) => s.projectSettings.gridSpacingDeg);
  const gridSpacing = coerceGridSpacing(gridSpacingRaw);

  const promoteTargetSelection = useCallback(
    (fid: FeatureId) => store.getState().setActiveFeature(fid),
    [store],
  );
  // CANCEL = leave the tool (Escape / キャンセル). Un-promoting the target alone left the
  // toolbar button `aria-pressed=true` while the session was disarmed, so pressing the
  // SAME button again ran the store's press-toggle (tool → null) instead of re-arming —
  // the tool could only be revived by detouring through another tool. Releasing
  // `activeTool` here keeps the toolbar's pressed state and the session's armed state
  // ONE truth (教訓 5.2 全経路で破棄 + 単一の真実源), so the next press always re-arms.
  // `setActiveTool(null)` runs the store's own selection reset契約, which subsumes the
  // target un-promotion.
  const releaseToolOnCancel = useCallback(() => {
    store.getState().setActiveTool(null);
  }, [store]);

  const ring = useRingEditTool<S>({
    resolveFeature,
    resolveStore,
    anchorTime,
    current,
    ids,
    gridSpacing,
    startProcess,
    onCommitted,
    onTargetSelected: promoteTargetSelection,
    onCancelled: releaseToolOnCancel,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the ring-edit tool is "active" iff edit.ring is the tool
  // in 編集モード. When that CHANGES, funnel through start / resetForSwitch so no
  // transient draft leaks across the transition. One effect keyed on the boolean.
  const isRingActive = mode === EDIT_MODE.Edit && activeTool === TOOL_ID.EditRing;
  const prevActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (isRingActive === prev) return;
    prevActiveRef.current = isRingActive;
    if (isRingActive) {
      ring.start();
    } else {
      ring.resetForSwitch();
    }
    // Key on the active boolean only (start/reset fire exactly on a transition).
  }, [isRingActive]);

  // --- Feed the provisional ring-edit primitives to the render sink on every draft
  // change (FR-22). An idle draft yields [] so the overlay vanishes on reset (教訓 5.2).
  useEffect(() => {
    drawSink.drawRingEdit(buildRingEditPrimitives(ring.draft, style));
  }, [ring.draft, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo vertex (FR-78). Active while a session runs.
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (ring.flow === RING_EDIT_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        ring.cancel();
        return;
      }
      if (
        ring.draft !== null &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        ring.undoLastVertex();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ring.flow, ring.draft, ring.cancel, ring.undoLastVertex]);

  // --- Report the in-progress ring-edit to the host so it suspends the GLOBAL shortcut
  // dispatcher (教訓 c1e5534): the controller's OWN Ctrl+Z (undo vertex) is the only
  // handler (no double undo, H2) AND a stray global Delete cannot fire during a
  // ring-delete (H1). The flow is the single truth; we only mirror it up.
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    const active = ring.flow !== RING_EDIT_FLOW.Idle;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the dispatcher
    // suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [ring.flow, onDrawingChange]);

  // --- Map-input handler: a LEFT click resolves the feature under it and routes to the
  // hook (target select / vertex place / ring delete). The controller owns the hit-test
  // (教訓 5.14); the hook drives the state machine.
  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const world = screenToWorld(e.clientX, e.clientY);
      ring.handleClick(world, featureAtPoint(world));
    },
    [ring, screenToWorld, featureAtPoint],
  );

  const onMapPointerMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      // Only meaningful while drafting; the hook ignores a preview with no draft.
      ring.updatePreview(screenToWorld(e.clientX, e.clientY));
    },
    [ring, screenToWorld],
  );

  // --- Camera passthrough (mirrors the knife bridge): forward wheel + non-left pointer
  // events to the live dispatcher so pan / zoom keep working while ring-editing.
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = ring-edit input (handled by onMapPointerDown)
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

  if (ring.flow === RING_EDIT_FLOW.Idle) return null;

  return (
    <div className="ring-edit-tool" data-testid="ring-edit-tool" data-flow={ring.flow}>
      {/* The transparent map-input bridge mounted while a session runs (教訓 5.14):
          forwards LEFT presses to the hook (target / vertex / ring input) AND
          camera-only events (wheel + non-left pointer) to the live dispatcher so
          中ボタンパン / ホイールズーム keep working. */}
      <RingEditInputBridge
        onMapPointerDown={onMapPointerDown}
        onMapPointerMove={onMapPointerMove}
        onMapWheel={onMapWheel}
        onMapCameraPointerDown={onMapCameraPointerDown}
        onMapCameraPointerMove={onMapCameraPointerMove}
        onMapCameraPointerUp={onMapCameraPointerUp}
        onMapCameraPointerCancel={onMapCameraPointerCancel}
      />

      {/* The per-state Japanese guide (FR-92). */}
      <p className="ring-edit-tool__guide" data-testid="ring-edit-guide" role="status">
        {ring.guide}
      </p>

      {/* 判断用メッセージ (拒否理由) — kept until a meaningful event (教訓 5.12). */}
      {ring.message !== null && (
        <p className="ring-edit-tool__message" data-testid="ring-edit-message" role="alert">
          {ring.message}
        </p>
      )}

      <div className="ring-edit-tool__controls" data-testid="ring-edit-controls">
        <button
          type="button"
          data-testid="ring-edit-submode"
          onClick={() => ring.toggleSubMode()}
        >
          {ring.subMode === RING_EDIT_SUBMODE.Add
            ? RING_EDIT_STRINGS.switchToDelete
            : RING_EDIT_STRINGS.switchToAdd}
        </button>
        {ring.subMode === RING_EDIT_SUBMODE.Add && (
          <>
            <button
              type="button"
              data-testid="ring-edit-confirm"
              disabled={!ring.canConfirm}
              onClick={() => ring.confirm()}
            >
              {RING_EDIT_STRINGS.confirmRing}
            </button>
            <button
              type="button"
              data-testid="ring-edit-undo"
              disabled={ring.draft === null || ring.draft.vertices.length === 0}
              onClick={() => ring.undoLastVertex()}
            >
              {RING_EDIT_STRINGS.undoVertex}
            </button>
            <label className="ring-edit-tool__grid">
              <input
                type="checkbox"
                data-testid="ring-edit-gridsnap"
                /* The hook's toggle — NOT the draft's copy — is the state source: the
                   checkbox is live BEFORE a target face is picked (no draft yet) and
                   must not silently snap back to unchecked. The hook keeps the running
                   draft in sync with it (単一の真実源). */
                checked={ring.gridSnap}
                onChange={(e) => ring.setGridSnap(e.target.checked)}
              />
              {RING_EDIT_STRINGS.gridSnap}
            </label>
          </>
        )}
        <button type="button" data-testid="ring-edit-cancel" onClick={() => ring.cancel()}>
          {RING_EDIT_STRINGS.cancel}
        </button>
        {/* Live vertex count for integration tests. */}
        <span data-testid="ring-edit-vertex-count" hidden>
          {ring.draft?.vertices.length ?? 0}
        </span>
      </div>
    </div>
  );
}

/**
 * The transparent map-input bridge mounted while a ring-edit session runs (教訓 5.14).
 * It forwards LEFT presses + moves to the hook via React handlers, AND forwards the
 * camera-only events (wheel + non-left pointer) to the live map dispatcher through a
 * native ref (React registers `onWheel` as a PASSIVE root listener, so a React handler
 * cannot preventDefault the page scroll). Mirrors KnifeInputBridge — kept per-controller
 * because the LEFT-button forwarding differs (教訓 5.30 過剰共有の戒め).
 */
function RingEditInputBridge(props: {
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
      className="ring-edit-tool__input"
      data-testid="ring-edit-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
      onPointerMove={(e) => onMapPointerMove({ clientX: e.clientX, clientY: e.clientY })}
    />
  );
}
