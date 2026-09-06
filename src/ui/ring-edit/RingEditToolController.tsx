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

import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import type { OptionBarStore } from '../shell/option-bar';
import { useToolBarChrome } from '../shell/useToolBarChrome';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';

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
  /** オプションバー（設計書 §C.4）。確定の列はここへ出す（増分 5d / E-2）。 */
  readonly optionBar?: OptionBarStore | undefined;
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

  // **昇格させた対象を覚えておく**（増分 5 の手直し B1）。戻すときに「自分が昇格させた
  // ものかどうか」を見分けるために要る（下の {@link unpromoteOwnTarget} の注記）。
  const promotedTargetRef = useRef<FeatureId | null>(null);
  const promoteTargetSelection = useCallback(
    (fid: FeatureId) => {
      promotedTargetRef.current = fid;
      store.getState().setActiveFeature(fid);
    },
    [store],
  );

  // **自分が昇格させた対象だけを選択から戻す**（増分 5 の手直し B1 / GPT #8）。
  // 旧版は `clearSelection()` ―― 頂点の選択も、道具が触っていない地物の選択も、まとめて
  // 空にしていた。設計書 §D.4 の階段は「対象を離す」であって「選択を全部捨てる」ではない。
  const unpromoteOwnTarget = useCallback(() => {
    const promoted = promotedTargetRef.current;
    promotedTargetRef.current = null;
    if (promoted === null) return;
    const s = store.getState();
    if (s.activeFeature !== promoted) return;
    s.setActiveFeature(null);
  }, [store]);

  // CANCEL = leave the tool. **これは［やめる］を押されたときの経路だけである** ――
  // ボタンとして「やめる」を押したのは「この作業をやめる」という意思表示だから、道具ごと
  // 降りてよい。**Escape はここを通らない**（増分 5 の手直し B1 / 設計書 §D.4）: Escape は
  // 1 回で 1 段だけ戻る階段で、道具を降りるのは大域の `shell/escape-ladder.ts` の持ち場。
  //
  // Un-promoting the target alone left the toolbar button `aria-pressed=true` while the
  // session was disarmed, so pressing the SAME button again ran the store's press-toggle
  // (tool → null) instead of re-arming — the tool could only be revived by detouring
  // through another tool. Releasing `activeTool` here keeps the toolbar's pressed state
  // and the session's armed state ONE truth (教訓 5.2 全経路で破棄 + 単一の真実源).
  const releaseToolOnCancel = useCallback(() => {
    unpromoteOwnTarget();
    store.getState().setActiveTool(null);
  }, [unpromoteOwnTarget, store]);

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
        // --- Esc の階段（設計書 §D.4 / 増分 5 の手直し B1）--------------------
        //
        // **1 回の Escape で 1 段だけ**戻る。旧版は 1 回で「手順の対象」「元からの選択」
        // 「道具」の三段をまとめて捨てていた（GPT #8）。
        //
        //   1. 打った頂点列がある → **頂点列だけをまとめて捨てる**（面も道具も保つ）
        //   2. 対象の面を掴んでいる → 面だけ離す（道具は持ったまま）
        //   3. どちらも無い → **何もせず大域の階段へ譲る**（preventDefault もしない）
        //
        // 3 で止めないのが肝である ―― 大域の `shell/escape-ladder.ts` が「頂点を外す →
        // 地物の選択を外す → 道具を『選ぶ』へ戻す」を順にやる。ここで止めると、道具を
        // 構えているあいだ素の状態へ戻る道が無くなる。3 の局面では `onDrawingChange` も
        // false を報せている（対象が null なら名乗らない）ので、名乗りと段が食い違わない。
        if (ring.draft !== null && ring.draft.vertices.length > 0) {
          e.preventDefault();
          ring.discardDraftVertices();
          return;
        }
        if (ring.targetId !== null) {
          e.preventDefault();
          ring.releaseTarget();
          unpromoteOwnTarget();
          return;
        }
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
  }, [
    ring.flow,
    ring.draft,
    ring.targetId,
    ring.discardDraftVertices,
    ring.releaseTarget,
    ring.undoLastVertex,
    unpromoteOwnTarget,
  ]);

  // --- Report the in-progress ring-edit to the host so it suspends the GLOBAL shortcut
  // dispatcher (教訓 c1e5534): the controller's OWN Ctrl+Z (undo vertex) is the only
  // handler (no double undo, H2) AND a stray global Delete cannot fire during a
  // ring-delete (H1). The flow is the single truth; we only mirror it up.
  useEffect(() => {
    if (onDrawingChange === undefined) return;
    // **増分 5c: 「構えている」ではなく「下書きを持っている」を報せる**（設計書 §D.4 /
    // 実装計画 §5 の 5c「確定後のふるまいを全道具で揃える」）。
    //
    // 旧版は `flow !== Idle` ―― **道具を構えた瞬間から**真になっていた。ホストはこれを
    // 「鍵盤は道具のもの」と読んで大域の割り振りを降ろすので、**道具を選んだだけで
    // Ctrl+Z・Delete が効かなくなり**、確定した直後（対象を離したあと）も道具を外すまで
    // 戻らなかった（報告 04 §3.5 の「所属変更の確定直後の Ctrl+Z が無反応」）。
    //
    // 追加の道具は増分 3 の手直し D3 で既に「待機中は止めない」へ直っている。ここは
    // 手順のある道具に同じ形を入れる ―― **対象を掴んでいるあいだだけ**道具のもの。
    const active = ring.flow !== RING_EDIT_FLOW.Idle && ring.targetId !== null;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the dispatcher
    // suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [ring.flow, ring.targetId, onDrawingChange]);

  // --- Map-input handler: a LEFT click resolves the feature under it and routes to the
  // hook (target select / vertex place / ring delete). The controller owns the hit-test
  // (教訓 5.14); the hook drives the state machine.
  // --- 案内・断り・確定の列をオプションバーへ（増分 5d / 設計書 §C.4 / E-2 / N-27）---
  //
  // 確定欄は 176px ＝ U-8 の下限（幅 60px）で 2 つが限度なので、［確定］［やめる］だけを
  // 置き、残りは設定欄へ差し込む。**testid は 1 つも変えていない**（T-1）。
  const optionBar = props.optionBar;
  const ringAdding = ring.subMode === RING_EDIT_SUBMODE.Add;
  const ringCommit = useMemo(
    () => [
      ...(ringAdding
        ? [
            {
              id: 'confirm',
              testId: 'ring-edit-confirm',
              label: RING_EDIT_STRINGS.confirmRing,
              disabled: !ring.canConfirm,
              onClick: () => ring.confirm(),
            },
          ]
        : []),
      {
        id: 'cancel',
        testId: 'ring-edit-cancel',
        label: RING_EDIT_STRINGS.cancel,
        onClick: () => ring.cancel(),
      },
    ],
    // **同一性を安定させる**（増分 5 の手直し B3 の注記 7）。依存に道具の戻り値を
    // 丸ごと入れると **毎レンダー新しい配列と新しい関数**になり、帯への押し込みが
    // 毎回走る（`setCommit` は `onClick` を同一性で見るので常に「違う」になる）。
    [ringAdding, ring.canConfirm, ring.confirm, ring.cancel],
  );
  const ringExtras = useMemo(
    () => (
      <>
        <button
          type="button"
          data-testid="ring-edit-submode"
          onClick={() => ring.toggleSubMode()}
        >
          {ring.subMode === RING_EDIT_SUBMODE.Add
            ? RING_EDIT_STRINGS.switchToDelete
            : RING_EDIT_STRINGS.switchToAdd}
        </button>
        {ringAdding && (
          <>
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
                checked={ring.gridSnap}
                onChange={(e) => ring.setGridSnap(e.target.checked)}
              />
              {RING_EDIT_STRINGS.gridSnap}
            </label>
          </>
        )}
      </>
    ),
    [
      ringAdding,
      ring.subMode,
      ring.draft,
      ring.gridSnap,
      ring.toggleSubMode,
      ring.undoLastVertex,
      ring.setGridSnap,
    ],
  );
  useToolBarChrome({
    optionBar,
    active: ring.flow !== RING_EDIT_FLOW.Idle,
    slotId: 'ring-edit',
    nextStep: ring.message ?? ring.guide,
    commit: ringCommit,
    extras: ringExtras,
  });

  // --- 対象欄（240px）は **この道具が自分で押し込む**（増分 5 の手直し B3 / バグ狩り #6）--
  //
  // `shell/ToolOptionBar` の `TOOLS_WITH_OWN_TARGET` に輪郭が入ったので、あちらは
  // `activeFeature` から対象欄を作らない。それまでは **1 度も面を押していないのに一覧で
  // 選んだ地物の名前が出て**、次の一手の「編集する面を選んでください」と矛盾していた。
  // 名前の作り方は `describeOptionBarTarget` をそのまま使う（写像表を増やさない＝教訓 5.29）。
  //
  // **空へ戻すのは後片付けでやる**（`useToolBarChrome` と同じ理由＝教訓 5.68）。5 つの
  // コントローラは全部が同時にマウントされているので、effect の本体で「降りているなら
  // 空へ」と書くと、構えていない道具が構えている道具の押し込みを踏み消す。
  const ringArmed = ring.flow !== RING_EDIT_FLOW.Idle;
  const ringStage =
    ring.targetId === null ? RING_EDIT_STRINGS.stage(1) : RING_EDIT_STRINGS.stage(2);
  const ringTargetName = useMemo(() => {
    if (ring.targetId === null) return null;
    const feature = resolveFeature(ring.targetId);
    return feature === undefined ? null : describeOptionBarTarget(feature);
  }, [ring.targetId, resolveFeature]);
  useEffect(() => {
    if (optionBar === undefined || !ringArmed) return;
    optionBar.setTarget(ringStage, ringTargetName);
    return () => optionBar.setTarget(null, null);
  }, [optionBar, ringArmed, ringStage, ringTargetName]);

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

      {/* 案内・断り・確定の列は **オプションバーへ移した**（増分 5d / 設計書 §C.4 /
          E-2 / N-27）。地図の上に押せる部品を置かないので K-2 の事故が構造的に
          起こり得ない。ここに残すのは観測のミラーだけである。 */}
      <span className="ring-edit-tool__guide" data-testid="ring-edit-guide" hidden>
        {ring.guide}
      </span>
      {ring.message !== null && (
        <span className="ring-edit-tool__message" data-testid="ring-edit-message" hidden>
          {ring.message}
        </span>
      )}
      <span data-testid="ring-edit-vertex-count" hidden>
        {ring.draft?.vertices.length ?? 0}
      </span>
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
