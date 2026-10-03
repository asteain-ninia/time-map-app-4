// UI 層（地図マウントの結線 / 当たり判定）: クリック位置から「何を掴んだか」を解決し、
// 選択・編集ドラッグ・右クリックメニューへ渡す口を組み立てる。
//
// 描画・当たり判定・矩形選択・ツールのスナップは **同じ 1 つの解決** を読む（教訓 5.29:
// 描かれているもの == 掴めるもの）。画面↔世界の変換もレンダラの逆変換 1 本だけを使う。

import type { MutableRefObject } from 'react';

import type { AddHostPorts } from '../../add/host-ports';
import { createLiveEditBinding } from '../../consistency-binding';
import {
  promotesOnContextMenu,
  suspendsContextMenu,
  type FocusOwner,
} from '../../shell/focus-owner';
import { TOOL_ID, toolShowsVertexHandles } from '../../shell/tools';
import { EDIT_MODE } from '../../state/session';
import { createEditSessionPort } from '../edit-session-adapter';
import {
  buildEditSnapshot,
  buildMovingRings,
  ringIdForLeafVertex,
} from '../edit-session-snapshot';
import {
  liveHitTestAt,
  verticesInRectangle,
  verticesNearPoint,
  type NearVertexCandidate,
} from '../live-hit-test';
import {
  createLiveContextMenuPort,
  promoteHitToSelection,
} from '../live-context-menu-port';
import { createLiveSelectionPort } from '../live-selection-port';
import type { ContextMenuOpener } from '../MapContextMenu';
import type {
  ContextMenuPort,
  EditSessionPort,
  HitTester,
  SelectionPort,
} from '../ports';
import { createNeighboursQuery } from '../slide-snap-neighbours';
import { resolveDisplayFor } from '../display-resolution-cache';
import { edgeAddMidpoint } from '../edge-click';
import { grabRadiusPx } from '../grab-radius';
import { withRubberBand } from '../rubber-band';
import {
  createListPickOnce,
  describeNearVertices,
  preferListPick,
  type CandidateRelevantState,
  type DescribedVertexCandidate,
  type ListPick,
} from '../vertex-candidates';
import {
  worldToScreen as projectWorldToScreen,
  screenToWorld as unprojectScreenToWorld,
  type ScreenPoint,
} from '../../../render';
import { PROCESS_STATUS, type ProcessResult } from '../../../domain/consistency/index';
import type { WorldCoordinate } from '../../../domain/coordinate';
import { RELEASE_OUTCOME, type EditRefusalKind } from '../../../domain/editing/index';
import { reportVertexCarryForward } from '../../../domain/editing/apply-proposal';
import { getCalendar } from '../../../domain/time/calendar';
import type { FeatureId, RingId, VertexId } from '../../../domain/ids';
import {
  replaceVertices,
  withActiveFeature,
  type NextTargetPreference,
  type RectangleResolver,
} from '../../../domain/selection';
import type { TimePoint } from '../../../domain/time/time-point';
import type { MountDomainRoot, MountStore, MountTransients } from './shared';

/** HB3-20 review fix: minimum near-candidate query look-ahead (screen px) so the
 *  slide (排他) collision check keeps working even when the user disables snapping
 *  (snapDistancePx=0). Converted to world units per frame via the live zoom. */
const SLIDE_LOOKAHEAD_PX = 8;

/** この合成で使う暦（`ui/live-lookup.ts` と同じ 1 本）。 */
const MOUNT_CALENDAR = getCalendar('gregorian');

/** `recordCommitRef` が持つ確定ハンドラの型（App.tsx 側の宣言と同型）。 */
type RecordCommit = (
  result: ProcessResult<MountDomainRoot>,
  preference: NextTargetPreference | undefined,
  anchorTime: TimePoint,
) => void;

