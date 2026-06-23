// UI layer: React UI shell. May import domain and render only.
//
// The application root mounts the U20 layout shell (AppShell): top menu, left
// toolbar, central map area, right sidebar, bottom timeline slot + status bar
// (FR-111). The session store (U16) is the single truth source for mode / tool /
// selection / time; the shell binds to it and never holds map-draw state in
// React (技術方針 2.3).
//
// U23 INTEGRATION (教訓 5.7 完了トリガーの明示配線 / 教訓 5.2 全経路で破棄): the
// root now CONSUMES the add-tool flow — it mounts {@link AddToolController} in the
// shell overlay, bound to the same store. The controller turns toolbar tool
// selection into a session start, map-input pointer events into vertex placement,
// the complete / save buttons into the U23 logic, and feeds the provisional
// {@link buildAddPrimitives} batch to the live renderer. The renderer is created
// imperatively on map mount (技術方針 2.3) and its `screenToWorld` / `drawBatch`
// back the controller's ports.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from 'zustand';

import { createSessionStore } from './state/store';
import { EDIT_MODE } from './state/session';
import { AppShell } from './shell';
import { buildSidebarContent } from './shell/SidebarContent';
import { TOOL_ID } from './shell/tools';
import {
  DetailPanels,
  EMPTY_DETAIL_PANELS,
  closeDetailPanel,
  openPanel,
  type DetailPanelsState,
  type AssetResolver,
  type EditDispatch,
  type FeatureLookup as PropertyFeatureLookup,
} from './property';
import { Timeline } from './timeline/Timeline';
import { CommandRegistry } from './shell/commands';
import './shell/shell.css';
import './property/property.css';
import './file-ops/file-ops.css';
import './help-tools/help-tools.css';

import { getCalendar } from '../domain/time/calendar';
import type { DomainProject } from '../domain/persistence/index';
import {
  FileOpsController,
  buildEmptyProject,
  type SupplyZoomRange,
  type WindowCloseHook,
  type DropTargetHook,
  type FileDropHandlers,
} from './file-ops/index';
import type { ZoomRange } from '../render/camera';

import {
  AddToolController,
  type AddToolControllerProps,
  type AddDrawSink,
  type ScreenToWorld,
} from './add/AddToolController';
import {
  isFaceFeature,
  parentCandidates as buildParentCandidates,
  type ParentCandidate,
} from '../domain/add/index';
import { createAddHostPorts, type AddHostPorts } from './add/host-ports';
import {
  KnifeToolController,
  type KnifeDrawSink,
} from './knife/index';
import { MergeToolController, type MergeDrawSink } from './merge/index';
import './merge/merge.css';
import { ReparentToolController, type ReparentDrawSink } from './reparent/index';
import './reparent/reparent.css';
import { HelpToolsController } from './help-tools/index';
import type { DrawPrimitive } from '../render/map-renderer';
import {
  createBasicAttributes,
  createColorInfo,
  withFillOpacity,
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
} from '../domain/attributes';
import {
  ConflictResolutionModal,
  type ApplyResolutions,
} from './conflict/index';
import './conflict/conflict.css';
import './knife/knife.css';
import type {
  Conflict,
  ConflictsPendingResult,
} from '../domain/consistency/index';
import type { ConflictShapes } from './conflict/index';
import {
  createHistory,
  execute as historyExecute,
  undo as historyUndo,
  redo as historyRedo,
  canUndo as historyCanUndo,
  canRedo as historyCanRedo,
  type History,
} from '../domain/command/history';
import type { Command } from '../domain/command/index';
import { COMMAND_ID } from './shell/commands';
import { featuresAt, verticesAt, leafShapeAt, leafAtPoint } from './live-lookup';
import { createLiveExistenceResolver } from './live-existence';
import { buildCommittedFeatures } from './map/committed-features';
import { buildActiveFeatureHandlePrimitives } from './map/active-feature-handles';
import {
  PointerDispatcher,
  NOOP_ADD_PORT,
  LongitudeShiftControl,
  type CameraPort,
  type HitTester,
  type MapCameraInput,
} from './map/index';
import { createLiveContextMenuPort } from './map/live-context-menu-port';
import {
  MapContextMenu,
  type ContextMenuOpener,
} from './map/MapContextMenu';
import { HIT_KIND } from '../domain/selection';
import { liveHitTestAt, drawnAreaAt } from './map/live-hit-test';
import { createLiveSelectionPort } from './map/live-selection-port';
import { createEditSessionPort } from './map/edit-session-adapter';
import {
  buildEditSnapshot,
  ringIdForLeafVertex,
} from './map/edit-session-snapshot';
import { createNeighboursQuery } from './map/slide-snap-neighbours';
import { RELEASE_OUTCOME, type DragSession, type FeatureSnapshot } from '../domain/editing/index';
import {
  worldToScreen as projectWorldToScreen,
  screenToWorld as unprojectScreenToWorld,
  type ScreenPoint,
} from '../render';
import { createRedrawScheduler } from './map/redraw-scheduler';
import type { Camera as RenderCamera } from '../render/camera';
import type { WorldCoordinate } from '../domain/coordinate';
import { DEFAULT_LABEL_THRESHOLDS } from '../render/feature-layer';
import { DEFAULT_GRID_STYLE, type GridStyle } from '../render/grid-layer';
import {
  coerceGridSpacing,
  applyLongitudeShift,
  centerLonForPreset,
  type CenterLonPreset,
} from '../domain/basemap/index';
import type { GeoMultiPolygon } from '../domain/geometry/types';

// The domain truth root is U14's persistence {@link DomainProject} (histories +
// settings + base-map). U39 wires file-ops to load / save / repair it; the shell
// and the add / knife controllers stay generic over it and never reach inside
// (spec 依存: ルート状態を不変に受け渡す).
type DomainRoot = DomainProject;

