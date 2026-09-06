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

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { Feature } from '../../domain/feature';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { FeatureId } from '../../domain/ids';
import type { MergeSnapshot, MergeIdPorts } from '../../domain/merge/index';

import { buildMergeHighlight } from '../../render/reaffiliation-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import type { OptionBarStore } from '../shell/option-bar';
import { useToolBarChrome } from '../shell/useToolBarChrome';
import { EDIT_TOOL_STRINGS } from '../shell/strings';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';

import { MergeOptionsDialog } from './MergeOptionsDialog';
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

/**
 * Feature id under a world point (host LEAF hit-test). null = miss. HB3-16: this resolves
 * an INDIVIDUAL leaf via `leafAtPoint` (not the drawn aggregate) so a child inside an
 * aggregate is pickable as a merge target.
 */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

/**
 * Resolve a chosen target's leaf shape at the merge anchor time (host live-lookup
 * `leafShapeAt`), or undefined when it is absent / not a leaf. Used to highlight the
 * picked leaf on the map (HB3-15(c)) so an undrawn leaf inside an aggregate is visible.
 */
export type ResolveLeafShape = (featureId: FeatureId) => GeoMultiPolygon | undefined;

/**
 * The render sink the merge target-highlight primitives are pushed into (U17). Mirrors the
 * knife `KnifeDrawSink` — the host shares the single tool-overlay slot (merge / knife /
 * reparent are mutually exclusive, so only one feeds it at a time).
 */
export interface MergeDrawSink {
  drawHighlight(primitives: readonly DrawPrimitive[]): void;
}

