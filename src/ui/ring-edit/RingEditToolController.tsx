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
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import {
  DISCARD_REASON,
  DraftDiscardConfirm,
  confirmBlocksToolKey,
} from '../shell/DraftDiscardConfirm';
import { useDraftSwitchGuard, type DraftSwitchGuard } from '../shell/useDraftSwitchGuard';
import type { DraftLostHandler } from '../shell/useDraftTimeGate';
import { useTargetStillThere } from '../shell/useTargetStillThere';
import type { OptionBarStore } from '../shell/option-bar';
import { useOptionBarEpoch, useToolBarChrome } from '../shell/useToolBarChrome';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';
import { ImpactConfirmDialog } from '../shell/ImpactConfirmDialog';
import { PROPERTY_STRINGS } from '../property/messages';
import { RING_KIND, type RingKind } from '../../domain/ring';

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
  /**
   * **本物のモーダルが開いた／閉じた**ことを報せる口（増分 5 の手直し 2 回目）。
   * この道具の本物のモーダルは「描きかけを捨てますか」の板だけである ―― 背面を覆う
   * 板を置いてあるので、答えるまで背後で Ctrl+S などが走ってはいけない。
   * `onDrawingChange`（＝下書きを持っている）とは意味が違うので別の口にする。
   */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
  /**
   * 輪郭を消す前の確認（`ring-delete-impact`）が出ていると名乗る口。**別の口にしてある**
   * のは、上の `onModalChange` が「作図をやめますか」の確認のためのもので、2 つの板が
   * 同じ口を取り合うと片方が閉じた瞬間にもう片方の名乗りまで消えるからである（決定 (13)）。
   */
  readonly onImpactModalChange?: ((open: boolean) => void) | undefined;
  /**
   * **打ちかけの輪郭を捨てたことを伝える口**（増分 5 の手直し 2 回目。追加の道具の
   * `onDraftDiscarded` と同じ役割）。捨てた頂点の数を状態行へ出すために要る。
   */
  readonly onDraftDiscarded?: ((count: number) => void) | undefined;
  /** 年の移動・設定の補正・読み込みで捨てたものを報せる口（B112）。 */
  readonly onDraftLost?: DraftLostHandler | undefined;
  /** 一覧で別の地物を選んで下書きを片付けたあとに視点を合わせる口（B118）。 */
  readonly onFocusSelection?: (() => void) | undefined;
  /** 選択を動かすと聞く下書きを持っているかの変化を伝える口（B118。板のあいだ視点を止める）。 */
  readonly onDraftHeldChange?: ((held: boolean) => void) | undefined;
  /**
   * いま Ctrl+Z で戻す相手（打った点）を道具が持っているか（B64）。対象を掴んだだけで点が無い
   * あいだは偽を報せ、ホストが取り消し・やり直しを大域へ通す。
   */
  readonly onUndoPointChange?: ((hasPoint: boolean) => void) | undefined;
  /** 掴んでいた面がいまの年に居なくなり、手放したことを伝える口（B112）。 */
  readonly onTargetGone?: ((targetId: FeatureId) => void) | undefined;
  /** Provisional draw style override. */
  readonly style?: RingEditStyle | undefined;
}

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

