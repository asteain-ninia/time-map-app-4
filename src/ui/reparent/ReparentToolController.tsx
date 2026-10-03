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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { Feature } from '../../domain/feature';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { FeatureId } from '../../domain/ids';
import type { AffiliationSnapshot } from '../../domain/editing/apply-proposal';

import { buildForest } from '../../domain/hierarchy/forest';
import {
  affiliationRejectMessage,
  isLegalNewParent,
  type ParentDecision,
} from '../../domain/affiliation/index';

import { buildReparentHighlight } from '../../render/reaffiliation-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';
import type { SessionStore } from '../state/store';
import { EDIT_MODE } from '../state/session';
import type { OptionBarStore } from '../shell/option-bar';
import { useOptionBarEpoch, useToolBarChrome } from '../shell/useToolBarChrome';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';
import { TOOL_ID } from '../shell/tools';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import { useDeferredCommit, type CommitScheduler } from '../shell/useDeferredCommit';
import { formatYear } from '../timeline/time-display';

import { REPARENT_CHOICE, ReparentOptionsDialog, type ReparentChoice } from './ReparentOptionsDialog';

import { REPARENT_STRINGS } from './strings';
import {
  REPARENT_FLOW,
  REPARENT_TARGET_SOURCE,
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
  /**
   * **本物のモーダルが開いた／閉じた**ことを報せる口（増分 5 の手直し A4 / B4）。
   *
   * `onDrawingChange`（＝下書きを持っている）と **分けて**報せる。両者は鍵盤の持ち主として
   * 意味が違う ―― 下書きを持っているだけなら保存（Ctrl+S）は通してよいが、**モーダルが
   * 開いているあいだは通してはいけない**（確認の背後で保存が走ると、何に対して答えたのか
   * 分からなくなる）。この道具では **最上位化の確認の板**（B4）が本物のモーダルである。
   *
   * ほかの 3 道具（分ける・結ぶ・穴あけ）と同じ形（`KnifeToolController` が手本）。
   */
  readonly onModalChange?: ((open: boolean) => void) | undefined;
  /**
   * 一覧で印を付けた地物（`markedFeatures`。増分 7 の中身 2b）。**2 件以上あるときは
   * それが対象になる** ―― V8「3 件をまとめて連邦にする」の入口である。渡さない
   * ホスト（単体の検査台）では従来どおり地図クリックだけで対象を掴む。
   */
  readonly markedFeatureIds?: readonly FeatureId[] | undefined;
  /**
   * 確定を遅らせる口（進行表示のため）。検査は同期の実装を差し込む
   * （`useDeferredCommit` の注記）。
   */
  readonly commitScheduler?: CommitScheduler | undefined;
  /**
   * **外から 3 択の板を開かせる要求**（素性欄の親欄の 3 ボタン。増分 7 の中身 3b）。
   *
   * `nonce` が変わるたびに、`choice` の枝で板を開く ―― 同じ枝を続けて押しても開き直せる
   * ように、値ではなく回数で駆動する。null なら何もしない。
   */
  readonly openOptionsRequest?:
    | { readonly nonce: number; readonly choice: ReparentChoice }
    | null
    | undefined;
  /**
   * 対象のうち **自分の歴史をまだ持っていない**件数を数える口（司令塔の決定 (1)）。
   * 板の予告に「この操作で自分の歴史を持つようになります」を出すために使う。
   * 道具は根を持たないので、ホストが数えて渡す（教訓 5.29 単一の真実源）。
   */
  readonly countWithoutOwnSeries?: ((featureIds: readonly FeatureId[]) => number) | undefined;
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
  //
  // **これは［やめる］を押されたときの経路だけである**（増分 5 の手直し B1）――
  // ボタンとして「やめる」を押したのは「この作業をやめる」という意思表示だから道具ごと
  // 降りてよい。**Escape はここを通らない**: Escape は 1 回で 1 段だけ戻る階段で、道具を
  // 降りるのは大域の `shell/escape-ladder.ts` の持ち場である（設計書 §D.4）。
  //
  // **`clearSelection()` はもう呼ばない**（GPT #8）。所属変更は自前の `targetId` /
  // `newParentId` だけを持ち、セッションの `activeFeature` は **1 度も書いていない** ――
  // それなのに取りやめのたびに選択を空にしていたので、**道具が掴んだのではない元からの
  // 選択まで巻き添えで消えて**いた。道具が触っていないものは道具が片付けない。
  const releaseToolOnCancel = useCallback(() => {
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
    //
    // **印から来た対象だけを持っているあいだは名乗らない**（増分 7 の手直し 2 回目 / 設計適合
    // 指摘 1）。印は一覧のもので道具の下書きではない（司令塔の決定 (6): 道具の Escape で印を
    // 消さない）。それなのに名乗っていたので、大域の Escape の階段は止められ、道具も Escape を
    // 受けず（印から来た対象は離さない）、**2 回目からの Escape が誰にも受けられず黙って
    // いた**（§D.4「連打すれば必ず素の状態へ戻る」に反する）。名乗らなければ大域の階段が
    // 「選択を外す → 道具を降りる」を進める。新しい上位領域を地図で選びかけたら、それは
    // 道具の下書きなので名乗る（Escape はその選びかけを外す）。
    const holdsOwnDraft =
      reparent.targetSource !== REPARENT_TARGET_SOURCE.Marked || reparent.newParentId !== null;
    const active =
      reparent.flow !== REPARENT_FLOW.Idle && reparent.targetId !== null && holdsOwnDraft;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [reparent.flow, reparent.targetId, reparent.targetSource, reparent.newParentId, onDrawingChange]);

  // --- 最上位化の確認（増分 5 の手直し B4 / バグ狩り B-1 / E4）------------------
  //
  // ［最上位へ（所属を外す）］は **押した瞬間に確定していた**。削除と同じで結果が大きい
  // （その地物はどこにも所属しなくなる）のに、何が起きるかを見せる場が無かった。
  //
  // **確定欄の［確定］には畳まず、この操作専用の確認を出す形にした**（司令塔に任された
  // 判断。理由: ［確定］は「選んだ上位領域へ移す」、最上位化は「上位領域を無くす」で
  // **結果が別物**である。1 つのボタンの意味が隠れた状態で切り替わるほうが危ない ――
  // 押した部品と、出る確認と、起きることが 1 本の線でつながっているほうが読める）。
  // ボタンの置き場と `data-testid` は変えていない（T-1）。
  //
  // **増分 7 で 3 択の板に育てた**（中身 1）。器は 1 つ（`ReparentOptionsDialog`）で、
  // どのボタンから入ったかを「最初に開く枝」として渡す ―― ［所属を変える］は
  // 既存から選ぶ枝、［新しく作る］は作る枝、［最上位へ］は独立の枝。**押した部品と、
  // 出る板の枝と、起きることが 1 本の線でつながる**（増分 5 の手直し B4 の理由をそのまま
  // 3 択へ広げた）。`data-testid="reparent-detach-confirm"` は独立の枝の警告文として
  // 役割ごと残してある（T-1: 役割で維持する）。
  const [optionsChoice, setOptionsChoice] = useState<ReparentChoice | null>(null);
  const optionsOpen = optionsChoice !== null;

  // 対象が消えたら板も畳む（教訓 5.2: 一時的な UI は全経路で捨てる）。対象を離す
  // Escape・［選択を外す］・道具を降りる・確定 ―― どれも対象が空になる。
  const reparentTargetCount = reparent.targetIds.length;
  useEffect(() => {
    if (reparentTargetCount === 0) setOptionsChoice(null);
  }, [reparentTargetCount]);

  // --- 一覧の印を対象として引き継ぐ（増分 7 の中身 2b）------------------------
  //
  // **印は道具のものではない**ので、道具は「いま印が付いているもの」を読むだけで、
  // 印そのものは触らない（消すのは一覧の側）。印が 0 件になったら地図で掴む従来の
  // 手順へ戻る。
  const markedIds = props.markedFeatureIds;
  const markedKey = markedIds === undefined ? '' : markedIds.join(',');
  const setTargets = reparent.setTargets;
  const targetSourceNow = reparent.targetSource;
  useEffect(() => {
    if (!isReparentActive) return;
    if (markedIds === undefined) return;
    if (markedIds.length === 0) {
      // **印を全部外したら道具も対象を離す**（司令塔の決定 (6)）。逆ではない ――
      // 道具側の Escape では印を消さない（印は一覧のものだから）。
      if (targetSourceNow === REPARENT_TARGET_SOURCE.Marked) setTargets([]);
      return;
    }
    setTargets(markedIds, REPARENT_TARGET_SOURCE.Marked);
    // markedKey は配列の同一性ではなく中身で見る（一覧は毎回新しい配列を作る）。
  }, [isReparentActive, markedKey, targetSourceNow]);

  // 素性欄の親欄からの「この枝で板を開いて」（増分 7 の中身 3b）。**対象が入った
  // あとで開く** ―― 印を立てるのと道具を構えるのは合成ルートが先に済ませている。
  const openOptionsRequest = props.openOptionsRequest ?? null;
  const lastOpenNonceRef = useRef<number>(-1);
  useEffect(() => {
    if (openOptionsRequest === null) return;
    if (openOptionsRequest.nonce === lastOpenNonceRef.current) return;
    lastOpenNonceRef.current = openOptionsRequest.nonce;
    if (!isReparentActive) return;
    setOptionsChoice(openOptionsRequest.choice);
  }, [openOptionsRequest, isReparentActive]);

  // --- 確定の進行表示と二重クリックの関門（増分 7 の中身 9）--------------------
  const deferred = useDeferredCommit(
    props.commitScheduler === undefined ? undefined : { schedule: props.commitScheduler },
  );

  /**
   * 候補として選べるか（板のツリーが使う）。**確定と同じ述語**（`isLegalNewParent`）を
   * 洗い直した対象それぞれに掛ける（教訓 5.26）。null なら選べる。
   */
  //
  // **森は 1 度だけ組む**（`useMemo`）。板は候補の行ごとにこれを呼ぶので、行ごとに
  // 組み直すと 775 地物 × 8 行ぶんの走査になる（実データでは体感できる遅さになる）。
  // 板が開いているあいだ地物は変わらない（背面の覆いで触れない）ので、開いた時点の
  // 森で足りる。
  const optionsForest = useMemo(
    () => (optionsChoice === null ? null : buildForest(resolveFeatures())),
    [optionsChoice, resolveFeatures],
  );
  const eligibility = useCallback(
    (candidateId: FeatureId): string | null => {
      const forest = optionsForest ?? buildForest(resolveFeatures());
      for (const leafId of reparent.plan.leafIds) {
        const verdict = isLegalNewParent(forest, leafId, candidateId);
        if (!verdict.ok) return affiliationRejectMessage(verdict.reason);
      }
      return null;
    },
    [optionsForest, resolveFeatures, reparent.plan],
  );

  const confirmFromDialog = useCallback(
    (decision: ParentDecision, options: { readonly directDomainNameOverride?: string }): void => {
      deferred.run(() => {
        // **断られたら板を閉じない**（反証 2-12）。閉じると、入力した名前も選んだ
        // 行き先も一緒に消えて、理由を読んだあと最初からやり直しになる。
        if (reparent.confirmWith(decision, options)) setOptionsChoice(null);
      });
    },
    [deferred, reparent],
  );

  // 板が開いているあいだは鍵盤の持ち主が `modal` になる（＝背後で Ctrl+S / Delete が
  // 走らない）。ほかの 3 道具と同じ形（`KnifeToolController` が手本＝増分 5 の手直し A4）。
  // 板が出ていると名乗るのは **板の側の仕事**（司令塔の決定 (13)）。ここで
  // `optionsOpen` を見て名乗ると、板を足すたびにこの effect を直す作業が要り、
  // 増分 7 で実際に 5 枚ぶん漏れた。いまは `ReparentOptionsDialog` へ口を渡すだけ。
  const onModalChange = props.onModalChange;

  // --- Keyboard: Escape (FR-78 / 設計書 §D.4). Active while a session runs.
  //
  // **ConflictPaused では降りる**（増分 5 の手直し B1 で分ける・結ぶ・穴あけへ揃えた）。
  // そこでは競合解決の板が Escape の持ち主で、道具側が対象を離すと、板が閉じたあとの
  // ホストの再武装が拾うものを失う。
  useEffect(() => {
    if (
      reparent.flow === REPARENT_FLOW.Idle ||
      reparent.flow === REPARENT_FLOW.ConflictPaused
    ) {
      return;
    }
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
        // **1 回の Escape で 1 段だけ**戻る。旧版は 1 回で「手順の対象」「元からの選択」
        // 「道具」の三段をまとめて捨てていた（GPT #8）―― この道具は選択を昇格させて
        // いないので、消えていたのは **利用者が道具の外で選んだもの**である。
        //
        //   0. 最上位化の確認が出ている → 板を閉じる（選んだものはそのまま残す）
        //   1. 新しい上位領域を選びかけ → **その選びかけだけ外す**（対象も道具も保つ）
        //   2. 対象を掴んでいる → 対象だけ離す（道具は持ったまま）
        //   3. どちらも無い → **何もせず大域の階段へ譲る**（preventDefault もしない）
        //
        // 3 で止めないのが肝である ―― 大域の `shell/escape-ladder.ts` が「頂点を外す →
        // 地物の選択を外す → 道具を『選ぶ』へ戻す」を順にやる。3 の局面では
        // `onDrawingChange` も false を報せている（対象が null なら名乗らない）ので、
        // 名乗りと段が食い違わない。
        if (optionsOpen) {
          e.preventDefault();
          // **確定が始まっていれば閉じない**（司令塔の決定 (9) / 反証 2-11）。閉じても
          // 確定は走り切るので、板だけ消えると「押していないのに変わった」に見える。
          if (!deferred.busy) setOptionsChoice(null);
          return;
        }
        if (reparent.newParentId !== null) {
          e.preventDefault();
          reparent.clearNewParent();
          return;
        }
        if (reparent.targetId !== null) {
          // **印から来た対象は道具側で離さない**（バグ狩り #9 / 司令塔の決定 (6)）。
          // 離すと帯は「選んでいません」になるのに一覧は「対象 3 件」のままで、
          // どちらが本当かが読めなくなる。印がある限り対象は印から引く 1 つの源に
          // する ―― 外すのは一覧の［対象を全部外す］である。この局面では道具は鍵盤を
          // 名乗っていないので（上の `onDrawingChange`）、Escape は大域の階段が受ける。
          if (reparent.targetSource === REPARENT_TARGET_SOURCE.Marked) return;
          e.preventDefault();
          reparent.clearSelection();
          return;
        }
        return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [
    reparent.flow,
    reparent.targetId,
    reparent.newParentId,
    reparent.clearNewParent,
    reparent.clearSelection,
    reparent.targetSource,
    optionsOpen,
    deferred.busy,
  ]);

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
    // **対象は全件を塗る**（反証 2-2）。旧版は先頭 1 件だけだったので、3 件をまとめて
    // 動かしているのに地図では 1 件しか色が付かなかった。
    const targetShapes =
      resolveLeafShape === undefined
        ? []
        : reparent.targetIds.map((id) => resolveLeafShape(id));
    const newParentShape =
      resolveLeafShape && reparent.newParentId !== null
        ? resolveLeafShape(reparent.newParentId)
        : undefined;
    drawSink.drawHighlight(buildReparentHighlight({ targetShapes, newParentShape }));
  }, [reparent.targetIds, reparent.newParentId, resolveLeafShape, drawSink]);

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
  // **消す経路**（対象を外す・道具を降りる・モードを離れる・確定して選び直しへ戻る）は
  // **後片付け関数 1 本**に寄せる（増分 5 の手直し B3。`useToolBarChrome` が同じ理由で
  // そうしている＝教訓 5.68）。5 つの道具のコントローラは全部が同時にマウントされている
  // ので、effect の本体に「構えていないなら空へ」と書くと **構えていない道具が構えている
  // 道具の押し込みを踏み消す**。React は 1 つのコミットの中で「全部の後片付け → 全部の
  // 再実行」の順に走らせるので、後片付けへ置けば木の位置に関わらず「前の道具が空へ戻す →
  // 次の道具が押し込む」になる。旧版の「自分が押し込んだ印」方式は、いま帯を持っている
  // のが誰かを知らないので踏み消しの半分しか塞げていなかった。
  //
  // **段階表示**（「手順 n/3」）と **移し先**も一緒に出す（設計書 §C.4 の
  // 「**手順 2/3** 対象: 南ケナ州 → 親: ?」/ バグ狩り #9）。旧版は対象の名前しか出して
  // いなかったので、**どこへ移そうとしているのかが画面のどこにも出ていなかった**。
  const optionBar = props.optionBar;
  const reparentArmed = reparent.flow !== REPARENT_FLOW.Idle;
  // **帯へ押し込む条件は「店の真実（いま構えている道具）」と AND する**（手直し 3 回目）。
  // 道具の `flow` は自分の state なので、`activeTool` が外れてから畳まれるまで **1 コミット
  // 遅れる**。その 1 コミットのあいだに押し直すと、**降りたばかりの道具が次の持ち主の
  // 中身を自分のもので上書きする**（実測: 分ける → 選ぶ で対象欄が「手順 1/4（選んで
  // いません）」になり、そのあと空で固まった）。押し込みは店が「いまこの道具」と
  // 言っているあいだだけにする。
  const reparentArmedHoldsBar = reparentArmed && isReparentActive;
  const reparentStage = optionsOpen
    ? REPARENT_STRINGS.stage(3)
    : reparent.targetId === null
      ? REPARENT_STRINGS.stage(1)
      : reparent.newParentId === null
        ? REPARENT_STRINGS.stage(2)
        : REPARENT_STRINGS.stage(3);
  const reparentTargetName = useMemo(() => {
    if (reparent.targetId === null) return null;
    const features = resolveFeatures();
    // **全件を名乗る**（反証 2-2）。旧版は先頭 1 件しか出していなかったので、3 件を
    // まとめて動かしているのに帯には 1 件ぶんの名前しか出ず、何件を相手にしているのかが
    // 画面のどこにも出ていなかった。
    const names = reparent.targetIds
      .map((id) => describeFeatureById(features, id))
      .filter((n): n is string => n !== null);
    const head = names[0];
    if (head === undefined) return null;
    const target =
      names.length === 1 ? head : REPARENT_STRINGS.targetWithRest(head, names.length - 1);
    if (optionsOpen) {
      return REPARENT_STRINGS.targetWithParent(target, REPARENT_STRINGS.parentDetached);
    }
    const parent =
      reparent.newParentId === null
        ? REPARENT_STRINGS.parentUnset
        : (describeFeatureById(features, reparent.newParentId) ?? REPARENT_STRINGS.parentUnset);
    return REPARENT_STRINGS.targetWithParent(target, parent);
  }, [reparent.targetId, reparent.targetIds, reparent.newParentId, optionsOpen, resolveFeatures]);
  // 器が持ち直されたら押し直すために、代を React の値として読む（手直し 3 回目）。
  const optionBarEpoch = useOptionBarEpoch(optionBar);
  // **書いた人の印**（手直し 3 回目）。空へ戻すのは自分が最後に書いたときだけ。
  const targetWriterRef = useRef<object>({});
  useEffect(() => {
    if (optionBar === undefined || !reparentArmedHoldsBar) return;
    // **後片付けは「自分が最後に書いた」ときだけ効かせる**（増分 5 の手直し 2〜3 回目。
    // 理由は `shell/useToolBarChrome` の注記と同じ ―― この道具の後片付けは 1 コミット
    // 遅れて走るので、同じ持ち替えで次の持ち主が入れた対象名を踏み消していた）。
    //
    // **`optionBarEpoch` を依存に入れて押し直す**（手直し 3 回目）。器が持ち直されると
    // 中身は空へ戻るので、押し込んだ側が黙っていると対象欄が空のまま固まる。
    const targetWriter = targetWriterRef.current;
    optionBar.setTarget(reparentStage, reparentTargetName, targetWriter);
    return () => {
      optionBar.clearTargetIfMine(targetWriter);
    };
  }, [optionBar, reparentArmedHoldsBar, reparentStage, reparentTargetName, optionBarEpoch]);

  // --- Map-input handler: a LEFT click resolves the feature under it and feeds it to
  // the hook (first = target, second = new parent). The overlay never steals other
  // input — the input layer sits above the map and forwards here only while a session
  // runs.
  // --- 案内・断り・確定の列をオプションバーへ（増分 5d / 設計書 §C.4 / E-2 / N-27）---
  //
  // 確定欄は 176px ＝ U-8 の下限（幅 60px）で 2 つが限度なので、［確定］［やめる］だけを
  // 置き、残りは設定欄へ差し込む（増分 3 の `add-undo` と同じ形）。**testid は 1 つも
  // 変えていない**（T-1: 役割で維持する。置き場が移っただけ）。
  const reparentCommit = useMemo(
    () => [
      {
        id: 'confirm',
        testId: 'reparent-confirm',
        label: REPARENT_STRINGS.confirm,
        // **対象さえ掴んでいれば押せる**（増分 7 の中身 1）。旧版は「新しい上位領域を
        // 地図でクリック済み」までを条件にしていたので、**地図に描かれていない集約を
        // 親にしたい人はここへ辿り着けなかった** ―― いまは押すと 3 択の板が開き、親は
        // 台帳と同じツリーから選べる。
        disabled: reparent.targetIds.length === 0,
        onClick: () => setOptionsChoice(REPARENT_CHOICE.Existing),
      },
      {
        id: 'cancel',
        testId: 'reparent-cancel',
        label: REPARENT_STRINGS.cancel,
        onClick: () => reparent.cancel(),
      },
    ],
    // **同一性を安定させる**（増分 5 の手直し B3 の注記 7）。依存に道具の戻り値を
    // 丸ごと入れると **毎レンダー新しい配列と新しい関数**になり、帯への押し込みが
    // 毎回走る（`setCommit` は `onClick` を同一性で見るので常に「違う」になる）。
    [reparent.targetIds.length, reparent.cancel],
  );
  const reparentExtras = useMemo(
    () => (
      <>
        {/* 最上位化（parentNone）: 対象を掴んだ時点で押せる（FR-46 独立 / 解体の
            構成要素）。確定欄は 2 つで満杯なので設定欄に置く。
            **押した瞬間には確定しない**（増分 5 の手直し B4）―― 何が起きるかを見せる
            確認を 1 度挟む。 */}
        <button
          type="button"
          data-testid="reparent-confirm-none"
          disabled={!reparent.canConfirmNone}
          onClick={() => setOptionsChoice(REPARENT_CHOICE.None)}
        >
          {REPARENT_STRINGS.confirmNone}
        </button>
        {/* **新しい上位領域を作る**（`parentCreate` / `parentCreateWithTerminal` の
            入口。G-3 / FR-46 must / FR-47）。増分 6 までは呼び出し側が 1 つも無く、
            連邦化・自治化が画面から到達不能だった。 */}
        <button
          type="button"
          data-testid="reparent-create-parent"
          disabled={!reparent.canConfirmNone}
          onClick={() => setOptionsChoice(REPARENT_CHOICE.Create)}
        >
          {REPARENT_STRINGS.parentCreate}
        </button>
        <button
          type="button"
          data-testid="reparent-clear"
          disabled={reparent.targetIds.length === 0}
          onClick={() => reparent.clearSelection()}
        >
          {REPARENT_STRINGS.clear}
        </button>
      </>
    ),
    [reparent.canConfirmNone, reparent.targetIds.length, reparent.clearSelection],
  );
  useToolBarChrome({
    optionBar,
    active: reparentArmedHoldsBar,
    slotId: 'reparent',
    nextStep: reparent.message ?? reparent.guide,
    commit: reparentCommit,
    extras: reparentExtras,
  });

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
          (pan / zoom keep working). **確認の板が出ているあいだは降ろす**（増分 5 の
          手直し B4）―― 板の背面で地物を選び替えられると、「何に対して答えたのか」が
          分からなくなる。 */}
      {!optionsOpen && (
        <ReparentInputBridge
          onMapPointerDown={onMapPointerDown}
          onMapWheel={onMapWheel}
          onMapCameraPointerDown={onMapCameraPointerDown}
          onMapCameraPointerMove={onMapCameraPointerMove}
          onMapCameraPointerUp={onMapCameraPointerUp}
          onMapCameraPointerCancel={onMapCameraPointerCancel}
        />
      )}

      {/* 案内と断りは **オプションバーの「次の一手」** が本文を出す（増分 5 の手直し B3 /
          設計書 §C.4・§B.5 の台帳 #2〜#3）。**ここに残すのは観測のミラーだけ**で、地図の
          上には描かない ―― 旧版はこの 2 つだけが `hidden` になっておらず、地図の上端に
          黒帯として出たまま、同じ文言が帯の「次の一手」にも出る **二重表示**だった
          （増分 5 の審査で指摘された残り 1 件）。ほかの 4 道具と同じ形に揃える。 */}
      <span className="reparent-tool__guide" data-testid="reparent-guide" hidden>
        {reparent.guide}
      </span>

      {reparent.message !== null && (
        <span className="reparent-tool__message" data-testid="reparent-message" hidden>
          {reparent.message}
        </span>
      )}

      {/* **3 択の作業ダイアログ**（増分 7 の中身 1・2・4・9・11）。押した部品が
          「最初に開く枝」を決める ―― ［所属を変える］は既存から選ぶ枝、［新しく作る］は
          作る枝、［最上位へ］は独立の枝。器は 1 つで、確認・予告・分け残しの名前・
          進行表示もここが持つ（設計書 §B.5「作業ダイアログは器 1 種類」）。 */}
      {optionsChoice !== null && (
        <ReparentOptionsDialog
          {...(onModalChange ? { onModalChange } : {})}
          materializingCount={props.countWithoutOwnSeries?.(reparent.plan.leafIds) ?? 0}
          features={resolveFeatures()}
          plan={reparent.plan}
          initialChoice={optionsChoice}
          initialParentId={reparent.newParentId}
          eligibility={eligibility}
          yearLabel={formatYear(anchorTime().year)}
          message={reparent.message}
          committing={deferred.busy}
          onConfirm={confirmFromDialog}
          onCancel={() => setOptionsChoice(null)}
        />
      )}

      {/* **確定の列はここには無い**（増分 5d）。オプションバーの確定欄 176px へ移した
          （設計書 §C.4 / E-2 / N-27）。地図に重ならないので K-2 の事故が構造的に
          起こり得ない。残っているのは観測だけである。 */}
      <span data-testid="reparent-target" hidden>
        {reparent.targetId === null ? '' : String(reparent.targetId)}
      </span>
      <span data-testid="reparent-parent" hidden>
        {reparent.newParentId === null ? '' : String(reparent.newParentId)}
      </span>
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
