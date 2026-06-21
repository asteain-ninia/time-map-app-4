// U28 — the 所属変更 (reparent / affiliation-change) INTEGRATION component (FR-46〜FR-49 /
// FR-94, 教訓 5.2 / 5.7 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the spec's 実装方針 demands and the integration lens
// flagged as MISSING for 所属変更: the pure {@link useReparentTool} hook + the whole
// src/domain/affiliation core (buildAffiliationProposal / allowedParentCandidates /
// decision / command) were unit-tested but UNREACHABLE — the 所属変更 toolbar tool armed
// (aria-pressed toggled) yet performed NO action because no UI consumed the domain logic
// (bughunt3: reparent-dead-button — selecting a nested face then clicking a different
// ancestor did nothing; feature count stayed stable, no reparent occurred). This
// component is that call site. It binds to the single-truth session store (U16), and:
//   - arms / discards a reparent session from the toolbar tool + mode (教訓 5.2 全経路):
//     selecting `edit.reparent` in 編集モード starts; leaving the tool / mode funnels
//     through `resetForSwitch` so no transient selection leaks;
//   - turns map-input LEFT clicks into picks (featureAtPoint → pick): the first click
//     chooses the target, the second the new上位領域, reusing the SAME drawn-area
//     hit-test the renderer / main hit-test / knife / merge use (単一真実源, 教訓 5.29);
//   - wires the confirm trigger to the hook (教訓 5.7); 確定 assembles the proposal
//     (buildAffiliationProposal) and runs U13 (FR-94);
//   - wires Escape→cancel (FR-78);
//   - forwards the camera-only raw events (wheel + non-left pointer) to the live map
//     dispatcher so pan / zoom keep working while selecting (mirrors the merge bridge).
//
// The component holds NO domain truth and writes the store ONLY through the host-supplied
// `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { AffiliationSnapshot } from '../../domain/editing/apply-proposal';

import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import { REPARENT_STRINGS } from './strings';
import {
  REPARENT_FLOW,
  useReparentTool,
  type ResolveAnchorTime,
  type ResolveFeatures,
  type StartAffiliationProcess,
} from './useReparentTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** Pointer client-coords → world (U17, same renderer inverse the click path uses). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Feature id under a world point (host drawn-area hit-test). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