export function App(): JSX.Element {
  // Bootstrap with an empty NEW project (地物 0 件 + 出界図 preset background,
  // FR-03 / spec §D). The file-ops controller re-initialises this atomically on
  // 新規プロジェクト and replaces it wholesale on 読み込み (教訓 5.22 / 5.36).
  // ROOT FIX (bughunt: live store created with NO ExistenceResolver — a time
  // change never deselected a feature/vertex that ceased to exist). The store
  // re-validates time-dependent selection on every time-change through an INJECTED
  // existence port (教訓 5.5/5.6, store.ts:setCurrentTime → U22 revalidateForTime),
  // re-implementing NO time logic. Without an `existence` option it fell back to
  // ALWAYS_PRESENT_RESOLVER, so the whole re-validation funnel was a silent no-op:
  // selecting a feature effective only in [t0,t1] then dragging the timeline past
  // t1 left it the active selection (property panel / delete / edit-move all acting
  // on a feature the map had dropped), contradicting FR-64/66/70.
  //
  // We now wire an existence resolver bound to the LIVE domain root via the SAME
  // featuresAt/verticesAt live-lookup the renderer / hit-test / knife use (単一
  // 真実源 — "exists" == "drawn/hittable"). The chicken/egg (the resolver must read
  // the store created BELOW) is resolved with a getRoot ref, the same pattern
  // recordCommit uses: the ref is assigned right after createSessionStore returns,
  // and the resolver reads it live per call (never a stale capture, 教訓 5.6).
  const liveRootRef = useRef<(() => DomainRoot) | null>(null);
  const store = useMemo(
    () =>
      createSessionStore<DomainRoot>({
        initialDomain: buildEmptyProject(),
        existence: createLiveExistenceResolver(() => {
          // Read the live committed root through the ref; until it is wired (it is
          // assigned synchronously on the very next line after this store is built)
          // fall back to an empty project so a predicate can never throw.
          const getRoot = liveRootRef.current;
          return getRoot !== null ? getRoot() : buildEmptyProject();
        }),
      }),
    [],
  );
  // Wire the live-root thunk now that the store exists (chicken/egg resolution).
  liveRootRef.current = () => store.getState().domain;

  // The U20 command registry: the ファイル menu / shortcuts dispatch through it.
  // Created here and shared with BOTH the shell (so the menu binds it) and the
  // file-ops controller (so it registers the save/open/new commands, 教訓 5.13).
  const registry = useMemo(() => new CommandRegistry(), []);

  // The active calendar for U14 load-time consistency checks (FR-106).
  const calendar = useMemo(() => getCalendar('gregorian'), []);

  // Window-close interception (FR-107 終了確認ガード): the controller registers the
  // quit guard; the host stores it so a later shell-side close event can await it.
  // Until the Electron close event is bridged (shell seam), the runner is held
  // here so the contract is real and the guard logic is observable / testable.
  const quitGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerWindowClose: WindowCloseHook = useCallback((runGuard) => {
    quitGuardRef.current = runGuard;
    return () => {
      quitGuardRef.current = null;
    };
  }, []);

  // D&D 読み込み (FR-105): the file-ops controller exposes the drop handlers; we bind
  // them on the app-shell ROOT, which is pointer-active and an ancestor of the map
  // area, so a real-browser drop (Electron Chromium) over the map bubbles up here
  // and reaches the load flow. The controller's own overlay container is
  // pointer-events:none (教訓 5.14) and therefore cannot be the real drop target.
  const [dropHandlers, setDropHandlers] = useState<FileDropHandlers | null>(null);
  const registerDropTarget: DropTargetHook = useCallback((handlers) => {
    setDropHandlers(handlers);
    return () => setDropHandlers(null);
  }, []);

  // The live renderer is created imperatively on map mount (技術方針 2.3); we hold
  // it behind a ref so the add-tool ports read the current renderer without riding
  // a React re-render. Until the map mounts the ports degrade gracefully (no-op
  // draw / identity transform), so the wiring is real and never crashes pre-mount.
  const rendererRef = useRef<AddHostPorts | null>(null);

  // ROOT FIX (bughunt: 追加/ナイフ描画中は中ボタンパンとホイールズームが効かない). The
  // add / knife controllers mount a full-surface input bridge ABOVE the map while
  // drawing (教訓 5.14); it captures pointer/wheel events that then never reach the
  // U40 PointerDispatcher (its DOM listeners are on the background map-input-layer,
  // a sibling), so 中ボタンパン / ホイールズーム died during drawing. We hold a
  // {@link MapCameraInput} port — built in onMapMount from the SAME live dispatcher —
  // behind a ref and hand it to both tool controllers so their bridge FORWARDS the
  // camera-only events (wheel + non-left pointer) to that one dispatcher (単一真実源 —
  // no second pan/zoom path, 教訓 5.29). Until the map mounts it degrades to a no-op.
  const cameraInputRef = useRef<MapCameraInput | null>(null);

  // ROOT FIX (bughunt2: FR-96 の右クリックメニューが NO-OP ポートに結線されていた). The
  // U40 dispatcher routes every right-button press to the `contextMenu` port, but the
  // root backed it with NOOP_CONTEXT_MENU_PORT, so right-click never opened a menu
  // (教訓 5.7). We now back it with the LIVE port (createLiveContextMenuPort, built in
  // onMapMount from the SAME hit-test / selection / surface transform the click path
  // uses) and bridge its open-request to the {@link MapContextMenu} React mount through
  // this opener ref — the SAME late-binding pattern cameraInputRef uses. A no-op until
  // the mount registers its setter (bindContextMenuOpener below).
  const contextMenuOpenerRef = useRef<ContextMenuOpener | null>(null);

  // The latest U12 commit handler, held behind a ref so the imperatively-created
  // edit-session port (built in `onMapMount`, which runs once per map mount) always
  // calls the CURRENT `recordCommit` without re-mounting the map on every render
  // (技術方針 2.3: the live input path stays off React re-render). Assigned by an
  // effect below once `recordCommit` exists; read by the edit-session `onReleased`.
  const recordCommitRef = useRef<
    ((result: ProcessResult<DomainRoot>, preference?: { readonly featureId: FeatureId }) => void) | null
  >(null);

  // The latest zoom CLAMP range (FR-10). The file-ops controller pushes it on
  // every settings change; we cache it so a range set BEFORE the map mounts is
  // applied as soon as the renderer exists (no lost update, 教訓 5.22).
  const zoomRangeRef = useRef<ZoomRange | null>(null);

  const onMapMount = useCallback((el: HTMLDivElement): (() => void) => {
    // HB-1 観測フック target. Resolved BEFORE the renderer is created because
    // `createAddHostPorts` fires `onCameraChange` synchronously on its initial paint
    // (to seed the hooks) — referencing `hookTarget` from inside that callback before
    // it exists would be a temporal-dead-zone ReferenceError that crashes the mount.
    // The pointer/wheel listeners attach to the map INPUT layer (教訓 5.14); if it is
    // not present yet (defensive) we fall back to the canvas mount element.
    const inputLayer = el.parentElement?.querySelector<HTMLElement>(
      '[data-testid="map-input-layer"]',
    );
    const hookTarget: HTMLElement = inputLayer ?? el;

    // HB3-4 ROOT FIX — the LIVE edit-drag preview. The U24 drag session held the moved
    // geometry as a transient (教訓 5.22: a drag never mutates committed state), but the
    // adapter had no `onPreview` and the render layer had no consumer, so the committed
    // feature + its handles kept drawing at the PRESS position for the whole drag and
    // then JUMPED to the new place on release (診断 HB3-4 / 教訓 5.7). We hold the live
    // session here as transient render state: the adapter's `onPreview` sets it (begin /
    // each move) and clears it (release / cancel), and the `editHandles` getter applies
    // its preview to the handle + outline positions so the vertex / feature follows the
    // cursor every frame. It carries NO truth — the commit still flows through onReleased
    // → recordCommit (技術方針 2.5). `scheduleEditPreviewRedraw` is pointed at the redraw
    // scheduler once it exists (a no-op until then; the early base paint is synchronous).
    let liveEditSession: DragSession | null = null;
    let scheduleEditPreviewRedraw = (): void => {};

    /** Reflect the live camera into the observation hooks (pan offset + zoom). */
    const publishCameraHooks = (camera: RenderCamera): void => {
      // Pan offset is the camera center displacement from the FR-11 origin (0,0);
      // a drag changes it, so the E2E reads a before/after delta. Zoom is verbatim.
      hookTarget.dataset['panX'] = String(camera.centerLon);
      hookTarget.dataset['panY'] = String(camera.centerLat);
      hookTarget.dataset['zoom'] = String(camera.zoom);
      // ROOT FIX (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale) — mirror
      // EVERY live render-camera change into the U16 store camera truth (技術方針 2.5:
      // camera STATE is owned by the session store). This is the SINGLE mirror path
      // for ALL camera changes — the FR-11 fit-all on first paint, the zero-size→
      // measured re-fit, AND every pan/wheel through writeCamera — so subscribers that
      // bind to store.camera (the U26 knife 固定円半径 / 閉線判定 zoom prop) always see
      // the renderer's TRUE zoom, never the DEFAULT_CAMERA.zoom=1 placeholder that
      // diverges from the actual fit zoom until the first interaction (二重真実源を
      // 作らない, 教訓 5.29). Only the three transform fields the render camera carries
      // are patched (the store Camera additionally has panX/panY).
      const s = store.getState();
      const cur = s.camera;
      // ONE store transition per camera change: `updateCamera` mirrors `centerLon`
      // into the top-level FR-12 longitude truth within the SAME set() (store.ts),
      // so a live pan / wheel — the hottest path — fires the subscription once, not
      // twice (updateCamera + setCenterLon). The guard also covers the centerLon
      // mirror: if camera fields are unchanged then centerLon (== camera.centerLon)
      // is too, so there is nothing to write.
      if (
        cur.zoom !== camera.zoom ||
        cur.centerLon !== camera.centerLon ||
        cur.centerLat !== camera.centerLat
      ) {
        s.updateCamera({
          zoom: camera.zoom,
          centerLon: camera.centerLon,
          centerLat: camera.centerLat,
        });
      }
    };

    /**
     * HB-14 観測フック: mirror the count of committed features that SURVIVED the
     * period-aware view clip on the latest composite into `data-visible-feature-count`
     * (既存 app-active-feature 方式). A behavioural E2E commits one area, then zooms in
     * step by step and asserts this count never wrongly drops to 0 while the feature
     * is still on screen (拡大すると地物が消える 再発防止). Holds NO truth — pure mirror.
     */
    const publishVisibleCountHook = (count: number): void => {
      hookTarget.dataset['visibleFeatureCount'] = String(count);
    };

    // HB3-9 RENDER OBSERVATION HOOK (__E2E__). The bughunt lesson "Behavioral E2E
    // standard" requires tests that observe the actual RENDER so a render-only bug
    // (handles never drawn) is detectable from a real pointer-driven test — a synthetic
    // shortcut cannot see it. We expose a small read-only window hook that mirrors (a)
    // the live active feature id, (b) the live active tool id (the toolbar's aria-pressed
    // tool), (c) the per-kind primitive counts of the LAST drawn frame (handle / label /
    // preview / shape / point / line), and (d) whether a live tool preview is present.
    // It holds NO truth — pure mirrors of the store + the last composed frame (技術方針
    // 2.5). `frame` is updated by the host's onFrameComposed below.
    type E2EFrameSummary = {
      handle: number;
      label: number;
      shape: number;
      point: number;
      line: number;
      preview: number;
      hasLivePreview: boolean;
      vertexHandlePositions: readonly { readonly lon: number; readonly lat: number }[];
    };
    let lastFrame: E2EFrameSummary = {
      handle: 0,
      label: 0,
      shape: 0,
      point: 0,
      line: 0,
      preview: 0,
      hasLivePreview: false,
      vertexHandlePositions: [],
    };
    const e2eWindow = el.ownerDocument.defaultView as (Window & {
      __E2E__?: unknown;
    }) | null;
    if (e2eWindow !== null) {
      e2eWindow.__E2E__ = {
        /** The live active feature id ('' when none). */
        getActiveFeature: (): string =>
          (store.getState().activeFeature as unknown as string | null) ?? '',
        /** The live active tool id ('' when none) — the toolbar's aria-pressed tool. */
        getActiveTool: (): string =>
          (store.getState().activeTool as unknown as string | null) ?? '',
        /** The live interaction mode ('view' / 'add' / 'edit'). */
        getMode: (): string => store.getState().mode,
        /** Per-kind primitive counts of the LAST drawn frame (handle/label/shape/point/line). */
        getPrimitiveCounts: (): E2EFrameSummary => ({ ...lastFrame }),
        /** Whether a live tool preview (FR-78 仮表示 overlay) is present this frame. */
        hasLivePreview: (): boolean => lastFrame.hasLivePreview,
        /**
         * HB3-4: the WORLD positions of the active feature's VERTEX edit-handles in the
         * LAST drawn frame (preview positions during a live drag). A behavioural E2E
         * asserts the dragged handle follows the cursor mid-drag and does NOT jump back
         * to the committed position after release.
         */
        getVertexHandlePositions: (): readonly {
          readonly lon: number;
          readonly lat: number;
        }[] => lastFrame.vertexHandlePositions.map((p) => ({ lon: p.lon, lat: p.lat })),
        /**
         * HB3-4: convert a CLIENT screen point to a world coordinate via the LIVE
         * renderer inverse (the SAME transform the draw / hit-test use). Lets the drag
         * E2E identify WHICH committed handle corresponds to a known screen corner,
         * independent of the camera. Returns null before the renderer mounts.
         */
        screenToWorld: (
          clientX: number,
          clientY: number,
        ): { readonly lon: number; readonly lat: number } | null =>
          rendererRef.current?.screenToWorld(clientX, clientY) ?? null,
      };
    }

    /** HB3-9: mirror the last composed frame's primitive summary into the __E2E__ hook. */
    const publishFrameHook = (summary: E2EFrameSummary): void => {
      lastFrame = summary;
    };

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
      // GridSettingsPanel change reflects on the next redraw. The host hard-coded
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
        };
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
      editHandles: () => {
        const s = store.getState();
        if (s.mode !== EDIT_MODE.Edit) return [];
        // HB3-6/18 review fix: tools with their OWN overlay (ナイフ / 結合 / 所属変更) promote a
        // target into activeFeature for highlighting; the edit-handles layer must NOT also
        // draw vertex/edge handles on that target during those tools (cosmetic bleed under
        // the tool overlay). Handles belong to 選択 / 頂点編集 / 地物移動 only.
        if (
          s.activeTool === TOOL_ID.EditKnife ||
          s.activeTool === TOOL_ID.EditMerge ||
          s.activeTool === TOOL_ID.EditReparent
        ) {
          return [];
        }
        // HB3-4: pass the LIVE drag session so the active feature's handles + a preview
        // outline are drawn at the PREVIEW position (follows the cursor) during a drag,
        // and at the committed position otherwise. The builder ignores a session for a
        // different feature (no stale bleed, 教訓 5.6).
        return buildActiveFeatureHandlePrimitives(
          s.domain,
          s.currentTime,
          s.activeFeature,
          s.displayControl,
          liveEditSession,
        );
      },
      // HB3-4 観測フック: a live edit-drag preview is present iff a session is in flight
      // for the active feature in 編集 mode. ORed into the frame's `hasLivePreview` so a
      // behavioural E2E (and the __E2E__ hook) can assert the drag preview is live — the
      // edit preview is composited in the editHandles layer (NOT the tool overlay), so it
      // would otherwise not register in the overlay-derived preview count.
      editPreviewActive: () => {
        const s = store.getState();
        return (
          s.mode === EDIT_MODE.Edit &&
          liveEditSession !== null &&
          liveEditSession.target.featureId === s.activeFeature
        );
      },
      // HB3-9 観測フック: mirror the last drawn frame's primitive summary into __E2E__.
      onFrameComposed: (summary) => publishFrameHook(summary),
    });
    rendererRef.current = ports;
    // Apply any clamp range supplied before mount (FR-10 即時反映).
    if (zoomRangeRef.current !== null) ports.setZoomRange(zoomRangeRef.current);

    // HB-1 ROOT FIX — wire the U40 PointerDispatcher to the LIVE camera (U17). The
    // pure dispatcher + pan/zoom math existed (PointerDispatcher / pan / VTransform)
    // but the composition root never CONNECTED them to the real viewport, so a drag
    // or wheel moved nothing (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」).
    // We back the U40 CameraPort with the renderer's live camera (read/write through
    // the host ports — the single camera the draw uses, 教訓 5.29) and attach the DOM
    // listeners to the map INPUT layer (教訓 5.14). View-mode left/middle drag pans;
    // the wheel does cursor-anchored zoom in EVERY mode. Selection / add are owned by
    // their own input controllers, so those ports are honest no-ops here.
    // Drain a throttled redraw before a pointerdown hit-test so drawn == live state
    // (bughunt round-2: stale-frame hit-test window). Assigned once the redraw
    // scheduler is built below; a no-op until then (the early base paint is already
    // synchronous, so a press before the scheduler exists has nothing to flush).
    let flushRedraw = (): void => {};
    const cameraPort: CameraPort = {
      read: () => ports.readCamera(),
      write: (camera) => {
        // The renderer is the camera the DRAW uses; writing it fires the host's
        // onCameraChange (publishCameraHooks), which is the SINGLE place that mirrors
        // the live render camera into the U16 store truth (技術方針 2.5: camera STATE
        // is owned by the session store) AND the observation hooks. Routing the store
        // mirror through onCameraChange — rather than duplicating it here — means the
        // FR-11 fit-all initial camera and the zero-size re-fit also reach the store,
        // not only pan/wheel, so subscribers (FR-12 中心経度 / FR-13 grid / U26 knife
        // 固定円 zoom) never see the stale DEFAULT_CAMERA placeholder (二重真実源を
        // 作らない, 教訓 5.29).
        ports.writeCamera(camera);
      },
    };
    // HB-15 ROOT FIX — wire the LIVE map click hit-test + selection so an edit-mode
    // click on a vertex / feature actually selects (教訓 5.7 合成ルートの結線漏れ). The
    // hit-test reuses the renderer's box-corrected screen↔world (HB-7) AND
    // live-lookup's featuresAt / verticesAt AND the SAME display-control-resolved drawn
    // area set the U26 knife featureAtPoint port now uses (drawnAreaAt) — 二重真実源を
    // 作らない, 教訓 5.29).
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
    const hitTester: HitTester = {
      hitTest: (point) => {
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
            // Forward projector for the screen-px vertex / point / line proximity,
            // from the SAME camera/viewport the frame drew with (単一真実源).
            toScreen: (w) => projectWorldToScreen(w, camera, viewport),
            // The camera + viewport let the hit-test enumerate the EXACT ±360° wrap
            // turns the renderer painted each drawable at (`wrapTurnsForLonSpan`), so a
            // point/vertex/line/area shown only as a wrap replica is still grabbable
            // (bughunt: 描画と hit-test の wrap 一致 — clip ⊇ draw ⊇ hit).
            wrap: { camera, viewport },
            point,
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
    const selectionPort = createLiveSelectionPort(
      {
        getSelection: () => store.getState().selection,
        restoreSelection: (sel) => store.getState().restoreSelection(sel),
      },
      surfaceToWorld,
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
    const editSession = createEditSessionPort<DomainRoot>({
      // The dragged handle world position uses the SAME renderer inverse the hit-test
      // and selection use, so the press / preview / release resolve against one camera.
      screenToWorld: surfaceToWorld,
      // The ring a dragged LEAF vertex belongs to (undefined for point / line), from
      // the live feature at the current time (shared rule, edit-session-snapshot).
      ringIdForVertex: (hit) =>
        ringIdForLeafVertex(editSnapshotCtx, hit.featureId, hit.vertexId),
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
      anchorTime: () => store.getState().currentTime,
      currentState: () => store.getState().domain,
      ports: editBinding.ports,
      // Assemble the complete after-state snapshot from the live session (moved vertex
      // bodies against the committed feature record / vertex store, 単一真実源). The snap
      // that survived to release is promoted to a share pair inside buildEditSnapshot via
      // decideSharePairAtRelease, so the dragged vertex collapses onto its target (HB3-20
      // 共有化 / 受け入れ基準12).
      buildSnapshot: (session) => buildEditSnapshot(editSnapshotCtx, session),
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
        if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
        if (outcome.result.status !== PROCESS_STATUS.Committed) return;
        const featureId =
          outcome.proposal.snapshot.feature?.id ??
          outcome.proposal.snapshot.deletedFeatureId;
        const preference = featureId !== undefined ? { featureId } : undefined;
        recordCommitRef.current?.(outcome.result, preference);
      },
      // HB3-4: receive the live session on every transition (begin / each move / release
      // / cancel). Hold it as transient render state and schedule a frame so the dragged
      // vertex / feature is redrawn at its preview position and FOLLOWS the cursor. On
      // release / cancel the session is null, so the next frame draws the committed
      // geometry (release path already ran recordCommit). Carries NO truth — the redraw
      // re-reads the store + this transient (技術方針 2.5 / 受け入れ基準8).
      onPreview: (session) => {
        liveEditSession = session;
        scheduleEditPreviewRedraw();
      },
    });
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
        // A feature-body / vertex hit becomes the active feature (the menu's command
        // target); a vertex hit additionally selects that vertex, exactly as a left
        // click resolves it (単一の選択書き込み経路). Empty space is never reached here
        // (the port skips promotion for an empty hit, keeping the current selection).
        if (hit.kind === HIT_KIND.FeatureBody) {
          s.setActiveFeature(hit.featureId);
        } else if (hit.kind === HIT_KIND.Vertex) {
          s.setActiveFeature(hit.featureId);
          s.replaceVertexSelection(hit.featureId, [hit.vertexId]);
        }
      },
      open: (request) => contextMenuOpenerRef.current?.open(request),
    });
    const dispatcher = new PointerDispatcher({
      getMode: () => store.getState().mode,
      camera: cameraPort,
      hitTester,
      selection: selectionPort,
      editSession,
      add: NOOP_ADD_PORT,
      contextMenu,
      // FR-10 即時反映 / Codex medium #6: clamp the wheel zoom against the LIVE
      // effective range (project-setting min/max + the renderer fit-world floor),
      // read fresh per notch so a settings change reaches the wheel and the floor
      // keeps the FR-11 fit-all initial camera in range (単一真実源 — the renderer's
      // own clamp, not a second copy here).
      getZoomRange: () => ports.effectiveZoomRange(),
    });

    // Convert a DOM event's client coords to surface-relative CSS px (the dispatcher
    // works in surface space, matching the renderer transform — 教訓 5.29).
    const toSurface = (clientX: number, clientY: number): { x: number; y: number } => {
      const box = hookTarget.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };

    const onPointerDown = (e: PointerEvent): void => {
      // STALE-FRAME HIT-TEST FIX (bughunt round-2): drain any throttled redraw NOW so
      // the pixels match the live store state BEFORE the hit-test runs. The hit-test
      // reads LIVE store state + the live camera (hitTester.hitTest), but the redraw is
      // FPS-capped, so when a frame is held back by the cap the store has advanced while
      // the user still sees the OLD frame — a press would then resolve against the NEW
      // feature set, not the visible one (『見える ≠ 掴める』). Flushing first restores
      // drawn == state (clip ⊇ draw ⊇ hit) at the instant of the press; it honours the
      // pending draw exactly once (no extra paint, 受け入れ基準 5) and is a no-op when no
      // frame is pending, so it costs nothing on the common path.
      flushRedraw();
      const { x, y } = toSurface(e.clientX, e.clientY);
      // Hand the capture target to the dispatcher so IT owns the pan's pointer
      // capture lifecycle end to end: capture on pan-start, release on EVERY
      // teardown path (release / cancel / mode-change abort). hookTarget is a
      // stable background element, but routing capture through the dispatcher keeps
      // the native and overlay-bridge paths under ONE capture discipline (教訓 5.2 /
      // 5.29) rather than each re-implementing setPointerCapture/release.
      dispatcher.pointerDown(PointerDispatcher.normalize(e, x, y), hookTarget);
    };
    const onPointerMove = (e: PointerEvent): void => {
      const { x, y } = toSurface(e.clientX, e.clientY);
      dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true));
    };
    const onPointerUp = (e: PointerEvent): void => {
      const { x, y } = toSurface(e.clientX, e.clientY);
      // The dispatcher releases the pan's pointer capture itself (it owns the
      // capture lifecycle, set in pointerDown above) — no manual release here.
      dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y));
    };
    const onPointerCancel = (e: PointerEvent): void => {
      dispatcher.pointerCancel(e.pointerId);
    };
    const onPointerLeave = (): void => dispatcher.pointerLeave();
    // BUGHUNT2 ROOT FIX (FR-96) — suppress the NATIVE browser/OS context menu on the
    // map so OUR right-click menu (opened from the pointerdown above) is the only one
    // shown. Without this the default contextmenu would pop over the custom menu. The
    // dispatcher already drove the context-menu request on pointerdown; this only
    // stops the default so the two never overlap.
    const onContextMenu = (e: MouseEvent): void => e.preventDefault();
    const onWheel = (e: WheelEvent): void => {
      // Prevent the page from scrolling so a notch becomes a zoom, not a scroll.
      e.preventDefault();
      const { x, y } = toSurface(e.clientX, e.clientY);
      dispatcher.wheel({ x, y, deltaY: e.deltaY, deltaMode: e.deltaMode });
    };

    hookTarget.addEventListener('pointerdown', onPointerDown);
    hookTarget.addEventListener('pointermove', onPointerMove);
    hookTarget.addEventListener('pointerup', onPointerUp);
    hookTarget.addEventListener('pointercancel', onPointerCancel);
    hookTarget.addEventListener('pointerleave', onPointerLeave);
    hookTarget.addEventListener('contextmenu', onContextMenu);
    // `passive: false` so `preventDefault` actually suppresses page scroll on wheel.
    hookTarget.addEventListener('wheel', onWheel, { passive: false });

    // ROOT FIX (bughunt: 追加/ナイフ描画中は中ボタンパンとホイールズームが効かない) —
    // expose the camera-only entry points of THIS dispatcher to the tool overlays.
    // The tool input bridge sits above the map (教訓 5.14) and would otherwise eat
    // the wheel / middle-button events; it now forwards them here so they reach the
    // SAME live dispatcher the background listeners use (単一真実源 — one pan/zoom
    // path, no drift). Client coords are converted to surface space with the SAME
    // `toSurface` (hookTarget rect) the native listeners use, so "scroll here ⇒ zoom
    // anchored here" cannot diverge between the two input surfaces (教訓 5.29). Left-
    // button input is NOT routed here (it stays owned by the tool); only the wheel
    // and non-left pointer interactions (the dispatcher's mode×button table gates
    // which non-left button actually pans) flow through.
    cameraInputRef.current = {
      wheel: (clientX, clientY, deltaY, deltaMode): void => {
        const { x, y } = toSurface(clientX, clientY);
        dispatcher.wheel({ x, y, deltaY, deltaMode });
      },
      pointerDown: (e, clientX, clientY): void => {
        // The tool owns the LEFT button (placement / cut input); never start a pan
        // sequence for it here. Non-left presses (middle/right) go to the dispatcher,
        // which decides pan vs context-menu from its mode×button table.
        if (e.button === 0) return;
        // Drain a throttled redraw before the dispatcher hit-tests (a right-button
        // press resolves a context-menu hit), for the same『見える＝掴める』reason as
        // the background pointerdown above (single flush rule).
        flushRedraw();
        const { x, y } = toSurface(clientX, clientY);
        // Hand the OVERLAY bridge (the element the event fired on) to the dispatcher
        // as the pan's capture target so a middle-button pan keeps tracking off the
        // bridge (受け入れ基準 3 押下→移動→解放の連続保証). Crucially the dispatcher now
        // OWNS the release on every teardown path: a mid-pan tool/mode switch fires
        // onModeChange → abortAll, which releases this capture BEFORE the bridge can
        // unmount on that switch (BUGHUNT2 root — was: capture left dangling, relying
        // on the browser's implicit on-removal release / the eventual pointerup).
        dispatcher.pointerDown(
          PointerDispatcher.normalize(e, x, y),
          e.currentTarget as Element | null ?? undefined,
        );
      },
      pointerMove: (e, clientX, clientY): void => {
        // A move with the left button held is a tool draw, not a pan — the dispatcher
        // tracks only the pointers IT started (a left press never started one here),
        // so an untracked move is a safe no-op. We still forward every move so an
        // in-flight middle-button pan keeps updating.
        const { x, y } = toSurface(clientX, clientY);
        dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true));
      },
      pointerUp: (e, clientX, clientY): void => {
        const { x, y } = toSurface(clientX, clientY);
        // The dispatcher releases the bridge's pointer capture itself (it owns the
        // capture lifecycle, set in pointerDown above) — no manual release here.
        dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y));
      },
      pointerCancel: (pointerId): void => {
        dispatcher.pointerCancel(pointerId);
      },
    };

    // Abort any in-progress pan/selection on a mode OR active-tool change so a stale
    // reference from the previous mode/tool cannot bleed into the next (教訓 5.2,
    // 受け入れ基準 6). A tool switch (store.setActiveTool) runs the same reset契約 as
    // setMode — it wipes the selection context — but leaves `mode` untouched, so
    // watching `mode` alone let an in-flight edit-drag survive a mid-drag toolbar
    // switch and still commit on release (bughunt root: the abort fired only on mode).
    let prevMode = store.getState().mode;
    let prevActiveTool = store.getState().activeTool;
    const unsubscribeMode = store.subscribe((s) => {
      if (s.mode === prevMode && s.activeTool === prevActiveTool) return;
      prevMode = s.mode;
      prevActiveTool = s.activeTool;
      dispatcher.onModeChange();
    });
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
    flushRedraw = (): void => redrawScheduler.flush();
    // HB3-4: route the live edit-drag preview redraw through the SAME FPS-capped
    // scheduler as every other high-frequency repaint, so a drag's per-move preview is
    // coalesced/capped like pan/zoom (受け入れ基準5) — N moves within one frame collapse
    // to ONE composite. The session is already stashed synchronously in onPreview, so a
    // deferred frame reads the freshest preview (no lost update, 教訓 5.6).
    scheduleEditPreviewRedraw = (): void => redrawScheduler.request();
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
    let prevDomain = store.getState().domain;
    let prevTime = store.getState().currentTime;
    let prevActive = store.getState().activeFeature;
    // HB3-9: the edit-handles layer is gated on 編集 mode, so a mode change (View↔Edit↔
    // Add) must trigger a redraw — otherwise entering 編集 with a feature already selected
    // would not draw its handles until some other tracked input changed (教訓 5.5).
    let prevRedrawMode = store.getState().mode;
    let prevDisplay = store.getState().displayControl;
    let prevAreaThreshold =
      store.getState().projectSettings.areaLabelOccupancyThreshold;
    // FR-13 / FR-109 グリッド即時反映: the grid spacing / color / opacity project
    // settings feed the host's gridStyle getter, so a change MUST trigger a redraw
    // too — otherwise the getter is never re-read and the panel change is invisible
    // (bughunt root: the subscription watched only the threshold among settings keys).
    let prevGridSpacing = store.getState().projectSettings.gridSpacingDeg;
    let prevGridColor = store.getState().projectSettings.gridColor;
    let prevGridOpacity = store.getState().projectSettings.gridOpacity;
    const unsubscribe = store.subscribe((s) => {
      // FR-110: a live renderFps change re-arms the per-frame budget (the cap is
      // fixed at scheduler construction, so setFps rebuilds it). This is NOT gated by
      // the early-return below — a pure renderFps change re-arms the budget without
      // forcing a redraw of unchanged content.
      if (s.appSettings.renderFps !== renderFps) {
        renderFps = s.appSettings.renderFps;
        redrawScheduler.setFps(renderFps);
      }
      const areaThreshold = s.projectSettings.areaLabelOccupancyThreshold;
      const gridSpacing = s.projectSettings.gridSpacingDeg;
      const gridColor = s.projectSettings.gridColor;
      const gridOpacity = s.projectSettings.gridOpacity;
      if (
        s.domain === prevDomain &&
        s.currentTime === prevTime &&
        s.activeFeature === prevActive &&
        s.mode === prevRedrawMode &&
        s.displayControl === prevDisplay &&
        areaThreshold === prevAreaThreshold &&
        gridSpacing === prevGridSpacing &&
        gridColor === prevGridColor &&
        gridOpacity === prevGridOpacity
      ) {
        return;
      }
      prevDomain = s.domain;
      prevTime = s.currentTime;
      prevActive = s.activeFeature;
      prevRedrawMode = s.mode;
      prevDisplay = s.displayControl;
      prevAreaThreshold = areaThreshold;
      prevGridSpacing = gridSpacing;
      prevGridColor = gridColor;
      prevGridOpacity = gridOpacity;
      requestRedraw();
    });
    return () => {
      unsubscribe();
      unsubscribeMode();
      redrawScheduler.dispose();
      hookTarget.removeEventListener('pointerdown', onPointerDown);
      hookTarget.removeEventListener('pointermove', onPointerMove);
      hookTarget.removeEventListener('pointerup', onPointerUp);
      hookTarget.removeEventListener('pointercancel', onPointerCancel);
      hookTarget.removeEventListener('pointerleave', onPointerLeave);
      hookTarget.removeEventListener('contextmenu', onContextMenu);
      hookTarget.removeEventListener('wheel', onWheel);
      ports.dispose();
      rendererRef.current = null;
      cameraInputRef.current = null;
      // HB3-9: drop the render-observation hook so a remount re-installs a fresh one
      // bound to the new renderer (no stale closure over the disposed host).
      if (e2eWindow !== null && '__E2E__' in e2eWindow) {
        delete (e2eWindow as { __E2E__?: unknown }).__E2E__;
      }
    };
  }, [store]);

  // Bridge the {@link MapContextMenu} mount's open-setter to the imperative live
  // context-menu port (assigned to the opener ref the port reads). Stable so the
  // mount's effect binds once; null on unmount (教訓 5.2 全経路で破棄).
  const bindContextMenuOpener = useCallback(
    (opener: ContextMenuOpener | null): void => {
      contextMenuOpenerRef.current = opener;
    },
    [],
  );

  // Supply the camera clamp range to U17 (FR-10 / FR-109 即時反映). Caches the
  // value and forwards it to the live renderer when one is mounted.
  const supplyZoomRange: SupplyZoomRange = useCallback((range) => {
    zoomRangeRef.current = range;
    rendererRef.current?.setZoomRange(range);
  }, []);

  // Stable port closures the controller depends on; each reads the current
  // renderer through the ref (単一の真実源 — the renderer owns the transform).
  const screenToWorld: ScreenToWorld = useCallback(
    (clientX, clientY) =>
      rendererRef.current?.screenToWorld(clientX, clientY) ?? { lon: clientX, lat: clientY },
    [],
  );
  const drawSink: AddDrawSink = useMemo(
    () => ({
      drawAdd(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawAdd(primitives);
      },
    }),
    [],
  );
  const knifeDrawSink: KnifeDrawSink = useMemo(
    () => ({
      drawKnife(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );
  // HB3-15(c): the merge / reparent target-highlight sinks. They share the renderer's
  // SINGLE tool-overlay slot (drawKnife) — knife / merge / reparent are mutually exclusive
  // tools, so only one ever feeds it at a time, and an idle/empty selection pushes `[]` so
  // the highlight clears on every reset path (教訓 5.2 / 5.18). Each reads the live renderer
  // through the ref, degrading to a no-op before the map mounts (the same late-binding
  // pattern drawSink / knifeDrawSink use).
  const mergeDrawSink: MergeDrawSink = useMemo(
    () => ({
      drawHighlight(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );
  const reparentDrawSink: ReparentDrawSink = useMemo(
    () => ({
      drawHighlight(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );

  // The stable camera-input port handed to BOTH tool controllers (bughunt: 追加/ナイフ
  // 描画中のパン/ズーム). Each method reads the live dispatcher-backed port through the
  // ref (set in onMapMount), degrading to a no-op before the map mounts — the SAME
  // late-binding pattern `screenToWorld` / `drawSink` use, so the controllers depend
  // on a stable contract that never re-mounts the map (技術方針 2.3).
  const mapCameraInput: MapCameraInput = useMemo(
    () => ({
      wheel: (clientX, clientY, deltaY, deltaMode) =>
        cameraInputRef.current?.wheel(clientX, clientY, deltaY, deltaMode),
      pointerDown: (e, clientX, clientY) =>
        cameraInputRef.current?.pointerDown(e, clientX, clientY),
      pointerMove: (e, clientX, clientY) =>
        cameraInputRef.current?.pointerMove(e, clientX, clientY),
      pointerUp: (e, clientX, clientY) =>
        cameraInputRef.current?.pointerUp(e, clientX, clientY),
      pointerCancel: (pointerId) => cameraInputRef.current?.pointerCancel(pointerId),
    }),
    [],
  );

  // NOTE (bughunt: Knife の固定円半径/閉線判定が初期 zoom のまま stale → bughunt2: その購読
  // を App から降ろす) — the U26 knife controller's 固定円 world-radius
  // (circleRadiusPx / zoom) and 閉線スナップ判定 must track the LIVE camera zoom, which
  // publishCameraHooks mirrors into store.camera on EVERY render-camera change (fit at
  // mount, then live on each wheel notch; see updateCamera below). That subscription
  // now lives INSIDE KnifeToolController (its only consumer), NOT here: lifting the
  // zoom scalar to App put it on the React render path, so every wheel notch re-rendered
  // the whole overlay subtree (AddTool / Knife / FileOps / HelpTools / conflict modal)
  // — a partial regression of 技術方針 2.3. Subscribing in the controller keeps the
  // 固定円 reactive while a wheel notch re-renders 只 that controller, not its siblings.

  // The add host ports (id minting / ring ids / the U13 process-start adapter).
  //
  // DEPENDENCY SEAM — U13 NOT YET LIVE-BOUND (spec §依存 U13; DECISIONS D16-D19):
  // `startProcess` below is a deterministic-rejection STUB, not the real U13
  // orchestrator. As a result the live synthesis CANNOT yet reach the committed
  // outcome: 受け入れ基準1(現在時刻錨として確定), 基準2(確定済み分岐), and 基準9
  // (完了後の選択再解決) hold ONLY against an injected U13 in the U23 unit tests
  // (AddToolController.test.tsx / useAddTool.test.tsx) — in the shipped composite
  // a SAVE always ends in the Japanese rejection message. The COMPLETE and SAVE
  // triggers are fully配線 (教訓 5.7) and observable; only the CONFIRM path is open.
  //
  // BINDING COST — NOT a「1行差し替え」(integration-lens correction): connecting the
  // live U13 is NOT swapping this one closure. It requires building a full
  // `ConsistencyPorts<DomainRoot, AddSnapshot>` adapter (U09 time / U10 spatial /
  // U06 difference / U12 single-undo) bound over the live domain root, PLUS an
  // `applyProposal` that materialises an AddSnapshot into a `DomainProject` history
  // anchor. The factory shape + per-port duties are pinned in
  // `./consistency-binding.ts` (LiveConsistencyBinding / CreateLiveAddBinding); the
  // controller consumes `StartAddProcess<S>` as a contract (教訓 5.33 契約越し), so
  // ONCE that binding exists App.tsx replaces the stub with
  // `createLiveAddBinding({ getRoot }).startProcess` — no change to the controller.
  //
  // OWNERSHIP — UNASSIGNED, NOT U42 (開発ガイド §1.8): `applyProposal` is a NEW
  // domain operation (snapshot → anchor → history insert) that no shipped unit
  // exposes. It is new domain work, so it cannot belong to U42 (U42「やらないこと」=
  // 新規ドメイン機能の実装 — U42 is verification-only). Recorded as an unassigned
  // open item requiring a planned unit in docs/現状.md.
  // The SINGLE shared id minter (finding 3): one generator + a project-wide
  // reservation set, owned here and handed to BOTH the add and knife bootstraps so
  // their ids share one series and never collide with each other or loaded data.
  const sharedMint = useMemo(
    () => createSharedIdMint(() => store.getState().domain),
    [store],
  );

  const hostBootstrap = useMemo(
    () => createAddBootstrap<DomainRoot>(() => store.getState().domain, sharedMint),
    [store, sharedMint],
  );

  // U12 — the LIVE undo/redo history (FR-73 / FR-74 / FR-94). The composition root
  // OWNS the History<DomainRoot>; every committed edit (add / knife / conflict-
  // resolution) is recorded as ONE undo unit through {@link recordCommit}, and
  // EditUndo / EditRedo apply its output back through the single store-write path
  // (教訓 5.11). The history is reset on a whole-state swap (load / new) because the
  // command stack of the OLD project is meaningless against the NEW one
  // (consistency-binding's whole-state-swap commands ignore the live input state,
  // so a stale stack would replay foreign states — 教訓 5.20 / 5.22).
  const historyRef = useRef<History<DomainRoot>>(createHistory(store.getState().domain));

  // The last domain WE committed (or reset to). The store subscription uses it to
  // tell an external whole-state swap (file load / new) from our own edit commit:
  // when store.domain changes to something we did not just write, reset the history
  // to that new baseline (its old stack cannot apply to the new project).
  const lastCommittedDomainRef = useRef<DomainRoot>(store.getState().domain);

  // Re-evaluate the EditUndo / EditRedo enabled gates after any history change so
  // the menu / shortcut reflect availability immediately (FR-74). The registry's
  // canRun closures read the history ref live; this只 nudges any listeners via a
  // version counter so the shell re-renders the menu gate.
  const [, setHistoryVersion] = useState(0);
  const refreshUndoRedoEnabled = useCallback(() => {
    setHistoryVersion((v) => v + 1);
  }, []);

  // Record a committed U13 result as ONE history entry AND reflect it into the
  // store with selection re-resolution (教訓 5.11). `historyExecute` runs the
  // command's whole-state-swap (it ignores history.state and returns the captured
  // committed state + CommandResult), so the derived result is exact regardless of
  // the stack. The committed domain becomes the new history root; we tag it so the
  // load/new subscription below does NOT mistake our own commit for an external swap.
  const recordCommand = useCallback(
    (
      command: Command<DomainRoot>,
      preference?: { readonly featureId: FeatureId },
    ): void => {
      const step = historyExecute(historyRef.current, command);
      historyRef.current = step.history;
      lastCommittedDomainRef.current = step.history.state;
      store.getState().applyCommandResult(step.history.state, step.result, preference);
      refreshUndoRedoEnabled();
    },
    [store, refreshUndoRedoEnabled],
  );

  const recordCommit = useCallback(
    (
      result: ProcessResult<DomainRoot>,
      preference?: { readonly featureId: FeatureId },
    ): void => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      recordCommand(result.command, preference);
    },
    [recordCommand],
  );

  // Keep the edit-session's commit-handler ref pointed at the current recordCommit.
  recordCommitRef.current = recordCommit;

  // Register the U12 undo / redo commands on the SAME registry the menu + shortcuts
  // dispatch (single truth source, 教訓 5.13). Each applies the history step back
  // through the store and bumps the gate. `canRun` gates on stack availability so
  // an empty stack disables the menu item AND the shortcut together (FR-74).
  useEffect(() => {
    const runUndo = (): void => {
      const step = historyUndo(historyRef.current);
      if (step.history === historyRef.current) return; // empty stack: no-op
      historyRef.current = step.history;
      lastCommittedDomainRef.current = step.history.state;
      store.getState().applyCommandResult(step.history.state, step.result);
      refreshUndoRedoEnabled();
    };
    const runRedo = (): void => {
      const step = historyRedo(historyRef.current);
      if (step.history === historyRef.current) return;
      historyRef.current = step.history;
      lastCommittedDomainRef.current = step.history.state;
      store.getState().applyCommandResult(step.history.state, step.result);
      refreshUndoRedoEnabled();
    };
    registry.register(COMMAND_ID.EditUndo, {
      run: runUndo,
      canRun: () => historyCanUndo(historyRef.current),
    });
    registry.register(COMMAND_ID.EditRedo, {
      run: runRedo,
      canRun: () => historyCanRedo(historyRef.current),
    });
    return () => {
      registry.unregister(COMMAND_ID.EditUndo);
      registry.unregister(COMMAND_ID.EditRedo);
    };
  }, [registry, store, refreshUndoRedoEnabled]);

  // HB-4 ROOT FIX — register the 表示専用モード切替 (ViewToggleViewMode) command on the
  // SAME registry the 表示 menu + shortcuts dispatch (教訓 5.13 単一の権限/真実源).
  // The id was declared and placed in the 表示 menu (menu.ts) but NO unit ever
  // registered a handler, so the menu導線 was permanently 未登録==無効 (the named
  // 導線 in HB-4) — only the toolbar's 表示専用 button worked, via a direct
  // setViewOnly. Registering it here makes the MENU command live too, and BOTH
  // surfaces flip the SAME store mode value (one truth source — they can never
  // drift). View → Edit (a sensible editable default); any editing mode → View.
  // This is always runnable (a view-axis command, not an editing command), so it
  // stays enabled even in display-only mode (permissions.ts: not in EDITING_COMMANDS).
  useEffect(() => {
    registry.register(COMMAND_ID.ViewToggleViewMode, {
      run: () => {
        const s = store.getState();
        // Leaving View lands in Edit; in any editing mode return to View. This is
        // the SAME transition the toolbar's mode-view button drives (useShell
        // setViewOnly), so the two导线 are one behaviour (教訓 5.30 同判定同実装).
        s.setMode(s.mode === EDIT_MODE.View ? EDIT_MODE.Edit : EDIT_MODE.View);
      },
    });
    return () => {
      registry.unregister(COMMAND_ID.ViewToggleViewMode);
    };
  }, [registry, store]);

  // BUGHUNT2 ROOT FIX — register the 編集→削除 (EditDelete) command on the SAME
  // registry the 編集 menu + the Delete accelerator dispatch (教訓 5.13 単一の権限/
  // 真実源). This is the SAME defect class as the HB-4 ViewToggleViewMode fix above:
  // COMMAND_ID.EditDelete was declared (commands.ts), placed in the 編集 menu with
  // the Delete accelerator (menu.ts), gated as an EDITING_COMMAND (permissions.ts),
  // labelled「削除」/「選択中の地物を削除します」(strings.ts) and listed in the
  // ショートカット一覧 — but NO unit ever registered a handler, so registry.isRunnable
  // returned false: the menu item was permanently disabled AND the Delete key was a
  // silent no-op (registry.dispatch returns false). 削除ロジック (U31) existed but was
  // never reachable from any live UI 導線 (教訓 5.7).
  //
  // The handler deletes the ACTIVE feature (FR-79 / FR-85「選択中の地物を削除します」)
  // through U31's indivisible 全錨 delete (sweep 全時間軸 + 双方向参照掃除 + 空集約の
  // 連鎖剪定, FR-41 / FR-35) — the SAME pure {@link createDeleteFeatureCommand} the
  // (future) プロパティ削除ボタン also routes through (single truth source, 教訓 5.30),
  // wrapped by `createDeleteFeatureCommandForRoot` into the SAME whole-state-swap
  // command shape add / knife / edit commits use, then recorded as ONE undo unit via
  // `recordCommand` (教訓 5.11 / 5.24): an absent target builds no command (no幽霊
  // entry), and the deleted feature drops out of selection while undo restores it.
  // `canRun` gates on an active feature so the menu item / Delete key disable together
  // when nothing is selected; permissions.ts already 표示専用モードでは一括無効化.
  useEffect(() => {
    const deleteActiveFeature = (): void => {
      const s = store.getState();
      const active = s.selection.activeFeature;
      if (active === null) return;
      const command = createDeleteFeatureCommandForRoot(s.domain, active);
      if (command === null) return; // target absent everywhere: no幽霊 entry (教訓 5.24)
      recordCommand(command);
    };
    registry.register(COMMAND_ID.EditDelete, {
      run: deleteActiveFeature,
      canRun: () => store.getState().selection.activeFeature !== null,
    });
    return () => {
      registry.unregister(COMMAND_ID.EditDelete);
    };
  }, [registry, store, recordCommand]);

  // Reset the history on an EXTERNAL whole-state swap (file load / new). A subscribe
  // bridge (技術方針 2.5: React 外のストアを subscribe で監視) compares the live domain
  // to the last domain we committed; a mismatch we did not author is a load/new, so
  // we re-root the history there (its old stack is meaningless — 教訓 5.22).
  useEffect(() => {
    return store.subscribe((s) => {
      if (s.domain === lastCommittedDomainRef.current) return;
      lastCommittedDomainRef.current = s.domain;
      historyRef.current = createHistory(s.domain);
      refreshUndoRedoEnabled();
      // 教訓 5.2 全経路で破棄: a whole-state swap (load / new / drag-drop) invalidates
      // any paused-conflict modal — its pending result + applyResolutions are bound
      // to the OLD proposal AND the OLD root, so a 確定/取消 against the new project
      // would replay a foreign baseline (mismatched feature/vertex ids) into
      // recordCommit/reArmActiveTool. Atomically dismiss the modal on the same swap
      // that re-roots the history so no stale binding can survive the load.
      setConflictState(null);
    });
  }, [store, refreshUndoRedoEnabled]);

  // U26 INTEGRATION (教訓 5.7 / 5.2): the knife-tool controller is mounted in the
  // SAME shell overlay, bound to the SAME store, so selecting 編集モード→ナイフ starts
  // a session, map-input clicks drive対象面選択 / 分断線入力 / 閉線確定, the继承先 modal +
  // U23 form re-use drive継承先選択 / 非継承側プロパティ入力, and 確定 hands a split
  // EditProposal to the U13 seam. Like the add seam, U13 is a deterministic stub;
  // the live binding (`CreateLiveKnifeBinding` in ./consistency-binding.ts) is the
  // SAME non-trivial `ConsistencyPorts<DomainRoot, SplitSnapshot>` adapter cost, and
  // its `applyProposal` is the SAME unassigned new-domain blocker (NOT U42; 開発ガイド
  // §1.8, docs/現状.md). The domain-lookup ports (resolveFeature / resolveStore /
  // featureAtPoint) are honest stubs over the empty scaffold root until a load +
  // selection unit supplies the live domain — the WIRING is real and observable; the
  // geometry path activates when those ports do.
  const knifeBootstrap = useMemo(
    () =>
      createKnifeBootstrap(
        () => store.getState().domain,
        () => store.getState().currentTime,
        sharedMint,
        // 対象面探索を描画解決と同じ単一真実源にする (bughunt): the display-control comes
        // from the SAME store slice committed-features feeds buildDisplayAreas with, and
        // the wrap frame from the SAME live render camera/viewport the frame drew at, so
        // ナイフの対象面選択 agrees with both the renderer and the main hit-test.
        () => store.getState().displayControl,
        () => rendererRef.current?.readCamera(),
      ),
    [store, sharedMint],
  );

  // U30 INTEGRATION (教訓 5.7 / 5.2): the merge-tool bootstrap mirrors the knife one —
  // shared id minting + live-lookup ports + the LIVE U13 binding (createLiveMergeBinding).
  // Selecting 編集モード→結合 starts a session, map-input clicks toggle target faces, and
  // 結合を確定 builds a MergeProposal (buildMergeProposal) and hands a merge EditProposal
  // to U13. This is the missing消費する ui コンシューマ for src/domain/merge (bughunt3:
  // 結合 was a dead button — domain logic existed but no UI drove it).
  const mergeBootstrap = useMemo(
    () =>
      createMergeBootstrap(
        () => store.getState().domain,
        () => store.getState().currentTime,
        sharedMint,
      ),
    [store, sharedMint],
  );

  // U28 INTEGRATION (教訓 5.7 / 5.2): the reparent-tool bootstrap mirrors the merge one —
  // live-lookup features + the LIVE U13 binding (createLiveAffiliationBinding). Selecting
  // 編集モード→所属変更 starts a session, the first map click picks the target, the second
  // picks the new上位領域, and 所属変更を確定 builds an AffiliationProposal
  // (buildAffiliationProposal) and hands an affiliation EditProposal to U13. This is the
  // missing消費する ui コンシューマ for src/domain/affiliation (bughunt3: 所属変更 was a
  // dead button — domain logic existed but no UI drove it).
  const reparentBootstrap = useMemo(
    () =>
      createReparentBootstrap(
        () => store.getState().domain,
        () => store.getState().currentTime,
      ),
    [store],
  );

  // ADD COMMIT (教訓 5.11 / U12): record the committed add as one history unit and
  // promote the new feature so selection re-resolves to it.
  const onAddCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, newFeatureId: FeatureId) => {
      recordCommit(result, { featureId: newFeatureId });
    },
    [recordCommit],
  );

  // KNIFE COMMIT (C3 — 教訓 5.11 / U12): record as one history unit and promote the
  // inheritor (SplitSnapshot.touchedFeatureIds[0]) so selection re-resolves to it
  // rather than blanket-clearing (FR-94 / split-after selection retention).
  const onKnifeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: SplitSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const inheritorId = snapshot.touchedFeatureIds[0] ?? snapshot.inheritorFeatureId;
      recordCommit(result, { featureId: inheritorId });
      // HB3-17: the split is done — the knife is no longer in knife state, so
      // deactivate the tool (the toolbar button must not stay pressed/"active";
      // ツール状態とUI表示のデシンク). Preserve the just-promoted inheritor selection
      // (教訓 5.11): recordCommit re-resolved selection onto the inheritor, so read it
      // back and pin it across the tool clear — only activeTool changes, not selection.
      const s = store.getState();
      s.setActiveTool(null, s.selection);
    },
    [recordCommit, store],
  );

  // MERGE COMMIT (教訓 5.11 / U12): record as one history unit and promote the result
  // feature (MergeSnapshot.resultFeatureId) so selection re-resolves to the merged
  // 地物 rather than blanket-clearing (FR-94 / merge-after selection retention).
  const onMergeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: MergeSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      recordCommit(result, { featureId: snapshot.resultFeatureId });
    },
    [recordCommit],
  );

  // REPARENT COMMIT (教訓 5.11 / U12): record as one history unit and keep selection on
  // the reparented target (AffiliationSnapshot.targetIds[0]) so the property panel /
  // sidebar re-resolve to it rather than blanket-clearing (FR-94 / reparent-after
  // selection retention; the finding's reparent-lost-selection guard).
  const onReparentCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: AffiliationSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const targetId = snapshot.targetIds[0];
      recordCommit(result, targetId !== undefined ? { featureId: targetId } : undefined);
    },
    [recordCommit],
  );

  // U35 — the conflict-resolution modal seam. When add / knife confirmation pauses
  // (ConflictsPending) the controller's onConflicts hands us the pending result +
  // the proposal-bound applyResolutions adapter + a shapes lookup; we hold them in
  // state and mount {@link ConflictResolutionModal}. On commit we record ONE undo
  // unit and re-arm the paused tool; on cancel we discard the tool draft (教訓 5.2).
  const [conflictState, setConflictState] = useState<ConflictPending | null>(null);

  // Re-arm the active tool after a paused-conflict modal closes, discarding any
  // transient tool draft (教訓 5.2 全経路で破棄) WHILE retaining the committed
  // selection. Toggling the tool null→prev funnels both controllers through
  // resetForSwitch (discard) then start (fresh session) ACROSS a microtask
  // boundary so React's keyed effects observe both transitions. BUT the store's
  // setActiveTool reset契約 clears selection by default, which would wipe the
  // feature a conflict commit JUST promoted (教訓 5.11 — selection must survive a
  // structure-change commit).
  //
  // ROOT FIX (bughunt round-2): pin the captured selection to BOTH toggle steps
  // via setActiveTool's preserveSelection arg. Earlier code cleared at the null
  // step and only restored AFTER the microtask re-arm, so the store transiently
  // held activeFeature=null between the two transitions — a synchronous broadcast
  // that re-rendered the property panel / sidebar empty and requested an extra
  // empty-selection canvas redraw before self-correcting one microtask later. By
  // preserving the selection in the SAME transition that changes activeTool, only
  // the TOOL DRAFT is discarded; no subscriber ever observes an empty frame.
  const reArmActiveTool = useCallback(() => {
    const s = store.getState();
    const tool = s.activeTool;
    const retained = s.selection;
    s.setActiveTool(null, retained);
    queueMicrotask(() => {
      store.getState().setActiveTool(tool, retained);
    });
  }, [store]);

  // Build the per-conflict shapes lookup for the preview: the two participants'
  // resolved leaf shapes at the conflict time, from the LIVE root (the same
  // live-lookup the detection used — single truth source, 教訓 5.29).
  const shapesFor = useCallback(
    (conflict: Conflict): ConflictShapes => ({
      aFeatureId: conflict.a.featureId,
      aShape: shapeForConflictParticipant(store.getState().domain, conflict, conflict.a.featureId),
      bFeatureId: conflict.b.featureId,
      bShape: shapeForConflictParticipant(store.getState().domain, conflict, conflict.b.featureId),
    }),
    [store],
  );

  const onAddConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<AddSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      setConflictState({
        pending: result,
        applyResolutions: hostBootstrap.applyResolutionsFor(proposal),
        // 教訓 5.11: promote the added feature once the conflict commit lands.
        preference: { featureId: proposal.featureId },
      });
    },
    [hostBootstrap],
  );

  const onKnifeConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<SplitSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      // Promote the inheritor (SplitSnapshot.touchedFeatureIds[0]) on commit, the
      // SAME preference a direct knife commit uses (教訓 5.11 / split selection).
      const snapshot = proposal.snapshot;
      const inheritorId = snapshot.touchedFeatureIds[0] ?? snapshot.inheritorFeatureId;
      setConflictState({
        pending: result,
        applyResolutions: knifeBootstrap.applyResolutionsFor(proposal),
        preference: { featureId: inheritorId },
      });
    },
    [knifeBootstrap],
  );

  const onMergeConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<MergeSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      // Promote the result feature on commit, the SAME preference a direct merge
      // commit uses (教訓 5.11 / merge selection retention).
      setConflictState({
        pending: result,
        applyResolutions: mergeBootstrap.applyResolutionsFor(proposal),
        preference: { featureId: proposal.snapshot.resultFeatureId },
      });
    },
    [mergeBootstrap],
  );

  const onReparentConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<AffiliationSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      // Promote the reparented target on commit, the SAME preference a direct reparent
      // commit uses (教訓 5.11 / reparent selection retention).
      const targetId = proposal.snapshot.targetIds[0];
      setConflictState({
        pending: result,
        applyResolutions: reparentBootstrap.applyResolutionsFor(proposal),
        ...(targetId !== undefined ? { preference: { featureId: targetId } } : {}),
      });
    },
    [reparentBootstrap],
  );

  const onConflictCommitted = useCallback(
    (result: ProcessResult<DomainRoot>) => {
      // Forward the paused edit's selection preference so the modal commit promotes
      // the same feature a direct commit would (教訓 5.11; was being dropped).
      recordCommit(result, conflictState?.preference);
      setConflictState(null);
      reArmActiveTool();
    },
    [recordCommit, reArmActiveTool, conflictState],
  );

  const onConflictCancel = useCallback(() => {
    setConflictState(null);
    reArmActiveTool();
  }, [reArmActiveTool]);

  // Live target-shape for the knife emphasis (FR-92): the resolved shape of the
  // currently-selected leaf at the current time, recomputed on selection / time /
  // domain change via a store subscription mirrored into React state.
  const knifeTargetShape = useKnifeTargetShape(store);

  // HB3-11 — feature detail panels (FR-99後段). The U32 DetailPanels + open-panel
  // model existed and were unit-tested, but the property panel's「詳細」button's
  // onOpenDetail was never wired into the composition root, so detail display did
  // nothing (教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」). Hold the open-panels
  // state, open one on the button, mount the panels in the overlay; the document body
  // is an honest empty stub for now (HB3-11 decision; 文書本体保存は別タスク).
  const [detailPanels, setDetailPanels] = useState<DetailPanelsState>(EMPTY_DETAIL_PANELS);
  const onOpenDetail = useCallback(
    (featureId: FeatureId) =>
      setDetailPanels((s) => openPanel(s, featureId, DETAIL_PANEL_BASE_POS)),
    [],
  );
  // HB3-11 review fix: prune detail panels whose feature no longer exists in the LIVE
  // domain — deleted, or swapped away by a file LOAD / NEW project — so a stale panel
  // never lingers as an invisible, un-closable ghost (a missing feature renders null in
  // DetailPanels, so without this the entry could not be closed). Keyed on DOMAIN identity
  // (camera / time set()s are skipped) and returns the SAME state ref when nothing is
  // pruned, so it adds no re-render churn. A time-hidden feature still EXISTS in the domain
  // (a history carries it), so it is kept — only genuinely-removed features are pruned.
  useEffect(() => {
    let prevDomain = store.getState().domain;
    return store.subscribe(() => {
      const domain = store.getState().domain;
      if (domain === prevDomain) return;
      prevDomain = domain;
      setDetailPanels((s) => {
        if (s.panels.length === 0) return s;
        const live = s.panels.filter((p) =>
          domain.histories.some((h) => h.featureId === p.featureId),
        );
        return live.length === s.panels.length ? s : { panels: live };
      });
    });
  }, [store]);
  // LIVE feature lookup for the detail panels (resolves at the current time, fresh
  // per call — never a stale capture, 教訓 5.6 / 単一真実源 5.29).
  const detailFeatureLookup = useMemo<PropertyFeatureLookup>(
    () => ({
      featureAt: (featureId) =>
        featuresAt(store.getState().domain, store.getState().currentTime).find(
          (f) => f.id === featureId,
        ) ?? null,
    }),
    [store],
  );

  // HB3-14 — attribute editing. The U32 property form's SAVE assembled a
  // PropertyEditIntent and handed it to editDispatch, but the composition root passed
  // NO editDispatch to buildSidebarContent, so save fell to the honest throwing stub
  // (editNotWired) — attribute editing did nothing (教訓 5.7). Wire a real dispatch: it
  // builds the after-state feature (new attributes + color, SAME geometry), wraps it as a
  // U24 {@link FeatureSnapshot} EditProposal at the edit-target anchor time, runs the SAME
  // fixed-order U13 pipeline add/knife/move use (createLiveEditBinding → applyEditProposal),
  // and records ONE U12 undo unit. A Rejected result throws so the form surfaces 保存に失敗
  // rather than a silent no-op (HB-3 honest-failure discipline).
  const propertyEditBinding = useMemo(
    () => createLiveEditBinding({ getRoot: () => store.getState().domain }),
    [store],
  );
  const propertyEditDispatch = useMemo<EditDispatch>(
    () => ({
      dispatchEdit: (intent) => {
        const feature = featuresAt(store.getState().domain, intent.editTime).find(
          (f) => f.id === intent.featureId,
        );
        if (feature === undefined) {
          throw new Error('編集対象が現在の時刻に存在しません。');
        }
        const v = intent.attributes;
        const nextFeature = withColor(
          withAttributes(feature, createBasicAttributes(v.name, v.startYear, v.endYear)),
          createColorInfo(
            v.autoColorEnabled,
            v.fillColor,
            v.selectedColor,
            v.borderColor,
            v.paletteTheme,
            v.fillOpacity,
            v.selectedOpacity,
          ),
        );
        // Attribute / style edit: geometry is unchanged, so no vertex body moves.
        const snapshot: FeatureSnapshot = { feature: nextFeature, vertices: [] };
        const proposal = createEditProposal(intent.featureId, intent.editTime, snapshot);
        const result = propertyEditBinding.startProcess(proposal);
        if (result.status === PROCESS_STATUS.Committed) {
          recordCommit(result, { featureId: intent.featureId });
          return;
        }
        if (result.status === PROCESS_STATUS.Rejected) {
          throw new Error(result.message);
        }
        // detectSpatial=[] for the edit binding, so a pure attribute edit never reaches
        // ConflictsPending; surface honestly if it somehow does (never a silent success).
        throw new Error('属性の編集を適用できませんでした。');
      },
    }),
    [store, propertyEditBinding, recordCommit],
  );

  // FR-85 — the プロパティタブ「地物を削除」button. The {@link DeleteFeatureButton}
  // component + the U31 delete command both existed and were unit-tested, but the button
  // was NEVER mounted in the live property panel — only the 編集メニュー / Delete キー
  // reached COMMAND_ID.EditDelete (see the EditDelete handler above, which itself notes
  // "(future) プロパティ削除ボタン"). Same wiring-gap class as HB3-11/HB3-14 (教訓 5.7
  // ロジックはあるが UI から呼ばれない). Wire the button through the SAME pure
  // createDeleteFeatureCommandForRoot path the menu/Delete-key use (single delete truth
  // source, 教訓 5.30): it deletes the shown feature across 全錨 as ONE undo unit, and an
  // absent target builds no command (no幽霊 entry, 教訓 5.24). Undo restores it.
  const propertyDeleteFeature = useCallback(
    (featureId: FeatureId): void => {
      const command = createDeleteFeatureCommandForRoot(store.getState().domain, featureId);
      if (command === null) return;
      recordCommand(command);
    },
    [store, recordCommand],
  );

  // HB-3 ROOT FIX — mount the three sidebar sections (プロパティ / 地物一覧 / イベント
  // 一覧) INTO the shell's sidebar slot (教訓 5.7 合成ルートの結線漏れ). The slots were
  // never passed to AppShell, so the sidebar rendered empty and the U32
  // PropertyPanel was never mounted. The content binds to the LIVE store + domain
  // root at the current time (single truth source, 教訓 5.29); selecting a 地物一覧
  // row promotes it through the SAME store.setActiveFeature path the map uses, so
  // the property panel re-resolves to it automatically. The slot closures read the
  // domain / time fresh per call (never a stale capture, 教訓 5.6).
  const sidebar = useMemo(
    () =>
      buildSidebarContent<DomainRoot>({
        store,
        getRoot: () => store.getState().domain,
        getTime: () => store.getState().currentTime,
        calendar,
        onOpenDetail,
        editDispatch: propertyEditDispatch,
        onDeleteFeature: propertyDeleteFeature,
      }),
    [store, calendar, onOpenDetail, propertyEditDispatch, propertyDeleteFeature],
  );

  return (
    <div
      id="app-shell"
      onDragOver={dropHandlers?.onDragOver}
      onDrop={dropHandlers?.onDrop}
    >
      <AppShell
        store={store}
        registry={registry}
        sidebar={sidebar}
        onMapMount={onMapMount}
        timeline={<Timeline store={store} />}
        mapOverlay={
          /* FR-12 INTEGRATION (教訓 5.7 合成ルートの結線漏れ / 教訓 5.16 倍率の二重適用
             防止): mount the U18 経度シフト control ANCHORED TO THE MAP AREA (not the
             whole-shell overlay, which would overlap the timeline / status bar and
             steal their clicks) and wire it to the SAME renderer camera the U40
             pan/wheel path writes (rendererRef → writeCamera), so a shift / preset
             actually moves the map center. The widget existed + was unit-tested but
             was never mounted — the FR-12 feature was user-unreachable (bughunt2).
             The widget reports a RAW shift操作量; the zoom is applied ONCE here via
             applyLongitudeShift against the LIVE camera zoom (the domain multiplies,
             never the widget, 教訓 5.16). writeCamera fires onCameraChange →
             publishCameraHooks → updateCamera, which mirrors centerLon into the store
             truth in ONE set() (単一真実源, 教訓 5.29), so the readout — bound to
             store.centerLon — reflects the new center. A preset jumps the continuous
             center to the named longitude (本初子午線中心 0° / 太平洋中心 180°). */
          <LongitudeShiftPanel store={store} rendererRef={rendererRef} />
        }
        overlay={
          <>
            {/* Observability marker (回帰観点 E2E): mirrors the live selection truth
                (store.selection.activeFeature) so a regression test can assert the
                inheritor stays selected after a split (教訓 5.11). Hidden; it holds
                NO truth — it只 reflects the store (技術方針 2.5). */}
            <ActiveFeatureMarker store={store} />
            {/* HB3-11: the feature detail panels (FR-99後段) — draggable/closable, one
                per feature, showing all attributes (dl) + an empty document-body stub.
                Selecting from a panel promotes through the SAME store.setActiveFeature
                path every selection uses (no second selection source, 教訓 5.29). */}
            <DetailPanels
              state={detailPanels}
              featureLookup={detailFeatureLookup}
              assetResolver={NO_ASSET_RESOLVER}
              detailDocumentOf={() => ''}
              onClose={(id) => setDetailPanels((s) => closeDetailPanel(s, id))}
              onSelectFeature={(fid) => store.getState().setActiveFeature(fid)}
            />
            {/* HB-10 観測フック (Ctrl+Y redo の挙動 E2E): mirror the live undo/redo
                stack availability into hidden markers (既存 app-active-feature 方式).
                A behavioural test commits→undo→Ctrl+Y redo and asserts these flip,
                proving Ctrl+Y truly runs redo. The App re-renders on every history
                change (setHistoryVersion), so these read historyRef live; they hold
                NO truth — pure mirrors (技術方針 2.5). */}
            <span data-testid="app-can-undo" hidden>
              {historyCanUndo(historyRef.current) ? '1' : '0'}
            </span>
            <span data-testid="app-can-redo" hidden>
              {historyCanRedo(historyRef.current) ? '1' : '0'}
            </span>
            {/* HB-4 観測フック (回帰観点 E2E): mirror the live session mode + active
                tool truth (store.mode / store.activeTool) into hidden data-testid
                markers so a behavioural test can assert the 表示専用→編集 transition
                actually flips the mode and activates the edit tools (既存
                app-active-feature マーカーと同方式). They hold NO truth — pure mirrors
                of the store (技術方針 2.5). */}
            <SessionModeMarker store={store} />
            {/* BUGHUNT2 ROOT FIX — the FR-96 right-click context menu mount. Bridges
                the live context-menu port (createLiveContextMenuPort in onMapMount) to
                the U20 ContextMenu component, bound to the LIVE registry + session
                mode so each item's enabled state comes from the SAME resolveCommandEnabled
                the menu bar / shortcuts use (教訓 5.13). Was unreachable: the port was
                NOOP_CONTEXT_MENU_PORT, so right-click opened nothing. */}
            <MapContextMenu<DomainRoot>
              store={store}
              registry={registry}
              bindOpener={bindContextMenuOpener}
            />
            {/* U39 INTEGRATION (受け入れ基準 1-6): the file-ops controller registers
                the ファイル menu / shortcut commands on the SAME registry the shell
                dispatches, drives the FR-107 unsaved warning + FR-106 repair modals,
                reflects loaded / repaired projects into the store, supplies the
                FR-10 zoom clamp range to U17, and intercepts window-close with the
                quit guard. All file I/O routes through U15's typed IPC
                (window.timeMapApi); the renderer never touches fs (FR-02). */}
            <FileOpsController
              store={store}
              registry={registry}
              calendar={calendar}
              supplyZoomRange={supplyZoomRange}
              registerWindowClose={registerWindowClose}
              registerDropTarget={registerDropTarget}
            />
            {/* HB-8 / HB-9 INTEGRATION (教訓 5.7 / 5.13): register the ツール
                (設定 / 検索) と ヘルプ (バージョン情報 / ショートカット一覧 / 診断情報)
                command handlers on the SAME registry the menu + shortcuts dispatch,
                and render the views they open. Before this the five ids were
                未登録==無効 — the menu items rendered permanently grayed (HB-4 class
                of dead command). The handlers are torn down on unmount (useEffect
                cleanup unregister). 設定 reuses the U38 dialog bound to the live
                store; the rest are minimal views over existing pure logic. */}
            <HelpToolsController store={store} registry={registry} />
            <AddToolControllerWithParents
              store={store}
              startProcess={hostBootstrap.startProcess}
              ids={hostBootstrap.ids}
              nextRingId={hostBootstrap.nextRingId}
              screenToWorld={screenToWorld}
              drawSink={drawSink}
              mapCameraInput={mapCameraInput}
              onCommitted={onAddCommitted}
              onConflicts={onAddConflicts}
            />
            <KnifeToolController<DomainRoot>
              store={store}
              startProcess={knifeBootstrap.startProcess}
              ids={knifeBootstrap.ids}
              resolveFeature={knifeBootstrap.resolveFeature}
              resolveStore={knifeBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={knifeBootstrap.featureAtPoint}
              targetShape={knifeTargetShape}
              drawSink={knifeDrawSink}
              mapCameraInput={mapCameraInput}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onKnifeCommitted}
              onConflicts={onKnifeConflicts}
            />
            {/* U30 INTEGRATION (教訓 5.7 / 5.2): the merge-tool controller, bound to the
                SAME store. Selecting 編集モード→結合 starts a session; map-input clicks
                toggle target faces; 結合を確定 builds a MergeProposal and hands a merge
                EditProposal to the U13 seam (createLiveMergeBinding). Was a dead button
                — domain/merge existed but no UI consumed it (bughunt3 merge-no-reduction). */}
            <MergeToolController<DomainRoot>
              store={store}
              startProcess={mergeBootstrap.startProcess}
              ids={mergeBootstrap.ids}
              resolveFeatures={mergeBootstrap.resolveFeatures}
              resolveStore={mergeBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={mergeBootstrap.featureAtPoint}
              resolveLeafShape={mergeBootstrap.resolveLeafShape}
              drawSink={mergeDrawSink}
              mapCameraInput={mapCameraInput}
              onCommitted={onMergeCommitted}
              onConflicts={onMergeConflicts}
            />
            {/* U28 INTEGRATION (教訓 5.7 / 5.2): the reparent-tool controller, bound to the
                SAME store. Selecting 編集モード→所属変更 starts a session; the first map
                click picks the target, the second the new上位領域; 所属変更を確定 builds an
                AffiliationProposal and hands an affiliation EditProposal to the U13 seam
                (createLiveAffiliationBinding). Was a dead button — domain/affiliation
                existed but no UI consumed it (bughunt3 reparent-dead-button). */}
            <ReparentToolController<DomainRoot>
              store={store}
              startProcess={reparentBootstrap.startProcess}
              resolveFeatures={reparentBootstrap.resolveFeatures}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={reparentBootstrap.featureAtPoint}
              resolveLeafShape={reparentBootstrap.resolveLeafShape}
              drawSink={reparentDrawSink}
              mapCameraInput={mapCameraInput}
              onCommitted={onReparentCommitted}
              onConflicts={onReparentConflicts}
            />
            {/* U35 — conflict-resolution modal (FR-62 / FR-63). Mounted only while a
                confirmation is paused; it sits ABOVE the tool input layers and takes
                input first (教訓 5.14). Its applyResolutions is proposal-bound to the
                paused edit; commit records ONE undo unit (U12). */}
            {conflictState !== null && (
              <ConflictResolutionModal<DomainRoot>
                pending={conflictState.pending}
                applyResolutions={conflictState.applyResolutions}
                shapesFor={shapesFor}
                showGuide={store.getState().appSettings.showConflictGuide}
                onSuppressGuide={() =>
                  store.getState().updateAppSetting('showConflictGuide', false)
                }
                onCommitted={onConflictCommitted}
                onCancel={onConflictCancel}
              />
            )}
          </>
        }
      />
    </div>
  );
}