/** {@link createMountHitTest} の入力。 */
export interface MountHitTestOptions {
  /** 当たり判定が毎回読み直す唯一の U16 セッションストア。 */
  readonly store: MountStore;
  /** カメラ/ビューポートの唯一の読み口（描画と同じもの）。 */
  readonly ports: AddHostPorts;
  /** 画面座標 → クライアント座標の逆変換に使う入力層の矩形。 */
  readonly hookTarget: HTMLElement;
  /** 部品をまたぐ可変の参照（編集プレビューの受け渡し）。 */
  readonly transients: MountTransients;
  /** FR-87 辺ハンドル追加が使う、プロジェクト共通の頂点 id 発行器。 */
  readonly nextVertexIdRef: MutableRefObject<(() => VertexId) | null>;
  /** U06 差分書き戻しが使う、プロジェクト共通の環 id 発行器。 */
  readonly nextRingIdRef: MutableRefObject<(() => RingId) | null>;
  /** 確定した編集を 1 つの取り消し単位として記録する口。 */
  readonly recordCommitRef: MutableRefObject<RecordCommit | null>;
  /**
   * 確定の関門が断ったときに理由を画面へ出す口（増分 3 の手直し A5 / A6）。
   * **無反応にしない**（設計書 §H.5 の「消えない結果表示」へ出す）。App.tsx が入れる。
   */
  readonly announceEditRefusalRef?: MutableRefObject<((reason: EditRefusalKind) => void) | null>;
  /**
   * 共有頂点の移動を **その年より後ろの記録へも反映した**ことを画面へ出す口
   * （増分 3 の手直し 2 回目 / A1）。1 回目の手直しで引き継ぎ自体は入れたが、
   * **画面へ出す配線が無かった**ので、利用者から見ると「この年しか直っていない」と
   * 思い込むままだった（現状分析 C1 と同じ「実体はあるが呼ばれない」型の欠陥）。
   */
  readonly announceCarryForwardRef?: MutableRefObject<
    ((fromYear: number, toYear: number, anchorCount: number) => void) | null
  >;
  /** 右クリックメニューの React 側の開く口。 */
  readonly contextMenuOpenerRef: MutableRefObject<ContextMenuOpener | null>;
  /**
   * **いま鍵盤を持っているのは誰か**（設計書 §D.1。増分 5 の手直し A1）。
   *
   * 右クリックの扱いは 2 つに分かれる ―― **要求ごと捨てる**（ダイアログが持っている）
   * のと、**メニューは開くが選択は変えない**（道具が下書きを持っている）である。
   * 旧版は真偽値 1 個（`shortcutsSuspended`）しか渡していなかったので、後者を
   * 表現できず、**作図中の右クリックが下書きを壊していた**。判定そのものは
   * `shell/focus-owner.ts` の 1 本に置き、ここは現在値を読むだけにする（教訓 5.6）。
   */
  readonly focusOwnerRef: MutableRefObject<FocusOwner>;
  /**
   * **道具が下書きを持っているか**（増分 5 の手直し A1）。畳んだ持ち主の値では
   * 素性入力中に `text` が下書きを隠すので、生の値を別に渡す（`focus-owner.ts` の
   * `promotesOnContextMenu` の注記）。
   */
  readonly toolDraftRef: MutableRefObject<boolean>;
}

/** {@link createMountHitTest} の産物（U40 ディスパッチャへ渡す 4 つの口）。 */
export interface MountHitTest {
  readonly hitTester: HitTester;
  readonly selectionPort: SelectionPort;
  readonly editSession: EditSessionPort;
  readonly contextMenu: ContextMenuPort;
  /**
   * **掴める距離に居る頂点を全部返す**（設計書 §B.5 の台帳 #12 / V9）。母集合・可視判定・
   * ラップの数え方は `hitTester` と同じ 1 本（`verticesNearPoint`）を通る（教訓 5.29）。
   * 増分 8A で座標と「引いている地物の全部」を足した。
   */
  readonly probeVertexCandidates: (point: ScreenPoint) => readonly DescribedVertexCandidate[];
  /** 候補一覧から 1 つ選んだときの選択の書き込み（U22 の並びをそのまま作る）。 */
  readonly selectVertex: (featureId: FeatureId, vertexId: VertexId) => void;
}

/**
 * クリック解決（U22 HitResult）と、その先の選択 / 編集ドラッグ / 右クリックメニューの
 * 口をまとめて作る。
 */