/** リングの種類を画面の言葉にする（設計書 §H.1 の「外周／穴／飛び地」）。 */
function ringKindLabel(kind: RingKind): string {
  return kind === RING_KIND.Hole
    ? RING_EDIT_STRINGS.ringKindHole
    : RING_EDIT_STRINGS.ringKindTerritory;
}

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

  // FR-78 グリッドスナップ: the project grid spacing, read + coerced from the SAME
  // project setting the add tool reads (単一の真実源), so an add-hole vertex snaps to
  // the identical graticule an add-tool vertex would (mirrors AddToolController).
  const gridSpacingRaw = useStore(store, (s) => s.projectSettings.gridSpacingDeg);
  const gridSpacing = coerceGridSpacing(gridSpacingRaw);

  // **昇格させた対象を覚えておく**（増分 5 の手直し B1）。戻すときに「自分が昇格させた
  // ものかどうか」を見分けるために要る（下の {@link unpromoteOwnTarget} の注記）。
  const promotedTargetRef = useRef<FeatureId | null>(null);
  /**
   * **道具を構える前から選ばれていたもの**（増分 5 の手直し 2 回目）。設計書 §D.4.1 の
   * 表は「対象を離す／元からの選択: **保つ**」と定めているのに、対象を離すと選択が
   * `null` になっていた。昇格の直前の値を控え、離すときにそこへ戻す。
   */
  const previousSelectionRef = useRef<FeatureId | null>(null);
  const promoteTargetSelection = useCallback(
    (fid: FeatureId) => {
      const s = store.getState();
      // 控えるのは **最初の 1 回だけ**（選び直すたびに控えると「前の対象」に戻る）。
      if (promotedTargetRef.current === null) previousSelectionRef.current = s.activeFeature;
      promotedTargetRef.current = fid;
      s.setActiveFeature(fid);
    },
    [store],
  );

  // **自分が昇格させた対象だけを選択から戻す**（増分 5 の手直し B1 / GPT #8）。
  // 旧版は `clearSelection()` ―― 頂点の選択も、道具が触っていない地物の選択も、まとめて
  // 空にしていた。設計書 §D.4 の階段は「対象を離す」であって「選択を全部捨てる」ではない。
  const unpromoteOwnTarget = useCallback(() => {
    const promoted = promotedTargetRef.current;
    const previous = previousSelectionRef.current;
    promotedTargetRef.current = null;
    previousSelectionRef.current = null;
    if (promoted === null) return;
    const s = store.getState();
    if (s.activeFeature !== promoted) return;
    // **元からの選択へ戻す**（null へ落とさない＝設計書 §D.4.1 の表）。
    s.setActiveFeature(previous);
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

  // --- 教訓 5.2 全経路で破棄 ＋ 設計書 §D.4.1 の 3「確定できる点数まで来ている下書きは
  // 捨てる前に確認」。道具・鍵の出入りは共有の見張り（`shell/useDraftSwitchGuard`）が
  // 1 本で受ける ―― **確定できる輪郭（3 点以上）を持っているあいだは、切替先を構えずに
  // 聞く**。旧版はここで無条件に `resetForSwitch()` を呼んでいたので、**輪郭 4 点が
  // 確認なしに消えていた**（増分 5 の手直し 2 回目）。
  // **重なりで止まっている間は 0 と数える**（教訓 5.95。`AddToolController` の draftSizeRef と
  // 同じ理由）。この頂点はもう確定の手続きに渡してあり、行き先は重なり解決の板が決める。
  // 数えていると、板を閉じたあとの構え直しで「描きかけの頂点 4 個を捨てました」と嘘をつく。
  const ringVertexCount =
    ring.flow === RING_EDIT_FLOW.ConflictPaused ? 0 : (ring.draft?.vertices.length ?? 0);
  const ringGuard: DraftSwitchGuard = useDraftSwitchGuard({
    store,
    toolId: TOOL_ID.EditRing,
    // 輪郭は **3 点で確定できる**（`useRingEditTool` の `canConfirm` と同じ一線）。
    hasCommittableDraft: ring.canConfirm,
    vertexCount: ringVertexCount,
    onArm: () => {
      ring.start();
    },
    onDisarm: () => {
      ring.resetForSwitch();
    },
    // 利用者自身の Escape で「捨てる」と答えられた **1 段ぶん**（設計書 §D.4.1 の表）。
    onDiscardPoints: () => {
      if (ring.draft !== null && ring.draft.vertices.length > 0) {
        ring.discardDraftVertices();
        return;
      }
      ring.releaseTarget();
      unpromoteOwnTarget();
    },
    // 年の移動の［捨てる］は頂点列だけ。対象を掴んだまま（居ない年なら下の見張りが手放す）。
    onDiscardForTimeMove: ring.discardDraftVertices,
    onDraftDiscarded: props.onDraftDiscarded,
    onDraftLost: props.onDraftLost,
    onFocusSelection: props.onFocusSelection,
    onDraftHeldChange: props.onDraftHeldChange,
  });

  // **掴んでいる面がいまの年に居なくなった・隠れて描かれなくなったら手放す**（B112・B134）。残しておくと、
  // 見えない面に点を打ち、確定を押しても何も記録されず、状態行にも何も出ない（実機で確認）。
  // 板のあいだは待つ（［続ける］で選択が戻り、また描かれる）。見張りの後ろに置くので、捨てた知らせが先に出る。
  const onTargetGone = props.onTargetGone;
  const ringTargetPresent = useTargetStillThere(store, ring.targetId, resolveFeature);
  const releaseRingTarget = ring.releaseTarget;
  // 道具を降りるコミットでは見ない（読み込みで対象が消えても、手放したとは言わない）。
  const ringWatchesTarget =
    ringGuard.armed &&
    ring.flow !== RING_EDIT_FLOW.Idle &&
    ring.flow !== RING_EDIT_FLOW.ConflictPaused;
  const ringTargetId = ring.targetId;
  const ringIsBoardOpen = ringGuard.isBoardOpen;
  const ringBoard = ringGuard.pending;
  useEffect(() => {
    if (!ringWatchesTarget || ringTargetPresent || ringTargetId === null || ringIsBoardOpen()) return;
    releaseRingTarget();
    unpromoteOwnTarget();
    onTargetGone?.(ringTargetId);
  }, [
    ringWatchesTarget,
    ringTargetPresent,
    ringTargetId,
    ringIsBoardOpen,
    ringBoard,
    releaseRingTarget,
    unpromoteOwnTarget,
    onTargetGone,
  ]);

  // --- Feed the provisional ring-edit primitives to the render sink on every draft
  // change (FR-22). An idle draft yields [] so the overlay vanishes on reset (教訓 5.2).
  useEffect(() => {
    drawSink.drawRingEdit(buildRingEditPrimitives(ring.draft, style));
  }, [ring.draft, drawSink, style]);

  // B64: 打った頂点があるあいだだけ、Ctrl+Z の相手を道具が持っている。
  const ringHasUndoPoint = ring.draft !== null && ring.draft.vertices.length > 0;
  const onUndoPointChange = props.onUndoPointChange;
  useEffect(() => {
    if (onUndoPointChange === undefined) return;
    onUndoPointChange(ringHasUndoPoint);
    return () => onUndoPointChange(true);
  }, [ringHasUndoPoint, onUndoPointChange]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo vertex (FR-78). Active while a session runs.
  const onDrawingChange = props.onDrawingChange;
  // **重なりで止まっている間は打鍵を受けない**（鍵盤は板のもの。教訓 5.95。穴あけ・分けると
  // 同じ形）。受けると Escape が板の下で下書きを捨て、Ctrl+Z が止まっている頂点を減らす。
  useEffect(() => {
    if (ring.flow === RING_EDIT_FLOW.Idle || ring.flow === RING_EDIT_FLOW.ConflictPaused) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      // **板が開いているあいだ、道具の打鍵は Escape だけが通る**（手直し 3 回目。
      // 述語は `shell/DraftDiscardConfirm` の {@link confirmBlocksToolKey} に 1 本ある）。
      // 旧版は Escape のときだけ板を見ていたので、板の中の Ctrl+Z が頂点を 1 つ減らし、
      // Enter が形を確定して素性入力へ進んだ ―― しかも状態行は「いま使えません」と言う。
      if (confirmBlocksToolKey(ringGuard.pending !== null, e.key)) return;
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
        //
        // **0 段目がもう 1 つある**（増分 5 の手直し 2 回目）: 「捨てますか」の板が
        // 出ていたら、まずそれに答える。答え方は **なぜ聞いているか**で変わる
        // （設計書 §D.4.1 の 4 / 教訓 5.70）。
        if (ringGuard.pending !== null) {
          e.preventDefault();
          if (ringGuard.pending === DISCARD_REASON.Escape) ringGuard.discard();
          else ringGuard.keep();
          return;
        }
        if (ring.draft !== null && ring.draft.vertices.length > 0) {
          e.preventDefault();
          // **確定できる点数（3 点以上）まで来ていたら 1 度聞く**（§D.4.1 の 3）。
          if (ring.canConfirm) {
            ringGuard.askOnEscape();
            return;
          }
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
      // 点が無いときは受けない（B64）。旧版はここで面を黙って離していた。点が無ければ打鍵は
      // 大域の取り消しへ届く（分ける・穴あけと同じ形）。
      if (
        ringHasUndoPoint &&
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
    ring.canConfirm,
    ringHasUndoPoint,
    unpromoteOwnTarget,
    ringGuard,
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

  // **モーダルは別に報せる**（増分 5 の手直し A4 と同じ規律）。この道具の本物のモーダルは
  // 「描きかけを捨てますか」の板だけである ―― 下書きを持っているだけなら Ctrl+S は
  // 通してよいが、確認の背後で保存が走ると何に答えたのか分からなくなる。
  const onModalChange = props.onModalChange;
  useEffect(() => {
    if (onModalChange === undefined) return;
    onModalChange(ringGuard.pending !== null);
    return () => onModalChange(false);
  }, [ringGuard.pending, onModalChange]);

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
  // **帯へ押し込む条件は「店の真実（いま構えている道具）」と AND する**（手直し 3 回目）。
  // 道具の `flow` は自分の state なので、`activeTool` が外れてから畳まれるまで **1 コミット
  // 遅れる**。その 1 コミットのあいだに押し直すと、**降りたばかりの道具が次の持ち主の
  // 中身を自分のもので上書きする**（実測: 分ける → 選ぶ で対象欄が「手順 1/4（選んで
  // いません）」になり、そのあと空で固まった）。押し込みは店が「いまこの道具」と
  // 言っているあいだだけにする。
  const ringArmedHoldsBar = (ring.flow !== RING_EDIT_FLOW.Idle) && ringGuard.armed;
  useToolBarChrome({
    optionBar,
    active: ringArmedHoldsBar,
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
  const ringStage =
    ring.targetId === null ? RING_EDIT_STRINGS.stage(1) : RING_EDIT_STRINGS.stage(2);
  const ringTargetName = useMemo(() => {
    if (ring.targetId === null) return null;
    const feature = resolveFeature(ring.targetId);
    return feature === undefined ? null : describeOptionBarTarget(feature);
  }, [ring.targetId, resolveFeature]);
  // 器が持ち直されたら押し直すために、代を React の値として読む（手直し 3 回目）。
  const optionBarEpoch = useOptionBarEpoch(optionBar);
  // **書いた人の印**（手直し 3 回目）。空へ戻すのは自分が最後に書いたときだけ。
  const targetWriterRef = useRef<object>({});
  useEffect(() => {
    if (optionBar === undefined || !ringArmedHoldsBar) return;
    // **後片付けは「自分が最後に書いた」ときだけ効かせる**（増分 5 の手直し 2〜3 回目。
    // 理由は `shell/useToolBarChrome` の注記と同じ ―― この道具の後片付けは 1 コミット
    // 遅れて走るので、同じ持ち替えで次の持ち主が入れた対象名を踏み消していた）。
    //
    // **`optionBarEpoch` を依存に入れて押し直す**（手直し 3 回目）。器が持ち直されると
    // 中身は空へ戻るので、押し込んだ側が黙っていると対象欄が空のまま固まる。
    const targetWriter = targetWriterRef.current;
    optionBar.setTarget(ringStage, ringTargetName, targetWriter);
    return () => {
      optionBar.clearTargetIfMine(targetWriter);
    };
  }, [optionBar, ringArmedHoldsBar, ringStage, ringTargetName, optionBarEpoch]);

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

      {/* **輪郭を消す前の確認**（N-05 / 設計書 §A.3。増分 7 の中身 7）。器は削除・錨と
          同じ 1 つで、**「最後の外周を消すと面ごと消える」を事前に文で**出す。 */}
      {ring.pendingDelete !== null && (
        <ImpactConfirmDialog
          {...(props.onImpactModalChange ? { onModalChange: props.onImpactModalChange } : {})}
          testIdPrefix="ring-delete-impact"
          title={PROPERTY_STRINGS.ringDeleteTitle(
            ringKindLabel(ring.pendingDelete.ringKind),
          )}
          groups={[
            {
              testId: 'gone',
              heading: PROPERTY_STRINGS.impactHeadingGone,
              lines: ring.pendingDelete.lastTerritory
                ? [
                    PROPERTY_STRINGS.ringDeleteLineShape(
                      ringKindLabel(ring.pendingDelete.ringKind),
                    ),
                    PROPERTY_STRINGS.ringDeleteLineLastTerritory,
                  ]
                : [
                    PROPERTY_STRINGS.ringDeleteLineShape(
                      ringKindLabel(ring.pendingDelete.ringKind),
                    ),
                  ],
            },
          ]}
          confirmLabel={PROPERTY_STRINGS.ringDeleteConfirm}
          cancelLabel={PROPERTY_STRINGS.impactCancel}
          note={PROPERTY_STRINGS.impactUndoNote}
          onConfirm={() => ring.confirmPendingDelete()}
          onCancel={() => ring.cancelPendingDelete()}
        />
      )}

      {ring.flow === RING_EDIT_FLOW.ConflictPaused && (
        <p data-testid="ring-edit-conflict-paused" role="status">
          {RING_EDIT_STRINGS.conflictPaused}
        </p>
      )}

      {/* 確定できる輪郭を捨てる前の確認（設計書 §D.4.1 の 3）。**器は追加の道具・
          分ける・穴あけと共有の本物のモーダル**なので、この板が出ているあいだ地図の
          入力ブリッジは背面の覆いに遮られる（K-2 / 教訓 5.14）。 */}
      {ringGuard.pending !== null && (
        <DraftDiscardConfirm
          idPrefix="ring-edit-draft-discard"
          reason={ringGuard.pending}
          vertexCount={ringGuard.vertexCount}
          onKeep={ringGuard.keep}
          onDiscard={ringGuard.discard}
        />
      )}
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
