// U27 — the drill-tool (穴あけによる新地物生成) INTEGRATION component (FR-45 / FR-92 /
// FR-94 / FR-97, 教訓 5.2 / 5.7 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the integration lens flags: the pure U27 domain
// (checkDrillable / drillRegion / assembleDrillProposal / toEditProposal) + the pure
// {@link useDrillTool} hook + the {@link buildDrillPrimitives} render batch are
// UNREACHABLE until the UI calls them (dead code — no UI referenced domain/drill). This
// component is that call site — the消費する ui コンシューマ. It binds to the single-truth
// session store (U16), and:
//   - arms / discards a drill session from the toolbar tool + mode (教訓 5.2 全経路):
//     selecting `edit.drill` in 編集モード starts; leaving the tool / mode funnels through
//     `resetForSwitch` so no一時状態 leaks;
//   - turns map-input LEFT clicks into target末端-face selection (first click) / region
//     vertex placement (subsequent clicks), the controller owning `featureAtPoint`
//     (教訓 5.14) exactly as the knife/ring-edit controllers do;
//   - wires the COMPLETE triggers (confirm region → 新地物プロパティ入力 → save) to the
//     hook (教訓 5.7); save runs drillRegion and drives U13 through the injected
//     startProcess (FR-94 — 原末端への穴形成 + 新地物 = ONE undo unit);
//   - wires Escape→cancel and Ctrl+Z→undo vertex (FR-78);
//   - feeds `buildDrillPrimitives(region, preview)` to the injected render sink on every
//     draft change so the region overlay / markers / preview / closing line are drawn
//     (FR-45); an empty region yields [] so the overlay self-clears (教訓 5.2);
//   - re-uses U23's AddPropertyForm for the新地物 basic属性 (showParent=false — the上位
//     領域は元末端から初期継承; FR-97 / 教訓 5.30).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { BasicAttributes, ColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { DrillIdPorts, DrillSnapshot } from '../../domain/drill/index';

import { buildDrillPrimitives, type DrillStyle } from '../../render/drill-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';

import { AddPropertyForm } from '../add/AddPropertyForm';
import type { AddProperties } from '../../domain/add/index';

import { DRILL_STRINGS } from './strings';
import {
  DRILL_FLOW,
  useDrillTool,
  type ResolveAnchorTime,
  type ResolveFeature,
  type ResolveVertexStore,
  type StartDrillProcess,
} from './useDrillTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** The render sink the provisional drill primitives are pushed into (U17). It shares
 * the renderer's single tool-overlay slot (like the knife/ring-edit sinks). */
export interface DrillDrawSink {
  drawDrill(primitives: readonly DrawPrimitive[]): void;
}

/** A no-op draw sink (for hosts / tests that have not mounted a renderer yet). */
export const NO_DRILL_DRAW_SINK: DrillDrawSink = {
  drawDrill() {
    /* nothing to draw into yet */
  },
};