export interface ReparentToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U13 process-start adapter (host-bound; createLiveAffiliationBinding). */
  readonly startProcess: StartAffiliationProcess<S>;
  /** The features effective at the reparent anchor time (live-lookup). */
  readonly resolveFeatures: ResolveFeatures;
  /** The anchor time the reparent confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test). */
  readonly featureAtPoint: FeatureAtPoint;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the target. */
  readonly onCommitted?:
    | ((result: ProcessResult<S>, snapshot: AffiliationSnapshot) => void)
    | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<AffiliationSnapshot>) => void)
    | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function ReparentToolController<S>(
  props: ReparentToolControllerProps<S>,
): JSX.Element | null {
  const { store, startProcess, resolveFeatures, anchorTime, screenToWorld, featureAtPoint, onConflicts } =
    props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const reparent = useReparentTool<S>({
    resolveFeatures,
    anchorTime,
    startProcess,
    onCommitted,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the reparent tool is "active" iff edit.reparent is the
  // tool in 編集モード. When that CHANGES, funnel through start / resetForSwitch so no
  // transient selection leaks across the transition. One effect keyed on the boolean.
  const isReparentActive =
    mode === EDIT_MODE.Edit && activeTool === TOOL_ID.EditReparent;
  const prevActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (isReparentActive === prev) return;
    prevActiveRef.current = isReparentActive;
    if (isReparentActive) {
      reparent.start();
    } else {
      reparent.resetForSwitch();
    }
    // Key on the active boolean only (start/reset fire exactly on a transition).
  }, [isReparentActive]);

  // --- Keyboard: Escape→cancel (FR-78). Active while a session runs.
  useEffect(() => {
    if (reparent.flow === REPARENT_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        reparent.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reparent.flow, reparent.cancel]);

  // --- Map-input handler: a LEFT click resolves the feature under it and feeds it to
  // the hook (first = target, second = new parent). The overlay never steals other
  // input — the input layer sits above the map and forwards here only while a session
  // runs.
  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const world = screenToWorld(e.clientX, e.clientY);
      const fid = featureAtPoint(world);
      if (fid !== null) reparent.pick(fid);
    },
    [reparent, screenToWorld, featureAtPoint],
  );

  // --- Camera passthrough (mirrors the merge bridge): forward wheel + non-left pointer
  // events to the live dispatcher so pan / zoom keep working while selecting.
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = pick (handled by onMapPointerDown)
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

  if (reparent.flow === REPARENT_FLOW.Idle) return null;

  return (
    <div className="reparent-tool" data-testid="reparent-tool" data-flow={reparent.flow}>
      {/* The transparent map-input bridge mounted while selecting (教訓 5.14): forwards
          LEFT clicks to the hook (pick) AND camera-only events to the live dispatcher
          (pan / zoom keep working). */}
      <ReparentInputBridge
        onMapPointerDown={onMapPointerDown}
        onMapWheel={onMapWheel}
        onMapCameraPointerDown={onMapCameraPointerDown}
        onMapCameraPointerMove={onMapCameraPointerMove}
        onMapCameraPointerUp={onMapCameraPointerUp}
        onMapCameraPointerCancel={onMapCameraPointerCancel}
      />

      <p className="reparent-tool__guide" data-testid="reparent-guide" role="status">
        {reparent.guide}
      </p>

      {reparent.message !== null && (
        <p className="reparent-tool__message" data-testid="reparent-message" role="alert">
          {reparent.message}
        </p>
      )}

      <div className="reparent-tool__controls" data-testid="reparent-controls">
        <button
          type="button"
          data-testid="reparent-confirm"
          disabled={!reparent.canConfirm}
          onClick={() => reparent.confirm()}
        >
          {REPARENT_STRINGS.confirm}
        </button>
        <button
          type="button"
          data-testid="reparent-clear"
          disabled={reparent.targetId === null}
          onClick={() => reparent.clearSelection()}
        >
          {REPARENT_STRINGS.clear}
        </button>
        <button type="button" data-testid="reparent-cancel" onClick={() => reparent.cancel()}>
          {REPARENT_STRINGS.cancel}
        </button>
        {/* Live selection markers for integration tests. */}
        <span data-testid="reparent-target" hidden>
          {reparent.targetId === null ? '' : String(reparent.targetId)}
        </span>
        <span data-testid="reparent-parent" hidden>
          {reparent.newParentId === null ? '' : String(reparent.newParentId)}
        </span>
      </div>
    </div>
  );
}

/**
 * The transparent map-input bridge mounted while selecting (教訓 5.14). It forwards
 * LEFT-button presses to the reparent hook (pick) via a React handler, AND forwards the
 * camera-only events (wheel + non-left pointer) to the live map dispatcher.
 *
 * The wheel + pointer listeners are attached NATIVELY through a ref because React
 * registers `onWheel` as a PASSIVE root listener, so a React handler cannot
 * `preventDefault()` the page scroll — the host's own map listener uses
 * `{ passive: false }` for the same reason, and we mirror it so a notch zooms instead
 * of scrolling. (Mirrors MergeInputBridge — kept per-controller because the pick
 * forwarding differs, 教訓 5.30 過剰共有の戒め.)
 */
function ReparentInputBridge(props: {
  readonly onMapPointerDown: (e: { clientX: number; clientY: number; button?: number }) => void;
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
      onMapWheel({ clientX: e.clientX, clientY: e.clientY, deltaY: e.deltaY, deltaMode: e.deltaMode });
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
      className="reparent-tool__input"
      data-testid="reparent-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
    />
  );
}
