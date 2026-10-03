// UI 層（地図マウントの結線 / 描画）: レンダラホストの組み立てと、そこへ入る「何を描くか」
// の getter 一式、カメラ操作（視点合わせ・全体表示・拡大縮小）、そして FR-110 の再描画
// スケジューラの結線。
//
// 真実は 1 つも持たない: 描く内容はすべて合成のたびに U16 ストアから読み直し（教訓 5.6）、
// カメラの書き込み口も `ports.writeCamera` の 1 本だけ（教訓 5.29）。

import type { MutableRefObject } from 'react';

import { createAddHostPorts, type AddHostPorts } from '../../add/host-ports';
import { isFilterInert } from '../../discovery/index';
import { toolShowsVertexHandles } from '../../shell/tools';
import { EDIT_MODE } from '../../state/session';
import { buildActiveFeatureHandlePrimitives } from '../active-feature-handles';
import { buildCommittedFeatures } from '../committed-features';
import { resolveDisplayFor } from '../display-resolution-cache';
import {
  allFeaturesBoundsAt,
  featureBoundsAt,
  type AllFeaturesBoundsOptions,
} from '../feature-bounds';
import { isFeatureVisibleUnderFilter } from '../filtered-display';
import { keyboardZoomCamera, type ZoomDirection } from '../keyboard-zoom';
import { createRedrawScheduler } from '../redraw-scheduler';
import { redrawWatch, redrawWatchChanged } from '../redraw-watch';
import { withRubberBandLayer } from '../rubber-band';
import { withCandidateHoverLayer } from '../candidate-hover';
import { cameraForBounds, cameraForFit } from '../../../render';
import type { Camera as RenderCamera, ZoomRange } from '../../../render/camera';
import { DEFAULT_LABEL_THRESHOLDS } from '../../../render/feature-layer';
import { DEFAULT_GRID_STYLE, type GridStyle } from '../../../render/grid-layer';
import { coerceGridSpacing } from '../../../domain/basemap/index';
import type { FeatureId } from '../../../domain/ids';
import type { E2EFrameSummary } from './observation';
import type { MountStore, MountTransients } from './shared';

/** {@link createMountRender} の入力。 */
export interface MountRenderOptions {
  /** 地図キャンバスのマウント先（AppShell が `onMapMount` に渡す div）。 */
  readonly el: HTMLDivElement;
  /** 描く内容を毎フレーム読み直す唯一の U16 セッションストア。 */
  readonly store: MountStore;
  /** 部品をまたぐ可変の参照（編集プレビュー / 再描画の吐き出し口）。 */
  readonly transients: MountTransients;
  /** 生きたレンダラの置き場（ここへ入れる）。 */
  readonly rendererRef: MutableRefObject<AddHostPorts | null>;
  /** マウント前に渡された FR-10 のズーム範囲。 */
  readonly zoomRangeRef: MutableRefObject<ZoomRange | null>;
  /** S7 出界図 — 読み込んだ下地画像のバイト列。 */
  readonly baseMapImageRef: MutableRefObject<Uint8Array>;
  /** HB5-3 錨起点の視点合わせ（ここで実体を入れる）。 */
  readonly fitCameraToFeatureRef: MutableRefObject<((featureId: FeatureId) => void) | null>;
  /** 全体表示（ここで実体を入れる）。 */
  readonly fitCameraToAllRef: MutableRefObject<(() => void) | null>;
  /** 拡大 / 縮小（ここで実体を入れる）。 */
  readonly zoomMapRef: MutableRefObject<((direction: ZoomDirection) => void) | null>;
  /**
   * 拡大 / 縮小を **押す前に** 知らせる口（増分 8E / G-21）。押す前の倍率と、いま効いている
   * 上下限を渡すだけで、断るかどうかの判定は受け手（`map/zoom-limit-notice.ts`）が持つ。
   * ズームの処理そのものは変えない（上限での振る舞いはこれまでどおりクランプ）。
   */
  readonly zoomCommandNoticeRef?: MutableRefObject<
    ((direction: ZoomDirection, zoomBefore: number, range: ZoomRange) => void) | null
  >;
  /** HB-1 観測フックへカメラを写す。 */
  readonly publishCameraHooks: (camera: RenderCamera) => void;
  /** HB-14 観測フックへ可視地物数を写す。 */
  readonly publishVisibleCountHook: (count: number) => void;
  /** HB3-9 観測フックへフレームの内訳を写す。 */
  readonly publishFrameHook: (summary: E2EFrameSummary) => void;
}

