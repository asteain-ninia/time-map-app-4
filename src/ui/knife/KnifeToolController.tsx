// U26 — the knife-tool INTEGRATION component (FR-90 / FR-92 / FR-93 / FR-94,
// 教訓 5.2 / 5.7 / 5.8 / 5.11 / 5.14).
//
// This is the layer-crossing wiring the spec's 実装方針 demands: the pure
// {@link useKnifeTool} hook + the pure {@link buildKnifePrimitives} render-batch
// builder are USELESS until the UI calls them. This component is that call site —
// the消費する ui コンシューマ the integration lens flagged as missing. It binds to the
// single-truth session store (U16), and:
//   - starts / discards a knife session from the toolbar tool + mode (教訓 5.2 全
//     経路): selecting `edit.knife` in 編集モード starts; leaving the tool / mode
//     funnels through `resetForSwitch` so no一時状態 leaks (受け入れ基準 8);
//   - turns map-input pointer events into target selection (SelectingTarget) or cut
//     points (DrawingCut), with the固定円ヒット優先 designed alongside the visual
//     overlay (教訓 5.14): a click while drawing first asks "inside the固定円?" and
//     routes to閉線確定 vs頂点追加 accordingly;
//   - wires every COMPLETE trigger (confirmCut / confirmInheritor / save) to the
//     hook (教訓 5.7); 確定 assembles the proposal and runs U13 (FR-94);
//   - wires Escape→cancel and Ctrl+Z→undo (FR-78);
//   - feeds `buildKnifePrimitives(state)` to the injected render sink on every state
//     change so the overlay / target emphasis / cut preview / 固定円 are drawn (FR-90
//     / FR-92), and hands 非継承側プロパティ入力 to the RIGHT PANEL's「新規の姿」through
//     the shared {@link AddDraftStore} (FR-93 / 司令塔の決定 (5)): the same U23 form the
//     add tool uses, at the same place, so the map is never covered by the form. The
//     対象面強調 geometry is resolved from THIS session's own `targetId` through the
//     injected `resolveLeafShape` — the same live-lookup the host's `featureAtPoint`
//     picks from — so 強調 == クリックで取得した対象 (W3-A 単一真実源, 教訓 5.29).
//
// The component holds NO domain truth and writes the store ONLY through the
// host-supplied `onCommitted` (教訓 5.22 確定までの非破壊 / 単一の真実源).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { ColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { EditProposal, ProcessResult } from '../../domain/consistency/index';
import type { GeoMultiPolygon } from '../../domain/geometry/types';
import type { FeatureId } from '../../domain/ids';
import { featureDisplayName } from '../../domain/feature';
import { createGeoParams } from '../../domain/geo/geo-params';
import { multiPolygonAreaKm2 } from '../../domain/geo/geodesy';
import {
  KNIFE_LINE_KIND,
  KNIFE_PHASE,
  largestPieceIndex,
  smallestPieceIndex,
  shouldCloseOnCircleClick,
  splitsIntoManyPieces,
  type SplitSnapshot,
} from '../../domain/knife/index';
import { formatAreaKm2 } from '../property/messages';

import { buildKnifePrimitives, DEFAULT_KNIFE_STYLE, type KnifeStyle } from '../../render/knife-batch';
import type { DrawPrimitive } from '../../render/map-renderer';
import { type MapCameraInput, NOOP_MAP_CAMERA_INPUT } from '../map/index';

import type { SessionStore } from '../state/store';
import { TOOL_ID } from '../shell/tools';
import { EDIT_MODE } from '../state/session';
import { editableTargetFromEvent, isEditableTarget } from '../shell/focus-guard';
import type { OptionBarStore } from '../shell/option-bar';
import { useOptionBarEpoch, useToolBarChrome } from '../shell/useToolBarChrome';
import { describeOptionBarTarget } from '../shell/ToolOptionBar';
import {
  DISCARD_REASON,
  DraftDiscardConfirm,
  confirmBlocksToolKey,
} from '../shell/DraftDiscardConfirm';
import { DRAFT_DISCARD_STRINGS } from '../shell/strings';
import { useDraftSwitchGuard, type DraftSwitchGuard } from '../shell/useDraftSwitchGuard';
import type { DraftLostHandler } from '../shell/useDraftTimeGate';
import { useDeferredCommit, type CommitScheduler } from '../shell/useDeferredCommit';

import type { AddDraftPrompt, AddDraftStore } from '../add/add-draft-store';
import { ADD_TOOL_KIND, type ParentCandidate } from '../../domain/add/index';

import { InheritorModal } from './InheritorModal';
import { KNIFE_STRINGS } from './strings';
import {
  KNIFE_FLOW,
  useKnifeTool,
  type ResolveAnchorTime,
  type ResolveFeature,
  type ResolveVertexStore,
  type StartSplitProcess,
} from './useKnifeTool';
import { type SplitIdPorts } from '../../domain/knife/index';

// --- Injected ports (the layer-crossing contracts; 教訓 5.33) ----------------

/** The render sink the provisional knife primitives are pushed into (U17). */
export interface KnifeDrawSink {
  drawKnife(primitives: readonly DrawPrimitive[]): void;
}

/** Convert a pointer event's client position to a world coordinate (U17). */
export type ScreenToWorld = (clientX: number, clientY: number) => WorldCoordinate;

/** Resolve the feature id under a click (host hit-test; U22/U10). null = miss. */
export type FeatureAtPoint = (point: WorldCoordinate) => FeatureId | null;

/**
 * Resolve a target leaf id → its resolved shape for the対象面強調 (host live-lookup
 * `leafShapeAt`; W3-A). It is the SAME live-lookup source {@link FeatureAtPoint}
 * (`leafAtPoint`) picks from, so 強調される形 == クリックで取得した対象 == 実際に切られる
 * 形 (単一真実源, 教訓 5.29 — mirrors the merge / reparent `resolveLeafShape` port).
 */
export type ResolveLeafShape = (featureId: FeatureId) => GeoMultiPolygon | undefined;

/** The fixed-circle screen radius in world degrees at the current zoom (FR-17). */
export type CircleWorldRadius = () => number;

export interface KnifeToolControllerProps<S> {
  readonly store: StoreApi<SessionStore<S>>;
  /**
   * オプションバー（設計書 §C.4）。**確定の列はここへ出す**（増分 5d / E-2）――
   * 地図の下端中央に浮かせていた列を降ろすことで、地図のクリックを奪う事故（K-2）が
   * 構造的に起こり得なくなる。渡さなければ従来どおり何も押し込まない。
   */
  readonly optionBar?: OptionBarStore | undefined;
  /** U13 process-start adapter (host-bound; spec §依存 U13). */
  readonly startProcess: StartSplitProcess<S>;
  /** Injected id minting (NFR 5.8). */
  readonly ids: SplitIdPorts;
  /** Resolve a clicked feature id → domain Feature (LEAF gate is in the hook). */
  readonly resolveFeature: ResolveFeature;
  /** Resolve the live vertex store for geometry. */
  readonly resolveStore: ResolveVertexStore;
  /** The anchor time the split confirms at (UI 文脈優先). */
  readonly anchorTime: ResolveAnchorTime;
  /** Pointer client-coords → world (U17). */
  readonly screenToWorld: ScreenToWorld;
  /** Feature id under a world point (host hit-test). */
  readonly featureAtPoint: FeatureAtPoint;
  /**
   * Resolve the TOOL'S OWN target leaf id → its shape for the対象面強調 (W3-A).
   * Omitted ⇒ no emphasis is drawn (a host without a live domain).
   */
  readonly resolveLeafShape?: ResolveLeafShape | undefined;
  /** The provisional-knife render sink (U17). */
  readonly drawSink: KnifeDrawSink;
  /**
   * Forward the camera-only raw events (wheel + non-left pointer) from the knife
   * input bridge to the live map dispatcher (bughunt: ナイフ描画中の中ボタンパン/
   * ホイールズーム). The bridge covers the whole map while selecting / drawing
   * (教訓 5.14), so without this the wheel / middle-button events it captures never
   * reach the dispatcher and 地図のパン/ズームが死ぬ. Optional: defaults to a no-op.
   */
  readonly mapCameraInput?: MapCameraInput | undefined;
  /** Host commit handler (教訓 5.11): swap state + re-resolve selection. */
  readonly onCommitted?: ((result: ProcessResult<S>, snapshot: SplitSnapshot) => void) | undefined;
  /** Host conflict handler (FR-62): open the conflict-resolution flow. */
  readonly onConflicts?:
    | ((result: ProcessResult<S>, proposal: EditProposal<SplitSnapshot>) => void)
    | undefined;
  /**
   * Report whether a knife session is in progress (bughunt3). The host raises the
   * global-shortcut suspension while this is true so the controller's OWN Ctrl+Z
   * (undoCutPoint during DrawingCut, FR-78) is the only handler — the global EditUndo
   * no longer also fires (H2 二重undo) — AND so a stray global Delete cannot hit the
   * active feature while the InheritorModal / property form (H1 modal-pass-through) is
   * up. Fires `true` whenever the flow is past Idle, `false` on return to Idle.
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
   * 確定を遅らせる口（進行表示のため）。検査は同期の実装を差し込む
   * （`useDeferredCommit` の注記）。
   */
  readonly commitScheduler?: CommitScheduler | undefined;
  /**
   * **打ちかけの分断線を捨てたことを伝える口**（増分 5 の手直し 2 回目。追加の道具の
   * `onDraftDiscarded` と同じ役割）。捨てた頂点の数を状態行へ出すために要る ――
   * 黙って消さないのがこの増分の規律である（設計書 §D.4.1）。
   */
  readonly onDraftDiscarded?: ((count: number) => void) | undefined;
  /** 年の移動・設定の補正・読み込みで捨てたものを報せる口（B112）。 */
  readonly onDraftLost?: DraftLostHandler | undefined;
  /** 掴んでいた面がいまの年に居なくなり、手放したことを伝える口（B112）。 */
  readonly onTargetGone?: (() => void) | undefined;
  /**
   * 非継承側の素性入力を **右パネルの「新規の姿」**へ渡す口（司令塔の決定 (5) /
   * 設計書 §B.5 の台帳 #9 / §C.2 の 27）。追加の道具（`AddToolController`）と同じ橋で、
   * 地図の真ん中に板を出さないために要る。
   *
   * **省略できるのは型の上だけ**である。渡さないと「素性を入れる局面なのに入力の口が
   * どこにも無い」＝手順が進まない状態になるので、合成ルートは必ず渡すこと（単体テストも
   * `AddDraftForm` を一緒に載せる形にしてある）。
   */
  readonly addDraft?: AddDraftStore | undefined;
  /**
   * A sensible color for the非継承側 new feature when the form omits it (FR-97).
   *
   * **いまは誰も読んでいない**（司令塔の決定 (5)）。地図の板だったころから
   * `NonInheritedForm` はこの値を受け取るだけで使っておらず、色は右パネルの
   * `AddPropertyForm` が自分の既定（`DEFAULT_NEW_FEATURE_FILL_OPACITY` を掛けた
   * 1 本）を入れている。合成ルートと単体テストが渡している口なので**型としては残す**が、
   * 外すなら合成ルート側の 2 行と一緒に消す仕事である（司令塔へ申し送り）。
   */
  readonly defaultColor: ColorInfo;
  /** Provisional draw style override. */
  readonly style?: KnifeStyle | undefined;
}