/** A sensible default color for a non-inherited split feature (FR-97 auto-color on). */
// HB3-13: a knife-split's non-inherited piece is a NEW feature, so it gets the same
// translucent default fill (0.7) as a freshly-added feature (単一真実源の既定値).
const KNIFE_DEFAULT_COLOR = withFillOpacity(
  createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
);

/** HB3-20 review fix: minimum near-candidate query look-ahead (screen px) so the
 *  slide (排他) collision check keeps working even when the user disables snapping
 *  (snapDistancePx=0). Converted to world units per frame via the live zoom. */
const SLIDE_LOOKAHEAD_PX = 8;

/** HB3-11: base screen position for the first detail panel (later panels cascade). */
const DETAIL_PANEL_BASE_POS = { x: 160, y: 120 };
/** HB3-11: detail documents are an honest empty stub for now (文書本体保存は別タスク) and
 *  carry no embedded assets, so the asset resolver always returns null (safe broken-image). */
const NO_ASSET_RESOLVER: AssetResolver = { resolveAsset: () => null };

/**
 * Mount {@link AddToolController} with the live FACE parent candidates (FR-77 親面).
 * The candidate list is the FACES present at the current timeline instant — derived
 * from the SAME `featuresAt` resolution the renderer / hit-test use (単一真実源, 教訓
 * 5.3 / 5.29), so the 親選択 offers exactly the faces the user currently sees. It is
 * recomputed reactively on every domain / time change (a time change can drop a
 * covering parent — the controller's `revalidateParentSelection` then clears a stale
 * choice, 教訓 5.5). Without this wiring the 親選択 dropdown only ever showed 親なし
 * and no hierarchy (=集約表示) could ever be built through the live UI.
 */
