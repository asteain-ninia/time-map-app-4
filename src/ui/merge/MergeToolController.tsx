// U30 — the merge-tool (合体 / 結合) INTEGRATION component (FR-50 / FR-52 / FR-94,
// 教訓 5.2 / 5.7 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the spec's 実装方針 demands and the integration
// lens flagged as MISSING for merge: the pure {@link useMergeTool} hook + the whole
// src/domain/merge core (buildMergeProposal / MergeProposal / precondition / decision /
// command) were unit-tested but UNREACHABLE — the 結合 toolbar tool armed (aria-pressed
// toggled) yet performed NO action because no UI consumed the domain logic (bughunt3:
// merge-no-reduction — clicking two adjacent split-siblings left the feature count
// unchanged). This component is that call site. It binds to the single-truth session
// store (U16), and:
//   - arms / discards a merge session from the toolbar tool + mode (教訓 5.2 全経路):
//     selecting `edit.merge` in 編集モード starts; leaving the tool / mode funnels through
//     `resetForSwitch` so no transient target set leaks;
//   - turns map-input LEFT clicks into target toggles (featureAtPoint → toggleTarget),
//     reusing the SAME drawn-area hit-test the renderer / main hit-test / knife use
//     (単一真実源, 教訓 5.29);
//   - wires the confirm trigger to the hook (教訓 5.7); 確定 assembles the proposal
//     (buildMergeProposal) and runs U13 (FR-94);
//   - wires Escape→cancel (FR-78);
//   - forwards the camera-only raw events (wheel + non-left pointer) to the live map
//     dispatcher so pan / zoom keep working while selecting (mirrors the knife bridge).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { MergeSnapshot, MergeIdPorts } from '../../domain/merge/index';

import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';

import { MERGE_STRINGS } from './strings';
import {
  MERGE_FLOW,
  useMergeTool,
  type ResolveAnchorTime,
  type ResolveFeatures,
  type ResolveVertexStore,
  type StartMergeProcess,
} from './useMergeTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** Pointer client-coords → world (U17, same renderer inverse the click path uses). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Feature id under a world point (host drawn-area hit-test). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

export interface MergeToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U13 process-start adapter (host-bound; createLiveMergeBinding). */
  readonly startProcess: StartMergeProcess<S>;
  /** Injected id minting (NFR 5.8; shared minter so ids never collide). */
  readonly ids: MergeIdPorts;
  /** The features effective at the merge anchor time (live-lookup). */
  readonly resolveFeatures: ResolveFeatures;
  /** The vertex store effective at the merge anchor time (live-lookup). */
  readonly resolveStore: ResolveVertexStore;
  /** The anchor time the merge confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test). */
  readonly featureAtPoint: FeatureAtPoint;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the result. */
  readonly onCommitted?: ((result: ProcessResult<S>, snapshot: MergeSnapshot) => void) | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<MergeSnapshot>) => void)
    | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function MergeToolController<S>(props: MergeToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    resolveFeatures,
    resolveStore,
    anchorTime,
    screenToWorld,
    featureAtPoint,
    onConflicts,
  } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  const merge = useMergeTool<S>({
    resolveFeatures,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the merge tool is "active" iff edit.merge is the tool in
  // 編集モード. When that CHANGES, funnel through start / resetForSwitch so no transient
  // target set leaks across the transition. One effect keyed on the boolean.
  const isMergeActive = mode === EDIT_MODE.Edit && activeTool === TOOL_ID.EditMerge;
  const prevActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (isMergeActive === prev) return;
    prevActiveRef.current = isMergeActive;
    if (isMergeActive) {
      merge.start();
    } else {
      merge.resetForSwitch();
    }
    // Key on the active boolean only (start/reset fire exactly on a transition).
  }, [isMergeActive]);

  // --- Keyboard: Escape→cancel (FR-78). Active while a session runs.
  useEffect(() => {
    if (merge.flow === MERGE_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        merge.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [merge.flow, merge.cancel]);

  // --- Map-input handler: a LEFT click resolves the feature under it and toggles it
  // into / out of the target set. The overlay never steals other input — the input
  // layer sits above the map and forwards here only while a merge session runs.
  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const world = screenToWorld(e.clientX, e.clientY);
      const fid = featureAtPoint(world);
      if (fid !== null) merge.toggleTarget(fid);
    },
    [merge, screenToWorld, featureAtPoint],
  );

  // --- Camera passthrough (mirrors the knife bridge): forward wheel + non-left
  // pointer events to the live dispatcher so pan / zoom keep working while selecting.
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = target toggle (handled by onMapPointerDown)
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

  if (merge.flow === MERGE_FLOW.Idle) return null;

  return (
    <div className="merge-tool" data-testid="merge-tool" data-flow={merge.flow}>
      {/* The transparent map-input bridge mounted while selecting (教訓 5.14): forwards
          LEFT clicks to the hook (target toggle) AND camera-only events to the live
          dispatcher (pan / zoom keep working). */}
      <MergeInputBridge
        onMapPointerDown={onMapPointerDown}
        onMapWheel={onMapWheel}
        onMapCameraPointerDown={onMapCameraPointerDown}
        onMapCameraPointerMove={onMapCameraPointerMove}
        onMapCameraPointerUp={onMapCameraPointerUp}
        onMapCameraPointerCancel={onMapCameraPointerCancel}
      />

      <p className="merge-tool__guide" data-testid="merge-guide" role="status">
        {merge.guide}
      </p>

      {merge.message !== null && (
        <p className="merge-tool__message" data-testid="merge-message" role="alert">
          {merge.message}
        </p>
      )}

      <div className="merge-tool__controls" data-testid="merge-controls">
        <button
          type="button"
          data-testid="merge-confirm"
          disabled={!merge.canConfirm}
          onClick={() => merge.confirm()}
        >
          {MERGE_STRINGS.confirm}
        </button>
        <button
          type="button"
          data-testid="merge-clear"
          disabled={merge.targetIds.length === 0}
          onClick={() => merge.clearTargets()}
        >
          {MERGE_STRINGS.clear}
        </button>
        <button type="button" data-testid="merge-cancel" onClick={() => merge.cancel()}>
          {MERGE_STRINGS.cancel}
        </button>
        {/* Live target count for integration tests. */}
        <span data-testid="merge-target-count" hidden>
          {merge.targetIds.length}
        </span>
      </div>
    </div>
  );
}

/**
 * The transparent map-input bridge mounted while selecting (教訓 5.14). It forwards
 * LEFT-button presses to the merge hook (target toggle) via a React handler, AND
 * forwards the camera-only events (wheel + non-left pointer) to the live map dispatcher.
 *
 * The wheel + pointer listeners are attached NATIVELY through a ref because React
 * registers `onWheel` as a PASSIVE root listener, so a React handler cannot
 * `preventDefault()` the page scroll — the host's own map listener uses
 * `{ passive: false }` for the same reason, and we mirror it so a notch zooms instead
 * of scrolling. (Mirrors KnifeInputBridge — kept per-controller because the LEFT-button
 * forwarding differs, 教訓 5.30 過剰共有の戒め.)
 */
function MergeInputBridge(props: {
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
      className="merge-tool__input"
      data-testid="merge-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
    />
  );
}