/** {@link createMountRender} の産物。 */
export interface MountRender {
  /** 生きたレンダラホスト（カメラの唯一の読み書き口でもある）。 */
  readonly ports: AddHostPorts;
  /**
   * ストア購読による再描画と、ホスト自身の高頻度再描画の FPS 上限化を **開始する**。
   * 分割前と同じ位置——入力側のリスナーとモード購読を張ったあと——で呼ぶこと。
   * ここより前に `setRedrawRequester` を入れると、マウント直後の
   * `setZoomRange` による再クランプ描画が同期から rAF 送りへ変わってしまい、
   * ストア購読の登録順（モード中断の購読が先）も入れ替わる。
   */
  readonly startRedrawScheduling: () => void;
  /** 後始末（購読解除 → スケジューラ破棄 → ホスト破棄 → 遅延結線の解除）。 */
  readonly dispose: () => void;
}

/**
 * レンダラホストを作り、「何を描くか」の getter とカメラ操作を結線する。
 */
export function createMountRender(options: MountRenderOptions): MountRender {
  const {
    el,
    store,
    transients,
    rendererRef,
    zoomRangeRef,
    baseMapImageRef,
    fitCameraToFeatureRef,
    fitCameraToAllRef,
    zoomMapRef,
    zoomCommandNoticeRef,
    publishCameraHooks,
    publishVisibleCountHook,
    publishFrameHook,
  } = options;

  // P0-A — feed the LIVE committed features into the renderer. The host reads
  // this getter on every composite, so the latest committed domain resolved at
  // the current time (with the live selection for FR-82) is what draws (single
  // truth source — no copy of the domain in the renderer, 教訓 5.29 / 5.6).
  const ports = createAddHostPorts(el, {
    committedFeatures: () => {
      const s = store.getState();
      // Areas flow through U34 (集約 / depth / focus); points / lines directly
      // (P0-A). The display-control comes from the store so the slider re-derives
      // the batch on the next redraw (FR-42 / FR-43, 教訓 5.5).
      return buildCommittedFeatures(
        s.domain,
        s.currentTime,
        s.activeFeature,
        s.displayControl,
        // FR-113: the session display filter (種別/深度/個別非表示/不透明度) culls +
        // opacity-composes the drawn batch. DEFAULT is inert, so an untouched filter
        // draws byte-identically (perf 鉄則). A change swaps `filter` wholesale, which
        // the redraw subscription tracks (s.filter === prevFilter guard) so the next
        // composite re-derives (教訓 5.5).
        s.filter,
      );
    },
    // FR-86 / FR-109: the area-label occupancy threshold is a project setting; the
    // point/line label thresholds are not user-settable (DEFAULT applies). Read
    // live so a settings change reflects on the next redraw (教訓 5.35).
    labelThresholds: () => ({
      ...DEFAULT_LABEL_THRESHOLDS,
      areaMinOccupancy:
        store.getState().projectSettings.areaLabelOccupancyThreshold,
    }),
    // FR-13 / FR-109 グリッド即時反映: derive the LIVE graticule style from the
    // project settings (gridSpacingDeg / gridColor / gridOpacity) so a
    // SettingsDialog change reflects on the next redraw. The host hard-coded
    // DEFAULT_GRID_STYLE before, so the panel truth never reached the draw
    // (bughunt: グリッド設定が地図描画に反映されない). The emphasis/width/label-font
    // fields stay at the DEFAULT (not user-settable, 受け入れ基準 8); only the three
    // user settings are overlaid. Spacing is coerced to an allowed value so a stale
    // setting can never produce an off-list spacing (教訓 5.18, 単一の coerce規則).
    // Read live per composite — never a stale capture (教訓 5.6).
    gridStyle: (): GridStyle => {
      const ps = store.getState().projectSettings;
      return {
        ...DEFAULT_GRID_STYLE,
        spacing: coerceGridSpacing(ps.gridSpacingDeg),
        color: ps.gridColor,
        opacity: ps.gridOpacity,
        // 増分 8E（G-12）: 表示の設定で外せる、赤道・0 度・180 度の強調。
        emphasizeSpecialLines: store.getState().gridEmphasisVisible,
      };
    },
    // FR-13 グリッド ON/OFF 即時反映: derive the LIVE graticule visibility from the
    // project setting so the topBar toggle / SettingsDialog checkbox reflect on the
    // next redraw. Read live per composite — never a stale capture (教訓 5.6 / 5.35).
    // The redraw-on-settings subscription below tracks gridVisible so a toggle fires
    // a redraw at once (buildGridPrimitives(false,…) → 明示的空, 教訓 5.18).
    gridVisible: (): boolean => {
      // FR-13 / K-6: **上書きがあればそれ、無ければプロジェクト設定**。上書きは
      // 上部バーのトグルが書くセッション限りの値で、保存ファイルには入らない
      // （`SessionState.gridVisibleOverride`）。読むだけのあいだも眺め方は変えられる。
      const s = store.getState();
      return s.gridVisibleOverride ?? s.projectSettings.gridVisible;
    },
    // HB-1 観測フック: mirror the LIVE camera into DOM data-* attributes on the
    // map input layer so a behavioural E2E can read the pan offset + zoom and
    // assert they actually changed (既存 app-active-feature マーカーと同方式). The
    // attributes hold NO truth — they只 reflect the renderer camera (技術方針 2.5).
    onCameraChange: (camera) => publishCameraHooks(camera),
    // HB-14 観測フック: how many committed features survived this frame's clip.
    onVisibleFeatureCount: (count) => publishVisibleCountHook(count),
    // HB3-9 ROOT FIX — the EDIT HANDLES layer (FR-87). `computeHandles` was a dead
    // domain value with NO render consumer (診断 HB3-9 / 教訓 5.7「ロジックはあるが UI
    // から呼ばれない」): a user who selected a feature in 編集 mode saw no vertex /
    // add-vertex handles and could not tell what to grab. We now evaluate it FRESH
    // per composite for the active feature and feed the resulting screen-fixed
    // (FR-17) handle primitives into the frame ABOVE the committed shape and UNDER the
    // tool overlay. Gated to 編集 mode with an active feature; in every other state the
    // getter returns [] so no handle draws (受け入れ基準: 非存在は描画指示に現れない).
    // This is the prerequisite for HB3-4 (drag preview) / HB3-8 (move 排他). The
    // feature + vertex store come from the SAME resolveDisplayFor bundle the draw /
    // hit-test share, so a handle sits exactly on the drawn vertex (教訓 5.29).
    // FR-110 視野内カウント: `view` はこのフレームを合成する camera/viewport そのもの。
    // ハンドルビルダーへ渡し、視野内の頂点だけを生成・カウントさせる (デカい地物も
    // ズームインすれば cap を下回り編集できる)。
    // 増分 8A（N-07）: 矩形選択の枠をこの層のいちばん上に足す（`withRubberBandLayer`）。
    // 増分 8A の手直し: 候補一覧の行に乗っている頂点の輪も足す（`withCandidateHoverLayer`）。
    editHandles: withCandidateHoverLayer(() => transients.candidateHover, withRubberBandLayer(() => transients.rubberBand, (view) => {
      const s = store.getState();
      // **増分 5b: 条件を「編集モードのとき」から「掴める道具のとき」へ変えた**
      // （設計書 §C.3 / 実装計画 §5 の 5b）。モードの 3 ボタンが消えて `mode` が
      // 道具からの導出値になったので、`mode === Edit` は「面・線・点 以外の道具を
      // 構えている」とほぼ同義になり、条件として何も言わなくなる。**掴めるのは
      // 「選ぶ」「頂点」「動かす」の 3 つだけ**である。
      //
      // 読むだけ（鍵が閉じている）ときはハンドルを出さない ―― 選べる・読めるが
      // 直せない（裁定 N-4）ので、掴める印を出すのは嘘になる。
      if (s.mode === EDIT_MODE.View) return [];
      // HB3-6/18 review fix: tools with their OWN overlay (ナイフ / 結合 / 所属変更) promote
      // a target into activeFeature for highlighting; the edit-handles layer must NOT also
      // draw vertex/edge handles on that target during those tools (cosmetic bleed under
      // the tool overlay). **その除外はいま `toolShowsVertexHandles` の中にある** ――
      // 同じ判断を 2 か所に書くと、道具が増えたときに片方だけ直して食い違う（教訓 5.44）。
      if (!toolShowsVertexHandles(s.activeTool)) return [];
      // HB3-4: pass the LIVE drag session so the active feature's handles + a preview
      // outline are drawn at the PREVIEW position (follows the cursor) during a drag,
      // and at the committed position otherwise. The builder ignores a session for a
      // different feature (no stale bleed, 教訓 5.6).
      // FR-110: thread appSettings.vertexMarkerCap (single source = U16) so the handle
      // path is suppressed WHOLESALE for a pathologically large active feature (perf
      // guard); the default cap (2000) leaves normal features unchanged.
      return buildActiveFeatureHandlePrimitives(
        s.domain,
        s.currentTime,
        s.activeFeature,
        s.displayControl,
        transients.liveEditSession,
        undefined,
        undefined,
        s.appSettings.vertexMarkerCap,
        // FR-113 (Codex F2): suppress handles for an active feature the filter hides.
        s.filter,
        // FR-80/82 選択頂点ハイライトの結線: the U22 selection truth reaches the DRAW path
        // here. Without it the handle layer had no selection input at all, so selecting a
        // vertex produced ZERO pixel change (実機接写ペアが md5 一致) even though the
        // selection state itself was correct — the classification lived in
        // domain/selection/visual with no render consumer (教訓 5.7).
        //
        // `vertexOwner` rides along because a vertex id is a GLOBAL VertexStore key and
        // FR-30 共有頂点 means a neighbour cites the same id: without the owner the ring
        // leaked onto the active feature's copy of a vertex selected on ANOTHER feature
        // (FR-81 一owner). It is also what lets the builder draw the FR-82 頂点選択
        // コンテキスト地物 when the owner is not the active feature.
        //
        // NO `draggingVertexIds` FROM HERE (敵対レビュー MEDIUM): the orange ring means
        // 「この頂点はいま動いている」. The live edit path moves exactly ONE vertex
        // (edit-session-adapter's targetFromHit builds a single-vertex VertexMove /
        // EdgeAdd target), and the builder already derives that one from the live
        // DragSession, so its ring can never disagree with the previewed position.
        // Handing the WHOLE selection set as "dragging" painted v2/v3 orange at their
        // committed positions while only v1 moved — and U22's VertexDrag transient is
        // armed on the mere press, so even a zero-move click turned the set orange. It is
        // also never observable here: the live selection port drives PointerDown and
        // PointerUp inside ONE `end()` call, so the store only ever sees the IDLE
        // transient.
        //
        // FR-80 多頂点同時移動 (now live) still does NOT change that: the builder derives
        // the ring set from the GESTURE's own truth — `movingVertexIds(session)`, the same
        // union that positions the preview — so every orange vertex is one that is really
        // in motion and really drawn at its preview position. Feeding the selection set
        // from here would re-introduce exactly the defect above (rings on vertices that a
        // mere press, or a single-vertex drag, leaves standing still).
        {
          selectedVertexIds: s.selection.vertexIds,
          ownerFeatureId: s.selection.vertexOwner,
        },
        // contextOutlineStyle は既定のまま (undefined ⇒ default 適用)
        undefined,
        view,
      );
    })),
    // HB3-4 観測フック: a live edit-drag preview is present iff a session is in flight
    // for the active feature in 編集 mode. ORed into the frame's `hasLivePreview` so a
    // behavioural E2E (and the __E2E__ hook) can assert the drag preview is live — the
    // edit preview is composited in the editHandles layer (NOT the tool overlay), so it
    // would otherwise not register in the overlay-derived preview count.
    editPreviewActive: () => {
      const s = store.getState();
      return (
        s.mode !== EDIT_MODE.View &&
        toolShowsVertexHandles(s.activeTool) &&
        transients.liveEditSession !== null &&
        transients.liveEditSession.target.featureId === s.activeFeature
      );
    },
    // HB3-9 観測フック: mirror the last drawn frame's primitive summary into __E2E__.
    onFrameComposed: (summary) => publishFrameHook(summary),
    // S7 出界図 結線 (FR-03 / 教訓 5.7 合成ルートの結線漏れ) — resolve the DISPLAYED base
    // map from the LIVE truth: the store domain's baseMap.source + meta (swapped on
    // load / new) and the retained project base-map image bytes (baseMapImageRef,
    // pushed by the file-ops controller on load / new). The host resolves these
    // through the domain's single `resolveDisplayedBasemap` decision — a loaded user
    // project (non-empty source WITH bytes) paints its OWN 4096×2048 image (perfectly
    // feature-aligned), while a new / empty / preset-id project (or missing bytes)
    // paints the bundled preset. Read live per composite so a load / new is followed
    // on the next redraw (単一真実源 — never a stale copy, 教訓 5.6). This is the fix
    // for the実機 report「海岸線と地物が南北にズレる」: the preset SVG's land was
    // normalized to a different height than the project image, so features drew
    // shifted; painting the project's own image removes the shift.
    baseMap: () => {
      const bm = store.getState().domain.baseMap;
      return { source: bm.source, meta: bm.meta, bytes: baseMapImageRef.current };
    },
  });
  rendererRef.current = ports;
  // Apply any clamp range supplied before mount (FR-10 即時反映).
  if (zoomRangeRef.current !== null) ports.setZoomRange(zoomRangeRef.current);

  // HB5-3 錨起点の視点合わせ — frame the camera onto a feature's world extent. Bound
  // here because `ports` (the SINGLE camera write path, 教訓 5.29) is in scope. Reads
  // the LIVE root at the CURRENT time (the anchor-row click sets the time to the錨の
  // 開始 FIRST via setCurrentTime, so this resolves the shape at that time), computes
  // the fit against the renderer's OWN viewport + the effective FR-10 zoom clamp
  // (zoomMin/zoomMax, fit-world floor applied), and writes through `ports.writeCamera`
  // — the SAME path pan/wheel use, so it mirrors into the U16 store camera truth via
  // onCameraChange (no二重真実源). A feature with no resolvable extent is a no-op.
  fitCameraToFeatureRef.current = (featureId: FeatureId): void => {
    const s = store.getState();
    const bounds = featureBoundsAt(s.domain, s.currentTime, featureId);
    if (bounds === null) return;
    const { viewport } = ports.readCamera();
    // paddingRatio defaults to DEFAULT_FIT_PADDING_RATIO (≈20% margin/side, HB5-3).
    const camera = cameraForBounds(bounds, viewport, {
      range: ports.effectiveZoomRange(),
    });
    ports.writeCamera(camera);
  };

  // 全体表示 — frame every feature that is DRAWN at the current time. Deliberately the
  // SAME fit as the錨一覧導線 above (cameraForBounds + DEFAULT_FIT_PADDING_RATIO ≈20%/side
  // + the effective FR-10 zoom clamp — `cameraForFit` is that fit plus the 地物ゼロ
  // fallback, so BOTH branches obey the clamp), only with the WHOLE-project extent
  // instead of one feature's, and written through the SAME single `ports.writeCamera`
  // path so it mirrors into the U16 store camera truth via onCameraChange (単一真実源,
  // 教訓 5.29). 地物ゼロ / 全部非表示 ⇒ the FR-11 既定視点 (world fit).
  //
  // FR-113 母集合 (review fix): the extent counts only features the map actually PAINTS.
  // committed-features drops anything outside `visibleIds`, so framing a 絞り込みで
  // 非表示 feature would zoom out onto empty space (絞り込みで1地物だけ表示中なのに
  // 全世界へ引く). The gate is the SAME single verdict the draw / hit / 一覧 / ツール取得
  // read (isFeatureVisibleUnderFilter), and it is not even consulted on an INERT filter
  // (the common case pays nothing — no resolution, no per-feature call).
  fitCameraToAllRef.current = (): void => {
    const s = store.getState();
    const { viewport } = ports.readCamera();
    let options: AllFeaturesBoundsOptions = {};
    if (!isFilterInert(s.filter)) {
      const resolution = resolveDisplayFor(s.domain, s.currentTime, s.displayControl);
      options = {
        isVisible: (featureId) => isFeatureVisibleUnderFilter(resolution, s.filter, featureId),
      };
    }
    const bounds = allFeaturesBoundsAt(s.domain, s.currentTime, options);
    ports.writeCamera(cameraForFit(bounds, viewport, { range: ports.effectiveZoomRange() }));
  };

  // 拡大 / 縮小 — the keyboard/menu counterpart of the wheel notch. `keyboardZoomCamera`
  // is the SAME U17 `zoomStepAtCursor` step + FR-10 clamp the wheel runs through, only
  // anchored at the viewport centre instead of the cursor, and the result is written
  // through the SAME single `ports.writeCamera` path (単一真実源, 教訓 5.29) so it mirrors
  // into the U16 store camera via onCameraChange exactly like a wheel zoom.
  zoomMapRef.current = (direction: ZoomDirection): void => {
    const { camera, viewport } = ports.readCamera();
    zoomCommandNoticeRef?.current?.(direction, camera.zoom, ports.effectiveZoomRange());
    ports.writeCamera(
      keyboardZoomCamera(camera, viewport, direction, ports.effectiveZoomRange()),
    );
  };

  // FR-110 描画更新頻度: route EVERY store-driven redraw through the U19 redraw
  // scheduler so the configured render FPS actually caps the draw rate (bughunt
  // root: the FrameScheduler existed but was never instantiated, so renderFps was a
  // dead setting — validated/clamped/persisted yet never reaching the draw loop,
  // 教訓 5.7). The scheduler collapses N requests within one frame into ONE draw
  // (受け入れ基準 5) and gates draws faster than the per-frame budget. A live
  // renderFps change re-arms the cap via setFps (watched in the subscription below)
  // so a settings confirm takes effect at once (FR-110 即時反映). The single-rAF
  // throttle lives in U19; this is only the結線 (no second copy of the rule).
  let renderFps = store.getState().appSettings.renderFps;
  const redrawScheduler = createRedrawScheduler({
    draw: () => ports.redraw(),
    initialFps: renderFps,
  });
  const requestRedraw = (): void => redrawScheduler.request();
  // Now that the scheduler exists, point the pre-declared flush at it so a
  // pointerdown drains any pending throttled frame before the hit-test (drawn ==
  // state, 『見える＝掴める』).
  transients.flushRedraw = (): void => redrawScheduler.flush();
  // HB3-4: route the live edit-drag preview redraw through the SAME FPS-capped
  // scheduler as every other high-frequency repaint, so a drag's per-move preview is
  // coalesced/capped like pan/zoom (受け入れ基準5) — N moves within one frame collapse
  // to ONE composite. The session is already stashed synchronously in onPreview, so a
  // deferred frame reads the freshest preview (no lost update, 教訓 5.6).
  transients.scheduleEditPreviewRedraw = (): void => redrawScheduler.request();

  // ストア購読は「入力側のモード中断購読のあと」に張る（分割前と同じ登録順）。購読の
  // 実体が入るのは `startRedrawScheduling` を呼んだ時点なので、それまでは null。
  let unsubscribe: (() => void) | null = null;
  const startRedrawScheduling = (): void => {
    // FR-110 ROOT FIX (bughunt round-2): route the host's OWN high-frequency repaints
    // through the SAME scheduler. Pan/wheel (writeCamera), tool-draft moves (drawAdd /
    // drawKnife) and resize (resyncViewport) previously called the synchronous full-frame
    // recomposition on every input event, so those interactions — exactly the ones FR-110
    // is meant to cap — repainted at raw input rate, bypassing the FrameScheduler that was
    // wired only around the store-subscription redraw. Injecting the requester here makes
    // the host defer its composite to `redrawScheduler.request()` (whose draw re-enters
    // `ports.redraw()`), so N input events within one frame collapse to ONE composite and
    // the configured render FPS caps the draw rate (受け入れ基準 5). The camera/overlay
    // state is still written synchronously inside the host, so readCamera / hit-tests / the
    // observation hooks see the live camera at once — only the pixels are throttled.
    ports.setRedrawRequester(requestRedraw);
    // Re-composite whenever the committed domain / current time / selection /
    // display-control / label-threshold setting changes so an added / edited /
    // split feature (or a slider / setting change) draws at once (P0-A / 教訓 5.5).
    // The Canvas subscribes to the store directly, OFF the React render path
    // (技術方針 2.3 / 2.5). A redraw after a tool overlay draw is idempotent (it
    // re-composites with the same last overlay), so there is no double-source risk.
    // WHICH state changes need a composite is decided by ONE pure, unit-tested function
    // (`map/redraw-watch`) instead of a hand-maintained列 of `let prevX` variables. That
    //列 DRIFTED from what the host getters actually read — twice: the FR-13 grid settings
    // (gridStyle) and then the FR-80/82 vertex selection (editHandles). Selecting a vertex
    // does NOT change `activeFeature` (U22's HIT_KIND.Vertex branch leaves it alone by
    // design — FR-82 has a distinct「頂点選択コンテキスト地物」state), so on an already-active
    // feature EVERY previously-watched value stayed identical → early return → no redraw →
    // the FR-82 selection ring appeared only when some unrelated input moved. The watch set
    // now lives next to its own regression test, and its invariant is stated once there:
    // every value a getter reads MUST appear in it (教訓 5.35 / 5.7).
    let prevWatch = redrawWatch(store.getState());
    unsubscribe = store.subscribe((s) => {
      // FR-110: a live renderFps change re-arms the per-frame budget (the cap is
      // fixed at scheduler construction, so setFps rebuilds it). This is NOT gated by
      // the early-return below — a pure renderFps change re-arms the budget without
      // forcing a redraw of unchanged content.
      if (s.appSettings.renderFps !== renderFps) {
        renderFps = s.appSettings.renderFps;
        redrawScheduler.setFps(renderFps);
      }
      const watch = redrawWatch(s);
      if (!redrawWatchChanged(prevWatch, watch)) return;
      prevWatch = watch;
      requestRedraw();
    });
  };

  const dispose = (): void => {
    unsubscribe?.();
    redrawScheduler.dispose();
    ports.dispose();
    rendererRef.current = null;
    // 教訓 5.2 全経路で破棄 — the camera-driving runners close over the now-disposed
    // `ports`. Left non-null they keep their commands' `canRun` true, so 表示 → 拡大 /
    // 縮小 / 全体表示 would render ENABLED and call readCamera/writeCamera on a
    // disposed host. Nulling them makes those commands honestly disabled until a
    // remount re-binds them (setup runs AFTER this cleanup, so a remount re-assigns).
    zoomMapRef.current = null;
    fitCameraToAllRef.current = null;
    fitCameraToFeatureRef.current = null;
  };

  return { ports, startRedrawScheduling, dispose };
}