/**
 * 上位領域の候補は **常に空**である（`showParent: false` なので欄そのものが出ない）。
 * 毎レンダー新しい配列を作らないよう 1 本に固定する（`AddDraftStore` は中身を同一性で
 * 見るので、作り直すと押し込むたびに購読者へ通知が飛ぶ）。
 */
const NO_PARENT_CANDIDATES: readonly ParentCandidate[] = [];

/**
 * 上位領域は **ドメインが元の面から引き継ぐ**（FR-44）ので、選ばせない＝選ばれても何も
 * しない。`showParent: false` と対で置く（欄が出ないので呼ばれることは無いが、口は塞ぐ）。
 */
const NOOP_CHOOSE_PARENT = (): void => {
  /* 非継承側の上位領域は assembleSplitProposal が元の面から継ぐ (FR-44) */
};

const NOOP_COMMITTED = (): void => {
  /* host did not bind a commit handler; nothing to swap */
};

export function KnifeToolController<S>(props: KnifeToolControllerProps<S>): JSX.Element | null {
  const {
    store,
    startProcess,
    ids,
    resolveFeature,
    resolveStore,
    anchorTime,
    screenToWorld,
    featureAtPoint,
    resolveLeafShape,
    drawSink,
    onConflicts,
    style,
  } = props;
  const optionBar = props.optionBar;
  const mapCameraInput = props.mapCameraInput ?? NOOP_MAP_CAMERA_INPUT;

  // ROOT FIX (bughunt2: per-wheel-notch App re-render re-rendered ALL overlay
  // controllers). The固定円 world radius (circleRadiusPx / zoom) and the閉線スナップ
  // 判定 must track the LIVE camera zoom, but the zoom scalar used to be LIFTED into
  // App (useStore at the App level) and threaded down as a `zoom` prop. Because the
  // render-camera mirror writes a new store.camera.zoom on EVERY wheel notch, that
  // App-level subscription re-rendered the WHOLE overlay subtree once per notch
  // (技術方針 2.3 の部分後退). Subscribing to the zoom HERE — the ONLY consumer —
  // keeps the固定円 reactive while leaving the zoom scalar OFF the App render path,
  // so a wheel notch re-renders只 this controller, not its siblings (二重真実源を
  // 作らない: the store camera stays the single zoom truth, 教訓 5.29).
  const zoom = useStore(store, (s) => s.camera.zoom);

  const onCommitted = props.onCommitted ?? NOOP_COMMITTED;

  // HB3-6 / HB3-18: when the knife picks a (leaf) target, promote it into the store
  // selection through the SAME setActiveFeature path every selection uses (no second
  // selection source, 教訓 5.29), so the target is also drawn in the selection color and
  // is the Delete / property-panel subject. The対象面強調 geometry does NOT come from this
  // selection — it is resolved from the tool's own target below (W3-A 単一真実源).
  //
  // **昇格させた対象を覚えておく**（増分 5 の手直し B1）。戻すときに「自分が昇格させた
  // ものかどうか」を見分けるために要る ―― 覚えていないと、道具が触っていない選択まで
  // 巻き添えに消してしまう（下の {@link unpromoteOwnTarget} の注記）。
  const promotedTargetRef = useRef<FeatureId | null>(null);
  /**
   * **道具を構える前から選ばれていたもの**（増分 5 の手直し 2 回目）。設計書 §D.4.1 の
   * 表は「対象を離す／元からの選択: **保つ**」と定めているのに、分ける・輪郭・穴あけの
   * 3 つは対象を離すと選択が `null` になっていた（結ぶ・所属は自前の対象を持つので
   * 元から保っていた）。昇格の直前の値を控え、離すときにそこへ戻す。
   */
  const previousSelectionRef = useRef<FeatureId | null>(null);
  const promoteTargetSelection = useCallback(
    (fid: FeatureId) => {
      const s = store.getState();
      // 1 度の手順のあいだに対象を選び直しても、控えるのは **最初の 1 回だけ**
      // （2 回目に控えると「前の対象」に戻ってしまう）。
      if (promotedTargetRef.current === null) previousSelectionRef.current = s.activeFeature;
      promotedTargetRef.current = fid;
      s.setActiveFeature(fid);
    },
    [store],
  );

  // **自分が昇格させた対象だけを選択から戻す**（増分 5 の手直し B1 / GPT #8）。
  //
  // 旧版はここで `clearSelection()` を呼んでいた ―― 頂点の選択も、道具が触っていない
  // 地物の選択も、まとめて空にする。設計書 §D.4 の階段は「対象を離す」であって
  // 「選択を全部捨てる」ではないので、**自分が `setActiveFeature` で押し込んだ id が
  // まだ選ばれているときに限って** null へ戻す。別のものが選ばれていれば、それは
  // 利用者が道具の外で選び直したということなので触らない。
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

  // W3-B — CANCEL = leave the tool. **これは「やめる」と言われたときの経路だけである**
  // （［やめる］ボタン・拒否の dismiss・継承先の板や素性入力の板の取消）。ボタンとして
  // ［やめる］を押したのは「この作業をやめる」という意思表示だから、道具ごと降りてよい。
  //
  // **Escape はここを通らない**（増分 5 の手直し B1 / 設計書 §D.4）。Escape は 1 回で
  // 1 段だけ戻る階段で、道具を降りるのは階段のいちばん下 ―― そこは大域の
  // `shell/escape-ladder.ts` の持ち場なので、道具側からは `setActiveTool(null)` を
  // 呼ばない。下の keydown の注記を参照。
  //
  // Un-promoting the target alone left the toolbar button `aria-pressed=true` while the
  // session was disarmed, so pressing the SAME button again ran the store's press-toggle
  // (tool → null) instead of re-arming — the knife could only be revived by detouring
  // through another tool. Releasing `activeTool` here keeps the toolbar's pressed state
  // and the session's armed state ONE truth (教訓 5.2 全経路で破棄 + 単一の真実源), so the
  // next press always re-arms. Same規約 as ring-edit (8950639).
  const releaseToolOnCancel = useCallback(() => {
    unpromoteOwnTarget();
    store.getState().setActiveTool(null);
  }, [unpromoteOwnTarget, store]);

  const knife = useKnifeTool<S>({
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

  // --- W3-A: the対象面強調 geometry. THE TOOL'S OWN target (`knife.state.targetId`) is
  // the single source — NOT the store's `activeFeature`. The old App-level hook keyed the
  // emphasis on the selection, which (a) drew an amber "target" over a leftover selection
  // while the knife was still ASKING for a target, and (b) drifted from the click's own
  // resolution: 対象取得 went through the display-resolved `drawnAreaAt` (the drawn
  // AGGREGATE id) while the emphasis went through the raw-leaf `leafShapeAt`, so at the
  // default 集約表示 the highlight either vanished (FR-35 shapeless aggregate) or lit up
  // the parent's OWN footprint somewhere else entirely (FR-37 直轄領構成). Resolving the
  // tool's own target through the SAME live-lookup the host's `featureAtPoint` picks from
  // makes 強調 == クリックで取得した対象 == 実際に切られる形 (単一真実源, 教訓 5.29;
  // merge / reparent already do exactly this, HB3-15(c) / HB3-16).
  //
  // Memoized on the session state so a camera-only re-render (this controller subscribes
  // to `zoom` for the固定円) never re-resolves the geometry — camera stays off the
  // shape-resolution path (技術方針 2.3).
  //
  // W3-AB fix-forward (レビュー HIGH「取得済み target が時刻/FR-113 に追随しない」): the
  // memo ALSO keys on the live inputs the injected `resolveLeafShape` reads at call time —
  // 時刻 / domain / FR-113 filter / display-control. The removed `useKnifeTargetShape` hook
  // subscribed to the store and so re-resolved on those; keying only on the session state
  // FROZE the emphasis at acquisition, so a timeline move left the user looking at the OLD
  // instant's shape while 確定 cut at `anchorTime()` = the CURRENT time (強調 ≠ 実際に切られ
  // る形 — the exact defect W3-A claimed to close), and a 個別非表示 left a hidden feature
  // emphasised and splittable. `camera` is deliberately NOT among the keys: the gate stays a
  // SKIP for camera and a PASS-THROUGH for everything the resolution actually depends on
  // (the invariant the deleted knife-target-shape.test.tsx pinned as「skip, not freeze」).
  const liveTime = useStore(store, (s) => s.currentTime);
  const liveDomain = useStore(store, (s) => s.domain);
  const liveFilter = useStore(store, (s) => s.filter);
  const liveDisplayControl = useStore(store, (s) => s.displayControl);
  const knifeState = knife.state;
  const targetShape = useMemo((): GeoMultiPolygon | undefined => {
    if (
      knifeState.phase === KNIFE_PHASE.Inactive ||
      knifeState.phase === KNIFE_PHASE.SelectingTarget
    ) {
      return undefined;
    }
    return resolveLeafShape?.(knifeState.targetId);
  }, [
    knifeState,
    resolveLeafShape,
    // Live resolution inputs (read INSIDE the port; listed so the memo tracks them).
    liveTime,
    liveDomain,
    liveFilter,
    liveDisplayControl,
  ]);

  // --- V10 ④（現状分析 §11-14）: 飛び地のある面（と外周が自分に接する面）は、分断線が
  // 何度横切っても 2 つにまとまる。**確定の前に**言う ―― 分断線を引いている間の「次の一手」と
  // 継承先の板の両方に出す。判定はドメインの分割と同じ 1 本（`splitsIntoManyPieces`）を見る
  // （教訓 5.29。分割がどの経路を通るかと、画面が言うことを食い違わせない）。
  //
  // **穴のある面はもう 2 つにまとまらない**（増分 8B の手直し / B69）。外周を切片で分けて
  // 穴を差し引くので、穴だけを持つ面には注記を出さない。`splitsIntoManyPieces` は保存された
  // ままの経度を受けても経度をつないでから判定する（反証 2-4）。
  const twoPiecesReason = useMemo((): string | null => {
    if (targetShape === undefined || targetShape.length === 0) return null;
    if (splitsIntoManyPieces(targetShape)) return null;
    // 1 多角形で 2 つにまとまるのは、外周が自分に接している（くびれで囲んだ入り江）面だけ。
    // これを「穴」と呼ぶのは今までどおり（言い換えは 8E の文言の総点検で）。
    return targetShape.length > 1
      ? KNIFE_STRINGS.twoPiecesReasonExclave
      : KNIFE_STRINGS.twoPiecesReasonHole;
  }, [targetShape]);
  const twoPiecesNote =
    twoPiecesReason === null
      ? null
      : KNIFE_STRINGS.twoPiecesNote(twoPiecesReason);

  // --- V10 / N-09: 片を「番号・方角・面積」で呼ぶ。面積は **素性欄と同じ測り方**
  // （プロジェクトの測地設定＋`formatAreaKm2`）にする ―― 板と素性欄で同じ片の面積が
  // 違う数で出ると、どちらを信じればよいか分からなくなる。
  const equatorLengthKm = useStore(
    store,
    (s) => s.projectSettings.equatorLengthKm,
  );
  const flattening = useStore(store, (s) => s.projectSettings.flattening);
  const pieceAreas = useMemo((): readonly string[] | undefined => {
    if (knifeState.phase !== KNIFE_PHASE.ChoosingInheritor) return undefined;
    const geo = createGeoParams(equatorLengthKm, flattening);
    const pieces = knifeState.result.pieces ?? [
      knifeState.result.sideA,
      knifeState.result.sideB,
    ];
    return pieces.map((p) => formatAreaKm2(multiPolygonAreaKm2(p.area, geo)));
  }, [knifeState, equatorLengthKm, flattening]);

  // W3-AB fix-forward: when the target stops resolving (FR-113 hidden / no longer effective
  // at the current time), the session must not keep a ghost target — drop back to 対象選択
  // with the tool still ARMED, mirroring the store's own heal (setCurrentTime revalidates the
  // active feature in the SAME transition). Without this the
  // knife would sit in DrawingCut over an invisible feature. Skipped when the host bound no
  // `resolveLeafShape` (a host without a live domain resolves nothing by design) and while
  // ConflictPaused (the host's conflict flow owns the session until it commits / cancels).
  const dropTarget = knife.dropTarget;
  const knifeFlow = knife.flow;
  const onTargetGone = props.onTargetGone;
  // 素性欄の打ちかけ（年の移動で捨てたものを言うときにも読むので、見張りより前に置く）。
  const propertiesDirtyRef = useRef(false);
  // 道具を降りるコミットでは見ない（読み込みで対象が消えても、手放したとは言わない）。
  const knifeArmedNow = useStore(
    store,
    (s) => s.mode === EDIT_MODE.Edit && s.activeTool === TOOL_ID.EditKnife,
  );
  useEffect(() => {
    if (resolveLeafShape === undefined) return;
    if (!knifeArmedNow) return;
    if (knifeFlow === KNIFE_FLOW.Idle || knifeFlow === KNIFE_FLOW.ConflictPaused) return;
    if (
      knifeState.phase === KNIFE_PHASE.Inactive ||
      knifeState.phase === KNIFE_PHASE.SelectingTarget
    ) {
      return;
    }
    if (targetShape !== undefined) return;
    dropTarget();
    // 手放した理由を言う（B112）。隠しただけなら面は居るので言わない（§D.6 の状態行が別に言う）。
    if (resolveFeature(knifeState.targetId) === undefined) onTargetGone?.();
  }, [knifeArmedNow, knifeState, knifeFlow, targetShape, resolveLeafShape, dropTarget, resolveFeature, onTargetGone]);

  // --- 教訓 5.2 全経路で破棄 ＋ 設計書 §D.4.1 の 3「確定できる点数まで来ている下書きは
  // 捨てる前に確認」。道具・鍵の出入りは共有の見張り（`shell/useDraftSwitchGuard`）が
  // 1 本で受ける ―― **確定できる分断線（2 点以上）を持っているあいだは、切替先を構えずに
  // 聞く**。旧版はここで無条件に `resetForSwitch()` を呼んでいたので、輪郭・穴あけと同じく
  // **分断線 2 点が確認なしに消えていた**（増分 5 の手直し 2 回目）。
  const cutPoints =
    knife.state.phase === KNIFE_PHASE.DrawingCut ? knife.state.line.points.length : 0;
  const knifeGuard: DraftSwitchGuard = useDraftSwitchGuard({
    store,
    toolId: TOOL_ID.EditKnife,
    // 分断線は **2 点で確定できる**（1 本の線分になる）。それ未満は聞かずに捨てる。
    hasCommittableDraft: cutPoints >= 2,
    // 継承先を選ぶ・素性を入れる局面の切った形も打った年のもの。年を動かすときは聞く
    // （`asksOnTimeMove` の注記）。
    asksOnTimeMove:
      cutPoints >= 2 ||
      knife.flow === KNIFE_FLOW.ChoosingInheritor ||
      knife.flow === KNIFE_FLOW.EnteringProperties,
    vertexCount: cutPoints,
    onArm: () => {
      knife.start();
    },
    onDisarm: () => {
      knife.resetForSwitch();
    },
    // 利用者自身の Escape で「捨てる」と答えられた **1 段ぶん**（設計書 §D.4.1 の表）。
    // 点を打っている最中なら点列だけ、素性を入れている最中なら対象を離す段まで戻す。
    onDiscardPoints: () => {
      if (
        knife.state.phase === KNIFE_PHASE.DrawingCut &&
        knife.state.line.points.length > 0
      ) {
        knife.discardCutLine();
        return;
      }
      knife.releaseTarget();
      unpromoteOwnTarget();
    },
    // 年の移動の［捨てる］は下書きだけ。対象を掴んだまま（居ない年なら下の見張りが手放す）。
    onDiscardForTimeMove: knife.discardForTimeMove,
    describeDraft: () => {
      if (knife.flow === KNIFE_FLOW.EnteringProperties) {
        return propertiesDirtyRef.current
          ? DRAFT_DISCARD_STRINGS.discardedCutAndTyped
          : DRAFT_DISCARD_STRINGS.discardedCut;
      }
      if (knife.flow === KNIFE_FLOW.ChoosingInheritor) return DRAFT_DISCARD_STRINGS.discardedCut;
      return cutPoints > 0 ? DRAFT_DISCARD_STRINGS.discarded(cutPoints) : '';
    },
    onDraftDiscarded: props.onDraftDiscarded,
    onDraftLost: props.onDraftLost,
  });

  // --- Feed the provisional knife primitives to the render sink on every state
  // change (FR-90 / FR-92). An idle state yields [] so the overlay / circle vanish
  // on reset (教訓 5.2) with no clearing code.
  useEffect(() => {
    drawSink.drawKnife(
      buildKnifePrimitives({ state: knife.state, targetShape, zoom }, style),
    );
  }, [knife.state, targetShape, zoom, drawSink, style]);

  // --- Keyboard: Escape→cancel, Ctrl+Z→undo (FR-78). Active while a session runs, EXCEPT
  // while the U35 conflict modal owns the screen (ConflictPaused): there the MODAL owns Esc
  // (its own `useModalKeydown` → onConflictCancel → the host's `reArmActiveTool`). Leaving
  // this listener live let an Escape that missed the dialog's React handler run
  // `knife.cancel()` → `setActiveTool(null)` while the modal stayed open; the later
  // `reArmActiveTool` then read `activeTool === null` and toggled null→null, so the tool did
  // NOT come back after the conflict was resolved (W3-AB レビュー LOW). Same規約 as merge,
  // which already skips Esc while its FR-52 dialog is open.
  useEffect(() => {
    if (knife.flow === KNIFE_FLOW.Idle || knife.flow === KNIFE_FLOW.ConflictPaused) return;
    const onKey = (e: KeyboardEvent): void => {
      // Focus guard (バグハント第11波 #3/#6): a text-editing element owns the
      // keyboard (timeline year field / sidebar input) — let native Escape /
      // Ctrl+Z through, dispatching NOTHING and preventing NOTHING, so the tool
      // never cancels or undoes a cut point over native character editing (教訓 5.13:
      // reuse the SINGLE focus-guard predicate, no per-controller re-implementation).
      //
      // **Escape だけは別**（増分 5 の手直し 2 回目 / A2 と同じ規則）。素性入力を右パネルへ
      // 移した（決定 (5)）結果、名前欄に焦点があるあいだ **Escape を誰も受けなくなった**
      // ―― 道具はここで降り、大域は焦点の関門で落ちるので、10 回押しても
      // `tool=edit.knife owner=text` のまま抜けられなかった。追加の道具と同じく、
      // **文字の欄の中でも「やめる」は道具のもの**にする（打ちかけがあれば 1 度聞く）。
      // **板が開いているあいだ、道具の打鍵は Escape だけが通る**（手直し 3 回目。
      // 述語は `shell/DraftDiscardConfirm` の {@link confirmBlocksToolKey} に 1 本ある）。
      // 旧版は Escape のときだけ板を見ていたので、板の中の Ctrl+Z が頂点を 1 つ減らし、
      // Enter が形を確定して素性入力へ進んだ ―― しかも状態行は「いま使えません」と言う。
      if (confirmBlocksToolKey(knifeGuard.pending !== null, e.key)) return;
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
        //   1. 継承先を選ぶ板が出ている → 板を閉じる ＝ この作業をやめる
        //      （階段の最上段は `modal`。`cancel` の意味と一致する）
        //   2. 素性を入力している → **対象を離す**段まで戻す（道具は持ったまま。
        //      欄に打ちかけがあれば 1 度聞く＝増分 5 の手直し 2 回目）
        //   3. 分断線の点列がある → **点列だけをまとめて捨てる**（対象も道具も保つ。
        //      確定できる点数なら 1 度聞く）
        //   4. 対象を掴んでいる   → 対象だけ離す（道具は持ったまま。**元からの選択は保つ**）
        //   5. どれも無い         → **何もせず大域の階段へ譲る**
        //
        // 5 で `preventDefault` も `stopPropagation` もしないのが肝である ―― 大域の
        // `shell/escape-ladder.ts` が「頂点を外す → 地物の選択を外す → 道具を『選ぶ』へ
        // 戻す」を順にやる。ここで止めると、道具を構えているあいだ **素の状態へ戻る道が
        // 無くなる**（§D.4 の「連打すれば必ず戻る」が破れる）。
        //
        // 5 の局面では `onDrawingChange` も false を報せている（対象が null なら名乗らない）
        // ので、大域の割り振りは生きている ―― 名乗りと階段の段が食い違わない。
        //
        // **0 は増分 5 の手直し 2 回目で足した段である。** 答え方は **なぜ聞いているか**で変わる
        // （設計書 §D.4.1 の 4）―― 道具・鍵で出ている板は「続ける」、利用者自身の
        // Escape で出ている板は「捨てる」。後者を「続ける」にすると、押すたびに板が
        // 開いては閉じるだけで素の状態へ戻れない（教訓 5.70）。
        if (knifeGuard.pending !== null) {
          e.preventDefault();
          if (knifeGuard.pending === DISCARD_REASON.Escape) knifeGuard.discard();
          else knifeGuard.keep();
          return;
        }
        if (knife.flow === KNIFE_FLOW.ChoosingInheritor) {
          e.preventDefault();
          knife.cancel();
          return;
        }
        // **素性を入力している局面**（決定 (5) で右パネルへ移った）。追加の道具と同じ
        // 規則にする ―― 欄が「打ちかけ無し」を名乗っていれば 1 回でやめ、打ちかけが
        // あれば 1 度聞く。**やめた先は「対象を離す」段**（§D.4.1 の階段）で、道具は
        // 持ったままである（旧版の `knife.cancel()` は道具ごと降りていた）。
        //
        // **打ちかけは中身で見る**（増分 8B の手直し / 反証 2-2）。旧版は焦点のある欄の
        // `pristine` だけを見ていたので、名前を打ってから地図（幕）を押して焦点が欄から外れると、
        // 次の Escape で **打ちかけの名前・引いた分断線・選んだ継承先が確認なしに** まとめて
        // 消えた。幕は「右のパネルで…」と案内する作りなので、案内を消すつもりで Escape を押す
        // のは自然である。いまは「名前か種別に何か打った」「継承先を既定から選び直した」の
        // どちらかがあれば、焦点がどこにあっても 1 度聞く。
        if (knife.flow === KNIFE_FLOW.EnteringProperties) {
          e.preventDefault();
          const inheritChosen =
            knife.state.phase === KNIFE_PHASE.EnteringProperties &&
            knife.state.inheritIndex !== largestPieceIndex(knife.state.result);
          if (
            propertiesDirtyRef.current ||
            inheritChosen ||
            (inEditable && target?.pristine === false)
          ) {
            knifeGuard.askOnEscape();
            return;
          }
          knife.releaseTarget();
          unpromoteOwnTarget();
          return;
        }
        if (inEditable) return; // ここから下は文字の欄の中では動かさない。
        if (
          knife.state.phase === KNIFE_PHASE.DrawingCut &&
          knife.state.line.points.length > 0
        ) {
          e.preventDefault();
          // **確定できる点数（2 点以上）まで来ていたら 1 度聞く**（§D.4.1 の 3）。
          if (knife.state.line.points.length >= 2) {
            knifeGuard.askOnEscape();
            return;
          }
          knife.discardCutLine();
          return;
        }
        if (knife.targetId !== null) {
          e.preventDefault();
          knife.releaseTarget();
          unpromoteOwnTarget();
          return;
        }
        return;
      }
      // ここから下は作図中の打鍵だけ。文字の欄の中は上の関門で既に降りている。
      if (
        knife.state.phase === KNIFE_PHASE.DrawingCut &&
        (e.ctrlKey || e.metaKey) &&
        (e.key === 'z' || e.key === 'Z')
      ) {
        e.preventDefault();
        knife.undoCutPoint();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // `knife.state` を丸ごと依存に入れる（旧版は `state.phase` だけ）―― 階段の 1 段目は
    // **点列が何点あるか**を見るので、点を打つたびに閉包を張り替えないと「1 点打ったのに
    // まだ 0 点だと思っているリスナー」が残る。
  }, [
    knife.flow,
    knife.state,
    knife.targetId,
    knife.cancel,
    knife.discardCutLine,
    knife.releaseTarget,
    knife.undoCutPoint,
    unpromoteOwnTarget,
    knifeGuard,
  ]);

  // --- bughunt3 (H2 / H1): report the in-progress knife to the host so it suspends
  // the GLOBAL shortcut dispatcher. The global useShortcuts listener registers BEFORE
  // this controller's (mount vs. flow-change), so it would fire EditUndo FIRST on
  // Ctrl+Z during DrawingCut and a tool-side stopImmediatePropagation could not unwind
  // it — suspending the global path entirely is the robust fix (host derives
  // shortcutsSuspended = modalOpen || toolDrawing, 単一真実源 教訓 5.29). The knife flow
  // is that single truth; we only mirror it up. Suspending across the WHOLE non-Idle
  // flow also covers the InheritorModal / 非継承側 property form (H1).
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
    const active = knife.flow !== KNIFE_FLOW.Idle && knife.targetId !== null;
    onDrawingChange(active);
    // On unmount clear the flag so a torn-down controller never leaves the global
    // dispatcher suspended (教訓 5.2 全経路で破棄).
    return () => onDrawingChange(false);
  }, [knife.flow, knife.targetId, onDrawingChange]);

  // --- 非継承側の素性入力は **右パネルの「新規の姿」**で受ける（司令塔の決定 (5) /
  // 設計書 §B.5 の台帳 #9 / §C.2 の 27）------------------------------------------------
  //
  // **なぜ移すのか**: 同じ「新しい地物の素性を入れる」作業なのに置き場が 2 通りあると、
  // 名前欄の焦点も保存ボタンの名前も 2 通りになる。加えて地図の中央の板は **いま切った
  // 形の真上に出る**ので、切り口を見ながら名前を入れられなかった（追加の道具が N-15 で
  // 直したのと同じ害）。右パネルなら覆わない。
  //
  // **上位領域は聞かない**（`showParent: false`）。非継承側の上位領域は
  // `assembleSplitProposal` が元の面から引き継ぐ（FR-44）ので、ここで選ばせると
  // 「選んだのに反映されない欄」になる。
  //
  // **自分の局面でないときは何もしない**（`!enteringProperties` で早々に抜ける）。
  // 追加・分ける・穴あけの 3 つが同じ 1 本の口を共有していて、3 つとも同時にマウント
  // されている ―― 「自分の番でなければ `null` を押し込む」と書くと、**別の道具が開いて
  // いる入力待ちを踏み消す**（教訓 5.68 と同じ形の事故）。後片付けも「自分が押し込んだ
  // ものがまだ載っているときだけ」戻す。
  const addDraft = props.addDraft;
  // **素性入力の局面**（＝非継承側の素性を右パネルで受けている最中）。下の帯の押し込みも
  // 同じ 1 本を見る（同じ判定を 2 か所に書かない＝教訓 5.29）。
  const enteringProperties = knife.flow === KNIFE_FLOW.EnteringProperties;
  // N-13: 素性を入れている間に地図が押されたか（押されたら「次の一手」で理由を言う）。
  // 局面を離れたら忘れる（次の分割へ持ち越さない）。
  const [mapLockedHint, setMapLockedHint] = useState(false);
  useEffect(() => {
    if (!enteringProperties) setMapLockedHint(false);
  }, [enteringProperties]);
  const enteringYear = anchorTime().year;
  const knifeSave = knife.save;
  const knifeCancel = knife.cancel;
  /**
   * **分割の本当の確定（＝右パネルの［保存］）に進行表示を掛ける**（実装計画 8B の中身 3 /
   * 増分 7 の §3 の 1 の宿題）。分割は 4 段の手順で、時間がかかるのは最後の［保存］
   * ―― 編集案を組み立てて整合の検査を通す段である（増分 8B の実測は進捗に書いた）。
   * 所属変更と同じ器（`useDeferredCommit`）を通すので、押した直後に 1 コマ描かれて
   * ［保存］が「分割しています…」になり、2 回目は走らない。
   */
  const knifeSaveDeferred = useDeferredCommit(
    props.commitScheduler === undefined
      ? undefined
      : { schedule: props.commitScheduler },
  );
  const runKnifeSave = useCallback(
    (properties: Parameters<typeof knifeSave>[0]) => {
      knifeSaveDeferred.run(() => knifeSave(properties));
    },
    [knifeSaveDeferred, knifeSave],
  );
  const saveBusy = knifeSaveDeferred.busy;
  // **素性欄の打ちかけ**（増分 8B の手直し / 反証 2-2）。欄が変わったときだけ知らせて
  // もらい、Escape で「聞かずにやめてよいか」を焦点ではなく中身で決める。局面を離れたら
  // 忘れる（次の分割へ持ち越さない）。
  const onPropertiesDirtyChange = useCallback((dirty: boolean) => {
    propertiesDirtyRef.current = dirty;
  }, []);
  useEffect(() => {
    if (!enteringProperties) propertiesDirtyRef.current = false;
  }, [enteringProperties]);
  // **名前を入れる段の前置き**（増分 8B の手直し）: 延ばした先でも切れていればそのこと
  // （B69 の残り）、新しい片が 2 つ以上なら「この名前と種別は n 片すべてに付きます」
  // （設計適合 2-1）。**次の一手の先頭**に置く ―― 素性欄に段を足すと、窓が低いとき
  // ［保存］が時刻レールの下へ押し出されて押せなくなった（E2E の knife-nway で実測）。
  // 帯は 1 行で末尾が切れるので、大事な順に前から並べる（行き先の案内は最後）。
  const enteringResult =
    knife.state.phase === KNIFE_PHASE.EnteringProperties ? knife.state.result : undefined;
  const enteringPrefix = useMemo((): string => {
    if (enteringResult === undefined) return '';
    const newPieces =
      (enteringResult.pieces ?? [enteringResult.sideA, enteringResult.sideB]).length - 1;
    const beyond =
      enteringResult.cutsBeyondLine === true ? KNIFE_STRINGS.beyondLineShort : '';
    const shared = newPieces >= 2 ? KNIFE_STRINGS.sharedNameNote(newPieces) : '';
    return `${beyond}${shared}`;
  }, [enteringResult]);
  useEffect(() => {
    if (addDraft === undefined || !enteringProperties) return;
    const mine: AddDraftPrompt = {
      // 切り分けた非継承側は面である（`showParent` を明示しているので、この値から
      // 上位領域の欄の有無は決まらない）。
      tool: ADD_TOOL_KIND.Face,
      parentCandidates: NO_PARENT_CANDIDATES,
      defaultParentId: null,
      currentYear: enteringYear,
      showParent: false,
      onChooseParent: NOOP_CHOOSE_PARENT,
      // **戻り値は丸ごと渡す**（種別ラベルを黙って落とさない ―― 過去に同じ取りこぼしが
      // あった）。`AddProperties` は `knife.save` が受ける形と同じ 3 つ組である。
      onSave: runKnifeSave,
      onCancel: knifeCancel,
      busyLabel: saveBusy ? KNIFE_STRINGS.committing : null,
      onDirtyChange: onPropertiesDirtyChange,
    };
    addDraft.set(mine);
    // 局面を離れる・道具を降りる・アンマウントの全経路で必ず閉じる（教訓 5.2）。
    return () => {
      if (addDraft.get() === mine) addDraft.set(null);
    };
  }, [
    addDraft,
    enteringProperties,
    enteringYear,
    runKnifeSave,
    knifeCancel,
    saveBusy,
    onPropertiesDirtyChange,
  ]);

  // **モーダルは別に報せる**（増分 5 の手直し A4）。継承先の選択板（`InheritorModal`）と
  // 非継承側の素性入力は、Escape / Tab しか自分では受けない本物のモーダルである。
  const onModalChange = props.onModalChange;
  useEffect(() => {
    if (onModalChange === undefined) return;
    // **素性入力はもうモーダルではない**（決定 (5)）。右パネルの「新規の姿」で受けるので、
    // 鍵盤の持ち主は入力欄（`text`）である ―― ここで `modal` と名乗ると、名前を打って
    // いる最中に Ctrl+S が止まる（追加の道具では止まらないのに、分けるでだけ止まる）。
    // 残るモーダルは **継承先を選ぶ板**（画面全体に重なる作業ダイアログ）だけ。
    // **「捨てますか」の板もモーダルである**（増分 5 の手直し 2 回目）。背面を覆う板を
    // 置いた本物のモーダルなので、答えるまで背後で Ctrl+S などが走ってはいけない。
    onModalChange(
      knife.flow === KNIFE_FLOW.ChoosingInheritor || knifeGuard.pending !== null,
    );
    return () => onModalChange(false);
  }, [knife.flow, knifeGuard.pending, onModalChange]);

  // --- Map-input handler with the固定円ヒット優先 (教訓 5.14). A click while:
  //   - SelectingTarget → resolve the feature under it and select (LEAF gate in hook);
  //   - DrawingCut → if ≥1 point placed AND the click is INSIDE the固定円 (within the
  //     screen-fixed radius of the FIRST point) route to clickInsideCircle (閉線確定 at
  //     ≥3 pts), else add a vertex. The overlay never steals this — the input layer
  //     sits above the map and forwards here while a knife session runs.
  const circleWorldRadius = useMemo(
    () => (zoom > 0 ? DEFAULT_KNIFE_STYLE.circleRadiusPx / zoom : Infinity),
    [zoom],
  );

  const onMapPointerDown = useCallback(
    (e: { clientX: number; clientY: number; button?: number }) => {
      if (e.button !== undefined && e.button !== 0) return;
      const s = knife.state;
      // N-13: 素性を入れている最終段階では、幕（入力の橋）が地図のクリックを受け止める
      // だけで何もしない ―― 背後の地物を選んだり動かしたりさせない。黙って無視すると
      // 「効かない」と読まれるので、理由を次の一手に出す。
      if (s.phase === KNIFE_PHASE.EnteringProperties) {
        setMapLockedHint(true);
        return;
      }
      const world = screenToWorld(e.clientX, e.clientY);
      if (s.phase === KNIFE_PHASE.SelectingTarget) {
        const fid = featureAtPoint(world);
        if (fid !== null) knife.selectTarget(fid);
        return;
      }
      if (s.phase === KNIFE_PHASE.DrawingCut) {
        const first = s.line.points[0];
        // Euclidean degree distance: the固定円 is a screen-space radius mapped to
        // world degrees via the equirectangular transform (same zoom for lon/lat).
        const within =
          first !== undefined &&
          Math.hypot(first.lon - world.lon, first.lat - world.lat) <= circleWorldRadius;
        const insideCircle =
          within && shouldCloseOnCircleClick(s.line.points.length, true);
        if (first !== undefined && insideCircle) {
          knife.clickInsideCircle(world, true);
        } else {
          knife.placeCutPoint(world);
        }
      }
    },
    [knife, screenToWorld, featureAtPoint, circleWorldRadius],
  );

  // --- Camera passthrough (bughunt: ナイフ描画中の中ボタンパン/ホイールズーム). The
  // input bridge captures every pointer/wheel event over the map; forward the
  // camera-only ones (wheel + non-left pointer) to the live map dispatcher so 中ボタ
  // ンパン / ホイールズーム keep working while selecting / drawing. The LEFT button is
  // consumed by target select / cut-point input above and is NOT forwarded.
  const onMapWheel = useCallback(
    (e: { clientX: number; clientY: number; deltaY: number; deltaMode: number }) => {
      mapCameraInput.wheel(e.clientX, e.clientY, e.deltaY, e.deltaMode);
    },
    [mapCameraInput],
  );
  const onMapCameraPointerDown = useCallback(
    (e: PointerEvent) => {
      if (e.button === 0) return; // left = target/cut input (handled by onMapPointerDown)
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

  // --- 案内・断り・確定の列をオプションバーへ（増分 5d / 設計書 §C.4）------------
  //
  // **確定欄は 2 つで満杯**（176px ÷ U-8 の下限 60px）なので、［1 つ戻す］は設定欄へ
  // 差し込む（増分 3 の `add-undo` と同じ形）。testid は 1 つも変えていない（T-1）――
  // 役割は「分断線を確定する」「1 点戻す」「やめる」のままで、置き場だけが移った。
  const drawingCut = knife.state.phase === KNIFE_PHASE.DrawingCut;
  // **断られた局面でも［やめる］を確定欄に出す**（増分 5 の手直し B3 / GPT #11）。
  // 旧版は断り文と［やめる］を **地図の中央の板**に出していて、その板が
  // `pointer-events: auto` で地図のクリックを奪っていた（K-2 の当事者）。板は消し、
  // 断り文は「次の一手」へ、［やめる］はここへ移す。
  const rejected = knife.flow === KNIFE_FLOW.Rejected;
  /**
   * **分割の確定にも進行表示と二重クリックの関門を掛ける**（増分 7 の中身 9 の
   * 未結線の解消）。分割の確定は実データで 2.5〜3.1 秒かかるのに、押しても画面が
   * 動かないので「効かなかった」と読まれてもう 1 度押される。所属変更・まとめて種別と
   * **同じ器**（`useDeferredCommit`）を通す ―― 押している間だけ確定ボタンの文言が
   * 「分割しています…」に変わり、2 回目は走らない。
   */
  const knifeDeferred = useDeferredCommit(
    props.commitScheduler === undefined ? undefined : { schedule: props.commitScheduler },
  );
  const confirmCut = knife.confirmCut;
  const runConfirmCut = useCallback(() => {
    knifeDeferred.run(() => confirmCut());
  }, [knifeDeferred, confirmCut]);
  // **分断線の点が足りないあいだは確定を押させない**（N-10「0 点でも押せる」）。開いた線は
  // 2 点、閉じた線は 3 点（閉じられるのは 3 点からなので、閉じていれば常に足りている）。
  // 理由は「次の一手」に出す（確定欄のすぐ左＝ボタンの脇）。
  const cutPointCount =
    knife.state.phase === KNIFE_PHASE.DrawingCut
      ? knife.state.line.points.length
      : 0;
  const cutClosed =
    knife.state.phase === KNIFE_PHASE.DrawingCut &&
    knife.state.line.kind === KNIFE_LINE_KIND.Closed;
  const cutTooShort = drawingCut && !cutClosed && cutPointCount < 2;
  const knifeCommit = useMemo(
    () =>
      drawingCut
        ? [
            {
              id: 'confirm',
              testId: 'knife-confirm-cut',
              label: knifeDeferred.busy ? KNIFE_STRINGS.committing : KNIFE_STRINGS.confirmCut,
              disabled: knifeDeferred.busy || cutTooShort,
              onClick: runConfirmCut,
            },
            {
              id: 'cancel',
              testId: 'knife-cancel',
              label: KNIFE_STRINGS.cancel,
              onClick: () => knife.cancel(),
            },
          ]
        : // **素性入力中も確定欄を空にしない**（追加の道具と同じ形＝`ADD_STRINGS` の側の
          // 注記）。空にすると「やめる」経路が画面から消え、名前を打っている途中で
          // 取りやめる手が Escape だけになる ―― その Escape も右パネルの名前欄に焦点が
          // あるあいだは焦点の守り（`isEditableTarget`）に阻まれて道具へ届かない。
          // **保存は右パネルの［保存］が持つ**ので、帯には［やめる］だけを出す。
          rejected || enteringProperties
          ? [
              {
                id: 'cancel',
                testId: 'knife-cancel',
                label: KNIFE_STRINGS.cancel,
                onClick: () => knife.cancel(),
                // 保存（＝分割の確定）が走っている間は取りやめさせない（走り終えたら
                // 道具が次の対象を待つ構えへ戻るので、押す相手がいなくなる）。
                disabled: saveBusy,
              },
            ]
          : [],
    // **同一性を安定させる**（増分 5 の手直し B3 の注記 7）。依存に道具の戻り値を
    // 丸ごと入れると **毎レンダー新しい配列と新しい関数**になり、帯への押し込みが
    // 毎回走る（`setCommit` は `onClick` を同一性で見るので常に「違う」になる）。
    [
      drawingCut,
      rejected,
      enteringProperties,
      runConfirmCut,
      knifeDeferred.busy,
      cutTooShort,
      saveBusy,
      knife.cancel,
    ],
  );
  const knifeExtras = useMemo(
    () =>
      drawingCut ? (
        <button
          type="button"
          data-testid="knife-undo"
          disabled={
            knife.state.phase !== KNIFE_PHASE.DrawingCut ||
            knife.state.line.points.length === 0
          }
          onClick={() => knife.undoCutPoint()}
        >
          {KNIFE_STRINGS.undoVertex}
        </button>
      ) : null,
    [drawingCut, knife.state, knife.undoCutPoint],
  );
  // **帯へ押し込む条件は「店の真実（いま構えている道具）」と AND する**（手直し 3 回目）。
  // 道具の `flow` は自分の state なので、`activeTool` が外れてから畳まれるまで **1 コミット
  // 遅れる**。その 1 コミットのあいだに押し直すと、**降りたばかりの道具が次の持ち主の
  // 中身を自分のもので上書きする**（実測: 分ける → 選ぶ で対象欄が「手順 1/4（選んで
  // いません）」になり、そのあと空で固まった）。押し込みは店が「いまこの道具」と
  // 言っているあいだだけにする。
  const knifeArmedHoldsBar = (knife.flow !== KNIFE_FLOW.Idle) && knifeGuard.armed;
  // **次の一手**（設計書 §C.4）。断り（`message`）があればそれが最優先なのは今までどおり。
  //   - 確定が走っている間 → 「分割しています…」（中身 3 の進行表示。帯にも出す）
  //   - 素性入力 → 行き先（右のパネル）。地図を押されたら「触れません」と言う（N-13）
  //   - 分断線を閉じた → 閉じたこと（N-10「閉じても何も変わらない」）
  //   - 点が足りない → 確定を押せない理由（N-10「0 点でも押せる」）
  //   - 穴・飛び地のある面 → 2 つにまとまること（V10 ③④。開いた線のときだけ ――
  //     閉じた線はどの面でも「囲みの内と外」の 2 つなので言う必要が無い）
  const knifeNextStep = useMemo((): string => {
    if (knife.message !== null) return knife.message;
    if (saveBusy || knifeDeferred.busy) return KNIFE_STRINGS.committing;
    if (enteringProperties) {
      return `${enteringPrefix}${
        mapLockedHint
          ? KNIFE_STRINGS.mapLockedWhileNaming
          : KNIFE_STRINGS.nextStepEnterProperties
      }`;
    }
    if (drawingCut) {
      if (cutClosed) return KNIFE_STRINGS.nextStepClosed;
      // 帯の欄は 1 行で末尾が切れるので、**大事な順**に前から置く:
      // 押せない理由 → 2 つにしか分かれないこと → いつもの案内。
      const reason = cutTooShort
        ? KNIFE_STRINGS.cutNeedsPoints(cutPointCount)
        : '';
      const note =
        twoPiecesReason === null
          ? ''
          : KNIFE_STRINGS.twoPiecesShort(twoPiecesReason);
      return `${reason}${note}${knife.guide}`;
    }
    return knife.guide;
  }, [
    knife.message,
    knife.guide,
    saveBusy,
    knifeDeferred.busy,
    enteringProperties,
    enteringPrefix,
    mapLockedHint,
    drawingCut,
    cutClosed,
    cutTooShort,
    cutPointCount,
    twoPiecesReason,
  ]);
  useToolBarChrome({
    optionBar,
    active: knifeArmedHoldsBar,
    slotId: 'knife',
    // **素性入力の局面では行き先まで言う**（司令塔の決定 (5)）。ドメインの案内文は
    // 「新規地物のプロパティを入力してください。」までしか言わない ―― 板が目の前に
    // 出ていたころはそれで足りたが、いま欄は右パネルにある。断り（`message`）が
    // 出ているときは今までどおりそちらが最優先である。
    nextStep: knifeNextStep,
    commit: knifeCommit,
    extras: knifeExtras,
  });

  // --- 対象欄（240px）は **この道具が自分で押し込む**（増分 5 の手直し B3 / バグ狩り #6）--
  //
  // `shell/ToolOptionBar` の `TOOLS_WITH_OWN_TARGET` にナイフが入ったので、あちらは
  // `activeFeature` から対象欄を作らない。それまでは **1 度も対象を押していないのに
  // 一覧で選んだ地物の名前が出て**、次の一手の「切る面を押してください」と矛盾していた。
  //
  // 名前の作り方は `describeOptionBarTarget` をそのまま使う（写像表を増やさない＝教訓 5.29）。
  // 掴んでいなければ null を押し込む ―― 器が「（選んでいません）」を出す。
  //
  // 段階表示は「手順 n/4」（設計書 §C.4 / バグ狩り #9）。「4 件中 2 件」と誤読されないよう
  // 「手順」の 2 文字を含む形は `KNIFE_STRINGS.stage` が持つ。
  const knifeStage = useMemo(() => {
    switch (knife.state.phase) {
      case KNIFE_PHASE.Inactive:
        return null;
      case KNIFE_PHASE.SelectingTarget:
        return KNIFE_STRINGS.stage(1);
      case KNIFE_PHASE.DrawingCut:
        return KNIFE_STRINGS.stage(2);
      case KNIFE_PHASE.ChoosingInheritor:
        return KNIFE_STRINGS.stage(3);
      case KNIFE_PHASE.EnteringProperties:
        return KNIFE_STRINGS.stage(4);
    }
  }, [knife.state.phase]);
  const knifeTargetName = useMemo(() => {
    if (knife.targetId === null) return null;
    const feature = resolveFeature(knife.targetId);
    return feature === undefined ? null : describeOptionBarTarget(feature);
  }, [knife.targetId, resolveFeature]);
  // 継承先の板の「○○として残る」の名前（種別を添えない素の表示名）。
  const knifeTargetDisplayName = useMemo(() => {
    if (knife.targetId === null) return undefined;
    const feature = resolveFeature(knife.targetId);
    return feature === undefined ? undefined : featureDisplayName(feature);
  }, [knife.targetId, resolveFeature]);
  // **空へ戻すのは後片付けでやる**（`useToolBarChrome` と同じ理由＝教訓 5.68）。5 つの
  // コントローラは全部が同時にマウントされているので、effect の本体で「降りているなら
  // 空へ」と書くと、構えていない道具が構えている道具の押し込みを踏み消す。React は
  // 「全部の後片付け → 全部の再実行」の順に走らせるので、後片付けへ置けば木の位置に
  // 関わらず「前の道具が空へ戻す → 次の道具が押し込む」になる。
  // 器が持ち直されたら押し直すために、代を React の値として読む（手直し 3 回目）。
  const optionBarEpoch = useOptionBarEpoch(optionBar);
  // **書いた人の印**（手直し 3 回目）。空へ戻すのは自分が最後に書いたときだけ。
  const targetWriterRef = useRef<object>({});
  useEffect(() => {
    if (optionBar === undefined || !knifeArmedHoldsBar) return;
    // **後片付けは「自分が最後に書いた」ときだけ効かせる**（増分 5 の手直し 2〜3 回目。
    // 理由は `shell/useToolBarChrome` の注記と同じ ―― この道具の後片付けは 1 コミット
    // 遅れて走るので、同じ持ち替えで次の持ち主が入れた対象名を踏み消していた）。
    //
    // **`optionBarEpoch` を依存に入れて押し直す**（手直し 3 回目）。器が持ち直されると
    // 中身は空へ戻るので、押し込んだ側が黙っていると対象欄が空のまま固まる。
    const targetWriter = targetWriterRef.current;
    optionBar.setTarget(knifeStage, knifeTargetName, targetWriter);
    return () => {
      optionBar.clearTargetIfMine(targetWriter);
    };
  }, [optionBar, knifeArmedHoldsBar, knifeStage, knifeTargetName, optionBarEpoch]);

  return (
    <KnifeToolChrome
      knife={knife}
      guard={knifeGuard}
      pieceAreas={pieceAreas}
      targetName={knifeTargetDisplayName}
      twoPiecesNote={twoPiecesNote}
      onMapPointerDown={onMapPointerDown}
      onMapWheel={onMapWheel}
      onMapCameraPointerDown={onMapCameraPointerDown}
      onMapCameraPointerMove={onMapCameraPointerMove}
      onMapCameraPointerUp={onMapCameraPointerUp}
      onMapCameraPointerCancel={onMapCameraPointerCancel}
    />
  );
}

// --- The provisional-knife chrome (guide + triggers + modal + property form) --

interface KnifeToolChromeProps<S> {
  readonly knife: ReturnType<typeof useKnifeTool<S>>;
  /** 「捨てますか」の板（`shell/useDraftSwitchGuard`）。 */
  readonly guard: DraftSwitchGuard;
  /** 継承先の板に出す片ごとの面積（V10 / N-09）。 */
  readonly pieceAreas: readonly string[] | undefined;
  /** 切る前の地物の名前（「○○として残る」の 1 文）。 */
  readonly targetName: string | undefined;
  /** 穴・飛び地で 2 つにまとまる注記（V10 ③④）。 */
  readonly twoPiecesNote: string | null;
  readonly onMapPointerDown: (e: { clientX: number; clientY: number; button?: number }) => void;
  /** Forward a wheel notch over the bridge to the camera (bughunt: 描画中のズーム). */
  readonly onMapWheel: (e: {
    clientX: number;
    clientY: number;
    deltaY: number;
    deltaMode: number;
  }) => void;
  /** Forward a non-left press over the bridge to the camera (描画中の中ボタンパン). */
  readonly onMapCameraPointerDown: (e: PointerEvent) => void;
  readonly onMapCameraPointerMove: (e: PointerEvent) => void;
  readonly onMapCameraPointerUp: (e: PointerEvent) => void;
  readonly onMapCameraPointerCancel: (e: PointerEvent) => void;
}

/**
 * The transparent map-input bridge mounted while selecting / drawing (教訓 5.14). It
 * forwards LEFT-button presses to the knife hook (target select / cut input) via a
 * React handler, AND forwards the camera-only events (wheel + non-left pointer) to
 * the live map dispatcher (bughunt: ナイフ描画中の中ボタンパン/ホイールズーム).
 *
 * The wheel + pointer listeners are attached NATIVELY through a ref because React
 * registers `onWheel` as a PASSIVE root listener, so a React handler cannot
 * `preventDefault()` the page scroll — the host's own map listener uses
 * `{ passive: false }` for the same reason, and we mirror it so a notch zooms
 * instead of scrolling. (Mirrors AddInputBridge — kept per-controller because the
 * LEFT-button forwarding differs, 教訓 5.30 過剰共有の戒め.)
 */
function KnifeInputBridge(props: {
  /** 幕として置いている（N-13）。見た目（カーソル）だけを変える。 */
  readonly locked?: boolean;
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
      className="knife-tool__input"
      data-testid="knife-input-layer"
      data-locked={props.locked === true ? 'true' : 'false'}
      onPointerDown={(e) =>
        onMapPointerDown({ clientX: e.clientX, clientY: e.clientY, button: e.button })
      }
    />
  );
}

function KnifeToolChrome<S>(props: KnifeToolChromeProps<S>): JSX.Element | null {
  const { knife, guard } = props;

  if (knife.flow === KNIFE_FLOW.Idle) return null;

  const choosing = knife.state.phase === KNIFE_PHASE.ChoosingInheritor;
  const entering = knife.state.phase === KNIFE_PHASE.EnteringProperties;

  return (
    <div className="knife-tool" data-testid="knife-tool" data-flow={knife.flow}>
      <span data-testid="knife-point-count" hidden>
        {knife.state.phase === KNIFE_PHASE.DrawingCut ? knife.state.line.points.length : 0}
      </span>
      {/* The map input bridge: a transparent layer ABOVE the map (教訓 5.14) ONLY
          while selecting / drawing, so it never steals input otherwise. The
          overlay drawn underneath does NOT capture clicks — this layer does, and
          forwards them to the hook with the固定円ヒット優先. It ALSO forwards the
          camera-only events (wheel + non-left pointer) to the live map dispatcher so
          中ボタンパン / ホイールズーム keep working while selecting / drawing (bughunt). */}
      {(knife.flow === KNIFE_FLOW.SelectingTarget ||
        knife.flow === KNIFE_FLOW.DrawingCut ||
        // N-13「最終段階だけ幕が無い」: 素性を入れている間も同じ橋を **幕** として残す。
        // 左クリックは受け止めて何もしない（背後の地物を選ばせない・動かさせない）。
        // ホイールと中ボタンの移動は通すので、切った形を見回すことはできる。
        knife.flow === KNIFE_FLOW.EnteringProperties) && (
        <KnifeInputBridge
          locked={knife.flow === KNIFE_FLOW.EnteringProperties}
          onMapPointerDown={props.onMapPointerDown}
          onMapWheel={props.onMapWheel}
          onMapCameraPointerDown={props.onMapCameraPointerDown}
          onMapCameraPointerMove={props.onMapCameraPointerMove}
          onMapCameraPointerUp={props.onMapCameraPointerUp}
          onMapCameraPointerCancel={props.onMapCameraPointerCancel}
        />
      )}

      {/* 案内と断りは **オプションバーの「次の一手」** が本文を出す（増分 5d /
          設計書 §C.4「拒否理由が出たときはその文がそのまま置き換わる」）。ここに残す
          のは観測のためのミラーで、**地図の上には描かない**（`hidden`）。読み上げの
          role は残す ―― 画面に出ている文言は帯のほうである。 */}
      <span className="knife-tool__guide" data-testid="knife-guide" hidden>
        {knife.guide}
      </span>
      {knife.message !== null && (
        <span className="knife-tool__message" data-testid="knife-message" hidden>
          {knife.message}
        </span>
      )}

      {/* **確定の列はここには無い**（増分 5d）。オプションバーの確定欄 176px へ移した
          （設計書 §C.4 / E-2）。地図の下端中央に浮いていたころは、押せる部品が地図に
          重なっていて K-2 の事故の当事者だった。残っているのは観測だけである。 */}
      <span data-testid="knife-cut-count" hidden>
        {knife.state.phase === KNIFE_PHASE.DrawingCut
          ? knife.state.line.points.length
          : 0}
      </span>

      {/* 継承先選択モーダル (FR-93 / HB3-5/19 n-way: one button per piece). */}
      {choosing && knife.state.phase === KNIFE_PHASE.ChoosingInheritor && (
        <InheritorModal
          pieces={(
            knife.state.result.pieces ?? [
              knife.state.result.sideA,
              knife.state.result.sideB,
            ]
          ).map((piece) => piece.area)}
          smallestIndex={smallestPieceIndex(knife.state.result)}
          selectedIndex={knife.state.selectedIndex}
          areas={props.pieceAreas}
          targetName={props.targetName}
          // 「2 つにしか分かれません」は **開いた線のときだけ**（閉じた線はどの面でも囲みの
          // 内と外の 2 つなので的外れ。設計適合 1-1。次の一手の側と同じ条件）。
          note={
            knife.state.line.kind === KNIFE_LINE_KIND.Open ? props.twoPiecesNote : null
          }
          beyondNote={
            knife.state.result.cutsBeyondLine === true ? KNIFE_STRINGS.beyondLineNote : null
          }
          onSelect={(index) => knife.selectInheritor(index)}
          onConfirm={() => knife.confirmInheritor()}
          onCancel={() => knife.cancel()}
        />
      )}

      {/* **非継承側の素性入力の板は地図から消した**（司令塔の決定 (5) / 設計書 §B.5 の
          台帳 #9 / §C.2 の 27）。素性は **右パネルの「新規の姿」**（`add-property-form`）で
          受ける ―― 板は切ったばかりの形の真上に出るので、切り口を見ながら名前を入れられ
          なかった。押し込みは上の `addDraft` の effect が行う。

          `knife-props` は **「素性入力の局面に居る」ことの観測ミラー**として `hidden` で
          残す（T-1 役割はそのまま／T-2 隠し観測は足す一方）。既に `knife-guide` /
          `knife-message` / `knife-rejected` が同じ形で残っており、探索の spec
          （`e2e/__bughunt__/explore-r4.spec.ts` / `e2e/__visual__/driver-a.spec.ts`）が
          「いまどの段に居るか」をこの名前で見ている。 */}
      {entering && <span data-testid="knife-props" hidden />}

      {/* 確定できる分断線を捨てる前の確認（設計書 §D.4.1 の 3）。**器は追加の道具と
          共有の本物のモーダル**なので、この板が出ているあいだ地図の入力ブリッジは
          背面の覆いに遮られる（K-2 / 教訓 5.14）。 */}
      {guard.pending !== null && (
        <DraftDiscardConfirm
          idPrefix="knife-draft-discard"
          reason={guard.pending}
          vertexCount={guard.vertexCount}
          onKeep={guard.keep}
          onDiscard={guard.discard}
        />
      )}

      {knife.flow === KNIFE_FLOW.ConflictPaused && (
        <p data-testid="knife-conflict-paused" role="status">
          {KNIFE_STRINGS.conflictPaused}
        </p>
      )}

      {/* **断りの板は地図から消した**（増分 5 の手直し B3 / GPT #11 / バグ狩り #4）。
          旧版はここに `pointer-events: auto` の板を出しており、**断りが出ているあいだ
          地図のクリックが奪われて**いた（設計書 §B.5 の K-2 と正面から衝突する）。
          断り文は帯の「次の一手」が、［やめる］は帯の確定欄が出す。ここに残るのは
          観測のミラーだけである（testid は役割のまま＝T-1）。 */}
      {knife.flow === KNIFE_FLOW.Rejected && knife.message !== null && (
        <span data-testid="knife-rejected" hidden>
          {knife.message}
        </span>
      )}
    </div>
  );
}

/** A no-op draw sink (for hosts that have not mounted a renderer yet). */
export const NO_KNIFE_DRAW_SINK: KnifeDrawSink = {
  drawKnife() {
    /* nothing to draw into yet */
  },
};
