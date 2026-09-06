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
import type { Feature } from '../../domain/feature';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { FeatureId } from '../../domain/ids';
import type { AffiliationSnapshot } from '../../domain/editing/apply-proposal';

import { buildReparentHighlight } from '../../render/reaffiliation-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import type { OptionBarStore } from '../shell/option-bar';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';

import { REPARENT_STRINGS } from './strings';
import {
  REPARENT_FLOW,
  useReparentTool,
  type ResolveAnchorTime,
  type ResolveFeatures,
  type ResolveVertexStore,
  type StartAffiliationProcess,
} from './useReparentTool';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** Pointer client-coords → world (U17, same renderer inverse the click path uses). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/**
 * Feature id under a world point (host LEAF hit-test). null = miss. HB3-16: this resolves
 * an INDIVIDUAL leaf via `leafAtPoint` (not the drawn aggregate) so a child inside an
 * aggregate is pickable, AND so two siblings of the SAME aggregate resolve to DISTINCT ids
 * — the root of HB3-15(b)「後から選択が消える」 (both siblings used to resolve to the one
 * parent aggregate id, so the second pick toggled the first back off).
 */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

/**
 * Resolve a chosen feature's leaf shape at the reparent anchor time (host live-lookup
 * `leafShapeAt`), or undefined when it is absent / not a leaf. Used to highlight the picked
 * target + new parent on the map (HB3-15(c)) so an undrawn leaf inside an aggregate is
 * visible.
 */
export type ResolveLeafShape = (featureId: FeatureId) => GeoMultiPolygon | undefined;

/**
 * The render sink the reparent target-highlight primitives are pushed into (U17). Mirrors
 * the knife `KnifeDrawSink` — the host shares the single tool-overlay slot (reparent /
 * knife / merge are mutually exclusive, so only one feeds it at a time).
 */
export interface ReparentDrawSink {
  drawHighlight(primitives: readonly DrawPrimitive[]): void;
}

/** A no-op draw sink (for hosts / tests that have not mounted a renderer yet). */
export const NO_REPARENT_DRAW_SINK: ReparentDrawSink = {
  drawHighlight() {
    /* nothing to draw into yet */
  },
};