function AddToolControllerWithParents(
  props: Omit<AddToolControllerProps<DomainRoot>, 'parentCandidates'>,
): JSX.Element {
  const domain = useStore(props.store, (s) => s.domain);
  const currentTime = useStore(props.store, (s) => s.currentTime);
  // The faces present at the current time, as 親候補 (FR-77). `featuresAt` is the
  // already-present-at-time set, so the existence predicate is simply membership —
  // never re-resolved here (the domain `parentCandidates` filters to face kind).
  const candidates: readonly ParentCandidate[] = useMemo(() => {
    const present = featuresAt(domain, currentTime);
    const presentIds = new Set(present.filter(isFaceFeature).map((f) => f.id));
    return buildParentCandidates(present, (id) => presentIds.has(id));
  }, [domain, currentTime]);
  return <AddToolController<DomainRoot> {...props} parentCandidates={candidates} />;
}

/**
 * A hidden marker reflecting the live selection's active feature id for回帰観点
 * E2E observability (教訓 5.11). It is a pure mirror of the store — no truth lives
 * here. Empty string when nothing is selected.
 */
function ActiveFeatureMarker(props: {
  readonly store: ReturnType<typeof createSessionStore<DomainRoot>>;
}): JSX.Element {
  const active = useStore(props.store, (s) => s.selection.activeFeature);
  // HB-15 観測フック: mirror the live vertex-selection truth (the first selected
  // vertex id + its owner feature) into hidden data-testid markers so a behavioural
  // E2E can assert an edit-mode click on a known vertex actually selected THAT vertex
  // (既存 app-active-feature 方式). Pure mirrors of the U22 selection state — no truth
  // lives here (技術方針 2.5). Empty string when no vertex is selected.
  const vertexId = useStore(props.store, (s) => {
    const it = s.selection.vertexIds.values().next();
    return it.done === true ? '' : (it.value as unknown as string);
  });
  const vertexOwner = useStore(
    props.store,
    (s) => (s.selection.vertexOwner ?? '') as unknown as string,
  );
  return (
    <>
      <span data-testid="app-active-feature" hidden>
        {active ?? ''}
      </span>
      <span data-testid="app-active-vertex" hidden>
        {vertexId}
      </span>
      <span data-testid="app-active-vertex-owner" hidden>
        {vertexOwner}
      </span>
    </>
  );
}

