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
//   - hands the新地物 basic属性 input to the RIGHT PANEL's「新規の姿」through the shared
//     {@link AddDraftStore} (FR-97 / 教訓 5.30 / 司令塔の決定 (5)) — the SAME U23 form the
//     add tool uses, at the same place, with showParent=false (上位領域は元末端から初期継承).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { ColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { FeatureId } from '../../domain/ids';
import type { DrillIdPorts, DrillSnapshot } from '../../domain/drill/index';

import { buildDrillPrimitives, type DrillStyle } from '../../render/drill-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import type { SessionStore } from '../state/store';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import { DISCARD_REASON, DraftDiscardConfirm } from '../shell/DraftDiscardConfirm';
import { useDraftSwitchGuard, type DraftSwitchGuard } from '../shell/useDraftSwitchGuard';
import type { OptionBarStore } from '../shell/option-bar';
import { useToolBarChrome } from '../shell/useToolBarChrome';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';

import type { AddDraftPrompt, AddDraftStore } from '../add/add-draft-store';
import { ADD_TOOL_KIND, type ParentCandidate } from '../../domain/add/index';

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
  /** オプションバー（設計書 §C.4）。確定の列はここへ出す（増分 5d / E-2）。 */
  readonly optionBar?: OptionBarStore | undefined;
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
  /**
   * **打ちかけの形を捨てたことを伝える口**（増分 5 の手直し 2 回目。追加の道具の
   * `onDraftDiscarded` と同じ役割）。捨てた頂点の数を状態行へ出すために要る。
   */
  readonly onDraftDiscarded?: ((count: number) => void) | undefined;
  /**
   * 新しい地物の素性入力を **右パネルの「新規の姿」**へ渡す口（司令塔の決定 (5) /
   * 設計書 §B.5 の台帳 #9 / §C.2 の 27）。追加の道具・分ける道具と同じ 1 本の橋である。
   *
   * **省略できるのは型の上だけ**である。渡さないと「素性を入れる局面なのに入力の口が
   * どこにも無い」＝手順が進まない状態になるので、合成ルートは必ず渡すこと（単体テストも
   * `AddDraftForm` を一緒に載せる形にしてある）。
   */
  readonly addDraft?: AddDraftStore | undefined;
  /**
   * A sensible color for the new feature when the form omits it (FR-97).
   *
   * **いまは誰も読んでいない**（司令塔の決定 (5)）。地図の板だったころから
   * `NewFeatureForm` はこの値を受け取るだけで使っておらず、色は右パネルの
   * `AddPropertyForm` が自分の既定を入れている。合成ルートと単体テストが渡している口
   * なので**型としては残す**が、外すなら合成ルート側と一緒に消す仕事である（申し送り）。
   */
  readonly defaultColor: ColorInfo;
  /** Provisional draw style override. */
  readonly style?: DrillStyle | undefined;
}

/**
 * 上位領域の候補は **常に空**である（`showParent: false` なので欄そのものが出ない）。
 * 毎レンダー新しい配列を作らないよう 1 本に固定する（`AddDraftStore` は中身を同一性で
 * 見るので、作り直すと押し込むたびに購読者へ通知が飛ぶ）。
 */
const NO_PARENT_CANDIDATES: readonly ParentCandidate[] = [];

/**
 * 上位領域は **ドメインが元の末端地物から引き継ぐ**（FR-45 / `assembleDrillProposal`）ので、
 * 選ばせない＝選ばれても何もしない。`showParent: false` と対で置く。
 */