export interface ReparentToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /** U13 process-start adapter (host-bound; createLiveAffiliationBinding). */
  readonly startProcess: StartAffiliationProcess<S>;
  /** The features effective at the reparent anchor time (live-lookup). */
  readonly resolveFeatures: ResolveFeatures;
  /** The anchor time the reparent confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /**
   * Live-lookup of the vertices at the anchor time. Threaded into the hook so
   * buildAffiliationProposal's post-reparent 形状=和・隙間なし check runs (基準 5 / FR-35).
   * Optional: a host without it falls back to the topological-only check.
   */
  readonly resolveStore?: ResolveVertexStore | undefined;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host LEAF hit-test, HB3-16). */
  readonly featureAtPoint: FeatureAtPoint;
  /** Resolve a target / new-parent id → its leaf shape for the on-map highlight (HB3-15(c)). */
  readonly resolveLeafShape?: ResolveLeafShape | undefined;
  /** The reparent target-highlight render sink (U17, HB3-15(c)). Defaults to a no-op. */
  readonly drawSink?: ReparentDrawSink | undefined;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /**
   * オプションバー（設計書 §C.4）。渡すと、いま相手にしている地物の名前を **対象欄へ
   * 押し込む**。渡さなくても道具は動く（帯が出ないだけ）ので任意 ―― 帯を持たない
   * 単体テストや、まだ帯を結線していない合成ルートのため。
   *
   * 帯を **持つ** のは `ToolOptionBar`（道具名・設定・確定はあちら）で、ここは
   * 対象欄だけを押し込む。詳しくは下の押し込み effect の注記。
   */
  readonly optionBar?: OptionBarStore | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the target. */
  readonly onCommitted?:
    | ((result: ProcessResult<S>, snapshot: AffiliationSnapshot) => void)
    | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<AffiliationSnapshot>) => void)
    | undefined;
  /**
   * Report whether a reparent session is in progress (bughunt-review). The host raises
   * the global-shortcut suspension while this is true so a stray global Ctrl+Z / Delete
   * cannot leak THROUGH a reparent flow to a domain op — the same modal-passthrough the
   * e63c8b9 fix blocks for Add / Knife but MISSED here. Suspending across the WHOLE
   * non-Idle flow mirrors Add / Knife / Merge. Fires `true` whenever the flow is past
   * Idle, `false` on return to Idle (cancel / commit / mode-switch).
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function ReparentToolController<S>(
  props: ReparentToolControllerProps<S>,
): JSX.Element | null {
  const { store, startProcess, resolveFeatures, anchorTime, screenToWorld, featureAtPoint, onConflicts } =
    props;
  const resolveStore = props.resolveStore;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;
  const resolveLeafShape = props.resolveLeafShape;
  const drawSink = props.drawSink ?? NO_REPARENT_DRAW_SINK;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  // W3-AB — CANCEL = leave the tool (Escape / キャンセル). Reparent was one of the two tools
  // W3-B's「cancel → 同一ボタン再アーム」対称化 never reached: its cancel only reset the
  // session, leaving `activeTool` = EditReparent (toolbar `aria-pressed=true`) with no
  // session, so pressing the SAME button again ran the store's press-toggle (tool → null)
  // and nothing happened — a dead button until the user detoured through another tool.
  // Releasing `activeTool` here keeps the toolbar's pressed state and the session's armed
  // state ONE truth (教訓 5.2 全経路で破棄 + 単一の真実源). Same規約 as knife / drill /
  // ring-edit / merge.
  const releaseToolOnCancel = useCallback(() => {
    // **増分 5c: 選択の後始末を明示に書く。** 旧版は `setActiveTool(null)` の
    // **副作用**（道具を替えたら選択を全消しする）に寄りかかっていたが、増分 5c で
    // その既定を反転した（`docs/現状.md` B28: 道具を持ち替えても選択は消さない）ので、
    // 寄りかかっていた側がここで黙って壊れる（教訓 5.44「共通ロジックを差し替えたら
    // 呼び出し側に残る写しを全部潰す」の、副作用版）。
    //
    // この道具は **自分で対象を選択へ昇格させている**（`onTargetSelected` →
    // `setActiveFeature`）ので、取りやめたら自分で戻す。掴んでいない選択まで
    // 巻き添えにする点は設計書 §D.4 の階段（対象を離す → 道具は持ったまま）とまだ
    // 食い違っており、そこは増分 7 で階段を各道具へ通すときに揃える。
    store.getState().clearSelection();
    store.getState().setActiveTool(null);
  }, [store]);

  const reparent = useReparentTool<S>({
    resolveFeatures,
    anchorTime,
    startProcess,
    onCommitted,
    onCancelled: releaseToolOnCancel,
    ...(resolveStore ? { resolveStore } : {}),
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

  // --- bughunt-review: report the in-progress reparent to the host so it suspends the
  // GLOBAL shortcut dispatcher while this session owns the keyboard, so a native
  // window-level Ctrl+Z / Delete cannot fire EditUndo / EditDelete THROUGH the reparent
  // flow to a domain op (the e63c8b9 modal-passthrough fix missed reparent). The host
  // derives shortcutsSuspended = modalOpen || toolDrawing (単一真実源 教訓 5.29); the
  // reparent flow is that single truth and we only mirror it up. Suspending across the
  // WHOLE non-Idle flow matches Add / Knife / Merge.
  const onDrawingChange = props.onDrawingChange;
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
    const active = reparent.flow !== REPARENT_FLOW.Idle && reparent.targetId !== null;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [reparent.flow, reparent.targetId, onDrawingChange]);

  // --- Keyboard: Escape→cancel (FR-78). Active while a session runs.
  useEffect(() => {
    if (reparent.flow === REPARENT_FLOW.Idle) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #6): a text-editing element owns the keyboard
      // (timeline year field / sidebar input) — let native Escape through,
      // dispatching NOTHING and preventing NOTHING, so the tool never cancels over
      // native character editing (教訓 5.13: reuse the SINGLE focus-guard predicate,
      // no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        reparent.cancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reparent.flow, reparent.cancel]);

  // --- HB3-15(c): feed the target + new-parent highlight to the render sink on every
  // selection change. Each id's leaf shape is resolved through the SAME live-lookup the
  // commit uses (`leafShapeAt`), so what highlights == what is committed (単一真実源).
  // Because HB3-16 lets a leaf INSIDE an aggregate be picked (it is not drawn standalone),
  // this is the user's only on-map feedback that an undrawn leaf was chosen as the target /
  // destination — without it the prior 「描画されていないものが選ばれる」regression would
  // return. The target and new parent draw in DISTINCT tool-specific colours so the two
  // roles read apart. An idle / empty selection builds `[]` so the highlight vanishes on
  // every reset path (教訓 5.2 / 5.18). targetId/newParentId are the reactive drivers;
  // anchorTime/domain are read at call time inside resolveLeafShape (教訓 5.6).
  useEffect(() => {
    const targetShape =
      resolveLeafShape && reparent.targetId !== null
        ? resolveLeafShape(reparent.targetId)
        : undefined;
    const newParentShape =
      resolveLeafShape && reparent.newParentId !== null
        ? resolveLeafShape(reparent.newParentId)
        : undefined;
    drawSink.drawHighlight(buildReparentHighlight({ targetShape, newParentShape }));
  }, [reparent.targetId, reparent.newParentId, resolveLeafShape, drawSink]);

  // --- オプションバーの対象欄（設計書 §C.4）------------------------------------
  //
  // **なぜこの道具が自分で押し込むのか**: 所属変更は `targetId` という自前の選択を持ち、
  // セッションストアの `activeFeature` を書かない。だから帯を持っている `ToolOptionBar`
  // からは「いま何を相手にしているか」が見えず、実機では「所属」を構えているあいだ対象欄が
  // 「（選んでいません）」のままだった。`ToolOptionBar` はこの道具（と「結ぶ」）については
  // 対象を押し込まない約束なので、ここが唯一の押し込み手である。
  //
  // **`claim` はしない**。帯の持ち主は `ToolOptionBar` のままで、道具名「⇄ 所属」も
  // あちらが押し込んでいる。押し込みの 4 本の API は持ち主を見ない規約なので、持たずに
  // 押し込める（`option-bar.ts` の `claim` 注記 3）。ここで `claim` すると帯が空へ戻り、
  // 道具名まで消えてしまう。
  //
  // **消す経路**（対象を外す・道具を降りる・モードを離れる・確定して選び直しへ戻る）では
  // null を押し込んで対象欄を空へ戻す（教訓 5.2 全経路で破棄）。どれも `targetId` が
  // null へ戻る経路なので、この 1 本の effect が全部を賄う。ただし **自分が押し込んだ
  // 覚えがあるときだけ**消す ―― 何も押していないのに null を押すと、別の道具が入れた
  // 名前を巻き添えで消しうる。
  const optionBar = props.optionBar;
  const pushedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (optionBar === undefined) return;
    // 相手にしているもの ＝ 所属を変える地物（`targetId`）。まだ選んでいなければ移し先を
    // 出す（普通は移し先だけが選ばれることは無いが、片方しか無い状態を黙って空にしない）。
    const shownId = reparent.targetId ?? reparent.newParentId;
    const name = shownId === null ? null : describeFeatureById(resolveFeatures(), shownId);
    if (name === null && pushedTargetRef.current === null) return;
    pushedTargetRef.current = name;
    optionBar.setTarget(null, name);
  }, [optionBar, reparent.targetId, reparent.newParentId, resolveFeatures]);

  // 部品ごと外れるときも消す（教訓 5.2: 一時的な表示は全経路で畳む）。上の effect の
  // 後片付けに書くと、選び直しのたびに「消す → 入れ直す」で帯が 1 度空になるので分ける。
  useEffect(
    () => () => {
      if (optionBar === undefined || pushedTargetRef.current === null) return;
      pushedTargetRef.current = null;
      optionBar.setTarget(null, null);
    },
    [optionBar],
  );

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
        {/* 最上位化 (detach / make-top-level, parentNone): enabled once a target is picked,
            independent of a new parent (FR-46 独立 / 解体の構成要素). Was unreachable — the
            domain parentNone variant had no UI entry point (bughunt wiring gap). */}
        <button
          type="button"
          data-testid="reparent-confirm-none"
          disabled={!reparent.canConfirmNone}
          onClick={() => reparent.confirmNone()}
        >
          {REPARENT_STRINGS.confirmNone}
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
 * 帯の対象欄に出す説明を、いまの年に効いている地物の一覧から引く。書式は
 * `ToolOptionBar` が公開している {@link describeOptionBarTarget}（「アアウェン州
 * （末端地物・州）」）をそのまま使う ―― 対象欄の書き方と種類の日本語は 1 か所に
 * 置き、道具ごとに写像表を作り直さない（教訓 5.29）。
 *
 * 引けなかった（その年には居ない）ときは null を返す ―― 内部 id は画面に出さない（U-1）。
 */
function describeFeatureById(
  features: readonly Feature[],
  featureId: FeatureId,
): string | null {
  const feature = features.find((f) => f.id === featureId);
  return feature === undefined ? null : describeOptionBarTarget(feature);
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