/** Convert a pointer event's client position to a world coordinate (U17). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Resolve the feature id under a click (host hit-test; U22/U10). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

export interface DrillToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U27→U13 process-start adapter (host-bound; createLiveDrillBinding). */
  readonly startProcess: StartDrillProcess<S>;
  /** Injected id minting (NFR 5.8; shared minter so ids never collide). */
  readonly ids: DrillIdPorts;
  /** Resolve a clicked feature id → domain Feature (LEAF gate is in the hook). */
  readonly resolveFeature: ResolveFeature;
  /** Resolve the live vertex store for geometry. */
  readonly resolveStore: ResolveVertexStore;
  /** The anchor time the drill confirms at (= 現在選択時刻, 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test, individual leaf). */
  readonly featureAtPoint: FeatureAtPoint;
  /** The provisional drill render sink (U17). Defaults to a no-op. */
  readonly drawSink?: DrillDrawSink | undefined;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection. */
  readonly onCommitted?:
    | ((result: ProcessResult<S>, snapshot: DrillSnapshot) => void)
    | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<DrillSnapshot>) => void)
    | undefined;
  /**
   * Report whether a drill session is in progress (教訓 c1e5534). The host raises the
   * global-shortcut suspension while this is true so the controller's OWN Ctrl+Z (undo
   * vertex, FR-78) is the only handler (no double undo, H2) AND a stray global Delete
   * cannot hit the target末端 face while the region draft / property form (H1) is up.
   * Fires `true` whenever the flow is past Idle, `false` on return to Idle.
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
  /** A sensible color for the new feature when the form omits it (FR-97). */
  readonly defaultColor: ColorInfo;
  /** Provisional draw style override. */
  readonly style?: DrillStyle | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function DrillToolController<S>(props: DrillToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    resolveFeature,
    resolveStore,
    anchorTime,
    screenToWorld,
    featureAtPoint,
    onConflicts,
    defaultColor,
    style,
  } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;
  const drawSink = props.drawSink ?? NO_DRILL_DRAW_SINK;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  // Promote / un-promote the chosen target末端 through the SAME setActiveFeature path
  // every selection uses (no second selection source, 教訓 5.29), mirroring knife/ring.
  const promoteTargetSelection = useCallback(
    (fid: FeatureId) => store.getState().setActiveFeature(fid),
    [store],
  );
  const clearTargetSelection = useCallback(() => store.getState().clearSelection(), [store]);

  const drill = useDrillTool<S>({
    resolveFeature,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    onTargetSelected: promoteTargetSelection,
    onCancelled: clearTargetSelection,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄: the drill tool is "active" iff edit.drill is the tool in
  // 編集モード. When that CHANGES, funnel through start / resetForSwitch so no transient
  // draft leaks across the transition. One effect keyed on the boolean.
  const isDrillActive = mode === EDIT_MODE.Edit && activeTool === TOOL_ID.EditDrill;
  const prevActiveRef = useRef<boolean>(false);
  useEffect(() => {
    const prev = prevActiveRef.current;
    if (isDrillActive === prev) return;
    prevActiveRef.current = isDrillActive;
    if (isDrillActive) {
      drill.start();
    } else {
      drill.resetForSwitch();
    }
    // Key on the active boolean only (start/reset fire exactly on a transition).
  }, [isDrillActive]);

  // --- Feed the provisional drill primitives to the render sink on every draft change
  // (FR-45). An empty region yields [] so the overlay vanishes on reset (教訓 5.2).
  useEffect(() => {
    drawSink.drawDrill(
      buildDrillPrimitives({ region: drill.region, preview: drill.preview }, style),
    );
  }, [drill.region, drill.preview, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo vertex (FR-78). Active while a session runs.
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (drill.flow === DRILL_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        drill.cancel();
        return;
      }
      if (
        drill.flow === DRILL_FLOW.DrawingRegion &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        drill.undoLastVertex();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drill.flow, drill.cancel, drill.undoLastVertex]);

  // --- Report the in-progress drill to the host so it suspends the GLOBAL shortcut
  // dispatcher (教訓 c1e5534): the controller's OWN Ctrl+Z (undo vertex) is the only
  // handler (no double undo, H2) AND a stray global Delete cannot fire during a drill
  // (H1). The flow is the single truth; we only mirror it up.
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    const active = drill.flow !== DRILL_FLOW.Idle;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the dispatcher
    // suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [drill.flow, onDrawingChange]);

  // --- Map-input handler: a LEFT click resolves the feature under it and routes to the
  // hook (target末端 select / region vertex place). The controller owns the hit-test
  // (教訓 5.14); the hook drives the state machine.
  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const world = screenToWorld(e.clientX, e.clientY);
      drill.handleClick(world, featureAtPoint(world));
    },
    [drill, screenToWorld, featureAtPoint],
  );

  const onMapPointerMove = useCallback(
    (e: { clientX: number; clientY: number }) => {
      drill.updatePreview(screenToWorld(e.clientX, e.clientY));
    },
    [drill, screenToWorld],
  );

  // --- Camera passthrough (mirrors the ring-edit / knife bridge): forward wheel +
  // non-left pointer events to the live dispatcher so pan / zoom keep working while
  // drilling. The LEFT button is consumed by target / region input above.
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = drill input (handled by onMapPointerDown)
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

  if (drill.flow === DRILL_FLOW.Idle) return null;

  const drawing = drill.flow === DRILL_FLOW.SelectingTarget || drill.flow === DRILL_FLOW.DrawingRegion;
  const entering = drill.flow === DRILL_FLOW.EnteringProperties;

  return (
    <div className="drill-tool" data-testid="drill-tool" data-flow={drill.flow}>
      {/* The transparent map-input bridge mounted while selecting / drawing (教訓 5.14):
          forwards LEFT presses + moves to the hook (target / region input) AND camera-
          only events (wheel + non-left pointer) to the live dispatcher so 中ボタンパン /
          ホイールズーム keep working. Only up while drawing so it never steals input
          during the property form. */}
      {drawing && (
        <DrillInputBridge
          onMapPointerDown={onMapPointerDown}
          onMapPointerMove={onMapPointerMove}
          onMapWheel={onMapWheel}
          onMapCameraPointerDown={onMapCameraPointerDown}
          onMapCameraPointerMove={onMapCameraPointerMove}
          onMapCameraPointerUp={onMapCameraPointerUp}
          onMapCameraPointerCancel={onMapCameraPointerCancel}
        />
      )}

      {/* The per-state Japanese guide (FR-92). */}
      <p className="drill-tool__guide" data-testid="drill-guide" role="status">
        {drill.guide}
      </p>

      {/* 判断用メッセージ (妥当性検証拒否 / U13 reject) — kept until a meaningful event (教訓 5.12). */}
      {drill.message !== null && (
        <p className="drill-tool__message" data-testid="drill-message" role="alert">
          {drill.message}
        </p>
      )}

      {/* Region-draft controls: confirm region / undo vertex / cancel (教訓 5.7). */}
      {drawing && (
        <div className="drill-tool__controls" data-testid="drill-controls">
          <button
            type="button"
            data-testid="drill-confirm"
            disabled={!drill.canConfirm}
            onClick={() => drill.confirmRegion()}
          >
            {DRILL_STRINGS.confirmRegion}
          </button>
          <button
            type="button"
            data-testid="drill-undo"
            disabled={drill.region.length === 0}
            onClick={() => drill.undoLastVertex()}
          >
            {DRILL_STRINGS.undoVertex}
          </button>
          <button type="button" data-testid="drill-cancel" onClick={() => drill.cancel()}>
            {DRILL_STRINGS.cancel}
          </button>
          {/* Live region vertex count for integration tests. */}
          <span data-testid="drill-vertex-count" hidden>
            {drill.region.length}
          </span>
        </div>
      )}

      {/* 新地物プロパティ入力 — re-uses U23's add form (FR-97 / 教訓 5.30). The上位領域は
          元末端から初期継承 (proposal assembler), so the parent selector is hidden. */}
      {entering && (
        <NewFeatureForm
          defaultColor={defaultColor}
          onSave={(attributes, color) => drill.save({ attributes, color })}
          onCancel={() => drill.cancel()}
        />
      )}

      {drill.flow === DRILL_FLOW.ConflictPaused && (
        <p data-testid="drill-conflict-paused" role="status">
          {DRILL_STRINGS.conflictPaused}
        </p>
      )}

      {drill.flow === DRILL_FLOW.Rejected && drill.message !== null && (
        <div data-testid="drill-rejected">
          <p role="alert">{drill.message}</p>
          <button type="button" data-testid="drill-rejected-dismiss" onClick={() => drill.cancel()}>
            {DRILL_STRINGS.cancel}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * The transparent map-input bridge mounted while a drill session is selecting / drawing
 * (教訓 5.14). It forwards LEFT presses + moves to the hook (target / region input) via
 * React handlers, AND forwards the camera-only events (wheel + non-left pointer) to the
 * live map dispatcher through a native ref (React registers `onWheel` as a PASSIVE root
 * listener, so a React handler cannot preventDefault the page scroll). Kept per-controller
 * because the LEFT-button forwarding differs (教訓 5.30 過剰共有の戒め) — this bridge
 * mirrors the ring-edit shape (pointerdown + pointermove for the region draft), NOT the
 * knife固定円 shape.
 */
function DrillInputBridge(props: {
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
      className="drill-tool__input"
      data-testid="drill-input-layer"
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
      onPointerMove={(e) => onMapPointerMove({ clientX: e.clientX, clientY: e.clientY })}
    />
  );
}

// --- 新地物プロパティ入力 (re-uses U23's AddPropertyForm shape; FR-97) --------------
//
// The spec mandates RE-USING U23's面情報追加入力フロー for the新地物 (FR-97 / 教訓 5.30
// 過少共有). U23's AddPropertyForm emits `AddProperties` (attributes + color). The上位
// 領域は元末端から初期継承 (assembleDrillProposal, FR-45), so the parent selector is
// hidden (showParent=false) and its result is forwarded to `drill.save`.

function NewFeatureForm(props: {
  readonly defaultColor: ColorInfo;
  readonly onSave: (attributes: BasicAttributes, color: ColorInfo) => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const { onSave, onCancel } = props;
  return (
    <div className="drill-tool__props" data-testid="drill-props">
      <h3>{DRILL_STRINGS.newFeatureProps}</h3>
      <AddPropertyForm
        showParent={false}
        parentCandidates={[]}
        onChooseParent={() => {
          /* parent is inherited from the original末端 by the domain assembler (FR-45) */
        }}
        onSave={(p: AddProperties) => onSave(p.attributes, p.color)}
        onCancel={onCancel}
      />
    </div>
  );
}