/** A no-op draw sink (for hosts / tests that have not mounted a renderer yet). */
export const NO_MERGE_DRAW_SINK: MergeDrawSink = {
  drawHighlight() {
    /* nothing to draw into yet */
  },
};

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
  /** Feature id under a world point (host LEAF hit-test, HB3-16). */
  readonly featureAtPoint: FeatureAtPoint;
  /** Resolve a target id → its leaf shape for the on-map highlight (HB3-15(c)). */
  readonly resolveLeafShape?: ResolveLeafShape | undefined;
  /** The merge target-highlight render sink (U17, HB3-15(c)). Defaults to a no-op. */
  readonly drawSink?: MergeDrawSink | undefined;
  /** Forward camera-only events (wheel + non-left pointer) to the live dispatcher. */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /**
   * オプションバー（設計書 §C.4）。渡すと、いま選んでいる結合対象を **対象欄へ押し込む**
   * （1 件なら名前だけ、2 件以上なら「◯◯ ほか 2 件」）。渡さなくても道具は動く
   * （帯が出ないだけ）ので任意 ―― 帯を持たない単体テストや、まだ帯を結線していない
   * 合成ルートのため。
   *
   * 帯を **持つ** のは `ToolOptionBar`（道具名・設定・確定はあちら）で、ここは対象欄
   * だけを押し込む。詳しくは下の押し込み effect の注記。
   */
  readonly optionBar?: OptionBarStore | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection to the result. */
  readonly onCommitted?: ((result: ProcessResult<S>, snapshot: MergeSnapshot) => void) | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<MergeSnapshot>) => void)
    | undefined;
  /**
   * Report whether a merge session is in progress (bughunt-review). The host raises
   * the global-shortcut suspension while this is true so a stray global Ctrl+Z /
   * Delete cannot leak THROUGH the FR-52 MergeOptionsDialog (Choosing) to a domain op:
   * that dialog handles only Esc via React onKeyDown, which a native window listener
   * ignores — the exact modal-passthrough the e63c8b9 fix blocks for Add / Knife but
   * MISSED here. Suspending across the WHOLE non-Idle merge flow (mirrors Add / Knife)
   * also covers the SELECTING phase. Fires `true` whenever the flow is past Idle,
   * `false` on return to Idle (cancel / commit / mode-switch).
   */
  readonly onDrawingChange?: ((drawing: boolean) => void) | undefined;
  /**
   * **本物のモーダルが開いた／閉じた**ことを報せる口（増分 5 の手直し A4 / GPT #5）。
   *
   * `onDrawingChange`（＝下書きを持っている）と **分けて**報せる。両者は鍵盤の持ち主として
   * 意味が違う ―― 下書きを持っているだけなら保存（Ctrl+S）は通してよいが、**モーダルが
   * 開いているあいだは通してはいけない**（確認の背後で保存が走ると、何に対して答えたのか
   * 分からなくなる）。旧版は「対象を持っている」という理由だけで下書き扱いにしていたので、
   * 継承先の選択や素性の入力の途中で Ctrl+S / Ctrl+Shift+S / Ctrl+N / Ctrl+O が
   * **背後で走った**。
   */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
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
  const resolveLeafShape = props.resolveLeafShape;
  const drawSink = props.drawSink ?? NO_MERGE_DRAW_SINK;

  const mode = useStore(store, (s) => s.mode);
  const activeTool = useStore(store, (s) => s.activeTool);

  // W3-AB — CANCEL = leave the tool (Escape / キャンセル). Merge was one of the two tools
  // W3-B's「cancel → 同一ボタン再アーム」対称化 never reached: its cancel only reset the
  // session, leaving `activeTool` = EditMerge (toolbar `aria-pressed=true`) with no session,
  // so pressing the SAME button again ran the store's press-toggle (tool → null) and nothing
  // happened — a dead button until the user detoured through another tool. Releasing
  // `activeTool` here keeps the toolbar's pressed state and the session's armed state ONE
  // truth (教訓 5.2 全経路で破棄 + 単一の真実源). Same規約 as knife / drill / ring-edit.
  //
  // **これは［やめる］を押されたときの経路だけである**（増分 5 の手直し B1）――
  // ボタンとして「やめる」を押したのは「この作業をやめる」という意思表示だから道具ごと
  // 降りてよい。**Escape はここを通らない**: Escape は 1 回で 1 段だけ戻る階段で、道具を
  // 降りるのは大域の `shell/escape-ladder.ts` の持ち場である（設計書 §D.4）。
  //
  // **`clearSelection()` はもう呼ばない**（GPT #8）。結ぶ道具は自前の `targetIds` だけを
  // 持ち、セッションの `activeFeature` は **1 度も書いていない** ―― それなのに取りやめの
  // たびに選択を空にしていたので、**道具が掴んだのではない元からの選択まで巻き添えで
  // 消えて**いた。道具が触っていないものは道具が片付けない。
  const releaseToolOnCancel = useCallback(() => {
    store.getState().setActiveTool(null);
  }, [store]);

  const merge = useMergeTool<S>({
    resolveFeatures,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    onCancelled: releaseToolOnCancel,
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

  // --- bughunt-review: report the in-progress merge to the host so it suspends the
  // GLOBAL shortcut dispatcher while this session owns the keyboard. The FR-52
  // MergeOptionsDialog (Choosing) handles only Esc via React onKeyDown, so a native
  // window-level Ctrl+Z / Delete would otherwise fire EditUndo / EditDelete straight
  // THROUGH the open dialog (the e63c8b9 modal-passthrough fix missed merge). The host
  // derives shortcutsSuspended = modalOpen || toolDrawing (単一真実源 教訓 5.29); the
  // merge flow is that single truth and we only mirror it up. Suspending across the
  // WHOLE non-Idle flow matches Add / Knife and also covers SELECTING.
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
    const active = merge.flow !== MERGE_FLOW.Idle && merge.targetIds.length > 0;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [merge.flow, merge.targetIds, onDrawingChange]);

  // **モーダルは別に報せる**（増分 5 の手直し A4）。FR-52 の選択板（`MergeOptionsDialog`）は
  // Escape / Tab しか自分では受けない本物のモーダルである。
  const onModalChange = props.onModalChange;
  useEffect(() => {
    if (onModalChange === undefined) return;
    onModalChange(merge.flow === MERGE_FLOW.Choosing);
    return () => onModalChange(false);
  }, [merge.flow, onModalChange]);

  // --- Keyboard: Escape→cancel (FR-78). Active while a session runs, EXCEPT while the
  // FR-52 options dialog is open (Choosing): there the modal owns Esc (Esc→cancelChoose
  // keeps the targets and returns to selecting, not abandoning the whole session).
  useEffect(() => {
    if (merge.flow === MERGE_FLOW.Idle || merge.flow === MERGE_FLOW.Choosing) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #6): a text-editing element owns the keyboard
      // (timeline year field / sidebar input) — let native Escape through,
      // dispatching NOTHING and preventing NOTHING, so the tool never cancels over
      // native character editing (教訓 5.13: reuse the SINGLE focus-guard predicate,
      // no per-controller re-implementation).
      if (isEditableTarget(editableTargetFromEvent(e))) return;
      if (e.key === 'Escape') {
        // --- Esc の階段（設計書 §D.4 / 増分 5 の手直し B1）--------------------
        //
        // **結ぶ道具の段は 1 つだけである。** ほかの 4 つは「下書き」と「対象」が別物
        // （分断線と切る面、輪郭と面…）だが、結ぶ道具は **対象の集合そのものが下書き**
        // でもある ―― 押していった地物の並びが、そのまま確定する中身になる。だから
        // 「点列を捨てる」と「対象を離す」を分けようがなく、1 段で全部外す。
        //
        //   1. 対象を 1 件以上掴んでいる → **全部外す**（道具は持ったまま選び直しへ）
        //   2. 1 件も無い → **何もせず大域の階段へ譲る**（preventDefault もしない）
        //
        // 2 で止めないのが肝である ―― 大域の `shell/escape-ladder.ts` が「頂点を外す →
        // 地物の選択を外す → 道具を『選ぶ』へ戻す」を順にやる。2 の局面では
        // `onDrawingChange` も false を報せているので、名乗りと段が食い違わない。
        if (merge.targetIds.length > 0) {
          e.preventDefault();
          merge.clearTargets();
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [merge.flow, merge.targetIds, merge.clearTargets]);

  // --- HB3-15(c): feed the target highlight to the render sink on every selection change.
  // Each toggled target's leaf shape is resolved through the SAME live-lookup the commit
  // uses (`leafShapeAt`), so what highlights == what is committed (単一真実源). Because
  // HB3-16 lets a leaf INSIDE an aggregate be picked (it is not drawn standalone), this is
  // the user's only on-map feedback that an undrawn leaf was chosen — without it the prior
  // 「描画されていないものが選ばれる」regression would return. An idle / empty selection
  // builds `[]` so the highlight vanishes on every reset path (教訓 5.2 / 5.18) with no
  // clearing code. targetIds is the reactive driver; anchorTime/domain are read at call
  // time inside resolveLeafShape (教訓 5.6).
  useEffect(() => {
    const shapes = resolveLeafShape
      ? merge.targetIds.map((id) => resolveLeafShape(id))
      : [];
    drawSink.drawHighlight(buildMergeHighlight({ targetShapes: shapes }));
  }, [merge.targetIds, resolveLeafShape, drawSink]);

  // --- オプションバーの対象欄（設計書 §C.4）------------------------------------
  //
  // **なぜこの道具が自分で押し込むのか**: 結合は `targetIds` という自前の選択（複数）を
  // 持ち、セッションストアの `activeFeature` を書かない。だから帯を持っている
  // `ToolOptionBar` からは「いま何を相手にしているか」が見えず、実機では「結ぶ」を
  // 構えているあいだ対象欄が「（選んでいません）」のままだった。`ToolOptionBar` は
  // この道具（と「所属」）については対象を押し込まない約束なので、ここが唯一の押し込み手。
  //
  // **`claim` はしない**。帯の持ち主は `ToolOptionBar` のままで、道具名「∪ 結ぶ」も
  // あちらが押し込んでいる。押し込みの API は持ち主を見ない規約なので、持たずに押し込める
  // （`option-bar.ts` の `claim` 注記 3）。ここで `claim` すると帯が空へ戻り、道具名まで
  // 消えてしまう。
  //
  // **何件選んだかを出す**のがこの道具の肝である（1 件なら名前だけ、2 件以上なら
  // 「◯◯ ほか 2 件」）。件数が読めないと、結合してから「1 つ入れ忘れていた」に気づく。
  //
  // **消す経路**（選択を外す・道具を降りる・モードを離れる・確定して選び直しへ戻る）は
  // **後片付け関数 1 本**に寄せる（増分 5 の手直し B3。`useToolBarChrome` が同じ理由で
  // そうしている＝教訓 5.68）。5 つの道具のコントローラは全部が同時にマウントされている
  // ので、effect の本体に「構えていないなら空へ」と書くと **構えていない道具が構えている
  // 道具の押し込みを踏み消す**（木の順に走るので、あとに置かれた道具ほど強い、という
  // 不条理な依存が生まれる）。React は 1 つのコミットの中で「全部の後片付け → 全部の
  // 再実行」の順に走らせるので、後片付けへ置けば木の位置に関わらず「前の道具が空へ戻す →
  // 次の道具が押し込む」になる。旧版の「自分が押し込んだ印」方式は、いま帯を持っている
  // のが誰かを知らないので踏み消しの半分しか塞げていなかった。
  //
  // **段階表示**（「手順 n/2」）も一緒に押し込む（設計書 §C.4 / バグ狩り #9）。
  const optionBar = props.optionBar;
  const mergeArmed = merge.flow !== MERGE_FLOW.Idle;
  const mergeStage =
    merge.flow === MERGE_FLOW.Choosing ? MERGE_STRINGS.stage(2) : MERGE_STRINGS.stage(1);
  const mergeTargetName = useMemo(
    () => describeMergeTargets(resolveFeatures(), merge.targetIds),
    [resolveFeatures, merge.targetIds],
  );
  useEffect(() => {
    if (optionBar === undefined || !mergeArmed) return;
    optionBar.setTarget(mergeStage, mergeTargetName);
    return () => optionBar.setTarget(null, null);
  }, [optionBar, mergeArmed, mergeStage, mergeTargetName]);

  // --- Map-input handler: a LEFT click resolves the feature under it and toggles it
  // into / out of the target set. The overlay never steals other input — the input
  // layer sits above the map and forwards here only while a merge session runs.
  // --- 案内・断り・確定の列をオプションバーへ（増分 5d / 設計書 §C.4 / E-2 / N-27）---
  //
  // 確定欄は 176px ＝ U-8 の下限（幅 60px）で 2 つが限度なので、［確定］［やめる］だけを
  // 置き、残りは設定欄へ差し込む（増分 3 の `add-undo` と同じ形）。**testid は 1 つも
  // 変えていない**（T-1: 役割で維持する。置き場が移っただけ）。
  const mergeCommit = useMemo(
    () => [
      {
        id: 'confirm',
        testId: 'merge-confirm',
        label: MERGE_STRINGS.confirm,
        disabled: !merge.canConfirm,
        onClick: () => merge.confirm(),
      },
      {
        id: 'cancel',
        testId: 'merge-cancel',
        label: MERGE_STRINGS.cancel,
        onClick: () => merge.cancel(),
      },
    ],
    // **同一性を安定させる**（増分 5 の手直し B3 の注記 7）。依存に道具の戻り値を
    // 丸ごと入れると **毎レンダー新しい配列と新しい関数**になり、帯への押し込みが
    // 毎回走る（`setCommit` は `onClick` を同一性で見るので常に「違う」になる）。
    [merge.canConfirm, merge.confirm, merge.cancel],
  );
  const mergeExtras = useMemo(
    () => (
      <button
        type="button"
        data-testid="merge-clear"
        disabled={merge.targetIds.length === 0}
        onClick={() => merge.clearTargets()}
      >
        {MERGE_STRINGS.clear}
      </button>
    ),
    [merge.targetIds, merge.clearTargets],
  );
  useToolBarChrome({
    optionBar,
    active: merge.flow !== MERGE_FLOW.Idle,
    slotId: 'merge',
    nextStep: merge.message ?? merge.guide,
    commit: mergeCommit,
    extras: mergeExtras,
  });

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
      {/* The transparent map-input bridge mounted while SELECTING (教訓 5.14): forwards
          LEFT clicks to the hook (target toggle) AND camera-only events to the live
          dispatcher (pan / zoom keep working). It is dropped while the FR-52 options
          dialog is open (Choosing) so the dialog's backdrop is the only input layer. */}
      {merge.flow !== MERGE_FLOW.Choosing && (
        <MergeInputBridge
          onMapPointerDown={onMapPointerDown}
          onMapWheel={onMapWheel}
          onMapCameraPointerDown={onMapCameraPointerDown}
          onMapCameraPointerMove={onMapCameraPointerMove}
          onMapCameraPointerUp={onMapCameraPointerUp}
          onMapCameraPointerCancel={onMapCameraPointerCancel}
        />
      )}

      {/* FR-52 options dialog: choose the result's 上位領域 + プロパティ source before the
          merge proposal is built. 確定 (merge-confirm) opens it; its 結合を実行 applies the
          chosen ParentDecision / PropertyDecision via confirmWith (教訓 5.7 完了トリガー). */}
      {merge.flow === MERGE_FLOW.Choosing && (
        <MergeOptionsDialog
          parentCandidates={merge.parentCandidates}
          propertyCandidates={merge.propertyCandidates}
          buildNewProperties={merge.buildNewProperties}
          onConfirm={merge.confirmWith}
          onCancel={merge.cancelChoose}
        />
      )}

      {/* 案内と断りは **オプションバーの「次の一手」** が本文を出す（増分 5d /
          設計書 §C.4）。ここに残すのは観測のミラーで、地図の上には描かない。 */}
      <span className="merge-tool__guide" data-testid="merge-guide" hidden>
        {merge.guide}
      </span>
      {merge.message !== null && (
        <span className="merge-tool__message" data-testid="merge-message" hidden>
          {merge.message}
        </span>
      )}

      {/* **確定の列はここには無い**（増分 5d）。オプションバーの確定欄 176px へ移した
          （設計書 §C.4 / E-2 / N-27）。地図に重ならないので K-2 の事故が構造的に
          起こり得ない。残っているのは観測だけである。 */}
      <span data-testid="merge-target-count" hidden>
        {merge.targetIds.length}
      </span>
    </div>
  );
}

/**
 * 帯の対象欄に出す説明。**複数を相手にする道具**なので、1 件目の説明のうしろに残りの
 * 件数を添える（「アアウェン州（末端地物・州） ほか 2 件」）。1 件のときは名前だけ
 * （「ほか 0 件」は読み手を戸惑わせる）。
 *
 * 1 件目の書式は `ToolOptionBar` が公開している {@link describeOptionBarTarget}
 * （「名前（種類・種別ラベル）」）をそのまま使う ―― 対象欄の書き方と種類の日本語は
 * 1 か所に置き、道具ごとに写像表を作り直さない（教訓 5.29）。
 *
 * 0 件、または 1 件目がその年に居なくて引けないときは null（内部 id は画面に出さない、
 * U-1。器が「（選んでいません）」を出す）。
 */
function describeMergeTargets(
  features: readonly Feature[],
  targetIds: readonly FeatureId[],
): string | null {
  const first = targetIds[0];
  if (first === undefined) return null;
  const feature = features.find((f) => f.id === first);
  if (feature === undefined) return null;
  const firstName = describeOptionBarTarget(feature);
  const rest = targetIds.length - 1;
  return rest === 0 ? firstName : EDIT_TOOL_STRINGS.targetWithMore(firstName, rest);
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