/**
 * HB-4 observability marker: mirrors the live session mode + active tool ids for
 * the回帰観点 E2E (the 表示専用→編集 transition + edit-tool activation). Pure
 * mirrors of the store truth — no state lives here (技術方針 2.5). Empty string
 * for "no active tool". The toolbar buttons already expose their `disabled`
 * state for the test; this surfaces the underlying mode/tool the gate derives
 * from, so a regression can pin the cause (mode flipped) as well as the effect
 * (buttons enabled).
 */
function SessionModeMarker(props: {
  readonly store: ReturnType<typeof createSessionStore<DomainRoot>>;
}): JSX.Element {
  const mode = useStore(props.store, (s) => s.mode);
  const activeTool = useStore(props.store, (s) => s.activeTool);
  return (
    <>
      <span data-testid="app-mode" hidden>
        {mode}
      </span>
      <span data-testid="app-active-tool" hidden>
        {activeTool ?? ''}
      </span>
    </>
  );
}

/**
 * FR-12 経度シフト panel: mounts the U18 {@link LongitudeShiftControl} bound to the
 * LIVE session store + the renderer camera (教訓 5.7 合成ルートの結線漏れ).
 *
 * The readout subscribes to the store's top-level `centerLon` truth (the SAME
 * value publishCameraHooks mirrors from every live render-camera change), so it
 * tracks pans / wheels / shifts / presets from one source (単一真実源, 技術方針 2.5).
 *
 * A shift / preset is applied by reading the LIVE renderer camera and writing a NEW
 * camera with the recomputed centerLon back through `writeCamera` — the SAME camera
 * the U40 pan/wheel path writes, so there is no second camera/longitude truth (教訓
 * 5.29). The zoom is applied EXACTLY once, inside `applyLongitudeShift` against the
 * live camera zoom; the widget reports a RAW shift操作量 and never sees zoom, so the
 * factor can never double-apply (教訓 5.16). Before the map mounts the renderer ref
 * is null and the handlers are honest no-ops (the widget still renders the readout).
 */