export function createMountHitTest(options: MountHitTestOptions): MountHitTest {
  const {
    store,
    ports,
    hookTarget,
    transients,
    nextVertexIdRef,
    nextRingIdRef,
    recordCommitRef,
    contextMenuOpenerRef,
    focusOwnerRef,
    toolDraftRef,
  } = options;

  // HB-15 ROOT FIX — wire the LIVE map click hit-test + selection so an edit-mode
  // click on a vertex / feature actually selects (教訓 5.7 合成ルートの結線漏れ). The
  // hit-test reuses the renderer's box-corrected screen↔world (HB-7) AND
  // live-lookup's featuresAt / verticesAt AND the SAME display-control-resolved drawn
  // area set the renderer fills (drawnAreaAt) — 二重真実源を作らない, 教訓 5.29. (The
  // TOOL target ports — knife / merge / reparent / ring-edit / drill — deliberately use
  // the raw-leaf `leafAtPoint` instead: a leaf inside an aggregate must stay directly
  // targetable at N=0, and each tool draws its own target emphasis, HB3-16 / W3-A.)
  //
  // Surface screen point → world (renderer inverse against the live camera/viewport
  // the frame drew with). Shared by the hit-test and the selection port so a click
  // resolves and finalizes against the SAME coordinate (単一の真実源, 教訓 5.29).
  const surfaceToWorld = (point: ScreenPoint): WorldCoordinate => {
    const { camera, viewport } = ports.readCamera();
    return unprojectScreenToWorld(point, camera, viewport);
  };
  // The hit-test resolves a surface-relative screen point to a U22 HitResult:
  // nearest committed vertex within a screen-px grab radius (頂点優先), else the leaf
  // body under the cursor (world containment, 穴透過), else a point/line near the
  // cursor, else empty.
  // 増分 8A の手直し（反証 重 3）: 一覧から選んだときに立てる **使い捨ての印**。
  // ディスパッチャは押下のたびに（左右・中ボタン、地図でも道具の橋渡しでも）まず
  // `hitTest` を 1 回呼ぶので、ここで印を「この押下の分」へ移して消す ―― 次の押下では
  // どのボタンであっても必ず消えている。効かせるのは下の `editSession.begin`（左ボタンの
  // 編集ドラッグの入口）だけで、右クリックのメニューと選択の書き込みには当たり判定の
  // 結果をそのまま渡す。
  const listPick = createListPickOnce();
  let pressPick: ListPick | null = null;
  const candidateContextOf = (): CandidateRelevantState => {
    const s = store.getState();
    return {
      domain: s.domain,
      currentTime: s.currentTime,
      mode: s.mode,
      activeTool: s.activeTool,
      displayControl: s.displayControl,
      filter: s.filter,
      camera: s.camera,
    };
  };
  const hitTester: HitTester = {
    hitTest: (point) => {
      pressPick = listPick.take();
      const s = store.getState();
      const { camera, viewport } = ports.readCamera();
      return liveHitTestAt(
        {
          root: s.domain,
          time: s.currentTime,
          // Codex #2: resolve the SAME display set the renderer drew (集約/実形状),
          // so a click on an aggregate body selects the aggregate and a hidden
          // child leaf / non-drawn vertex is never picked (単一真実源 — what is
          // drawn == what is hit). The display-control comes from the store, the
          // same slice committed-features feeds buildDisplayAreas with.
          displayControl: s.displayControl,
          // FR-113: restrict the hit母集合 to the SAME visible set the renderer culled
          // to, so a filter-hidden feature is not selectable and a click falls through
          // to whatever is drawn beneath (教訓 5.29 単一解決 — draw == hit). Inert default.
          filter: s.filter,
          // Forward projector for the screen-px vertex / point / line proximity,
          // from the SAME camera/viewport the frame drew with (単一真実源).
          toScreen: (w) => projectWorldToScreen(w, camera, viewport),
          // The camera + viewport let the hit-test enumerate the EXACT ±360° wrap
          // turns the renderer painted each drawable at (`wrapTurnsForLonSpan`), so a
          // point/vertex/line/area shown only as a wrap replica is still grabbable
          // (bughunt: 描画と hit-test の wrap 一致 — clip ⊇ draw ⊇ hit).
          wrap: { camera, viewport },
          // FR-87: the active feature exposes grabbable EDGE-midpoint handles, so a
          // click on an edge midpoint returns an Edge hit (→ U24 EdgeAdd) rather than
          // the body underneath. Only the selected feature draws edge handles, so we
          // pass the SAME active-feature truth the handle draw path uses (単一真実源).
          activeFeature: s.selection.activeFeature,
          // **描く条件と掴める条件を同じ入力で決める**（増分 5 の手直し A6）。
          // ハンドルを描くのは `mount/render.ts` の `editHandles` で、条件は
          // 「鍵が開いている」かつ「掴める道具（選ぶ・頂点・動かす）」である。
          // 同じ 2 つをここへ渡す ―― 渡さないと、読むだけのときに **見えていない
          // 頂点が最優先で掴まれ**、`app-active-vertex` が立って Escape の階段が
          // 1 段増える（GPT #2 / バグ狩り #15）。判定を 2 通りに書かないよう、
          // 述語そのものは `shell/tools.ts` の 1 本を読む（教訓 5.30）。
          handlesDrawn:
            s.mode !== EDIT_MODE.View && toolShowsVertexHandles(s.activeTool),
          point,
          // 増分 8A: 掴める距離を画面倍率に連動させる（下限 8px。`grab-radius.ts`）。
          radiusPx: grabRadiusPx(camera, viewport),
        },
        // World coordinate of the click (renderer inverse) for the world-space leaf
        // containment.
        surfaceToWorld(point),
      );
    },
  };
  // The LIVE SelectionPort drives U22's OWN reducer over the store selection truth
  // (restoreSelection) — so a body click promotes the feature AND clears the vertex
  // set, a vertex click replaces / Shift-toggles, empty clears, exactly per U22
  // (Codex P1: a setActiveFeature-only path wrongly left a stale vertex set). It
  // re-implements no selection rule.
  // FR-80 must (教訓 5.7 配線欠落) — the rubber-band RECTANGLE resolver: the vertices
  // inside a drag rectangle come from the SAME live drawn-vertex lookup the click
  // hit-test and the renderer use (`verticesInRectangle` over the shared display
  // resolution — displayControl honoured, so an aggregated/omitted vertex is never
  // rubber-band-selected, 単一真実源 5.29). Supplying it is what turns an empty-space
  // drag into a range select instead of resolving to "nothing inside".
  const rectangleResolver: RectangleResolver = {
    verticesInRectangle: (a, b) => {
      const s = store.getState();
      // wrap: enumerate the SAME ±360° turns the renderer painted (wrapTurnsForLonSpan)
      // so a vertex shown only as a wrap replica on a panned view is rubber-band
      // selectable — parity with the click hit-test (単一真実源, 描画⊇クリック⊇矩形).
      const { camera, viewport } = ports.readCamera();
      return verticesInRectangle(
        {
          root: s.domain,
          time: s.currentTime,
          displayControl: s.displayControl,
          // FR-113: a rubber-band never grabs a filter-hidden feature's vertices
          // (same母集合 as the click hit-test / renderer — 単一真実源).
          filter: s.filter,
          wrap: { camera, viewport },
        },
        a,
        b,
      );
    },
  };
  // 増分 8A（N-07）: 空いた所からのドラッグの間だけ、矩形選択の枠を描く（`withRubberBand`）。
  const selectionPort = withRubberBand(
    createLiveSelectionPort(
      {
        getSelection: () => store.getState().selection,
        restoreSelection: (sel) => store.getState().restoreSelection(sel),
      },
      surfaceToWorld,
      rectangleResolver,
    ),
    (band) => {
      transients.rubberBand = band;
      transients.scheduleEditPreviewRedraw();
    },
  );
  // ROOT FIX (bughunt: 実アプリで頂点/地物のドラッグ編集が PointerDispatcher に未結線 —
  // confirmRelease 到達不能, 教訓5.7「ロジックがあっても UI から呼ばれず機能しない状態を
  // 作らない」). The U24 drag-session adapter (createEditSessionPort) + its U13 binding
  // (createLiveEditBinding) existed and were unit-tested, but the dispatcher was built
  // WITHOUT an `editSession`, so an edit-mode left drag went only to U22 selection —
  // and selection EXCLUDES a drag (live-selection-port: wasDrag ⇒ no select) — while
  // the confirm trigger (confirmRelease → U13 → U12 undo unit) was never reached. We
  // now WIRE the edit session: a vertex / active-feature-body handle drag runs U24's
  // confirmRelease on release, commits ONE undo unit through the SAME recordCommit
  // path adds / knives / conflict-resolutions use (教訓5.11), and re-resolves selection.
  //
  // The binding reads the LIVE root at process-start (getRoot, never a stale capture —
  // 教訓5.6) and the after-state snapshot is built against the SAME committed root +
  // current time the renderer / hit-test resolve against (単一真実源, 教訓5.29).
  //
  // HB3-20 ROOT FIX — the slide / snap LIGHT PATH is now WIRED (診断 HB3-20 / 教訓 5.7
  // 「ロジックがあっても UI から呼ばれず機能しない」). The adapter's constrainSlide (排他)
  // + decideSnap (滑り) + the release-time decideSharePairAtRelease (共有化, built into
  // buildEditSnapshot) were live in the domain and unit-tested, but the three deps they
  // need were INTENTIONALLY omitted here — so a dragged vertex tunnelled through a
  // neighbour terminal and never snapped to / shared an adjacent boundary vertex. We now
  // inject them: a U10 RBush near-candidate query (`createNeighboursQuery`, narrowed per
  // frame around the preview — never an all-features scan, 教訓 5.3/5.4), the SAME
  // world→screen transform the draw uses (so it snaps where it looks like it snaps,
  // 単一真実源 5.29), and the live U16 snap distance (FR-110). With these present the
  // adapter runs the slide + snap light path every move and confirmRelease's share-pair
  // decision can collapse a surviving snap onto its target (受け入れ基準6/12).
  const editBinding = createLiveEditBinding({
    getRoot: () => store.getState().domain,
    // U4 study fix — the U06 difference write-back minters (shared project-wide
    // series via the lazy refs; assigned from sharedMint before any pointer event
    // can fire). Without them every conflict resolution on the edit-drag path was
    // refused (applyResolutionAt ⇒ undefined = 解決不能の行き止まり).
    nextVertexId: () => nextVertexIdRef.current!(),
    nextRingId: () => nextRingIdRef.current!(),
  });
  const editSnapshotCtx = {
    getRoot: () => store.getState().domain,
    getTime: () => store.getState().currentTime,
  };
  // The per-frame near-candidate query for the slide/snap light path (HB3-20). It
  // resolves the LIVE committed domain at the current time, narrows to terminals near
  // the preview via U10's RBush, and returns their boundary edges / polygons / snap
  // vertices + the dragged hole/enclave vertex's parent containment (受け入れ基準6 第4項).
  const neighboursQuery = createNeighboursQuery({
    getRoot: () => store.getState().domain,
    getTime: () => store.getState().currentTime,
    // The screen snap distance (px) expressed in WORLD units at the current zoom —
    // ONLY to widen the candidate query rectangle (the snap DECISION stays screen-space
    // in decideSnap, FR-31). zoom is CSS px per degree, so world margin = px / zoom; a
    // non-positive / unmeasured zoom yields 0 (no extra margin, exact-coincidence only).
    snapWorldMargin: () => {
      const { camera } = ports.readCamera();
      if (!Number.isFinite(camera.zoom) || camera.zoom <= 0) return 0;
      const px = store.getState().appSettings.snapDistancePx;
      // HB3-20 review fix: this margin widens the near-candidate QUERY used for BOTH the
      // snap AND the slide (排他) look-ahead. The snap DECISION uses snapDistancePx in
      // decideSnap (screen-space), so we floor the QUERY window at a fixed look-ahead —
      // disabling snap (snapDistancePx=0, a valid setting) must NOT also disable the slide
      // collision look-ahead, or a fast drag could tunnel a vertex through a thin
      // neighbour. Over-including candidates is safe: decideSnap with px=0 never snaps.
      const queryPx = Math.max(Number.isFinite(px) && px > 0 ? px : 0, SLIDE_LOOKAHEAD_PX);
      return queryPx / camera.zoom;
    },
  });
  const editSessionInner = createEditSessionPort<MountDomainRoot>({
    // The dragged handle world position uses the SAME renderer inverse the hit-test
    // and selection use, so the press / preview / release resolve against one camera.
    screenToWorld: surfaceToWorld,
    // The ring a dragged LEAF vertex belongs to (undefined for point / line), from
    // the live feature at the current time (shared rule, edit-session-snapshot).
    ringIdForVertex: (hit) =>
      ringIdForLeafVertex(editSnapshotCtx, hit.featureId, hit.vertexId),
    // FR-87: reserve the new vertex id for an edge-handle add through the SHARED
    // project-wide minter (via the ref, assigned from sharedMint on every render
    // before any pointer event can fire), so an edge-add id never collides with
    // stored data or another tool's output (教訓 5.37). Supplying this dep is what
    // makes the edge hit reachable; the adapter treats a caller with NO minter
    // (undefined dep — e.g. a unit test) as "edge hit stays plain selection" via its
    // own undefined-guard (教訓 5.7). In the live app the dep is always supplied.
    nextVertexId: () => nextVertexIdRef.current!(),
    // A feature-body hit begins a WHOLE-FEATURE move (受け入れ基準2 / FR-88) ONLY when
    // (HB3-8 ユーザー確定=排他) the 地物移動 tool is active AND the body is the currently-
    // selected active feature. Gating on EDIT_MOVE makes vertex-edit and feature-move
    // MUTUALLY EXCLUSIVE: in 頂点編集 a body drag no longer moves the whole feature
    // (ハンドル経由の頂点移動のみ) — that misfire (頂点編集中に地物移動が暴発) is the bug.
    // A body click on a non-active feature, or in any non-move tool, stays plain U22
    // selection (first click selects; switch to 地物移動 then drag to move).
    featureMoveAllowed: (hit) =>
      store.getState().activeTool === TOOL_ID.EditMove &&
      store.getState().selection.activeFeature === hit.featureId,
    // FR-80 複数頂点同時移動の結線: the LIVE U22 vertex selection, read fresh at PRESS.
    // Grabbing a vertex that is IN the selection turns the drag into ONE rigid move of
    // the whole set (the adapter asks U22's own companionVertexIdsFor — the rule is not
    // duplicated here). Without this dep the live path could only ever move the single
    // grabbed vertex, so 矩形/Shift で選んだ複数頂点はドラッグしても1点しか動かなかった
    // (教訓 5.7 — the reducer's release-time SimultaneousMoveSpec was unreachable because
    // a非空 press never enters live-selection-port's drag branch).
    vertexSelection: () => store.getState().selection,
    anchorTime: () => store.getState().currentTime,
    currentState: () => store.getState().domain,
    ports: editBinding.ports,
    // Assemble the complete after-state snapshot from the live session (moved vertex
    // bodies against the committed feature record / vertex store, 単一真実源). The snap
    // that survived to release is promoted to a share pair inside buildEditSnapshot via
    // decideSharePairAtRelease, so the dragged vertex collapses onto its target (HB3-20
    // 共有化 / 受け入れ基準12).
    buildSnapshot: (session) => buildEditSnapshot(editSnapshotCtx, session),
    // A5: 確定の関門が「移動後の辺」を見るための、動かす前のリング（連続経度）。
    movingRings: (session) => buildMovingRings(editSnapshotCtx, session),
    // --- HB3-20: slide / snap LIGHT PATH deps (受け入れ基準6 / 12) -----------------
    // The SAME world→screen transform the draw / hit-test use (so the snap fires where
    // it visually looks like it should, 単一真実源 5.29). decideSnap measures candidate
    // proximity in SCREEN px, so the projection must be the live camera's.
    worldToScreen: (world) => {
      const { camera, viewport } = ports.readCamera();
      return projectWorldToScreen(world, camera, viewport);
    },
    // The live U16 snap distance in screen px (FR-110). Read fresh so a settings change
    // takes effect on the next drag (教訓 5.35); non-positive ⇒ decideSnap never snaps.
    snapDistancePx: () => store.getState().appSettings.snapDistancePx,
    // The U10 near-candidate query for one drag frame (constrainSlide + decideSnap
    // inputs). Only called for a single-vertex drag (the adapter gates on a known
    // draggedVertexId); feature-move has no single point to slide / snap.
    neighboursAt: (preview, session) => neighboursQuery(preview, session),
    // On a processed release, record the committed edit as ONE U12 undo unit and
    // re-resolve selection to the edited feature (教訓5.11). A NoOp (zero-move / no
    // change) records nothing; a rejection / conflict surfaces no commit here (the
    // edit-session path has no conflict modal yet — detectSpatial returns none — so a
    // rejection is simply not committed rather than silently corrupting state).
    onReleased: (outcome) => {
      // 断られたら理由を出す（A5 / A6）。何も記録されていないので、利用者から見ると
      // 「離したのに何も起きない」になる ―― 理由を出さないと原因が分からない。
      if (outcome.kind === RELEASE_OUTCOME.Refused) {
        options.announceEditRefusalRef?.current?.(outcome.reason);
        return;
      }
      if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
      if (outcome.result.status !== PROCESS_STATUS.Committed) return;
      // A1 の報せ: **記録する前の**プロジェクトで、この移動が後ろの年の記録を何本
      // 書き換えるかを数える（判定は `applyEditProposal` と同じ 1 本を通る）。
      const carried = reportVertexCarryForward(
        store.getState().domain,
        outcome.proposal,
        MOUNT_CALENDAR,
      );
      const featureId =
        outcome.proposal.snapshot.feature?.id ??
        outcome.proposal.snapshot.deletedFeatureId;
      const preference = featureId !== undefined ? { featureId } : undefined;
      // fr100: the recolor anchor time is the PROPOSAL's own anchorTime (the time
      // the drag confirm resolved at press/release) — the exact commit time.
      recordCommitRef.current?.(outcome.result, preference, outcome.proposal.anchorTime);
      // 記録のあとに上書きする（既定の「素性の変更を行いました」より、こちらのほうが
      // 何が起きたかを言っている）。0 本なら何も足さない ―― 起きなかったことは言わない。
      if (carried.anchorCount > 0 && carried.firstYear !== null) {
        options.announceCarryForwardRef?.current?.(
          outcome.proposal.anchorTime.year,
          carried.firstYear,
          carried.anchorCount,
        );
      }
    },
    // HB3-4: receive the live session on every transition (begin / each move / release
    // / cancel). Hold it as transient render state and schedule a frame so the dragged
    // vertex / feature is redrawn at its preview position and FOLLOWS the cursor. On
    // release / cancel the session is null, so the next frame draws the committed
    // geometry (release path already ran recordCommit). Carries NO truth — the redraw
    // re-reads the store + this transient (技術方針 2.5 / 受け入れ基準8).
    onPreview: (session) => {
      transients.liveEditSession = session;
      transients.scheduleEditPreviewRedraw();
    },
    // 増分 8A（N-06）: 辺の中点の印をクリックしたら、その辺のちょうど中点に頂点を足す。
    // 中点は描いている印と同じ `computeHandles` から引く（`edge-click.ts`）。
    edgeClickPoint: (session) => {
      const s = store.getState();
      return edgeAddMidpoint(
        resolveDisplayFor(s.domain, s.currentTime, s.displayControl),
        session,
      );
    },
  });
  // 増分 8A の手直し（反証 重 3）: 一覧から選んだ直後の左ドラッグ 1 回だけ、選んだ頂点を
  // 最寄りより優先して掴む（`preferListPick`。条件はそちらの注記）。印はこの押下の
  // `hitTest` で既に消えているので、2 回目の押下には効かない。
  const editSession: EditSessionPort = {
    begin: (hit, point, modifiers) => {
      const pick = pressPick;
      pressPick = null;
      const preferred = preferListPick(
        hit,
        pick,
        modifiers,
        { context: candidateContextOf(), selection: store.getState().selection },
        () => probeNear(point),
      );
      return editSessionInner.begin(preferred, point, modifiers);
    },
    update: (point) => editSessionInner.update(point),
    release: (point, wasDrag) => editSessionInner.release(point, wasDrag),
    cancel: () => editSessionInner.cancel(),
  };
  // BUGHUNT2 ROOT FIX — the LIVE right-click context-menu port (FR-96). On a
  // right-button press the dispatcher calls this port (dispatch.ts:「Right button
  // is always a context-menu request」); it promotes the hit feature into the LIVE
  // selection through the SAME write path a left click uses (so 削除 etc. target the
  // right-clicked feature, 教訓 5.11), converts the surface point back to client px
  // for the position:fixed menu (the inverse of `toSurface`, same hookTarget rect —
  // 単一の transform, 教訓 5.29), and opens the {@link MapContextMenu} React mount
  // through the opener ref. Was NOOP_CONTEXT_MENU_PORT — right-click was a dead end.
  const contextMenu = createLiveContextMenuPort({
    surfaceToClient: (point) => {
      const box = hookTarget.getBoundingClientRect();
      return { x: point.x + box.left, y: point.y + box.top };
    },
    promoteHit: (hit) => {
      const s = store.getState();
      // Resolve the promoted selection with the SAME U22 builders a LEFT click uses
      // (単一の選択書き込み経路, 教訓 5.11 / 5.29) and write it through the ONE
      // restoreSelection seam: a feature-body hit makes it active AND clears any
      // vertex selection (bughunt5 HOLE-2 — the setActiveFeature-only path left a
      // stale vertex set, so a following 削除 wrongly targeted those vertices on
      // ANOTHER feature; the left-click reducer path already cleared it), a vertex
      // hit selects that feature + that single vertex (unchanged). Empty space is
      // never reached here (the port skips promotion for an empty hit).
      s.restoreSelection(promoteHitToSelection(s.selection, hit));
    },
    open: (request) => contextMenuOpenerRef.current?.open(request),
    // fr96 段階7 優先規則: ダイアログが鍵盤を持っているあいだは、右クリックの要求ごと
    // 捨てる（昇格もメニューも走らせない）。**道具が下書きを持っているだけのときは
    // 捨てない** ―― メニューは開いてよく、止めるのは昇格だけである（下の `promotes`。
    // 設計書 §I.3 の原則①）。どちらの判定も `shell/focus-owner.ts` の 1 本を通し、
    // 現在値は ref から読む（教訓 5.6: 古い写しを掴まない）。
    suspended: () => suspendsContextMenu(focusOwnerRef.current),
    promotes: () => promotesOnContextMenu({ toolDrawing: toolDraftRef.current }),
  });

  // 頂点の候補一覧（#12）。`hitTester` と **同じ入力** を渡すので、一覧に出る顔ぶれは
  // 「いま掴める頂点」とちょうど一致する（描画 ⊇ ヒット ＝ 候補）。
  const probeNear = (point: ScreenPoint): readonly NearVertexCandidate[] => {
    const s = store.getState();
    const { camera, viewport } = ports.readCamera();
    return verticesNearPoint(
      {
        root: s.domain,
        time: s.currentTime,
        displayControl: s.displayControl,
        filter: s.filter,
        toScreen: (w) => projectWorldToScreen(w, camera, viewport),
        wrap: { camera, viewport },
        activeFeature: s.selection.activeFeature,
        handlesDrawn:
          s.mode !== EDIT_MODE.View && toolShowsVertexHandles(s.activeTool),
        point,
        // 当たり判定と同じ掴める距離（増分 8A）。
        radiusPx: grabRadiusPx(camera, viewport),
      },
      surfaceToWorld(point),
    );
  };
  // 一覧の行に出す座標と「引いている地物の全部」を足す（増分 8A。現状.md B42）。
  const probeVertexCandidates = (point: ScreenPoint): readonly DescribedVertexCandidate[] => {
    const s = store.getState();
    return describeNearVertices(
      resolveDisplayFor(s.domain, s.currentTime, s.displayControl),
      probeNear(point),
    );
  };

  const selectVertex = (featureId: FeatureId, vertexId: VertexId): void => {
    const s = store.getState();
    // U22 の並びをそのまま作る（地物を選び直し、その頂点 1 つを選ぶ）。
    s.restoreSelection(
      replaceVertices(withActiveFeature(s.selection, featureId), featureId, new Set([vertexId])),
    );
    // 直後の左ドラッグ 1 回だけ、この頂点を最寄りより優先して掴む（反証 重 3 の手直し）。
    listPick.arm({ featureId, vertexId, context: candidateContextOf() });
  };

  return {
    hitTester,
    selectionPort,
    editSession,
    contextMenu,
    probeVertexCandidates,
    selectVertex,
  };
}