const NOOP_CHOOSE_PARENT = (): void => {
  /* 新地物の上位領域は assembleDrillProposal が元末端から継ぐ (FR-45) */
};

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
    style,
  } = props;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;
  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;
  const drawSink = props.drawSink ?? NO_DRILL_DRAW_SINK;

  // Promote / un-promote the chosen target末端 through the SAME setActiveFeature path
  // every selection uses (no second selection source, 教訓 5.29), mirroring knife/ring.
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
  // W3-B — CANCEL = leave the tool (Escape / キャンセル / 拒否の dismiss). Un-promoting the
  // target alone left the toolbar button `aria-pressed=true` while the session was
  // disarmed, so pressing the SAME button again ran the store's press-toggle (tool → null)
  // instead of re-arming — the drill could only be revived by detouring through another
  // tool. Releasing `activeTool` here keeps the toolbar's pressed state and the session's
  // armed state ONE truth (教訓 5.2 全経路で破棄 + 単一の真実源), so the next press always
  // re-arms. `setActiveTool(null)` runs the store's own selection reset契約, which subsumes
  // the target un-promotion. Same規約 as ring-edit (8950639) / knife.
  //
  // **これは［やめる］を押されたときの経路だけである**（増分 5 の手直し B1）――
  // ボタンとして「やめる」を押したのは「この作業をやめる」という意思表示だから道具ごと
  // 降りてよい。**Escape はここを通らない**: Escape は 1 回で 1 段だけ戻る階段で、道具を
  // 降りるのは大域の `shell/escape-ladder.ts` の持ち場である（設計書 §D.4）。
  const releaseToolOnCancel = useCallback(() => {
    unpromoteOwnTarget();
    store.getState().setActiveTool(null);
  }, [unpromoteOwnTarget, store]);

  const drill = useDrillTool<S>({
    resolveFeature,
    resolveStore,
    anchorTime,
    ids,
    startProcess,
    onCommitted,
    onTargetSelected: promoteTargetSelection,
    onCancelled: releaseToolOnCancel,
    ...(onConflicts ? { onConflicts } : {}),
  });

  // --- 教訓 5.2 全経路で破棄 ＋ 設計書 §D.4.1 の 3「確定できる点数まで来ている下書きは
  // 捨てる前に確認」。道具・鍵の出入りは共有の見張り（`shell/useDraftSwitchGuard`）が
  // 1 本で受ける ―― **確定できる形（3 点以上）を持っているあいだは、切替先を構えずに
  // 聞く**。旧版はここで無条件に `resetForSwitch()` を呼んでいたので、**穴あけ 4 点が
  // 確認なしに消えていた**（増分 5 の手直し 2 回目）。
  const drillGuard: DraftSwitchGuard = useDraftSwitchGuard({
    store,
    toolId: TOOL_ID.EditDrill,
    // 面をくり抜く形は **3 点で確定できる**（`useDrillTool` の `canConfirm` と同じ一線）。
    hasCommittableDraft: drill.region.length >= 3,
    vertexCount: drill.region.length,
    onArm: () => {
      drill.start();
    },
    onDisarm: () => {
      drill.resetForSwitch();
    },
    // 利用者自身の Escape で「捨てる」と答えられた **1 段ぶん**（設計書 §D.4.1 の表）。
    // **局面で分ける**（点の数だけで見てはいけない）―― 素性を入力している最中も
    // `region` は確定済みの形として生きているので、点の数で判定すると「対象を離す」
    // 段まで戻らず、右パネルの素性欄が閉じないまま残る。
    onDiscardPoints: () => {
      if (drill.flow === DRILL_FLOW.DrawingRegion && drill.region.length > 0) {
        drill.discardRegion();
        return;
      }
      drill.releaseTarget();
      unpromoteOwnTarget();
    },
    onDraftDiscarded: props.onDraftDiscarded,
  });

  // --- Feed the provisional drill primitives to the render sink on every draft change
  // (FR-45). An empty region yields [] so the overlay vanishes on reset (教訓 5.2).
  useEffect(() => {
    drawSink.drawDrill(
      buildDrillPrimitives({ region: drill.region, preview: drill.preview }, style),
    );
  }, [drill.region, drill.preview, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo vertex (FR-78). Active while a session runs,
  // EXCEPT while the U35 conflict modal owns the screen (ConflictPaused): there the MODAL
  // owns Esc, and a tool-side cancel would release `activeTool` under the open modal so the
  // host's later `reArmActiveTool` had nothing to restore (W3-AB レビュー LOW; mirrors knife
  // and merge's FR-52 dialog exclusion).
  const onDrawingChange = props.onDrawingChange;
  useEffect(() => {
    if (drill.flow === DRILL_FLOW.Idle || drill.flow === DRILL_FLOW.ConflictPaused) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a vertex over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      //
      // **Escape だけは別**（増分 5 の手直し 2 回目）。素性入力を右パネルへ移した
      // （決定 (5)）結果、名前欄に焦点があるあいだ **Escape を誰も受けなくなった**。
      // 追加の道具と同じく、**文字の欄の中でも「やめる」は道具のもの**にする
      // （打ちかけがあれば 1 度聞く）。
      const target = editableTargetFromEvent(e);
      const inEditable = isEditableTarget(target);
      if (inEditable && e.key !== 'Escape') return;
      if (e.key === 'Escape') {
        // --- Esc の階段（設計書 §D.4 / 増分 5 の手直し B1）--------------------
        //
        // **1 回の Escape で 1 段だけ**戻る。旧版は 1 回で「手順の対象」「元からの選択」
        // 「道具」の三段をまとめて捨てていた（GPT #8）。
        //
        //   0. 「捨てますか」の板が出ている → まずそれに答える（下の注記）
        //   1. 素性を入力している → **対象を離す**段まで戻す（道具は持ったまま。欄に
        //      打ちかけがあれば 1 度聞く＝増分 5 の手直し 2 回目）
        //   2. くり抜く形の頂点列がある → **頂点列だけをまとめて捨てる**（対象も道具も
        //      保つ。確定できる点数なら 1 度聞く）
        //   3. 対象を掴んでいる → 対象だけ離す（道具は持ったまま。**元からの選択は保つ**）
        //   4. どれも無い → **何もせず大域の階段へ譲る**（preventDefault もしない）
        //
        // 4 で止めないのが肝である ―― 大域の `shell/escape-ladder.ts` が「頂点を外す →
        // 地物の選択を外す → 道具を『選ぶ』へ戻す」を順にやる。4 の局面では
        // `onDrawingChange` も false を報せている（対象が null なら名乗らない）ので、
        // 名乗りと段が食い違わない。
        //
        // **0 の手前にもう 1 段ある**（増分 5 の手直し 2 回目）: 「捨てますか」の板が
        // 出ていたら、まずそれに答える。答え方は **なぜ聞いているか**で変わる
        // （設計書 §D.4.1 の 4 / 教訓 5.70）。
        if (drillGuard.pending !== null) {
          e.preventDefault();
          if (drillGuard.pending === DISCARD_REASON.Escape) drillGuard.discard();
          else drillGuard.keep();
          return;
        }
        // **素性を入力している局面**（決定 (5) で右パネルへ移った）。欄が「打ちかけ無し」を
        // 名乗っていれば 1 回でやめ、打ちかけがあれば 1 度聞く。**やめた先は「対象を離す」段**
        // （§D.4.1 の階段）で、道具は持ったままである（旧版は道具ごと降りていた）。
        if (drill.flow === DRILL_FLOW.EnteringProperties) {
          e.preventDefault();
          if (inEditable && target?.pristine === false) {
            drillGuard.askOnEscape();
            return;
          }
          drill.releaseTarget();
          unpromoteOwnTarget();
          return;
        }
        if (inEditable) return; // ここから下は文字の欄の中では動かさない。
        if (drill.region.length > 0) {
          e.preventDefault();
          // **確定できる点数（3 点以上）まで来ていたら 1 度聞く**（§D.4.1 の 3）。
          if (drill.region.length >= 3) {
            drillGuard.askOnEscape();
            return;
          }
          drill.discardRegion();
          return;
        }
        if (drill.targetId !== null) {
          e.preventDefault();
          drill.releaseTarget();
          unpromoteOwnTarget();
          return;
        }
        return;
      }
      // ここから下は作図中の打鍵だけ。文字の欄の中は上の関門で既に降りている。
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
  }, [
    drill.flow,
    drill.region,
    drill.targetId,
    drill.cancel,
    drill.discardRegion,
    drill.releaseTarget,
    drill.undoLastVertex,
    unpromoteOwnTarget,
    drillGuard,
  ]);

  // --- Report the in-progress drill to the host so it suspends the GLOBAL shortcut
  // dispatcher (教訓 c1e5534): the controller's OWN Ctrl+Z (undo vertex) is the only
  // handler (no double undo, H2) AND a stray global Delete cannot fire during a drill
  // (H1). The flow is the single truth; we only mirror it up.
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
    const active = drill.flow !== DRILL_FLOW.Idle && drill.targetId !== null;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the dispatcher
    // suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [drill.flow, drill.targetId, onDrawingChange]);

  // --- 新しい地物の素性入力は **右パネルの「新規の姿」**で受ける（司令塔の決定 (5) /
  // 設計書 §B.5 の台帳 #9 / §C.2 の 27）------------------------------------------------
  //
  // **なぜ移すのか**: 同じ「新しい地物の素性を入れる」作業なのに置き場が追加の道具と
  // 2 通りあると、名前欄の焦点も保存ボタンの名前も 2 通りになる。加えて地図の中央の板は
  // **いまくり抜いた形の真上に出る**ので、穴の形を見ながら名前を入れられなかった（追加の
  // 道具が N-15 で直したのと同じ害）。右パネルなら覆わない。
  //
  // **上位領域は聞かない**（`showParent: false`）。新地物の上位領域は
  // `assembleDrillProposal` が元の末端地物から引き継ぐ（FR-45）ので、ここで選ばせると
  // 「選んだのに反映されない欄」になる。
  //
  // **自分の局面でないときは何もしない**（`!drillEntering` で早々に抜ける）。追加・分ける・
  // 穴あけの 3 つが同じ 1 本の口を共有していて 3 つとも同時にマウントされている ――
  // 「自分の番でなければ `null` を押し込む」と書くと、**別の道具が開いている入力待ちを
  // 踏み消す**（教訓 5.68 と同じ形の事故）。後片付けも「自分が押し込んだものがまだ
  // 載っているときだけ」戻す。
  const addDraft = props.addDraft;
  const drillEntering = drill.flow === DRILL_FLOW.EnteringProperties;
  const enteringYear = anchorTime().year;
  const drillSave = drill.save;
  const drillCancel = drill.cancel;
  useEffect(() => {
    if (addDraft === undefined || !drillEntering) return;
    const mine: AddDraftPrompt = {
      // くり抜いて生まれるのは面である（`showParent` を明示しているので、この値から
      // 上位領域の欄の有無は決まらない）。
      tool: ADD_TOOL_KIND.Face,
      parentCandidates: NO_PARENT_CANDIDATES,
      defaultParentId: null,
      currentYear: enteringYear,
      showParent: false,
      onChooseParent: NOOP_CHOOSE_PARENT,
      // **戻り値は丸ごと渡す**（種別ラベルを黙って落とさない ―― 過去に同じ取りこぼしが
      // あった）。`AddProperties` は `drill.save` が受ける形と同じ 3 つ組である。
      onSave: drillSave,
      onCancel: drillCancel,
    };
    addDraft.set(mine);
    // 局面を離れる・道具を降りる・アンマウントの全経路で必ず閉じる（教訓 5.2）。
    return () => {
      if (addDraft.get() === mine) addDraft.set(null);
    };
  }, [addDraft, drillEntering, enteringYear, drillSave, drillCancel]);

  // **モーダルは別に報せる**（増分 5 の手直し A4）。新地物の素性入力は、Escape / Tab しか
  // 自分では受けない本物のモーダルである。
  const onModalChange = props.onModalChange;
  useEffect(() => {
    if (onModalChange === undefined) return;
    // **素性入力はもうモーダルではない**（決定 (5)）。右パネルの「新規の姿」で受けるので、
    // 鍵盤の持ち主は入力欄（`text`）である。**本物のモーダルは「捨てますか」の板だけ**で、
    // これは背面を覆う板を置いた本物のモーダルなので、答えるまで背後で Ctrl+S などが
    // 走ってはいけない（増分 5 の手直し 2 回目）。
    onModalChange(drillGuard.pending !== null);
    return () => onModalChange(false);
  }, [drill.flow, drillGuard.pending, onModalChange]);

  // --- Map-input handler: a LEFT click resolves the feature under it and routes to the
  // hook (target末端 select / region vertex place). The controller owns the hit-test
  // (教訓 5.14); the hook drives the state machine.
  // --- 案内・断り・確定の列をオプションバーへ（増分 5d / 設計書 §C.4 / E-2 / N-27）---
  //
  // 確定欄は 176px ＝ U-8 の下限（幅 60px）で 2 つが限度なので、［確定］［やめる］だけを
  // 置き、残りは設定欄へ差し込む。**testid は 1 つも変えていない**（T-1）。
  const optionBar = props.optionBar;
  // **断られた局面では［確定］を出さない**（増分 5 の手直し B3 / バグ狩り #13）。
  // 旧版は断り文と［やめる］を **地図の中央の板**に出していたが、その板の親は
  // `pointer-events: none` なので **出ているのに押せないボタン**だった。板は消し、
  // 断り文は帯の「次の一手」へ、［やめる］は確定欄へ移す。
  //
  // **素性入力の局面でも［確定］は出さない**（司令塔の決定 (5)）。くり抜く形はもう確定
  // 済みで、次の確定は右パネルの［保存］が持つ ―― 同じ働きのボタンを 2 か所に置くと、
  // 押した側で結果が変わる余地が生まれる。逆に［やめる］は残す: 空にすると名前を打って
  // いる途中で取りやめる手が Escape だけになり、その Escape も右パネルの名前欄に焦点が
  // あるあいだは焦点の守り（`isEditableTarget`）に阻まれて道具へ届かない。
  const drillRejected = drill.flow === DRILL_FLOW.Rejected;
  const drillCommit = useMemo(
    () =>
      drillRejected || drillEntering
        ? [
            {
              id: 'cancel',
              testId: 'drill-cancel',
              label: DRILL_STRINGS.cancel,
              onClick: () => drill.cancel(),
            },
          ]
        : [
            {
              id: 'confirm',
              testId: 'drill-confirm',
              label: DRILL_STRINGS.confirmRegion,
              disabled: !drill.canConfirm,
              onClick: () => drill.confirmRegion(),
            },
            {
              id: 'cancel',
              testId: 'drill-cancel',
              label: DRILL_STRINGS.cancel,
              onClick: () => drill.cancel(),
            },
          ],
    // **同一性を安定させる**（増分 5 の手直し B3 の注記 7）。依存に道具の戻り値を
    // 丸ごと入れると **毎レンダー新しい配列と新しい関数**になり、帯への押し込みが
    // 毎回走る（`setCommit` は `onClick` を同一性で見るので常に「違う」になる）。
    [drillRejected, drillEntering, drill.canConfirm, drill.confirmRegion, drill.cancel],
  );
  // **素性入力に入ったら［1 つ戻す］も引っ込める**（司令塔の決定 (5)）。押せてしまうと
  // **確定済みのくり抜く形から頂点が 1 つ黙って減り、戻したはずの頂点を含まない形が
  // 保存される**（`undoLastVertex` は局面を見ずに配列を削るだけである）。分ける道具は
  // 最初から「分断線を引いている間だけ」出しており、追加の道具も同じ理由で素性入力中は
  // ［1 つ戻す］を出さない ―― ここだけ常時出ていた。
  const drillExtras = useMemo(
    () =>
      drillEntering ? null : (
        <button
          type="button"
          data-testid="drill-undo"
          disabled={drill.region.length === 0}
          onClick={() => drill.undoLastVertex()}
        >
          {DRILL_STRINGS.undoVertex}
        </button>
      ),
    [drillEntering, drill.region, drill.undoLastVertex],
  );
  useToolBarChrome({
    optionBar,
    active: drill.flow !== DRILL_FLOW.Idle,
    slotId: 'drill',
    // **素性入力の局面では行き先まで言う**（司令塔の決定 (5)）。`guideEnterProperties` は
    // 「どこで入れるのか」を言っていない ―― 板が目の前に出ていたころはそれで足りたが、
    // いま欄は右パネルにある。断り（`message`）が出ているときは今までどおり最優先。
    nextStep:
      drill.message ?? (drillEntering ? DRILL_STRINGS.nextStepEnterProperties : drill.guide),
    commit: drillCommit,
    extras: drillExtras,
  });

  // --- 対象欄（240px）は **この道具が自分で押し込む**（増分 5 の手直し B3 / バグ狩り #6）--
  //
  // `shell/ToolOptionBar` の `TOOLS_WITH_OWN_TARGET` に穴あけが入ったので、あちらは
  // `activeFeature` から対象欄を作らない。それまでは **1 度も対象を押していないのに一覧で
  // 選んだ地物の名前が出て**、次の一手の「穴をあける末端地物を選んでください」と矛盾した。
  // 名前の作り方は `describeOptionBarTarget` をそのまま使う（教訓 5.29）。
  //
  // **空へ戻すのは後片付けでやる**（`useToolBarChrome` と同じ理由＝教訓 5.68）。
  const drillArmed = drill.flow !== DRILL_FLOW.Idle;
  const drillStage =
    drill.flow === DRILL_FLOW.EnteringProperties
      ? DRILL_STRINGS.stage(3)
      : drill.targetId === null
        ? DRILL_STRINGS.stage(1)
        : DRILL_STRINGS.stage(2);
  const drillTargetName = useMemo(() => {
    if (drill.targetId === null) return null;
    const feature = resolveFeature(drill.targetId);
    return feature === undefined ? null : describeOptionBarTarget(feature);
  }, [drill.targetId, resolveFeature]);
  useEffect(() => {
    if (optionBar === undefined || !drillArmed) return;
    // **後片付けは「自分が押し込んだ代」のあいだだけ効かせる**（増分 5 の手直し 2 回目。
    // 理由は `shell/useToolBarChrome` の注記と同じ ―― この道具の後片付けは 1 コミット
    // 遅れて走るので、同じ持ち替えで次の持ち主が入れた対象名を踏み消していた）。
    const epoch = optionBar.epoch();
    optionBar.setTarget(drillStage, drillTargetName);
    return () => {
      if (optionBar.epoch() !== epoch) return;
      optionBar.setTarget(null, null);
    };
  }, [optionBar, drillArmed, drillStage, drillTargetName]);

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

      {/* 案内・断り・確定の列は **オプションバーへ移した**（増分 5d / 設計書 §C.4 /
          E-2 / N-27）。ここに残すのは観測のミラーだけである。 */}
      <span className="drill-tool__guide" data-testid="drill-guide" hidden>
        {drill.guide}
      </span>
      {drill.message !== null && (
        <span className="drill-tool__message" data-testid="drill-message" hidden>
          {drill.message}
        </span>
      )}
      <span data-testid="drill-vertex-count" hidden>
        {drill.region.length}
      </span>

      {/* **新地物の素性入力の板は地図から消した**（司令塔の決定 (5) / 設計書 §B.5 の
          台帳 #9 / §C.2 の 27）。素性は **右パネルの「新規の姿」**（`add-property-form`）で
          受ける ―― 板はくり抜いたばかりの形の真上に出るので、穴を見ながら名前を入れられ
          なかった。押し込みは上の `addDraft` の effect が行う。

          `drill-props` は **「素性入力の局面に居る」ことの観測ミラー**として `hidden` で
          残す（T-1 役割はそのまま／T-2 隠し観測は足す一方）。既に `drill-guide` /
          `drill-message` / `drill-vertex-count` / `drill-rejected` が同じ形で残っており、
          探索の spec（`e2e/__visual__/driver-a.spec.ts`）が「いまどの段に居るか」を
          この名前の有無で見ている。 */}
      {drillEntering && <span data-testid="drill-props" hidden />}

      {/* 確定できる形を捨てる前の確認（設計書 §D.4.1 の 3）。**器は追加の道具・分ける
          道具と共有の本物のモーダル**なので、この板が出ているあいだ地図の入力ブリッジは
          背面の覆いに遮られる（K-2 / 教訓 5.14）。 */}
      {drillGuard.pending !== null && (
        <DraftDiscardConfirm
          idPrefix="drill-draft-discard"
          reason={drillGuard.pending}
          vertexCount={drillGuard.vertexCount}
          onKeep={drillGuard.keep}
          onDiscard={drillGuard.discard}
        />
      )}

      {drill.flow === DRILL_FLOW.ConflictPaused && (
        <p data-testid="drill-conflict-paused" role="status">
          {DRILL_STRINGS.conflictPaused}
        </p>
      )}

      {/* **断りの板は地図から消した**（増分 5 の手直し B3 / GPT #11 / バグ狩り #13）。
          旧版はここに［やめる］ボタンを出していたが、親の `.drill-tool` が
          `pointer-events: none` なので **出ているのに押せないボタン**だった。断り文は
          帯の「次の一手」が、［やめる］は帯の確定欄が出す。ここに残るのは観測のミラー
          だけである（testid は役割のまま＝T-1）。 */}
      {drill.flow === DRILL_FLOW.Rejected && drill.message !== null && (
        <span data-testid="drill-rejected" hidden>
          {drill.message}
        </span>
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