function LongitudeShiftPanel(props: {
  readonly store: ReturnType<typeof createSessionStore<DomainRoot>>;
  readonly rendererRef: React.MutableRefObject<AddHostPorts | null>;
}): JSX.Element {
  const { store, rendererRef } = props;
  const centerLon = useStore(store, (s) => s.centerLon);

  const onShift = useCallback(
    (shift: number): void => {
      const ports = rendererRef.current;
      if (ports === null) return;
      const { camera } = ports.readCamera();
      // Zoom applied ONCE in the domain (教訓 5.16); the continuous center stays a
      // scalar (FR-07, folding only at display time).
      const nextLon = applyLongitudeShift(camera.centerLon, shift, camera.zoom);
      ports.writeCamera({ ...camera, centerLon: nextLon });
    },
    [rendererRef],
  );

  const onPreset = useCallback(
    (preset: CenterLonPreset): void => {
      const ports = rendererRef.current;
      if (ports === null) return;
      const { camera } = ports.readCamera();
      ports.writeCamera({ ...camera, centerLon: centerLonForPreset(preset) });
    },
    [rendererRef],
  );

  return (
    <LongitudeShiftControl
      centerLon={centerLon}
      onShift={onShift}
      onPreset={onPreset}
    />
  );
}

/**
 * The state the App holds while a confirmation is paused on conflicts (U35). The
 * `applyResolutions` adapter is already bound to the paused proposal, so the modal
 * is generic over the domain root only (it never sees the snapshot type).
 */
interface ConflictPending {
  readonly pending: ConflictsPendingResult;
  readonly applyResolutions: ApplyResolutions<DomainRoot>;
  /**
   * The selection preference for the eventual commit (教訓 5.11). A direct add /
   * knife commit promotes the new feature / inheritor; a commit that went THROUGH
   * the conflict modal must promote the SAME element, so we carry it from the
   * paused edit and forward it on conflict commit (it was being lost before).
   */
  readonly preference?: { readonly featureId: FeatureId };
}

/**
 * Resolve one conflict participant's leaf shape at the conflict time for the
 * minimap preview. Falls back to the conflict overlap when the feature is absent
 * / not a leaf so the preview always has geometry (FR-63 参考表示). The time is the
 * conflict's pinned point (or range start) — the same instant the detection ran.
 */
function shapeForConflictParticipant(
  root: DomainRoot,
  conflict: Conflict,
  featureId: FeatureId,
): GeoMultiPolygon {
  const time = conflict.time.kind === 'point' ? conflict.time.at : conflict.time.from;
  const shape = leafShapeAt(root, time, featureId);
  return shape ?? conflict.overlap;
}

/**
 * Mirror the currently-selected leaf's resolved shape into React state for the
 * knife target emphasis (FR-92). Recomputed on selection / time / domain change
 * via a store subscription (技術方針 2.5: React 外のストアを subscribe で監視), so the
 * highlight tracks the live truth without a parallel selection source (教訓 5.29).
 *
 * IMPORTANT (技術方針 2.3「camera は React 描画パスに乗せない」, bughunt 再発防止):
 * the bare store subscription fires on EVERY set(), and a pan / wheel emits two
 * camera set()s per frame (updateCamera + setCenterLon, App.tsx cameraPort.write).
 * `leafShapeAt` allocates a fresh GeoMultiPolygon every call, so an unconditional
 * `setShape(compute())` handed React a NEW reference each camera frame and forced
 * a per-frame re-render of App + KnifeToolController while a leaf was selected —
 * putting camera changes on the React render path. We therefore GUARD on the only
 * inputs `leafShapeAt` reads (activeFeature / currentTime / domain) and skip the
 * recompute when none of them changed, so a camera-only set() is a no-op here.
 */
export function useKnifeTargetShape(
  store: ReturnType<typeof createSessionStore<DomainRoot>>,
): GeoMultiPolygon | undefined {
  const [shape, setShape] = useState<GeoMultiPolygon | undefined>(undefined);
  useEffect(() => {
    /** The leaf-shape inputs; identity-compared to gate the recompute. */
    const inputsOf = (
      s: ReturnType<typeof store.getState>,
    ): { fid: FeatureId | null; time: TimePoint; domain: DomainRoot } => ({
      fid: s.activeFeature,
      time: s.currentTime,
      domain: s.domain,
    });
    const compute = (
      fid: FeatureId | null,
      time: TimePoint,
    ): GeoMultiPolygon | undefined => {
      if (fid === null) return undefined;
      return leafShapeAt(store.getState().domain, time, fid) ?? undefined;
    };
    let prev = inputsOf(store.getState());
    setShape(compute(prev.fid, prev.time));
    return store.subscribe(() => {
      const next = inputsOf(store.getState());
      // Camera-only set()s leave fid/time/domain identical — skip the recompute
      // (and the re-render it would cause) so pan/zoom stays off the render path.
      if (
        next.fid === prev.fid &&
        next.time === prev.time &&
        next.domain === prev.domain
      ) {
        return;
      }
      prev = next;
      setShape(compute(next.fid, next.time));
    });
  }, [store]);
  return shape;
}

// --- The add bootstrap (id ports + the U13 seam) ----------------------------

import {
  createIdGeneratorState,
  nextRawId,
  type IdGeneratorState,
  type IdReservation,
} from '../domain/id-generator';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';

// --- shared id minter (finding 3: single generator + reservation set) --------
//
// Add and Knife must NOT mint ids from independent generators seeded at the same
// (time:0, counter:0): two empty generators produce identical first ids (v-0-0,
// f-0-0, …) and collide, and neither generator knew about ids already in the
// LOADED project. A collision silently last-wins in the VertexStore Map (座標/地物
// が無通知で失われる). So the composition root owns ONE minter, shared by both
// tools, that on every mint passes the CURRENT full set of project ids PLUS the
// ids it has already issued this session as the `existing` set nextRawId skips.

/** Collect every raw feature / vertex / ring id present anywhere in the project. */
export function collectProjectRawIds(root: DomainProject): Set<string> {
  const ids = new Set<string>();
  for (const history of root.histories) {
    ids.add(history.featureId as unknown as string);
    for (const entry of history.series.entries) {
      const snap = entry.anchor.snapshot;
      for (const v of snap.vertices.byId.keys()) ids.add(v as unknown as string);
      for (const f of snap.features) {
        ids.add(f.id as unknown as string);
        if (f.kind === 'point') ids.add(f.vertexId as unknown as string);
        else if (f.kind === 'line') {
          for (const vid of f.vertexIds) ids.add(vid as unknown as string);
        } else if (f.kind === 'leaf') {
          for (const ring of f.shape.rings) {
            ids.add(ring.id as unknown as string);
            for (const vid of ring.vertexIds) ids.add(vid as unknown as string);
          }
        }
      }
    }
  }
  return ids;
}

/** A shared `mint(prefix)` over one generator state + a live-project reservation. */
export type SharedIdMint = (prefix: string) => string;

/**
 * Build the single shared minter the composition root hands to BOTH tool
 * bootstraps. State (counter / time) is private and monotonic; on each mint the
 * `existing` set is the union of (a) every id currently in the live project and
 * (b) every id this minter has already issued this session — so a freshly minted
 * id can collide with neither stored data nor another tool's earlier output
 * (教訓 5.37 重複チェック). The time source is a monotonic tick so same-tick mints
 * still differ by counter.
 */
export function createSharedIdMint(getRoot: () => DomainProject): SharedIdMint {
  let state: IdGeneratorState = createIdGeneratorState();
  let tick = 0;
  const issued = new Set<string>();
  // PERF (bughunt2): collectProjectRawIds walks the WHOLE project
  // (histories × entries × features × vertices/rings). The previous code re-ran
  // it on EVERY mint, so assembling one add proposal with V vertices did V+ full
  // traversals → O(V × project_size) per add/knife, quadratic on large projects.
  // The domain root is IMMUTABLE — every commit yields a brand-new root object
  // (store reducers never mutate in place) — so the scan result is stable until
  // the root reference changes. Memoize the scan keyed by root IDENTITY and only
  // union the session-issued ids per call (教訓 5.37 重複チェック still satisfied:
  // `existing` always = current project ids ∪ this session's issued ids).
  let scannedRoot: DomainProject | null = null;
  let scannedIds = new Set<string>();
  return (prefix: string): string => {
    const root = getRoot();
    if (root !== scannedRoot) {
      scannedRoot = root;
      scannedIds = collectProjectRawIds(root);
    }
    // Issued ids are unioned into the cached project scan WITHOUT mutating it,
    // because nextRawId only READS `existing` (IdReservation = membership test);
    // we feed a composite view that defers to both sets (no per-mint copy).
    const existing: IdReservation = {
      has: (id: string): boolean => scannedIds.has(id) || issued.has(id),
    };
    const g = nextRawId(prefix, state, () => (tick += 1), existing);
    state = g.state;
    issued.add(g.value);
    return g.value;
  };
}
import {
  PROCESS_STATUS,
  createEditProposal,
  type ProcessResult,
  type EditProposal,
} from '../domain/consistency/index';
import type { AddSnapshot } from '../domain/add/index';
import type { TimePoint } from '../domain/time/time-point';
// U44 — the LIVE U13 binding factories (no longer a 型骨格): these build the real
// ConsistencyPorts<DomainRoot, Snapshot> adapter over the live domain root and
// expose the `startProcess` closure the controllers consume (./consistency-binding.ts).
import {
  createLiveAddBinding,
  createLiveEditBinding,
  createLiveKnifeBinding,
  createLiveMergeBinding,
  createLiveAffiliationBinding,
  createDeleteFeatureCommandForRoot,
} from './consistency-binding';
import type { AddIdPorts } from '../domain/add/index';
import type { StartAddProcess } from './add/useAddTool';

// Pin, at the type level, the live binding factory contracts (教訓 5.33 契約越し):
// the composition-root swap is contract-clean — the controllers consume only the
// produced `startProcess`, so the binding body is the only thing that changed.
export type LiveAddBindingFactory = typeof createLiveAddBinding;
export type LiveKnifeBindingFactory = typeof createLiveKnifeBinding;

interface AddBootstrap<S> {
  readonly ids: AddIdPorts;
  readonly nextRingId: () => ReturnType<typeof asRingId>;
  readonly startProcess: StartAddProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused add proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<AddSnapshot>,
  ) => ApplyResolutions<S>;
}

function createAddBootstrap<S>(getRoot: () => S, mint: SharedIdMint): AddBootstrap<S> {
  // Ids are minted through the SHARED minter (finding 3): one generator + a live
  // reservation set over the whole project, shared with the knife bootstrap, so
  // Add/Knife/loaded ids can never collide (教訓 5.37 重複チェック).
  const ids: AddIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
  };
  const nextRingId = (): ReturnType<typeof asRingId> => asRingId(mint('r'));

  // U44 — the LIVE U13 binding. `createLiveAddBinding` builds the full
  // ConsistencyPorts<DomainRoot, AddSnapshot> adapter (applyProposal = U44's
  // applyAddProposal; U09 time / U10 spatial / U06 difference / U12 single-undo)
  // over the live root read at process-start (getRoot, never a stale capture —
  // 教訓 5.6). The controller consumes StartAddProcess<S> as a contract (教訓 5.33);
  // the swap is contract-clean. The bootstrap's id ports back the U06 resolution
  // write-back ring/vertex minting. The binding is generic over the domain root S
  // (here always DomainProject), matching the controller's StartAddProcess<S>.
  const live = createLiveAddBinding({
    getRoot: getRoot as unknown as () => DomainRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId,
  });
  const startProcess = live.startProcess as unknown as StartAddProcess<S>;
  const applyResolutionsFor = (proposal: EditProposal<AddSnapshot>): ApplyResolutions<S> =>
    live.applyResolutionsFor(proposal) as unknown as ApplyResolutions<S>;

  return { ids, nextRingId, startProcess, applyResolutionsFor };
}

// --- The knife bootstrap (id ports + domain-lookup stubs + the U13 seam) -----

import type { VertexStore } from '../domain/vertex';
import { withAttributes, withColor, type Feature } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type {
  ResolveFeature,
  ResolveVertexStore,
  StartSplitProcess,
  FeatureAtPoint,
} from './knife/index';
import type { SplitIdPorts, SplitSnapshot } from '../domain/knife/index';
import type { DisplayControlInput } from '../render/display-pipeline';
import type { Camera, Viewport } from '../render';

/** A snapshot of the camera/viewport the frame drew with (for the knife wrap probe). */
type KnifeWrapFrame = { readonly camera: Camera; readonly viewport: Viewport } | undefined;

interface KnifeBootstrap<S> {
  readonly ids: SplitIdPorts;
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly featureAtPoint: FeatureAtPoint;
  readonly startProcess: StartSplitProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused split proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<SplitSnapshot>,
  ) => ApplyResolutions<S>;
}

function createKnifeBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
  mint: SharedIdMint,
  getDisplayControl: () => DisplayControlInput,
  getWrap: () => KnifeWrapFrame,
): KnifeBootstrap<DomainRoot> {
  // Ids are minted through the SAME shared minter the add bootstrap uses (finding
  // 3): a single generator + a project-wide reservation set, so a knife-minted id
  // can collide with neither an add-minted id nor a loaded id (教訓 5.37).
  const ids: SplitIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  // LIVE domain-lookup ports (P0-B): resolve against the CURRENT committed root at
  // the CURRENT time, read at call time so a load / time move / edit is reflected
  // without a stale capture (教訓 5.6). They share the single live-lookup rule
  // (live-lookup.ts) the consistency binding uses, so対象面選択 and U13 spatial
  // detection can never disagree about which feature is where (二重真実源を作らない,
  // 教訓 5.29). resolveStore returns the vertices effective at the same time so the
  // hook's geometry (checkSplittable / executeSplit) resolves against real coords.
  const resolveFeature: ResolveFeature = (featureId): Feature | undefined =>
    featuresAt(getRoot(), getTime()).find((f) => f.id === featureId);
  const resolveStore: ResolveVertexStore = (): VertexStore => verticesAt(getRoot(), getTime());
  // 対象面探索は描画解決と同じ単一真実源 (bughunt: ナイフが displayControl を無視して
  // 裏の非表示 leaf を選べた). The previous `leafAtPoint` tested every committed leaf
  // body regardless of what was drawn, so with the default N=0 集約表示 a click on an
  // aggregate body returned a HIDDEN child leaf as the split target (描画されていない
  // ものが選ばれる, 二重真実源). We now route through `drawnAreaAt` — the SAME
  // `resolveDisplayControl`-based drawn-area set the renderer (committed-features) fills
  // and the main hit-test (`liveHitTestAt`) picks — honouring the store's display-control
  // and the renderer's ±360° wrap turns. A body click resolves to the AGGREGATE the user
  // SEES (which the hook's LEAF gate then rejects as unsplittable), never an undrawn child
  // leaf. Read at call time so a load / time move / depth-slider change is reflected
  // without a stale capture (教訓 5.6 / 5.29).
  const featureAtPoint: FeatureAtPoint = (point): FeatureId | null =>
    drawnAreaAt(
      {
        root: getRoot(),
        time: getTime(),
        displayControl: getDisplayControl(),
        wrap: getWrap(),
      },
      point,
    );

  // U44 — the LIVE U13 binding for split. The proposal is ALREADY a U13
  // EditProposal<SplitSnapshot> (toEditProposal ran in the hook), so the swap is
  // contract-clean.
  const live = createLiveKnifeBinding({
    getRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  });
  const startProcess = live.startProcess;
  const applyResolutionsFor = (
    proposal: EditProposal<SplitSnapshot>,
  ): ApplyResolutions<DomainRoot> => live.applyResolutionsFor(proposal);

  return {
    ids,
    resolveFeature,
    resolveStore,
    featureAtPoint,
    startProcess,
    applyResolutionsFor,
  };
}

// --- The merge bootstrap (id ports + live-lookup + the U13 seam) --------------

import type {
  ResolveFeatures as MergeResolveFeatures,
  ResolveVertexStore as MergeResolveStore,
  StartMergeProcess,
  FeatureAtPoint as MergeFeatureAtPoint,
} from './merge/index';
import type { MergeIdPorts, MergeSnapshot } from '../domain/merge/index';

interface MergeBootstrap<S> {
  readonly ids: MergeIdPorts;
  readonly resolveFeatures: MergeResolveFeatures;
  readonly resolveStore: MergeResolveStore;
  readonly featureAtPoint: MergeFeatureAtPoint;
  /** Resolve a target id → its leaf shape at the current time (HB3-15(c) highlight). */
  readonly resolveLeafShape: (featureId: FeatureId) => GeoMultiPolygon | undefined;
  readonly startProcess: StartMergeProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused merge proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<MergeSnapshot>,
  ) => ApplyResolutions<S>;
}

function createMergeBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
  mint: SharedIdMint,
): MergeBootstrap<DomainRoot> {
  // Ids minted through the SAME shared minter the add / knife bootstraps use (finding
  // 3): one generator + a project-wide reservation set, so a merge-minted id (the new
  // result feature / 上位領域 / re-minted union vertices) can collide with neither an
  // add / knife-minted id nor a loaded id (教訓 5.37).
  const ids: MergeIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  // LIVE live-lookup ports (P0-B): the features / vertices effective at the CURRENT
  // time, read at call time so a load / time move / edit is reflected without a stale
  // capture (教訓 5.6). They share the SAME live-lookup rule (live-lookup.ts) the knife
  // bootstrap and the consistency binding use, so merge target selection / precondition
  // 検証 and U13 spatial detection can never disagree (二重真実源を作らない, 教訓 5.29).
  const resolveFeatures: MergeResolveFeatures = () => featuresAt(getRoot(), getTime());
  const resolveStore: MergeResolveStore = () => verticesAt(getRoot(), getTime());
  // HB3-16: 結合の対象探索は INDIVIDUAL LEAF を拾う `leafAtPoint`. 結合は末端 leaf のみを
  // たたみ込む操作なので、集約表示中(N=0)に集約体の下に隠れた子 leaf も直接ターゲットに
  // できなければならない (DECISIONS HB3-16). `drawnAreaAt` は描画されている集約体 id を返す
  // ため、(a) 個別 leaf が選べず、(b) 同じ集約に属する兄弟 A,B が両方とも同一の集約 id へ
  // 解決して2回目クリックで1回目が toggle off される「後から選択が消える」HB3-15(b) を生む。
  // `leafAtPoint` は各 leaf を別 id へ解決するので両症状が解消する。描画されていない leaf を
  // 選ぶ違和感(旧 bughunt の懸念)は HB3-15(c) のツール専用ハイライト(resolveLeafShape →
  // buildMergeHighlight)で「選んだ leaf が地図上に見える」ことで解消する(両方セットで実装)。
  // 単一真実源: leafAtPoint と下の resolveLeafShape は同じ live-lookup を使う (教訓 5.6/5.29)。
  const featureAtPoint: MergeFeatureAtPoint = (point): FeatureId | null =>
    leafAtPoint(getRoot(), getTime(), point);
  const resolveLeafShape = (featureId: FeatureId): GeoMultiPolygon | undefined =>
    leafShapeAt(getRoot(), getTime(), featureId) ?? undefined;

  // U44 — the LIVE U13 binding for merge. The proposal is ALREADY a U13
  // EditProposal<MergeSnapshot> (toMergeEditProposal ran in the hook), so the swap is
  // contract-clean. The binding's applyProposal = U44's applyMergeProposal.
  const live = createLiveMergeBinding({
    getRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  });
  const startProcess = live.startProcess;
  const applyResolutionsFor = (
    proposal: EditProposal<MergeSnapshot>,
  ): ApplyResolutions<DomainRoot> => live.applyResolutionsFor(proposal);

  return {
    ids,
    resolveFeatures,
    resolveStore,
    featureAtPoint,
    resolveLeafShape,
    startProcess,
    applyResolutionsFor,
  };
}

// --- The reparent bootstrap (live-lookup + the U13 seam) ----------------------

import type {
  ResolveFeatures as ReparentResolveFeatures,
  StartAffiliationProcess,
  FeatureAtPoint as ReparentFeatureAtPoint,
} from './reparent/index';
import type { AffiliationSnapshot } from '../domain/editing/apply-proposal';

interface ReparentBootstrap<S> {
  readonly resolveFeatures: ReparentResolveFeatures;
  readonly featureAtPoint: ReparentFeatureAtPoint;
  /** Resolve a target / new-parent id → its leaf shape at the current time (HB3-15(c)). */
  readonly resolveLeafShape: (featureId: FeatureId) => GeoMultiPolygon | undefined;
  readonly startProcess: StartAffiliationProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused reparent proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<AffiliationSnapshot>,
  ) => ApplyResolutions<S>;
}

function createReparentBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
): ReparentBootstrap<DomainRoot> {
  // LIVE live-lookup ports (P0-B): the features effective at the CURRENT time, read at
  // call time so a load / time move / edit is reflected without a stale capture (教訓
  // 5.6). They share the SAME live-lookup rule (live-lookup.ts) the knife / merge
  // bootstraps and the consistency binding use, so reparent target / parent selection
  // and U28 legality 検証 can never disagree with what is drawn (二重真実源を作らない,
  // 教訓 5.29). No id ports: the existing-parent reparent mints nothing (aggregates are
  // shapeless, FR-35; a `create` decision would mint inside buildAffiliationProposal).
  const resolveFeatures: ReparentResolveFeatures = () => featuresAt(getRoot(), getTime());
  // HB3-16: 所属変更の対象/上位探索も INDIVIDUAL LEAF を拾う `leafAtPoint` (DECISIONS HB3-16).
  // 集約表示中(N=0)に集約体の下に隠れた個別 leaf を直接ターゲット/新上位に選べる必要がある。
  // `drawnAreaAt` だと描画されている集約体 id を返すため、同じ集約に属する兄弟 A,B を続けて
  // 選ぶと両方が同一 id へ解決し、2回目クリックが pick の same-id ルールで1回目を toggle off
  // してしまう = HB3-15(b)「後から選択が消える」の同一親解決バグ。`leafAtPoint` は各 leaf を
  // 別 id へ解決するのでこれが解消する(別の上位領域へ移す操作が成立)。描画されていない leaf を
  // 選ぶ違和感は HB3-15(c) のツール専用ハイライト(resolveLeafShape → buildReparentHighlight)
  // で見えるようにすることで解消(両方セットで実装)。単一真実源 (教訓 5.6 / 5.29)。
  const featureAtPoint: ReparentFeatureAtPoint = (point): FeatureId | null =>
    leafAtPoint(getRoot(), getTime(), point);
  const resolveLeafShape = (featureId: FeatureId): GeoMultiPolygon | undefined =>
    leafShapeAt(getRoot(), getTime(), featureId) ?? undefined;

  // U44 — the LIVE U13 binding for reparent. The proposal is ALREADY a U13
  // EditProposal<AffiliationSnapshot> (toAffiliationEditProposal ran in the hook), so the
  // swap is contract-clean. The binding's applyProposal = U44's applyAffiliationProposal.
  const live = createLiveAffiliationBinding({ getRoot });
  const startProcess = live.startProcess;
  const applyResolutionsFor = (
    proposal: EditProposal<AffiliationSnapshot>,
  ): ApplyResolutions<DomainRoot> => live.applyResolutionsFor(proposal);

  return { resolveFeatures, featureAtPoint, resolveLeafShape, startProcess, applyResolutionsFor };
}
