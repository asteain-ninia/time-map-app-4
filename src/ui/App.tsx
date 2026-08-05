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
import { EDIT_MODE, type ToolId } from './state/session';
import { AppShell, SIDEBAR_SECTION } from './shell';
import { buildSidebarContent } from './shell/SidebarContent';
import { TOOL_ID } from './shell/tools';
import {
  DetailPanels,
  EMPTY_DETAIL_PANELS,
  closeDetailPanel,
  openPanel,
  intervalRejectionMessage,
  type DetailPanelsState,
  type AssetResolver,
  type EditDispatch,
  type AnchorIntervalEditDispatch,
  type FeatureLookup as PropertyFeatureLookup,
} from './property';
import { Timeline } from './timeline/Timeline';
import { CommandRegistry } from './shell/commands';
import './shell/shell.css';
import './property/property.css';
import './file-ops/file-ops.css';
import './help-tools/help-tools.css';

import { getCalendar } from '../domain/time/calendar';
import {
  DiagnosticLogger,
  ErrorBoundary,
  logSessionStart,
  resolveDiagnosticLogSink,
  wireGlobalErrorHandlers,
} from './discovery/index';
import type { DomainProject } from '../domain/persistence/index';
import { projectsEqual } from '../domain/persistence/index';
import {
  FileOpsController,
  buildEmptyProject,
  closeVerdictWithoutGuard,
  wireWindowCloseBridge,
  type SupplyZoomRange,
  type WindowCloseHook,
  type DropTargetHook,
  type FileDropHandlers,
  type BasemapReplaceHook,
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
import { RingEditToolController, type RingEditDrawSink } from './ring-edit/index';
import './ring-edit/ring-edit.css';
import { DrillToolController, type DrillDrawSink } from './drill/index';
import './drill/drill.css';
import { ReparentToolController, type ReparentDrawSink } from './reparent/index';
import './reparent/reparent.css';
import {
  SurveyToolController,
  SurveyMapBridge,
  SurveyControls,
  type SurveyDrawSink,
} from './survey/index';
import './survey/survey.css';
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
  withLimit as historyWithLimit,
  type History,
  type HistoryStep,
} from '../domain/command/history';
import type { Command } from '../domain/command/index';
import { createRedoPreferenceRegistry } from './state/redo-preference';
import { graftLiveBaseMap, reconcileHistoryOnExternalDomainSwap } from './state/history-reconcile';
import { COMMAND_ID } from './shell/commands';
import { featureByIdAt, featuresAt, verticesAt, leafShapeAt, leafAtPoint } from './live-lookup';
import { runEditDelete, type EditDeleteSelection } from './vertex-delete';
import { runUnshare } from './live-unshare';
import { createDetailDocumentDispatch } from './live-detail-document';
import { createLiveExistenceResolver } from './live-existence';
import { createLiveGrabbabilityResolver } from './live-grabbability';
import { buildCommittedFeatures, drawnFeatureFills } from './map/committed-features';
import {
  allFeaturesBoundsAt,
  featureBoundsAt,
  type AllFeaturesBoundsOptions,
} from './map/feature-bounds';
import { keyboardZoomCamera, type ZoomDirection } from './map/keyboard-zoom';
import {
  CURSOR_READOUT_INTERVAL_MS,
  CursorPositionStore,
} from './shell/cursor-position';
import { CursorCoordinateStatus } from './shell/CursorCoordinateStatus';
import { BROWSER_CLOCK, throttleTrailing } from './shell/map-resize';
import { buildActiveFeatureHandlePrimitives } from './map/active-feature-handles';
import {
  PointerDispatcher,
  NOOP_ADD_PORT,
  POINTER_BUTTON,
  LongitudeShiftControl,
  GlobalDepthControl,
  GridToggleControl,
  type CameraPort,
  type HitTester,
  type MapCameraInput,
} from './map/index';
import './map/grid-toggle.css';
import { buildForest } from '../domain/hierarchy/forest';
import { maxDerivedDepth } from '../domain/hierarchy/depth';
import { FEATURE_KIND, featureDisplayName } from '../domain/feature';
import {
  createLiveContextMenuPort,
  promoteHitToSelection,
  type ContextMenuRequest,
} from './map/live-context-menu-port';
import {
  MapContextMenu,
  type ContextMenuOpener,
} from './map/MapContextMenu';
// (fr96 本結線) the PURE right-click composition/dispatch (U36) + the live lookups
// they read (単一真実源: the SAME resolveDisplayFor owners / shared-vertex derivation
// the hit-test & renderer use, 教訓 5.29).
import { composeMenuFor } from './map/context-menu-adapter';
import {
  sharedLookupFromSet,
  type ContextMenuModel,
  type MenuItemKind,
  type NoMenu,
} from '../domain/context-menu/index';
// (fr96 / Codex F1b) the item → flow LAUNCH routing seam (dispatchMenuItem + the
// EditProperties live-existence guard live THERE, Vitest-pinned; App only injects
// its live effects as ports — vertex-delete.ts の同型).
import { launchMenuItem } from './context-menu-launch';
import { sharedVertexIdsFor } from './map/shared-vertex-derivation';
import { resolveDisplayFor } from './map/display-resolution-cache';
import {
  isEmphasizedByOtherAxisUnderFilter,
  isFeatureVisibleUnderFilter,
} from './map/filtered-display';
// FR-113 INERT fast path: an untouched filter needs no per-feature visibility gate at all
// (全体表示 then pays nothing for the母集合 check — the zero-overhead default rule).
import { isFilterInert } from './discovery/index';
// (fr100) the U33 auto-recolor funnel wrapper — structure + recolor as ONE undo unit.
import { maybeComposeAutoRecolor } from './coloring/recolor-binding';
// (FR-109 follow-up) the undoable default-palette change command — routed through the
// SAME recordCommand funnel so a palette change + its auto-recolor land as ONE undo unit.
import { createPaletteChangeCommand } from './coloring/palette-command';
import { toPersistedUiSettings } from './file-ops/ui-settings-bridge';
import type { PaletteSelection } from './state/settings';
import {
  ownerLookupFromMap,
  type RectangleResolver,
  type NextTargetPreference,
} from '../domain/selection';
import { liveHitTestAt, verticesInRectangle } from './map/live-hit-test';
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
  cameraForBounds,
  cameraForFit,
  type ScreenPoint,
} from '../render';
import { createRedrawScheduler } from './map/redraw-scheduler';
import { redrawWatch, redrawWatchChanged } from './map/redraw-watch';
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
        // bughunt (全 undo 後の dirty 解消): the store recomputes dirty after an undo /
        // redo by comparing the restored domain to the last-saved baseline. Commands
        // rebuild state via Immer, so the restored reference is value-equal-but-new — we
        // inject the domain's OWN value equality (U14 projectsEqual) rather than a bare
        // === so a true round-trip back to the saved state is recognised as clean.
        domainEquals: projectsEqual,
        existence: createLiveExistenceResolver(() => {
          // Read the live committed root through the ref; until it is wired (it is
          // assigned synchronously on the very next line after this store is built)
          // fall back to an empty project so a predicate can never throw.
          const getRoot = liveRootRef.current;
          return getRoot !== null ? getRoot() : buildEmptyProject();
        }),
        // 選択 heal の対称性 (S4/S4c): re-validate the vertex selection whenever ANY
        // display-resolution input changes — depth/focus setters, time changes, and
        // the post-commit tightening of applyCommandResult / applyUndoRedoResult —
        // against the SAME resolveDisplayFor `owners` map the renderer draws / the
        // hit-test grabs (単一真実源). Without this a change that stops drawing the
        // selection owner left its vertices selected but unresolvable, and the
        // property panel showed「選択頂点の所有地物を特定できません」; a SHARED vertex
        // that survives through another drawn owner is kept with its owner rewritten.
        // Bound to the LIVE root via the same getRoot ref the existence resolver uses
        // (read live per call, never stale — the post-commit heal must see the
        // just-committed root).
        grabbability: createLiveGrabbabilityResolver(() => {
          const getRoot = liveRootRef.current;
          return getRoot !== null ? getRoot() : buildEmptyProject();
        }),
        // FR-113 (U41): the live set of ALL feature ids (feature-history level) so the
        // store can prune the display filter's 個別非表示 / 強調 ids after a structure
        // change (reconcileToLiveFeatures). Reads the live root through the SAME getRoot
        // ref the existence resolver uses (never a stale capture, 教訓 5.6) — run AFTER a
        // commit it sees the just-committed feature set.
        liveFeatureIds: () => {
          const getRoot = liveRootRef.current;
          const root = getRoot !== null ? getRoot() : buildEmptyProject();
          return new Set<FeatureId>(root.histories.map((h) => h.featureId));
        },
        // FR-109 follow-up: read the palette 2 fields out of the committed root's
        // uiSettings so the store can mirror a palette command's change back into the
        // live projectSettings (settings dialog + save overlay source). undefined when
        // the root carries no uiSettings (a pre-`ui` project) — the store then leaves the
        // palette store-owned. The ONLY place App reaches into DomainProject.uiSettings
        // for the store (mirror of projectsEqual → uiSettingsEqual).
        readDomainPalette: (domain) =>
          domain.uiSettings === undefined
            ? undefined
            : {
                defaultPaletteTheme: domain.uiSettings.project.defaultPaletteTheme,
                customPalette: domain.uiSettings.project.customPalette,
              },
        // FR-113 (Codex F2): the selection-heal visibility port. Binds the store's filter
        // heal to the SAME single FR-113 verdict (isFeatureVisibleUnderFilter) the draw /
        // hit / tool-target paths read, over the live root (via the getRoot ref) at the
        // (time, control) the store passes. So hiding the ACTIVE feature deselects it at once.
        filterVisibility: {
          isVisible: (featureId, filter, time, control) => {
            const getRoot = liveRootRef.current;
            const root = getRoot !== null ? getRoot() : buildEmptyProject();
            return isFeatureVisibleUnderFilter(
              resolveDisplayFor(root, time, control),
              filter,
              featureId,
            );
          },
        },
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

  // U41 INTEGRATION (FR-117, 教訓 5.7 合成ルートの結線漏れ): the single shared
  // {@link DiagnosticLogger}. Both the non-React global handlers (below) and the
  // React {@link ErrorBoundary} (wrapping the shell) record through THIS one logger,
  // so an error caught on any path lands in one diagnostics buffer (単一真実源).
  //
  // FILE PERSISTENCE 結線 (FR-117 / 教訓 5.7): attach the shell file-sink so each
  // recorded entry is also appended to a LOCAL JSONL file via U15's typed IPC — the
  // logger was previously built with NO sink, so warnings the user saw on real
  // hardware left no on-disk trace. `resolveDiagnosticLogSink` returns undefined when
  // the `timeMapApi` bridge is absent (vitest/jsdom), so tests stay memory-only.
  const logger = useMemo(() => {
    const sink = resolveDiagnosticLogSink(globalThis);
    return new DiagnosticLogger(sink !== undefined ? { sink } : {});
  }, []);

  // SESSION START MARKER (FR-117): record ONE info entry (app version + real time)
  // at startup so a diagnostic log file opens with a session boundary the user can
  // correlate. Routed through the SAME logger → file sink. The ref guard keeps a dev
  // StrictMode double-mount from double-logging (教訓 5.2 全経路で一貫).
  const sessionMarkedRef = useRef(false);
  useEffect(() => {
    if (sessionMarkedRef.current) return;
    sessionMarkedRef.current = true;
    logSessionStart(logger, {
      version: __APP_VERSION__,
      contextTimeLabel: String(store.getState().currentTime),
    });
  }, [logger, store]);

  // FR-117 ROOT FIX — install the window-level (non-React) error handlers ONCE at
  // startup. installGlobalErrorHandlers (unhandledrejection / error 捕捉) had no
  // production caller, so void-ed IPC/IO rejections were silent (教訓 5.7). We wire
  // it here to the SAME logger and route each caught error's message to the EXISTING
  // notification surface (globalThis.alert — the sink FileOpsController.notify uses),
  // introducing NO new toast UI (§7.4 非目標). The uninstall runs on cleanup so a
  // re-mount (StrictMode double-invoke in dev) never leaks / double-installs listeners
  // (教訓 5.2 全経路で破棄). The作中時刻 for the log context is the live現在時刻 numeric
  // instant (non-sensitive, 教訓 5.15 — separate from the record's real-time stamp).
  useEffect(() => {
    const uninstall = wireGlobalErrorHandlers(window, {
      logger,
      contextTimeLabel: () => String(store.getState().currentTime),
    });
    return uninstall;
  }, [logger, store]);

  // Window-close interception (FR-107 終了確認ガード): the controller registers the
  // quit guard; the host stores it so the shell-side close event can await it.
  const quitGuardRef = useRef<(() => Promise<boolean>) | null>(null);
  const registerWindowClose: WindowCloseHook = useCallback((runGuard) => {
    quitGuardRef.current = runGuard;
    return () => {
      quitGuardRef.current = null;
    };
  }, []);

  // FR-107 ROOT FIX (教訓 5.7 合成ルートの結線漏れ) — the runner registered above used
  // to sit in this ref with NO caller: main had no `window.on('close')` bridge, so
  // × / Alt+F4 / タスクバー / OS シャットダウン closed the window with the unsaved
  // warning fully bypassed (残 HIGH). Subscribe to main's close enquiry (U15
  // `timeMapApi.onCloseRequest`) and answer with THIS guard's verdict; main
  // preventDefaults the close and re-closes only on `true` (close-guard.ts).
  // The bridge reads the ref LIVE on every request (no stale capture) and is
  // fail-closed (未登録 / 例外 / 非 boolean → 閉じない). It is a no-op without the
  // preload bridge (vitest / jsdom), so component tests are unaffected.
  //
  // FALLBACK (ブリック回避, fail-closed は保ったまま): the controller lives INSIDE the
  // ErrorBoundary, so a caught render error unmounts it and leaves NO runner — with a
  // bare fail-closed answer the window would then be permanently unclosable. When no
  // runner is registered we answer from the SAME single dirty basis the guard itself
  // reads (store.projectDirty): clean ⇒ allow (there is nothing to protect, so this is
  // never a data-losing decision), dirty ⇒ refuse (unchanged fail-closed contract).
  useEffect(
    () =>
      wireWindowCloseBridge(
        globalThis,
        () =>
          quitGuardRef.current ??
          ((): Promise<boolean> =>
            Promise.resolve(closeVerdictWithoutGuard(store.getState().projectDirty))),
      ),
    [store],
  );

  // FR-04 ベースマップ差し替え結線 — the FileOpsController registers its replace RUNNER
  // here (it owns the retained save bytes + the display push + the IPC api); the
  // settings dialog's差し替えボタン invokes it through `onRequestBasemapReplace`. Held
  // behind a ref so a registration does not re-render (the registerWindowClose
  // pattern, 技術方針 2.3). Null until the controller registers / after unmount
  // (教訓 5.2 全経路で破棄).
  const basemapReplaceRef = useRef<(() => Promise<void>) | null>(null);
  const registerBasemapReplace: BasemapReplaceHook = useCallback((run) => {
    basemapReplaceRef.current = run;
    return () => {
      basemapReplaceRef.current = null;
    };
  }, []);
  // The stable request handler threaded to the settings dialog (via HelpToolsController).
  // Always defined so the button is ENABLED in the live app — the runner registers on
  // controller mount, before the user can open 設定 (FR-109 起動点). A silent no-op when
  // no runner is registered (no U15 IPC bridge — honest degrade, never a crash).
  const handleRequestBasemapReplace = useCallback((): void => {
    void basemapReplaceRef.current?.();
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

  // fr96 (段階7 優先規則) — the LIVE suspended gate the right-click port reads. The
  // truth is the SAME `shortcutsSuspended` OR-chain (modal || *Drawing, derived below
  // near the modal/tool state) the global shortcut dispatcher stands down on (教訓
  // 5.13 / 5.29 単一真実源); it is mirrored into this ref on every render so the
  // imperatively-created port (built once in onMapMount) reads the CURRENT value per
  // right-click without re-mounting the map (the cameraInputRef late-binding pattern).
  // While suspended the port drops the request whole — no menu opens AND the live
  // selection is untouched (a knife/merge/survey draft's own Esc keeps ownership).
  const shortcutsSuspendedRef = useRef(false);

  // HB5-3 錨起点の視点合わせ — the「錨一覧」/ timeline-origin selection snaps the camera
  // onto the selected feature's world extent. Built in onMapMount (where `ports` — the
  // SINGLE camera write path — is in scope) and held behind a ref so the sidebar's
  // event-row click reaches the LIVE fit without re-mounting the map (the SAME
  // late-binding pattern cameraInputRef / contextMenuOpenerRef use). A no-op until the
  // map mounts. ONLY the anchor-origin導線 calls this (map-click selection goes through
  // the live-selection-port and never here), so a map click never moves the view.
  const fitCameraToFeatureRef = useRef<((featureId: FeatureId) => void) | null>(null);

  // 全体表示 (COMMAND_ID.ViewFitAll) — the SAME late-binding pattern as the anchor fit
  // above: bound inside `onMapMount` where `ports` (the single camera write path) is in
  // scope, so the 表示メニュー / Ctrl+Home 導線 (D58 — NOT Ctrl+0, which Electron's default
  // application menu owns as `resetZoom` and never delivers to the renderer) reaches the
  // LIVE camera without re-mounting the map. A no-op until the map mounts.
  const fitCameraToAllRef = useRef<(() => void) | null>(null);

  // 拡大 / 縮小 (COMMAND_ID.ViewZoomIn / ViewZoomOut, Ctrl+= / Ctrl+-) — the SAME
  // late-binding pattern: bound inside `onMapMount` where `ports` (the single camera
  // write path) is in scope. menu.ts declared these chords from the start but NO handler
  // was ever registered (教訓 5.7), and Electron's default application menu owned the
  // same chords as **page** zoom — which changes the CSS px scale and breaks the FR-16
  // 座標対応. With the default menu removed (shell/main/app-menu.ts) the chords reach the
  // renderer and land on the MAP zoom, through the same U17 step math the wheel uses.
  const zoomMapRef = useRef<((direction: ZoomDirection) => void) | null>(null);

  // The cursor's live world position behind the status-bar readout (FR-111). Held OUTSIDE
  // React (technical policy 2.3): the map pointermove path pushes into it at input rate
  // and only the small `CursorCoordinateStatus` node subscribes, so a mouse move never
  // re-renders the shell.
  //
  // A REF, not a useMemo (review fix): React may DISCARD a useMemo cache, and a re-created
  // store would silently split the wiring — the subscriber (`CursorCoordinateStatus`) would
  // read the NEW store while `onMapMount`'s already-installed pointermove kept pushing into
  // the OLD one, killing the readout permanently. A ref is the documented home for a
  // mutable instance that must survive every render (MapSizeStore uses the same discipline).
  const cursorPositionStoreRef = useRef<CursorPositionStore | null>(null);
  cursorPositionStoreRef.current ??= new CursorPositionStore();
  const cursorPositionStore = cursorPositionStoreRef.current;

  // The latest U12 commit handler, held behind a ref so the imperatively-created
  // edit-session port (built in `onMapMount`, which runs once per map mount) always
  // calls the CURRENT `recordCommit` without re-mounting the map on every render
  // (技術方針 2.3: the live input path stays off React re-render). Assigned by an
  // effect below once `recordCommit` exists; read by the edit-session `onReleased`.
  const recordCommitRef = useRef<
    | ((
        result: ProcessResult<DomainRoot>,
        preference: NextTargetPreference | undefined,
        anchorTime: TimePoint,
      ) => void)
    | null
  >(null);

  // The shared vertex-id minter, held behind a ref so the imperatively-created
  // edit-session port (built in `onMapMount`) can RESERVE a new vertex id for an
  // FR-87 edge-add without re-mounting the map when the minter memo changes. Assigned
  // from the SAME `sharedMint` add / knife use (below), so an edge-add-minted id can
  // collide with neither stored data nor another tool's output (教訓 5.37 重複チェック).
  const nextVertexIdRef = useRef<(() => VertexId) | null>(null);

  // The latest zoom CLAMP range (FR-10). The file-ops controller pushes it on
  // every settings change; we cache it so a range set BEFORE the map mounts is
  // applied as soon as the renderer exists (no lost update, 教訓 5.22).
  const zoomRangeRef = useRef<ZoomRange | null>(null);

  // S7 出界図 結線 — the LOADED project's base-map image bytes, retained here for
  // DISPLAY. The file-ops controller owns them for save round-trip (loadedAssetsRef);
  // it pushes the SAME reference here on every load / new via onBaseMapImageChange
  // (the supplyZoomRange pattern), so the renderer host's `baseMap` getter reads them
  // together with the store domain's baseMap.source/meta to decide preset vs user map
  // (単一真実源 — one bytes reference, no divergent copy). Empty until a project with a
  // base-map image is loaded; empty ⇒ the host shows the bundled preset (FR-03).
  const baseMapImageRef = useRef<Uint8Array>(new Uint8Array());

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

    // The map CELL (.map-area) — the ANCESTOR of the canvas mount, the input layer AND the
    // overlay layer. The FR-111 cursor readout hooks HERE, not on the input layer (review
    // fix): a tool input bridge (追加 / 切断 / 併合 / 再所属 / 測量) is a SIBLING of the input
    // layer that sits ABOVE it, so a move over a bridge never reaches the input layer and
    // entering a bridge fires the input layer's own `pointerleave` — the readout went blank
    // in exactly the modes that need coordinates most (測量 = FR-16, 作図). A move over ANY
    // of those layers bubbles to the cell, and the cell's `pointerleave` fires only when the
    // pointer really leaves the map cell, so 「地図の上か否か」is judged once against the map
    // region itself. A new tool overlay is covered automatically (no per-tool 結線 to forget,
    // 教訓 5.7 部分結線禁止).
    const mapCell: HTMLElement = el.parentElement ?? hookTarget;

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
      /** FR-82 点線アウトライン (頂点選択コンテキスト地物) drawn this frame. */
      dashedLine: number;
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
      dashedLine: 0,
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
         * FR-42 / FR-43: the number of DISTINCT features currently drawn, resolved
         * through the SAME U34 display pipeline the map draws (buildCommittedFeatures
         * with the live displayControl). A global-depth change rolls features up into
         * their aggregate (fewer) or expands them into children (more), so a behavioural
         * E2E asserts this count changes when the 階層深度 slider moves — the observable
         * proof the depth UI is wired to the display resolution. Distinct feature ids
         * (not primitive count) so a multipolygon aggregate counts as ONE feature.
         */
        getDrawnFeatureCount: (): number => {
          const s = store.getState();
          const drawn = buildCommittedFeatures(
            s.domain,
            s.currentTime,
            s.activeFeature,
            s.displayControl,
            // FR-113: the count reflects the display filter too (面オフ → fewer drawn),
            // so the display-filter E2E asserts the count changes on a kind/depth toggle.
            s.filter,
          );
          return new Set(drawn.map((f) => f.id)).size;
        },
        /**
         * FR-113 Phase 2: the color each drawn feature is ACTUALLY PAINTED with, keyed by
         * feature id — resolved through the SAME buildCommittedFeatures the map draws (live
         * filter included) and the renderer's OWN `activeColor` rule (`style.selectedColor`
         * when the feature is highlighted, else the fill). The FR-113 opacity is BAKED into
         * the string (`#rrggbb` when fully opaque, `rgba(…)` once dimmed), so a behavioural
         * E2E can prove「強調した地物以外が淡くなる」from the REAL draw batch rather than from
         * the store — AND can see a regression that repaints an emphasized feature in the
         * selection colour (a `style.fill` mirror never could). Read-only observation; the
         * mapping itself is the Vitest-pinned pure `drawnFeatureFills`.
         */
        getDrawnFeatureFills: (): Record<string, string> => {
          const s = store.getState();
          return drawnFeatureFills(
            buildCommittedFeatures(
              s.domain,
              s.currentTime,
              s.activeFeature,
              s.displayControl,
              s.filter,
            ),
          );
        },
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
        };
      },
      // FR-13 グリッド ON/OFF 即時反映: derive the LIVE graticule visibility from the
      // project setting so the topBar toggle / SettingsDialog checkbox reflect on the
      // next redraw. Read live per composite — never a stale capture (教訓 5.6 / 5.35).
      // The redraw-on-settings subscription below tracks gridVisible so a toggle fires
      // a redraw at once (buildGridPrimitives(false,…) → 明示的空, 教訓 5.18).
      gridVisible: (): boolean => store.getState().projectSettings.gridVisible,
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
          s.activeTool === TOOL_ID.EditReparent ||
          s.activeTool === TOOL_ID.EditRing ||
          s.activeTool === TOOL_ID.EditDrill
        ) {
          return [];
        }
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
          liveEditSession,
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
      ports.writeCamera(
        keyboardZoomCamera(camera, viewport, direction, ports.effectiveZoomRange()),
      );
    };

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
    const selectionPort = createLiveSelectionPort(
      {
        getSelection: () => store.getState().selection,
        restoreSelection: (sel) => store.getState().restoreSelection(sel),
      },
      surfaceToWorld,
      rectangleResolver,
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
        // fr100: the recolor anchor time is the PROPOSAL's own anchorTime (the time
        // the drag confirm resolved at press/release) — the exact commit time.
        recordCommitRef.current?.(outcome.result, preference, outcome.proposal.anchorTime);
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
      // fr96 段階7 優先規則: while a modal / tool draft owns the input, the right-click
      // request is dropped WHOLE (neither promote nor open — live-context-menu-port).
      // Read live through the ref so the port built once at mount always sees the
      // current OR-chain value (教訓 5.6, never a stale capture).
      suspended: () => shortcutsSuspendedRef.current,
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

    // FR-111 ステータスバーのカーソル座標 — the throttled bridge from the map pointer
    // path to the React-external cursor store. TRAILING throttle (the SAME
    // `throttleTrailing` the map-resize path uses — no new throttle implementation):
    // at most one publish per interval AND the last position of a burst always lands,
    // so the readout is live but a 60Hz move cannot cause 60 React renders/s
    // (再レンダー爆発の抑止; the store additionally drops no-change sets).
    // `cursorReadoutDisposed` closes the ONE hole a trailing throttle opens: its final
    // timer can fire AFTER this map unmounts, and `ports.screenToWorld` would then read
    // a disposed renderer/canvas (教訓 5.2 全経路で破棄). The flag makes that late call a
    // no-op; the cleanup below also clears the readout so no stale coordinate lingers.
    //
    // The OTHER hole a trailing throttle opens is shorter-lived but hit constantly (review
    // fix): the pointer can LEAVE the map inside the interval, and the pending trailing
    // call would then land AFTER `clear()` and resurrect the last coordinate for a cursor
    // that is no longer over the map (a real mouse exceeds 100Hz, so「素早く地図外へ抜ける」
    // always raced it). `publishCursorPosition.cancel()` on every leave / teardown drops
    // that pending call, so 地図外 = 非表示 holds unconditionally rather than by luck.
    let cursorReadoutDisposed = false;
    const publishCursorPosition = throttleTrailing(
      (clientX: number, clientY: number): void => {
        if (cursorReadoutDisposed) return;
        cursorPositionStore.set(ports.screenToWorld(clientX, clientY));
      },
      CURSOR_READOUT_INTERVAL_MS,
      BROWSER_CLOCK,
    );

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
    // FR-111 ステータスバーのカーソル座標 — on the map CELL (see `mapCell` above) so it sees
    // moves over the input layer AND over any tool bridge. Pushes into the React-EXTERNAL
    // cursor store, THROTTLED, so a 60Hz move cannot drive 60 React renders/s (only the
    // tiny readout node subscribes; the throttle caps the actual work regardless of how
    // many layers the event bubbles through). The unproject reuses the renderer's
    // box-corrected screen→world (the SAME transform the hit-test uses, 教訓 5.29) so
    //「表示された座標」==「掴める座標」.
    const onCursorMove = (e: PointerEvent): void => {
      publishCursorPosition(e.clientX, e.clientY);
    };
    const onCursorLeave = (): void => {
      // 地図外では非表示 (the readout falls back to the default status label). Drop any
      // PENDING trailing publish FIRST — otherwise it lands after this clear and puts the
      // stale coordinate back (see the throttle note above).
      publishCursorPosition.cancel();
      cursorPositionStore.clear();
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
    const onPointerLeave = (): void => {
      dispatcher.pointerLeave();
    };
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
    // The cursor readout listens on the map CELL (above the input layer AND the tool
    // overlays in the DOM tree), so it survives a tool bridge taking over the surface.
    mapCell.addEventListener('pointermove', onCursorMove);
    mapCell.addEventListener('pointerleave', onCursorLeave);

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
      // survey F1 — 測量中の左ドラッグをパンへ委譲する強制パン入口. The survey bridge
      // discriminates its LEFT button by a movement threshold (a genuine click
      // measures; a drag must pan); once the threshold is crossed it delegates the
      // in-flight gesture HERE. We start the SAME dispatcher pan a middle-button
      // press would: the normalized sample is re-tagged MIDDLE so decideDispatch's
      // single PAN_BUTTONS table routes it to Pan in EVERY mode (単一真実源 — no
      // second pan implementation in the bridge, 教訓 5.29), anchored at the
      // ORIGINAL press position (the hysteresis pixels catch up on the next move).
      // The bridge element is the capture target, and the dispatcher OWNS the
      // release on every teardown path (the same capture discipline as pointerDown
      // above); subsequent moves/ups flow through the ordinary forwarding.
      beginPan: (e, pressClientX, pressClientY): void => {
        flushRedraw();
        const { x, y } = toSurface(pressClientX, pressClientY);
        const n = PointerDispatcher.normalize(e, x, y);
        dispatcher.pointerDown(
          { ...n, button: POINTER_BUTTON.Middle },
          (e.currentTarget as Element | null) ?? undefined,
        );
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
    const unsubscribe = store.subscribe((s) => {
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
      mapCell.removeEventListener('pointermove', onCursorMove);
      mapCell.removeEventListener('pointerleave', onCursorLeave);
      // Stop the cursor readout BEFORE disposing the host: a trailing throttle call
      // must not reach the disposed renderer, and the status bar must not keep showing
      // the last coordinate of a map that no longer exists. Cancel the pending call AND
      // keep the flag: cancel drops the timer we know about, the flag is the belt-and-
      // braces guard for any call already in flight (教訓 5.2 全経路で破棄).
      publishCursorPosition.cancel();
      cursorReadoutDisposed = true;
      cursorPositionStore.clear();
      ports.dispose();
      rendererRef.current = null;
      cameraInputRef.current = null;
      // 教訓 5.2 全経路で破棄 — the camera-driving runners close over the now-disposed
      // `ports`. Left non-null they keep their commands' `canRun` true, so 表示 → 拡大 /
      // 縮小 / 全体表示 would render ENABLED and call readCamera/writeCamera on a
      // disposed host. Nulling them makes those commands honestly disabled until a
      // remount re-binds them (setup runs AFTER this cleanup, so a remount re-assigns).
      zoomMapRef.current = null;
      fitCameraToAllRef.current = null;
      fitCameraToFeatureRef.current = null;
      // HB3-9: drop the render-observation hook so a remount re-installs a fresh one
      // bound to the new renderer (no stale closure over the disposed host).
      if (e2eWindow !== null && '__E2E__' in e2eWindow) {
        delete (e2eWindow as { __E2E__?: unknown }).__E2E__;
      }
    };
    // `cursorPositionStore` is listed for honesty even though it is ref-backed and
    // therefore never changes identity: had it stayed a useMemo, a discarded cache would
    // have re-created it WITHOUT re-mounting the map, leaving these listeners pushing into
    // the abandoned store while the readout subscribed to the new one.
  }, [store, cursorPositionStore]);

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

  // S7 出界図 結線 — receive the loaded project's base-map image bytes from the file-ops
  // controller (on load: the file's bytes; on 新規: empty) and retain them for DISPLAY,
  // then request a redraw so the renderer host re-resolves preset-vs-user at once (the
  // SAME supplyZoomRange cache-then-forward pattern). The store domain swap that also
  // happens on load / new triggers its own redraw, but requesting one here makes the
  // bytes change an explicit 完了トリガー (教訓 5.7) so display follows even if the bytes
  // arrive without a domain reference change (e.g. a future 差し替え flow). A no-op on the
  // renderer when the map has not mounted yet (pre-mount / bootstrap).
  const handleBaseMapImageChange = useCallback((image: Uint8Array) => {
    baseMapImageRef.current = image;
    rendererRef.current?.redraw();
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
  // U25: the ring-edit provisional overlay sink. Shares the SAME single tool-overlay
  // slot (drawKnife) — ring-edit / knife / merge / reparent are mutually exclusive
  // tools, so only one ever feeds it at a time; an idle draft pushes `[]` so the
  // overlay clears on every reset path (教訓 5.2 / 5.18).
  const ringEditDrawSink: RingEditDrawSink = useMemo(
    () => ({
      drawRingEdit(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );
  // U27: the drill (穴あけ) provisional region overlay sink. Shares the SAME single
  // tool-overlay slot (drawKnife) — drill / ring-edit / knife / merge / reparent are
  // mutually exclusive tools, so only one ever feeds it at a time; an empty region
  // pushes `[]` so the overlay clears on every reset path (教訓 5.2 / 5.18).
  const drillDrawSink: DrillDrawSink = useMemo(
    () => ({
      drawDrill(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawKnife(primitives);
      },
    }),
    [],
  );
  // U37: the PERSISTENT survey layer sink (FR-14 / FR-15). Deliberately NOT the
  // shared single tool-overlay slot (drawKnife): the confirmed survey lines must
  // survive other tools' overlay pushes / `[]` resets and stay visible after
  // survey mode is exited (FR-15) — the renderer keeps them in a dedicated slot
  // (host-ports drawSurvey) composited under the edit handles / tool overlay.
  const surveyDrawSink: SurveyDrawSink = useMemo(
    () => ({
      drawSurvey(primitives: readonly DrawPrimitive[]): void {
        rendererRef.current?.drawSurvey(primitives);
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
      beginPan: (e, pressClientX, pressClientY) =>
        cameraInputRef.current?.beginPan?.(e, pressClientX, pressClientY),
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
  // Point the edit-session's edge-add vertex minter at the shared minter (FR-87). The
  // ref indirection lets the map's imperatively-created edit-session port reserve ids
  // through the SAME series add / knife use without re-mounting on a minter change.
  nextVertexIdRef.current = () => asVertexId(sharedMint('v'));

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
  // FR-74: the undo-stack depth limit is a configurable app setting (undoStackSize),
  // so the live history is created at the CONFIGURED limit (not the hard-coded
  // DEFAULT_HISTORY_LIMIT) and re-bounded whenever the setting changes (subscription
  // below). withLimit is wired here — the SAME single seam createHistory uses — so the
  // FR-74 上限変更可 contract is actually reachable from the UI (was: withLimit had no
  // caller, 教訓 5.7「ロジックがあっても UI から呼ばれない」).
  const historyRef = useRef<History<DomainRoot>>(
    createHistory(store.getState().domain, store.getState().appSettings.undoStackSize),
  );

  // The last domain WE committed (or reset to). The store subscription uses it to
  // tell an external whole-state swap (file load / new) from our own edit commit:
  // when store.domain changes to something we did not just write, reset the history
  // to that new baseline (its old stack cannot apply to the new project).
  const lastCommittedDomainRef = useRef<DomainRoot>(store.getState().domain);

  // F2: the last base-map-replace nonce we have processed. The load/new re-root
  // subscription below compares the LIVE store nonce against this to tell a base-map
  // REPLACE (FR-04, preserve the edit undo/redo stacks) from an external whole-state
  // swap (file load / new, re-root the history). Bumped only by store.replaceBaseMap.
  const lastBasemapReplaceNonceRef = useRef<number>(store.getState().basemapReplaceNonce);

  // 第6波 redo-drops-selection-preference: the selection preference a commit
  // promotes (次対象昇格 — the created / merged / reparented feature) is a UI-layer
  // value the pure Command does NOT carry, so a plain redo (which replays the
  // Command through applyUndoRedoResult) could not recover it and left the promoted
  // feature un-selected after add→undo→redo. We remember the preference per Command
  // at record time and look it back up for the exact Command a redo re-applies. undo
  // stays unchanged (deleted features drop via reresolve Step1; nothing to promote).
  const redoPreferenceRef = useRef(createRedoPreferenceRegistry<DomainRoot>());

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
  //
  // fr100 — the ONE auto-recolor funnel (FR-100 / FR-101): EVERY commit path in the
  // app funnels through THIS callback, so wrapping here guarantees structure +
  // auto-recolor land as ONE undo unit on every path (add / knife / merge / reparent
  // / ring-edit / drill / edit-drag / property・スタイル edit — incl. autoColorEnabled
  // トグル・パレット変更 — / 詳細文書 / vertex-delete / 全錨 delete / interval /
  // unshare / conflict-modal commit), never a second漏斗 (教訓 5.13 / 5.29).
  // `anchorTime` is REQUIRED and is the COMMAND's own commit/anchor time — NOT
  // store.currentTime — because property-edit (editTime = selected anchor start) and
  // interval edits commit at a time that can differ from the view time; each caller
  // states its own (全コミット経路 threaded below). maybeComposeAutoRecolor SHORT-
  // CIRCUITS to the unwrapped command when no auto-color target is effective at that
  // time (the 722-feature all-manual実データ: nothing changes, no adjacency graph is
  // ever built — the per-commit perf gate).
  const recordCommand = useCallback(
    (
      command: Command<DomainRoot>,
      preference: NextTargetPreference | undefined,
      anchorTime: TimePoint,
    ): void => {
      const wrapped = maybeComposeAutoRecolor(command, historyRef.current.state, anchorTime);
      const step = historyExecute(historyRef.current, wrapped);
      historyRef.current = step.history;
      lastCommittedDomainRef.current = step.history.state;
      // Remember this commit's next-target preference so a later redo of the SAME
      // command re-promotes it (第6波 redo-drops-selection-preference). Keyed to the
      // WRAPPED command — that is the exact object the history stack replays on redo.
      redoPreferenceRef.current.remember(wrapped, preference);
      store.getState().applyCommandResult(step.history.state, step.result, preference);
      refreshUndoRedoEnabled();
    },
    [store, refreshUndoRedoEnabled],
  );

  const recordCommit = useCallback(
    (
      result: ProcessResult<DomainRoot>,
      preference: NextTargetPreference | undefined,
      anchorTime: TimePoint,
    ): void => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      recordCommand(result.command, preference, anchorTime);
    },
    [recordCommand],
  );

  // FR-109 follow-up (ユーザー裁定): commit a default-palette change (defaultPaletteTheme
  // / customPalette) as ONE UNDOABLE command through the SAME recordCommand funnel every
  // other edit uses — so maybeComposeAutoRecolor detects the PaletteTransition and the
  // auto-recolor rides in the SAME undo unit (Ctrl+Z reverts palette + colours together).
  // The command writes the two fields INTO root.uiSettings.project (the recolor engine's
  // palette source); when the root has no uiSettings (a pre-`ui` project) it materialises
  // one from the LIVE store settings (toPersistedUiSettings) so every other uiSettings
  // field agrees. The no-op guard (createPaletteChangeCommand → null) drops a phantom
  // entry when the palette is unchanged. The anchor time is the current view time — the
  // instant the recolor's adjacency is evaluated at. The settings dialog's confirm routes
  // ONLY the palette pair here (its other changed keys stay the non-undoable store path).
  const commitPaletteChange = useCallback(
    (palette: PaletteSelection): void => {
      const command = createPaletteChangeCommand(store.getState().domain, palette, () =>
        toPersistedUiSettings({
          projectSettings: store.getState().projectSettings,
          appSettings: store.getState().appSettings,
        }),
      );
      if (command === null) return; // unchanged palette — no undo entry (教訓 5.24)
      recordCommand(command, undefined, store.getState().currentTime);
    },
    [store, recordCommand],
  );

  // Keep the edit-session's commit-handler ref pointed at the current recordCommit.
  recordCommitRef.current = recordCommit;

  // Register the U12 undo / redo commands on the SAME registry the menu + shortcuts
  // dispatch (single truth source, 教訓 5.13). Each applies the history step back
  // through the store and bumps the gate. `canRun` gates on stack availability so
  // an empty stack disables the menu item AND the shortcut together (FR-74).
  useEffect(() => {
    // F2 TRUE FIX (Codex re-review): apply an undo/redo history step to the store,
    // GRAFTING the LIVE base map onto the captured route so a base-map REPLACE (FR-04)
    // is genuinely NON-undoable. The undo/redo commands are whole-state swaps that
    // ignore their live input and return a route CAPTURED at commit time — carrying the
    // base map that was current THEN (consistency-binding makeCommand). Without this
    // graft, `edit → replace(B1) → undo` restored the captured B0 base map, so B1 was
    // lost while the retained display (baseMapImageRef) / save (loadedAssetsRef) BYTES —
    // which live OUTSIDE the domain snapshot and are NOT touched by undo/redo — stayed
    // on B1 (an inconsistent B0-source-over-B1-bytes state). Grafting the live
    // domain.baseMap keeps the CURRENT map across every feature-edit undo/redo, so all
    // three references agree. A genuine NO-OP when no replace intervened
    // (graftLiveBaseMap returns the captured state by identity), so ordinary undo/redo is
    // byte-for-byte the pre-fix path — historyRef.current keeps the same history object,
    // lastCommittedDomainRef the same reference, and no extra allocation/redraw happens.
    // Runs on the SAME transition family that applyUndoRedoResult commits, and because
    // lastCommittedDomainRef.current is set to the grafted domain BEFORE applyUndoRedoResult
    // commits it, the reconcile subscription sees `s.domain === lastCommittedDomainRef`
    // and does not mistake our own grafted undo/redo for an external swap.
    const applyHistoryStep = (
      step: HistoryStep<DomainRoot>,
      preference: NextTargetPreference | undefined,
    ): void => {
      const grafted = graftLiveBaseMap(step.history.state, store.getState().domain);
      // Keep historyRef.current.state in lock-step with the grafted domain so the
      // history root === the store domain (a later edit's auto-recolor baseline and the
      // next external-swap reconcile both read historyRef.current.state). Identity-stable
      // when the graft was a no-op (same history object reused).
      historyRef.current =
        grafted === step.history.state ? step.history : { ...step.history, state: grafted };
      lastCommittedDomainRef.current = grafted;
      store.getState().applyUndoRedoResult(grafted, step.result, preference);
      refreshUndoRedoEnabled();
    };
    const runUndo = (): void => {
      const step = historyUndo(historyRef.current);
      if (step.history === historyRef.current) return; // empty stack: no-op
      // bughunt (全 undo 後の dirty 解消): an undo recomputes projectDirty against the
      // last SAVED baseline (applyUndoRedoResult) instead of forcing it true, so undoing
      // back to the saved state clears the unsaved-changes warning. An ordinary edit
      // still dirties through applyCommandResult (recordCommand) — that path is unchanged.
      applyHistoryStep(step, undefined);
    };
    const runRedo = (): void => {
      // Recover the preference the commit promoted for the command redo re-applies
      // (the top of the CURRENT redo stack) BEFORE the transition pops it, so the
      // promoted selection is restored on redo (第6波 redo-drops-selection-preference).
      const preference = redoPreferenceRef.current.preferenceForNextRedo(
        historyRef.current,
      );
      const step = historyRedo(historyRef.current);
      if (step.history === historyRef.current) return;
      // Symmetric to runUndo: a redo recomputes dirty against the saved baseline (redoing
      // away from the saved state re-dirties; redoing back onto it stays clean).
      applyHistoryStep(step, preference);
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

  // 全体表示 (COMMAND_ID.ViewFitAll) — register the 表示メニュー / Ctrl+Home handler (the
  // chord lives in menu.ts; D58 records why it is NOT Ctrl+0) on the
  // SAME registry the menu + the global shortcut dispatcher read (教訓 5.13 単一の権限/
  // 真実源), so the menu row and the accelerator are one behaviour and enable/disable
  // together. The work itself is the late-bound `fitCameraToAllRef` (assigned in
  // onMapMount, where the single camera write path is in scope). `canRun` gates on the
  // map actually being mounted, so before mount the menu row is greyed rather than a
  // silent no-op (未登録==無効 と同じ体験, commands.ts の規約).
  useEffect(() => {
    registry.register(COMMAND_ID.ViewFitAll, {
      run: () => fitCameraToAllRef.current?.(),
      canRun: () => fitCameraToAllRef.current !== null,
    });
    return () => {
      registry.unregister(COMMAND_ID.ViewFitAll);
    };
  }, [registry]);

  // 拡大 / 縮小 (COMMAND_ID.ViewZoomIn / ViewZoomOut) — register the 表示メニュー rows +
  // the Ctrl+= / Ctrl+- accelerators on the SAME registry, so the menu row and the chord
  // are ONE behaviour (教訓 5.13). These chords were declared in menu.ts but never
  // registered, so both導線 were silent no-ops (and the OS menu stole them as page zoom).
  useEffect(() => {
    const canRun = (): boolean => zoomMapRef.current !== null;
    registry.register(COMMAND_ID.ViewZoomIn, { run: () => zoomMapRef.current?.('in'), canRun });
    registry.register(COMMAND_ID.ViewZoomOut, { run: () => zoomMapRef.current?.('out'), canRun });
    return () => {
      registry.unregister(COMMAND_ID.ViewZoomIn);
      registry.unregister(COMMAND_ID.ViewZoomOut);
    };
  }, [registry]);

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
  // NOTE: the FR-88 vertex-delete branch below overrides this whenever a vertex is
  // selected; this paragraph describes only the no-vertex feature-delete branch.
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
  // FR-88 頂点削除 — the body-scope U13 binding the vertex-delete branch confirms
  // through. It mirrors {@link propertyEditBinding} (a geometry-changing delete CAN
  // conflict, so it must NOT reuse propertyEditDispatch which throws on
  // ConflictsPending). bindPortsToProposal (applied inside startProcess) OVERRIDES the
  // base detectSpatial with the REAL detectSpatialAt(proposal), so the FR-88 完了時
  // 整合性維持プロセス (時間整合 + 制約 + 空間競合検出) genuinely fires on the delete.
  const vertexDeleteBinding = useMemo(
    () => createLiveEditBinding({ getRoot: () => store.getState().domain }),
    [store],
  );

  // FR-87 / FR-88 頂点削除 — the run branches on the LIVE selection (single funnel,
  // 教訓 5.13): the Delete key + 編集メニュー + FR-96 右クリック「削除」 all dispatch this
  // ONE command id.
  //   • vertex selection non-empty (vertexIds + vertexOwner) → delete those vertices.
  //     A right-click Vertex hit sets exactly this selection (promoteHit), so the
  //     FR-96「削除」targets the right-clicked vertex with NO extra menu item.
  //     buildVertexDeletePlan folds a multi-vertex selection into ONE undo unit and
  //     decides the delete-feature threshold via the domain's SINGLE deleteVertex.
  //       - survive → confirm the FeatureSnapshot through the SAME U13 pipeline
  //         add/knife/move/ring-edit use, record ONE undo unit, and re-resolve
  //         selection to the surviving vertices (makeCommand reports deletion only at
  //         feature-history level, so the deleted vertex id would otherwise linger —
  //         we pass the surviving vertex set as the preference AND explicitly reconcile
  //         when none survive, reresolve.ts:99-110).
  //       - delete-feature (閾値割れ) → a TIME-SLICE deletion via the SAME
  //         deletedFeatureId snapshot path ring-edit's last-territory delete uses; the
  //         feature drops only at the anchor time, NOT all-anchor (belowThreshold: the
  //         all-anchor delegation would over-delete across the timeline).
  //     A ConflictsPending is surfaced through the SAME conflict modal add/knife use
  //     (honest failure, HB-3 — never a silent no-op); a Rejected keeps the selection.
  //   • otherwise (no vertex selection, only an activeFeature) → the UNCHANGED U31
  //     全錨 delete (FR-79 / FR-85) recorded as ONE undo unit; an absent target builds
  //     no command (no幽霊 entry, 教訓 5.24).
  // The ONE delete funnel, delegating the branch to the single testable seam
  // {@link runEditDelete} (単一真実源 5.29 / 5.34). All host effects are injected so
  // the App holds no duplicated delete logic. Extracted as a callback (fr96) so the
  // registry handler below AND the right-click「頂点を削除」dispatch drive the SAME
  // funnel with an explicit selection — the FR-96 DeleteVertex intent names its own
  // {owner, vertexIds} payload rather than re-reading the live selection (教訓 5.6:
  // the menu fires exactly what it showed; no drift with a selection that moved).
  const runDeleteFunnel = useCallback(
    (selection: EditDeleteSelection): void => {
      runEditDelete<DomainRoot>(selection, {
        getRoot: () => store.getState().domain,
        getTime: () => store.getState().currentTime,
        startProcess: (proposal) => vertexDeleteBinding.startProcess(proposal),
        applyResolutionsFor: (proposal) => vertexDeleteBinding.applyResolutionsFor(proposal),
        // fr100: the vertex-delete proposal anchors at getTime() = currentTime, read
        // in the SAME synchronous run — the commit time IS the current time here.
        recordCommit: (result, preference) =>
          recordCommit(result, preference, store.getState().currentTime),
        openConflict: (result, apply, preference, clearVertexOwner) => {
          if (result.status !== PROCESS_STATUS.ConflictsPending) return;
          setConflictState({
            pending: result,
            applyResolutions: apply,
            // fr100: stash the paused proposal's anchor time (= currentTime at this
            // synchronous pause) so the eventual modal commit recolors at the SAME
            // time the proposal anchored at, not whatever the clock shows later.
            anchorTime: store.getState().currentTime,
            ...(preference !== undefined ? { preference } : {}),
            // Survive vertex-delete only: stash the owner to clear on commit (HOLE-1).
            ...(clearVertexOwner !== undefined ? { clearVertexOwner } : {}),
          });
        },
        clearVertexSelection: (featureId) =>
          store.getState().replaceVertexSelection(featureId, []),
        deleteFeatureAllAnchors: (featureId) => {
          const command = createDeleteFeatureCommandForRoot(store.getState().domain, featureId);
          if (command === null) return; // absent everywhere: no幽霊 entry (教訓 5.24)
          // fr100: the 全錨 delete has no single anchor time (it sweeps every anchor);
          // the recolor evaluates at the CURRENT view time — the instant whose map the
          // user watches the neighbours recolor on (documented best-effort choice).
          recordCommand(command, undefined, store.getState().currentTime);
        },
      });
    },
    [store, recordCommand, recordCommit, vertexDeleteBinding],
  );

  useEffect(() => {
    const deleteSelected = (): void => {
      // The live selection is the target (Delete キー / 編集メニュー path).
      runDeleteFunnel(store.getState().selection);
    };
    registry.register(COMMAND_ID.EditDelete, {
      run: deleteSelected,
      // FR-85 と整合: a vertex selection OR an active feature makes 削除 valid.
      canRun: () => {
        const sel = store.getState().selection;
        return (sel.vertexIds.size > 0 && sel.vertexOwner !== null) || sel.activeFeature !== null;
      },
    });
    return () => {
      registry.unregister(COMMAND_ID.EditDelete);
    };
  }, [registry, store, runDeleteFunnel]);

  // --- fr96 右クリックメニューの本結線 (FR-96 / FR-33) -------------------------
  //
  // The U36 composition (composeMenuFor) + dispatch (dispatchMenuItem) were live and
  // unit-tested, and the MapContextMenu mount already carried the DYNAMIC render path
  // (composeFor/onSelectItem additive props) — but the App never supplied them, so a
  // right-click still opened the LEGACY 2-item static menu (教訓 5.7 ロジックはあるが
  // UI から呼ばれない). This block supplies the live lookups + the intent router so
  // the dynamic menu composes from the SAME truth the renderer / hit-test resolve
  // (resolveDisplayFor owners / sharedVertexIdsFor / featureByIdAt, 教訓 5.29) and
  // every offered item fires the SAME flow the UI-button path runs (教訓 5.6).

  // FR-33 unshare — the id-generation state the unshare launcher threads through its
  // sequential mints. Session-local and monotonic; advanced via onIdStateAdvanced so
  // a second unshare can never re-mint an id of the first (教訓 5.37). The tick is a
  // monotonic integer source (never wall-clock alone — 教訓 5.37).
  const unshareIdStateRef = useRef<IdGeneratorState>(createIdGeneratorState());
  const unshareTickRef = useRef(0);
  // 教訓 5.37 (5.37 重複チェック): EVERY project raw id — features / vertices / rings
  // across ALL anchors — so an unshare-minted vertex id can collide with nothing that
  // exists at ANY time. Derived by the SAME collectProjectRawIds the shared minter
  // scans, memoized per root IDENTITY (the root is immutable; a commit swaps it).
  const reservedRawIdsRef = useRef<{ root: DomainRoot | null; ids: ReadonlySet<string> }>({
    root: null,
    ids: new Set<string>(),
  });
  const getReservedRawIds = useCallback((): ReadonlySet<string> => {
    const root = store.getState().domain;
    if (reservedRawIdsRef.current.root !== root) {
      reservedRawIdsRef.current = { root, ids: collectProjectRawIds(root) };
    }
    return reservedRawIdsRef.current.ids;
  }, [store]);

  // FR-33 共有解除 — run the live unshare launcher (live-unshare.ts). The ports are
  // the App's existing seams: store 直読 getRoot/getTime, the SAME pure applyProposal
  // the edit binding applies a FeatureSnapshot with (U44 applyEditProposal — reusing
  // vertexDeleteBinding's ports, a createLiveEditBinding over the live root), and the
  // whole-state-swap command recorded through the ONE history-record seam
  // (recordCommand → historyExecute → applyCommandResult, whose U22 reresolve promotes
  // the launcher-built preference — the new-id remap is already inside it).
  const runUnshareIntent = useCallback(
    (vertexIds: ReadonlySet<VertexId>, ownerFeatureId: FeatureId | null): void => {
      runUnshare(
        { vertexIds, ownerFeatureId },
        {
          getRoot: () => store.getState().domain,
          getTime: () => store.getState().currentTime,
          getIdState: () => unshareIdStateRef.current,
          now: () => (unshareTickRef.current += 1),
          // 必須 (教訓 5.37): the project-wide raw-id reservation set.
          getReservedVertexIds: getReservedRawIds,
          applyProposal: (root, proposal) => vertexDeleteBinding.ports.applyProposal(root, proposal),
          // fr100: the unshare plan is built and committed at getTime() = currentTime
          // in ONE synchronous run — that is the commit's anchor time.
          recordCommit: (command, preference) =>
            recordCommand(command, preference, store.getState().currentTime),
          onIdStateAdvanced: (next) => {
            unshareIdStateRef.current = next;
          },
        },
      );
    },
    [store, getReservedRawIds, vertexDeleteBinding, recordCommand],
  );

  // fr96 — arm an edit tool from a menu intent (分割→ナイフ / 所属変更 / 結合). The
  // SAME store transitions the toolbar buttons drive (単一真実源, 教訓 5.29): ensure
  // 編集モード (the menu also opens in 追加モード — canEdit covers Add), then arm the
  // tool WITH the current selection pinned so the just-right-clicked target stays
  // selected across the reset契約 (教訓 5.11; setActiveTool clears by default).
  const armEditTool = useCallback(
    (tool: ToolId): void => {
      const s = store.getState();
      const retained = s.selection;
      if (s.mode !== EDIT_MODE.Edit) s.setMode(EDIT_MODE.Edit);
      store.getState().setActiveTool(tool, retained);
    },
    [store],
  );

  // fr96 EditProperties — focus the sidebar プロパティ tab through the tab's OWN
  // switch path (the Sidebar owns its active-section state privately; driving its
  // rendered tab button is the additive way to activate it without a shell edit —
  // the same single path a user click takes, 教訓 5.29). The target feature was
  // already promoted via setActiveFeature, so the panel resolves it on switch.
  // Codex F3: an absent tab is surfaced LOUDLY (honest failure, 教訓 5.12) — a shell
  // testid rename must not silently degrade this導線. An explicit tab-state API is a
  // shell change and stays backlog.
  const focusPropertyTab = useCallback((): void => {
    const tab = document.getElementById(`sidebar-tab-${SIDEBAR_SECTION.Properties}`);
    if (tab instanceof HTMLElement) {
      tab.click();
      return;
    }
    console.warn(
      'fr96: プロパティタブ (sidebar-tab-properties) が見つからないため、タブ切替をスキップしました。',
    );
  }, []);

  // fr96 composeFor — assemble the U36 ComposeInput from the LIVE store snapshot at
  // right-click time (store.getState() per request — never a stale capture, 教訓 5.6)
  // and the three single-source lookups:
  //   featureKindLookup ← featureByIdAt (the same effective-at-time feature the draw
  //     / hit-test resolve);
  //   ownerLookup       ← resolveDisplayFor(...).owners (the grabbable vertex→owner
  //     map the hit-test grabs from — a cache HIT off the frame already resolved);
  //   sharedLookup      ← sharedVertexIdsFor (the RAW depth-independent shared set the
  //     FR-30 marker draws and the FR-33 unshare detaches — no drift, 教訓 5.29).
  const composeContextMenuFor = useCallback(
    (request: ContextMenuRequest): ContextMenuModel | NoMenu => {
      const s = store.getState();
      const resolution = resolveDisplayFor(s.domain, s.currentTime, s.displayControl);
      return composeMenuFor({
        selection: s.selection,
        mode: s.mode,
        activeTool: s.activeTool,
        hit: request.hit,
        position: { x: request.clientX, y: request.clientY },
        lookups: {
          featureKindLookup: {
            kindOf: (fid) => featureByIdAt(s.domain, s.currentTime, fid)?.kind ?? null,
          },
          ownerLookup: ownerLookupFromMap(resolution.owners),
          sharedLookup: sharedLookupFromSet(sharedVertexIdsFor(resolution)),
        },
        // FR-113 Phase 2: the LIVE per-feature 強調集合 decides WHICH of「この地物を強調」/
        // 「強調を解除」the menu offers — read from the SAME store slice the draw path
        // resolves emphasis from, at right-click time (never a stale capture, 教訓 5.6).
        emphasizedFeatureIds: s.filter.emphasizedIds,
        // ...and the 種別/深度軸 decides whether that item is ENABLED. The axis verdict comes
        // from the SAME FR-113 resolution the map paints (教訓 5.29 単一解決) with the
        // per-feature集合 factored out, so an axis-emphasized target gets the shown-but-
        // disabled item rather than a no-op toggle (出す=起きる, 教訓 5.6).
        axisEmphasisLookup: {
          isEmphasizedByOtherAxis: (fid) =>
            isEmphasizedByOtherAxisUnderFilter(resolution, s.filter, fid),
        },
      });
    },
    [store],
  );

  // fr96 onSelectItem — delegate to the launch seam (context-menu-launch.ts): the
  // PURE dispatch drift guard, the FLOW→TOOL_ID mapping, AND the Codex F1b
  // EditProperties live-existence guard all live THERE (Vitest-pinned); this
  // callback only injects the App's live effects as ports:
  //   Delete           → the ONE COMMAND_ID.EditDelete funnel (地物全錨削除);
  //   DeleteVertex     → the SAME runEditDelete vertex branch the live EditDelete
  //                      takes, fed the intent's own {owner, vertexIds} payload;
  //   EditProperties   → (live-existence checked) promote + focus プロパティ tab;
  //   Split / 所属変更 / 結合 → arm the matching edit tool (the flow's own session
  //                      collects its targets from there);
  //   Unshare          → the FR-33 live unshare launcher (ONE composite undo unit +
  //                      owner-selection remap onto the minted ids).
  const onSelectMenuItem = useCallback(
    (itemKind: MenuItemKind, model: ContextMenuModel): void => {
      launchMenuItem(itemKind, model, {
        getRoot: () => store.getState().domain,
        getTime: () => store.getState().currentTime,
        dispatchEditDelete: () => registry.dispatch(COMMAND_ID.EditDelete),
        deleteVertices: (ownerFeatureId, vertexIds) =>
          runDeleteFunnel({ activeFeature: null, vertexOwner: ownerFeatureId, vertexIds }),
        openProperties: (featureId) => {
          store.getState().setActiveFeature(featureId);
          focusPropertyTab();
        },
        armEditTool,
        unshare: (vertexIds, ownerFeatureId) => runUnshareIntent(vertexIds, ownerFeatureId),
        // FR-113 個別非表示: force-hide the right-clicked feature through the session
        // display filter (no domain mutation / history / dirty). Works in View mode too.
        hideFeature: (featureId) => store.getState().setFeatureHidden(featureId, true),
        // FR-113 Phase 2 強調/強調解除: session display filter only (no domain mutation /
        // history / dirty). Works in View mode too, symmetric with 個別非表示.
        setFeatureEmphasized: (featureId, emphasized) =>
          store.getState().setFeatureEmphasized(featureId, emphasized),
      });
    },
    [store, registry, runDeleteFunnel, focusPropertyTab, armEditTool, runUnshareIntent],
  );

  // HB5-4 選択解除 — Escape / 編集メニュー「選択解除」clears the active-feature + vertex
  // selection through the SINGLE U22 clear path (store.clearSelection → EMPTY_SELECTION;
  // no re-implementation, 教訓 5.29). It routes through the SAME global shortcut
  // dispatcher (useShortcuts) as the other 編集 commands, which STANDS DOWN whenever a
  // modal or a tool-draft owns the keyboard (shortcutsSuspended). So a live draft-cancel /
  // modal-close keeps Escape priority (task HB5-4): this handler is only reached when NO
  // draft / modal is active. `canRun` gates on a live selection so the menu item / Escape
  // are a no-op (and the menu item disables) when nothing is selected; permissions.ts
  // already 表示専用モードでは一括無効化 (EditDeselect ∈ EDITING_COMMANDS).
  useEffect(() => {
    registry.register(COMMAND_ID.EditDeselect, {
      run: () => store.getState().clearSelection(),
      canRun: () => {
        const sel = store.getState().selection;
        return sel.activeFeature !== null || (sel.vertexIds.size > 0 && sel.vertexOwner !== null);
      },
    });
    return () => {
      registry.unregister(COMMAND_ID.EditDeselect);
    };
  }, [registry, store]);

  // Reconcile the history on a store domain swap we did NOT author via a command. A
  // subscribe bridge (技術方針 2.5: React 外のストアを subscribe で監視) compares the live
  // domain to the last domain we committed; a mismatch we did not author is either a
  // base-map REPLACE (FR-04) or an external whole-state swap (file load / new):
  //   - a base-map replace (store basemapReplaceNonce bumped) PRESERVES the edit
  //     undo/redo stacks and only rebases the current root onto the new domain, so the
  //     replace does not destroy edit history and is itself non-undoable (F2);
  //   - an external load / new re-roots a fresh history (its old stack is meaningless
  //     against the new project — 教訓 5.22).
  // The pure branch lives in reconcileHistoryOnExternalDomainSwap (教訓 5.41).
  useEffect(() => {
    return store.subscribe((s) => {
      if (s.domain === lastCommittedDomainRef.current) return;
      lastCommittedDomainRef.current = s.domain;
      // A base-map replace bumps the nonce in the SAME transition as the domain swap.
      const isBasemapReplace = s.basemapReplaceNonce !== lastBasemapReplaceNonceRef.current;
      lastBasemapReplaceNonceRef.current = s.basemapReplaceNonce;
      // Preserve (replace) or re-root at the CONFIGURED undo-stack depth (FR-74, read
      // live so a load that hydrated a different undoStackSize re-roots at its limit).
      historyRef.current = reconcileHistoryOnExternalDomainSwap({
        current: historyRef.current,
        nextDomain: s.domain,
        undoStackSize: s.appSettings.undoStackSize,
        isBasemapReplace,
      });
      refreshUndoRedoEnabled();
      // 教訓 5.2 全経路で破棄: an EXTERNAL whole-state swap (load / new / drag-drop)
      // invalidates any paused-conflict modal — its pending result + applyResolutions
      // are bound to the OLD proposal AND the OLD root, so a 確定/取消 against the new
      // project would replay a foreign baseline (mismatched feature/vertex ids) into
      // recordCommit/reArmActiveTool. Atomically dismiss the modal on the same swap that
      // re-roots the history so no stale binding can survive the load. A base-map replace
      // changes NO features/vertices, so it must NOT dismiss an in-progress conflict modal.
      if (!isBasemapReplace) setConflictState(null);
    });
  }, [store, refreshUndoRedoEnabled]);

  // FR-74 ROOT FIX — re-bound the LIVE undo history when the configurable
  // undoStackSize app setting changes (教訓 5.7「ロジックがあっても UI から呼ばれない」:
  // withLimit was implemented + unit-tested but had NO caller, so the depth limit was
  // permanently fixed at DEFAULT_HISTORY_LIMIT=100). A settings-dialog confirm writes
  // appSettings.undoStackSize through the U16 store; this subscription applies the
  // SAME pure withLimit the history already exposes (no second trim rule, 教訓 5.29),
  // so lowering the limit immediately evicts the oldest entries past the new bound and
  // raising it restores headroom. Gated on an actual change of the watched value so an
  // unrelated store transition does not re-allocate the history. refreshUndoRedoEnabled
  // nudges the menu/shortcut gate after a trim may have emptied the undo stack.
  useEffect(() => {
    let prevUndoStackSize = store.getState().appSettings.undoStackSize;
    return store.subscribe((s) => {
      const next = s.appSettings.undoStackSize;
      if (next === prevUndoStackSize) return;
      prevUndoStackSize = next;
      historyRef.current = historyWithLimit(historyRef.current, next);
      refreshUndoRedoEnabled();
    });
  }, [store, refreshUndoRedoEnabled]);

  // FR-113 (Codex F1): the tool-target 取得 gate. merge / reparent / ring-edit / drill pick
  // an INDIVIDUAL leaf via `leafAtPoint` (raw-leaf semantics — a child inside an aggregate
  // must stay pickable at N=0, HB3-16), so they do NOT go through the knife's drawnAreaAt
  // filter. This gate layers the SAME single FR-113 verdict (isFeatureVisibleUnderFilter)
  // on the raw leaf, so a 個別非表示 / 種別オフ / 深度フィルタ leaf is NOT tool-targetable
  // while an aggregated-but-visible leaf still is (不変条件: 非表示地物はツール取得からも消える,
  // 教訓 5.29). Reads the live root / time / displayControl / filter (never a stale capture).
  const isToolTargetVisible = useCallback(
    (featureId: FeatureId): boolean => {
      const s = store.getState();
      const resolution = resolveDisplayFor(s.domain, s.currentTime, s.displayControl);
      return isFeatureVisibleUnderFilter(resolution, s.filter, featureId);
    },
    [store],
  );

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
        // W3-A: 対象取得は生リーフ (`leafAtPoint`) + FR-113 可視ゲート — merge / reparent /
        // ring-edit / drill と同じ単一の取得規約 (HB3-16). 対象面強調も同じ live-lookup
        // (`leafShapeAt`) 由来なので、取得と強調が食い違わない。
        isToolTargetVisible,
      ),
    [store, sharedMint, isToolTargetVisible],
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
        isToolTargetVisible,
      ),
    [store, sharedMint, isToolTargetVisible],
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
        isToolTargetVisible,
      ),
    [store, isToolTargetVisible],
  );

  // U25 INTEGRATION (教訓 5.7 / 5.2): the ring-edit (穴 / 飛び地) bootstrap mirrors the
  // knife / merge ones — shared id minting + live-lookup ports + the LIVE U13 binding.
  // Unlike add / knife, ring-edit rides the SAME live `createLiveEditBinding` the
  // edit-session drag confirm uses (confirmRingEdit → confirmRelease → applyEditProposal),
  // so FR-22/24 actually reach Committed without the add/knife U13 stub (risks §U13 回避).
  const ringEditBootstrap = useMemo(
    () =>
      createRingEditBootstrap(
        () => store.getState().domain,
        () => store.getState().currentTime,
        sharedMint,
        isToolTargetVisible,
      ),
    [store, sharedMint, isToolTargetVisible],
  );

  // U27 INTEGRATION (教訓 5.7 / 5.2): the drill (穴あけによる新地物生成) bootstrap mirrors
  // the knife / ring-edit ones — shared id minting + live-lookup ports + the LIVE U13
  // binding (createLiveDrillBinding, applyProposal = applyDrillProposal). Selecting
  // 編集モード→穴あけ arms a session; the first map click picks the target末端, then clicks
  // place the region vertices; 穴あけを確定 → 新地物プロパティ入力 → save runs drillRegion
  // and hands a drill EditProposal<DrillSnapshot> to U13 (原末端への穴形成 + 新地物 = ONE
  // undo unit). Was unreachable — domain/drill existed but no UI consumed it (FR-45).
  const drillBootstrap = useMemo(
    () =>
      createDrillBootstrap(
        () => store.getState().domain,
        () => store.getState().currentTime,
        sharedMint,
        isToolTargetVisible,
      ),
    [store, sharedMint, isToolTargetVisible],
  );

  // ADD COMMIT (教訓 5.11 / U12): record the committed add as one history unit and
  // promote the new feature so selection re-resolves to it.
  // fr100 note (add / knife / merge / reparent / ring-edit / drill): each controller
  // builds its proposal with `anchorTime: () => store.getState().currentTime`,
  // evaluated at CONFIRM, and its onCommitted callback runs SYNCHRONOUSLY inside that
  // same confirm call — so currentTime read here equals the proposal's anchorTime
  // (全コミット経路の確認). The property / interval / edit-drag paths, whose commit
  // time CAN differ from the view time, thread their own explicit times instead.
  const onAddCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, newFeatureId: FeatureId) => {
      recordCommit(result, { featureId: newFeatureId }, store.getState().currentTime);
    },
    [recordCommit, store],
  );

  // KNIFE COMMIT (C3 — 教訓 5.11 / U12): record as one history unit and promote the
  // inheritor (SplitSnapshot.touchedFeatureIds[0]) so selection re-resolves to it
  // rather than blanket-clearing (FR-94 / split-after selection retention).
  const onKnifeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: SplitSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const inheritorId = snapshot.touchedFeatureIds[0] ?? snapshot.inheritorFeatureId;
      recordCommit(result, { featureId: inheritorId }, store.getState().currentTime);
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
      recordCommit(result, { featureId: snapshot.resultFeatureId }, store.getState().currentTime);
    },
    [recordCommit, store],
  );

  // REPARENT COMMIT (教訓 5.11 / U12): record as one history unit and keep selection on
  // the reparented target (AffiliationSnapshot.targetIds[0]) so the property panel /
  // sidebar re-resolve to it rather than blanket-clearing (FR-94 / reparent-after
  // selection retention; the finding's reparent-lost-selection guard).
  const onReparentCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: AffiliationSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const targetId = snapshot.targetIds[0];
      recordCommit(
        result,
        targetId !== undefined ? { featureId: targetId } : undefined,
        store.getState().currentTime,
      );
    },
    [recordCommit, store],
  );

  // RING-EDIT COMMIT (教訓 5.11 / U12): record as one history unit. For an add / a
  // surviving delete, promote the edited leaf so selection re-resolves to it (FR-22/24
  // selection retention); for a FeatureDeleted last-territory delete the snapshot has
  // NO feature and the deleted id must NOT be re-selected (it fell out of the domain),
  // so no preference is passed and the deleted feature drops from selection.
  const onRingEditCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: RingFeatureSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const fid = snapshot.feature?.id;
      recordCommit(
        result,
        fid !== undefined ? { featureId: fid } : undefined,
        store.getState().currentTime,
      );
    },
    [recordCommit, store],
  );

  // DRILL COMMIT (教訓 5.11 / U12): record as one history unit and promote the NEW
  // feature (DrillSnapshot.newFeature.id) so selection re-resolves to it — the主役 of
  // 穴あけによる新地物生成 is the born feature (FR-45). The新地物 is not in
  // touchedFeatureIds, but makeCommand's baseline↔final history-id delta promotes it to
  // `created` (finding5), so undo/redo selection re-resolution stays correct.
  const onDrillCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: DrillSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      recordCommit(result, { featureId: snapshot.newFeature.id }, store.getState().currentTime);
    },
    [recordCommit, store],
  );

  // U35 — the conflict-resolution modal seam. When add / knife confirmation pauses
  // (ConflictsPending) the controller's onConflicts hands us the pending result +
  // the proposal-bound applyResolutions adapter + a shapes lookup; we hold them in
  // state and mount {@link ConflictResolutionModal}. On commit we record ONE undo
  // unit and re-arm the paused tool; on cancel we discard the tool draft (教訓 5.2).
  const [conflictState, setConflictState] = useState<ConflictPending | null>(null);

  // bughunt3 — GLOBAL SHORTCUT SUSPENSION (H1 + H2). The single `suspended` signal the
  // shell threads into useShortcuts (AppShell): the global window-keydown dispatcher
  // (Ctrl+Z=EditUndo / Delete=EditDelete / Ctrl+Y=EditRedo) must STAND DOWN whenever
  // something else owns the keyboard, so it neither (H1) fires THROUGH an open modal —
  // those modals handle only Esc/Tab via React onKeyDown, which a native window listener
  // ignores — nor (H2) double-fires alongside an Add/Knife tool's OWN Ctrl+Z while
  // drawing (the global listener registers FIRST, so it would win the race and a tool-
  // side stopImmediatePropagation could not unwind the already-fired undo).
  //
  // It is derived as modalOpen || toolDrawing from the components that OWN each piece of
  // truth (教訓 5.29 単一真実源 — no duplicate phase/visibility state):
  //   - conflictState        : the U35 conflict modal (already top-level here);
  //   - helpModalOpen         : 設定/検索/バージョン/ショートカット/診断 (HelpToolsController);
  //   - fileModalOpen         : FR-107 未保存警告 / FR-106 修復 (FileOpsController);
  //   - addDrawing / knifeDrawing : an Add session past Idle / a Knife flow past Idle.
  //   - mergeDrawing / reparentDrawing : a Merge / Reparent flow past Idle (bughunt-review).
  //     These cover the FR-52 MergeOptionsDialog (a real keyboard-owning modal that
  //     handles only Esc via React onKeyDown) and the reparent flow — both were MISSED by
  //     the e63c8b9 wiring, so Ctrl+Z / Delete leaked through them to a domain op.
  // Each child reflects its own state up through a callback; this root only ORs them.
  const [helpModalOpen, setHelpModalOpen] = useState(false);
  const [fileModalOpen, setFileModalOpen] = useState(false);
  const [addDrawing, setAddDrawing] = useState(false);
  const [knifeDrawing, setKnifeDrawing] = useState(false);
  const [mergeDrawing, setMergeDrawing] = useState(false);
  const [reparentDrawing, setReparentDrawing] = useState(false);
  // U25: a ring-edit session past Idle owns the keyboard (its OWN Ctrl+Z undoes a
  // vertex; a stray global Delete during a ring-delete must not fire) — 教訓 c1e5534.
  const [ringEditDrawing, setRingEditDrawing] = useState(false);
  // U27: a drill session past Idle owns the keyboard (its OWN Ctrl+Z undoes a region
  // vertex; a stray global Delete during a drill must not fire) — 教訓 c1e5534.
  const [drillDrawing, setDrillDrawing] = useState(false);
  // U37: an in-progress survey DRAFT owns the keyboard (its OWN Escape cancels the
  // draft; a stray global Delete during a measurement must not hit the selection).
  const [surveyDrafting, setSurveyDrafting] = useState(false);
  // Codex F1a: an OPEN right-click menu owns the keyboard too. Without this, Ctrl+Z
  // fired THROUGH the open menu and could delete the very feature the FROZEN menu
  // model still offers — a following EditProperties click then promoted a nonexistent
  // id (stale-menu 再現経路). Reported up by MapContextMenu via onOpenChange (the
  // onDrawingChange 同型); the menu's own Escape is a capture-phase listener and thus
  // suspension-independent (メニューを閉じるだけ — 選択は消さない). Side-effect by
  // design: while a menu is open the right-click PORT is suspended as well, so a
  // second right-click only closes the menu (outside-pointerdown) without opening a
  // new one — modal-consistent input ownership (段階7).
  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const shortcutsSuspended =
    conflictState !== null ||
    helpModalOpen ||
    fileModalOpen ||
    addDrawing ||
    knifeDrawing ||
    mergeDrawing ||
    reparentDrawing ||
    ringEditDrawing ||
    drillDrawing ||
    surveyDrafting ||
    contextMenuOpen;
  // fr96: mirror the OR-chain into the ref the live right-click port reads (assigned
  // every render, so the imperative port always sees the current value — 教訓 5.6).
  shortcutsSuspendedRef.current = shortcutsSuspended;

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
  // resolved leaf shapes at the conflict time, from the TRIAL state the detection
  // ran against (the proposal applied + any difference adjustments), NOT the
  // committed root. On a re-conflict round the orchestrator hands back the
  // difference-adjusted trial root, so reading from it makes the minimap reflect
  // the current (trimmed) trial geometry instead of the stale pre-resolution
  // shapes (the re-conflict stale-minimap fix — same state the detector saw,
  // single truth source 教訓 5.6 / 5.29). `trialState` is always the live
  // DomainRoot the U13 binding threads through ProcessResult.
  const shapesFor = useCallback(
    (conflict: Conflict, trialState: DomainRoot): ConflictShapes => ({
      aFeatureId: conflict.a.featureId,
      aShape: shapeForConflictParticipant(trialState, conflict, conflict.a.featureId),
      bFeatureId: conflict.b.featureId,
      bShape: shapeForConflictParticipant(trialState, conflict, conflict.b.featureId),
    }),
    [],
  );

  const onAddConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<AddSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      setConflictState({
        pending: result,
        applyResolutions: hostBootstrap.applyResolutionsFor(proposal),
        // fr100: the paused PROPOSAL's own anchor time — the modal commit recolors at
        // the time the edit anchors at, not whatever the view shows later.
        anchorTime: proposal.anchorTime,
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
        anchorTime: proposal.anchorTime,
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
        anchorTime: proposal.anchorTime,
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
        anchorTime: proposal.anchorTime,
        ...(targetId !== undefined ? { preference: { featureId: targetId } } : {}),
      });
    },
    [reparentBootstrap],
  );

  const onRingEditConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<RingFeatureSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      // Promote the edited leaf on commit, the SAME preference a direct ring-edit commit
      // uses (教訓 5.11). A FeatureDeleted delete carries no surviving feature, so no
      // preference is set (the deleted id drops from selection).
      const fid = proposal.snapshot.feature?.id;
      setConflictState({
        pending: result,
        applyResolutions: ringEditBootstrap.applyResolutionsFor(proposal),
        anchorTime: proposal.anchorTime,
        ...(fid !== undefined ? { preference: { featureId: fid } } : {}),
      });
    },
    [ringEditBootstrap],
  );

  const onDrillConflicts = useCallback(
    (result: ProcessResult<DomainRoot>, proposal: EditProposal<DrillSnapshot>) => {
      if (result.status !== PROCESS_STATUS.ConflictsPending) return;
      // Promote the NEW feature on commit, the SAME preference a direct drill commit
      // uses (教訓 5.11 / drill selection — the新地物 is the主役 of FR-45).
      setConflictState({
        pending: result,
        applyResolutions: drillBootstrap.applyResolutionsFor(proposal),
        anchorTime: proposal.anchorTime,
        preference: { featureId: proposal.snapshot.newFeature.id },
      });
    },
    [drillBootstrap],
  );

  const onConflictCommitted = useCallback(
    (result: ProcessResult<DomainRoot>) => {
      // Forward the paused edit's selection preference so the modal commit promotes
      // the same feature a direct commit would (教訓 5.11; was being dropped).
      // fr100: recolor at the PAUSED proposal's anchor time (stashed on the conflict
      // state) — the fallback current time covers only a legacy-shaped state.
      recordCommit(
        result,
        conflictState?.preference,
        conflictState?.anchorTime ?? store.getState().currentTime,
      );
      // Survive vertex-delete (bughunt5 HOLE-1): the deleted vertex ids linger in the
      // selection because reresolve cannot prune them (makeCommand reports deletion at
      // feature-history level only). Clear them in the SAME order the DIRECT survive
      // commit does (recordCommit → clearVertexSelection, vertex-delete.ts) so the
      // feature stays active but no ghost vertex id survives to mis-target a later 削除.
      // recordCommit ran applyCommandResult synchronously, so the store already reflects
      // the promoted feature; this clear only drops the (now-deleted) vertex set.
      const clearOwner = conflictState?.clearVertexOwner;
      if (clearOwner !== undefined && result.status === PROCESS_STATUS.Committed) {
        store.getState().replaceVertexSelection(clearOwner, []);
      }
      setConflictState(null);
      reArmActiveTool();
    },
    [recordCommit, reArmActiveTool, conflictState, store],
  );

  const onConflictCancel = useCallback(() => {
    setConflictState(null);
    reArmActiveTool();
  }, [reArmActiveTool]);

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
          // fr100: a property edit (incl. autoColorEnabled トグル / パレット変更)
          // commits at the EDIT-TARGET anchor's start — which can differ from the
          // view time — so the recolor anchors at intent.editTime (コマンドの時刻).
          recordCommit(result, { featureId: intent.featureId }, intent.editTime);
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

  // FR-98 後段 — the 詳細文書 edit dispatch (live-detail-document.ts). propertyEdit
  // Dispatch と同型: withDetailDocument (planDetailDocumentEdit 経由) → complete-state
  // FeatureSnapshot → createEditProposal(featureId, editTime, …) → the SAME
  // propertyEditBinding.startProcess attribute edits run → Committed ⇒ recordCommit =
  // ONE undo unit (教訓 5.11). The WRITE guard (MAX_DETAIL_DOCUMENT_LENGTH) and the
  // no-op guard live in the ONE plan the sidebar section also consults (教訓 5.29);
  // a Rejected result throws so the panel surfaces 保存に失敗 honestly (HB-3).
  const detailDocumentDispatch = useMemo(
    () =>
      createDetailDocumentDispatch({
        getRoot: () => store.getState().domain,
        startProcess: (proposal) => propertyEditBinding.startProcess(proposal),
        // fr100: the dispatch names its own commit time (= intent.editTime — the
        // edit-target anchor's start, which can differ from the view time).
        recordCommit: (result, preference, anchorTime) =>
          recordCommit(result, preference, anchorTime),
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
      // fr100: same choice as the menu/Delete-key 全錨 delete — no single anchor
      // time exists, so the recolor evaluates at the current view time.
      recordCommand(command, undefined, store.getState().currentTime);
    },
    [store, recordCommand],
  );

  // HB3-12 — 地物の存続期間編集. The U09 ops (changeStart / setEnd / deleteAnchor) that
  // move WHEN a feature appears / disappears on the time axis existed + were unit-tested,
  // but NOTHING called them (教訓 5.7 配線漏れ): the property panel showed存続期間 bars
  // read-only, and editing 開始年/終了年 only stored cosmetic snapshot attributes — they
  // never drove the actual anchor interval, so a feature could not be made to (dis)appear
  // at a different time. Wire the property panel's存続期間 intent through the SAME
  // whole-state-swap command path 全錨 delete uses (single command truth source, 教訓
  // 5.30): {@link createAnchorIntervalCommandForRoot} runs the right U09 op on the
  // feature's series and records ONE undo unit; selection re-resolves against the new
  // interval (a feature whose start moved past the current time drops out, just like a
  // time move, 教訓 5.11). A REJECTED op (sole-anchor delete INV-5, start≥end, …) throws
  // the domain's own testable reason so the panel surfaces it honestly (no silent no-op,
  // HB-3 honest-failure discipline) and pushes NO command (no幽霊 undo entry, 教訓 5.24).
  const anchorIntervalDispatch = useMemo<AnchorIntervalEditDispatch>(
    () => ({
      dispatchAnchorInterval: (intent) => {
        const root = store.getState().domain;
        const result = createAnchorIntervalCommandForRoot(root, intent);
        if (!result.ok) {
          throw new Error(intervalRejectionMessage(result.reason));
        }
        // fr100: an interval edit's commit time is the BOUNDARY the op moved (new
        // start / new end / the deleted anchor's own start) — NOT the view time; the
        // recolor time is resolved by the single helper beside the command builder.
        recordCommand(
          result.command,
          { featureId: intent.featureId },
          anchorIntervalRecolorTime(root, intent, store.getState().currentTime),
        );
      },
    }),
    [store, recordCommand],
  );

  // HB5-3 — the anchor-origin camera focus handed to the「錨一覧」rows. Stable
  // (reads the late-bound fit ref), so it never re-builds the sidebar memo. The
  // event-row click calls this AFTER promoting the feature + syncing time, so the
  // fit resolves the feature's shape at the錨の開始 time and writes the camera through
  // the single ports.writeCamera path. Only this錨導線 calls it — a map-click
  // selection routes through the live-selection-port and never moves the view.
  const focusCameraOnFeature = useCallback(
    (featureId: FeatureId): void => {
      // FR-113 (Codex F3, defensive): never fit the camera to an FR-113-hidden feature —
      // the list rows are already gated, this guards any direct caller (単一解決 reuse).
      if (!isToolTargetVisible(featureId)) return;
      fitCameraToFeatureRef.current?.(featureId);
    },
    [isToolTargetVisible],
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
        anchorIntervalDispatch,
        // FR-98 後段: the 詳細文書 editor in the sidebar property panel (the floating
        // DetailPanel stays view-only). The preview resolves no assets yet (the same
        // honest NO_ASSET_RESOLVER the detail panels use — 文書内画像アセットは別タスク).
        detailDocumentDispatch,
        assetResolver: NO_ASSET_RESOLVER,
        onDeleteFeature: propertyDeleteFeature,
        onFocusFeatureCamera: focusCameraOnFeature,
      }),
    [
      store,
      calendar,
      onOpenDetail,
      propertyEditDispatch,
      anchorIntervalDispatch,
      detailDocumentDispatch,
      propertyDeleteFeature,
      focusCameraOnFeature,
    ],
  );

  return (
    // U41 INTEGRATION (FR-117, 受け入れ基準3): wrap the whole shell in the React
    // error boundary bound to the SAME shared logger the global handlers use, so a
    // render-time exception is caught, logged through the single pipeline and shown
    // as the日本語 fallback instead of crashing the app (教訓 5.6 全経路網羅). The
    // non-React paths are covered by the global handlers installed above.
    <ErrorBoundary
      logger={logger}
      contextTimeLabel={() => String(store.getState().currentTime)}
    >
    <div
      id="app-shell"
      onDragOver={dropHandlers?.onDragOver}
      onDrop={dropHandlers?.onDrop}
    >
      <AppShell
        store={store}
        registry={registry}
        sidebar={sidebar}
        suspended={shortcutsSuspended}
        onMapMount={onMapMount}
        timeline={<Timeline store={store} />}
        /* FR-111 ステータスバー — the live cursor 経緯度 readout. Bound to the
           React-EXTERNAL cursor store the map pointermove path pushes into, so the
           60Hz input rate re-renders THIS node only (技術方針 2.3). Off the map it
           renders the SAME 準備完了 label the bare status bar shows, so the idle
           status bar is unchanged. */
        status={<CursorCoordinateStatus store={cursorPositionStore} />}
        mapOverlay={
          /* 教訓 5.14 / 5.29 — EVERY map-covering tool input bridge is mounted INSIDE
             the map cell (.map-area__overlay) so its client rect equals the canvas'
             box BY CONSTRUCTION: it can never cover the 上部バー controls / toolbar /
             timeline, and "clicked here ⇒ acted here" shares the renderer's one
             transform.

             第6工程 ROOT FIX: the six tool controllers used to live in the FULL-SHELL
             overlay with a scaffold grid that MIRRORED the shell's rows — but the
             mirror's empty `auto` rows collapse to 0, so every bridge spanned the
             whole shell height in the map column (実測 y=0..800 vs map 32..569),
             stealing the 階層深度ボタン clicks (depth-control e2e) and covering the
             timeline band. Anchoring them here removes that class of drift outright
             (the survey bridge already used this design). */
          <>
            <SurveyMapBridge
              store={store}
              screenToWorld={screenToWorld}
              mapCameraInput={mapCameraInput}
            />
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
              onDrawingChange={setAddDrawing}
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
              resolveLeafShape={knifeBootstrap.resolveLeafShape}
              drawSink={knifeDrawSink}
              mapCameraInput={mapCameraInput}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onKnifeCommitted}
              onConflicts={onKnifeConflicts}
              onDrawingChange={setKnifeDrawing}
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
              onDrawingChange={setMergeDrawing}
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
              resolveStore={reparentBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={reparentBootstrap.featureAtPoint}
              resolveLeafShape={reparentBootstrap.resolveLeafShape}
              drawSink={reparentDrawSink}
              mapCameraInput={mapCameraInput}
              onCommitted={onReparentCommitted}
              onConflicts={onReparentConflicts}
              onDrawingChange={setReparentDrawing}
            />
            {/* U25 INTEGRATION (教訓 5.7 / 5.2): the ring-edit (穴 / 飛び地) controller,
                bound to the SAME store. Selecting 編集モード→穴・飛び地 arms a session; the
                first map click picks the target末端面, then (add) clicks place the new
                ring's vertices — the first click auto-classifies 穴 vs 飛び地 — and
                リングを確定 assembles the after-state and drives U24→U13 (the SAME live
                createLiveEditBinding the edit-session drag uses, so it actually commits);
                (delete) clicking inside a ring removes it (deleteHoleRing /
                deleteTerritoryRing). Was unreachable — domain/ring-edit existed but no UI
                consumed it (integration lens). */}
            <RingEditToolController<DomainRoot>
              store={store}
              startProcess={ringEditBootstrap.startProcess}
              ids={ringEditBootstrap.ids}
              resolveFeature={ringEditBootstrap.resolveFeature}
              resolveStore={ringEditBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              current={ringEditBootstrap.current}
              screenToWorld={screenToWorld}
              featureAtPoint={ringEditBootstrap.featureAtPoint}
              drawSink={ringEditDrawSink}
              mapCameraInput={mapCameraInput}
              onCommitted={onRingEditCommitted}
              onConflicts={onRingEditConflicts}
              onDrawingChange={setRingEditDrawing}
            />
            {/* U27 INTEGRATION (教訓 5.7 / 5.2): the drill (穴あけによる新地物生成)
                controller, bound to the SAME store. Selecting 編集モード→穴あけ arms a
                session; the first map click picks the target末端 face, then clicks place
                the region vertices; 穴あけを確定 → 新地物プロパティ入力 → save runs
                drillRegion and hands a drill EditProposal<DrillSnapshot> to the U13 seam
                (createLiveDrillBinding). Was unreachable — domain/drill existed but no
                UI consumed it (integration lens, FR-45). */}
            <DrillToolController<DomainRoot>
              store={store}
              startProcess={drillBootstrap.startProcess}
              ids={drillBootstrap.ids}
              resolveFeature={drillBootstrap.resolveFeature}
              resolveStore={drillBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={drillBootstrap.featureAtPoint}
              drawSink={drillDrawSink}
              mapCameraInput={mapCameraInput}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onDrillCommitted}
              onConflicts={onDrillConflicts}
              onDrawingChange={setDrillDrawing}
            />
          </>
        }
        topBar={
          /* FR-12 INTEGRATION (教訓 5.7 合成ルートの結線漏れ / 教訓 5.16 倍率の二重適用
             防止): mount the U18 経度シフト control in the上部バー (ユーザー要望「経度シフト
             を上部表示に。現状の表示は邪魔」). It USED to float over the MAP AREA
             (.map-area__overlay bottom-left), where its box swallowed map body clicks
             (HB-15 / 8d1ce75); the上部バー is a normal flow row that never overlaps the
             map input layer, so that pointer-events trap is gone by construction (教訓
             5.14). Wired to the SAME renderer camera the U40 pan/wheel path writes
             (rendererRef → writeCamera), so a shift / preset actually moves the map
             center. The widget reports a RAW shift操作量; the zoom is applied ONCE here
             via applyLongitudeShift against the LIVE camera zoom (the domain multiplies,
             never the widget, 教訓 5.16). writeCamera fires onCameraChange →
             publishCameraHooks → updateCamera, which mirrors centerLon into the store
             truth in ONE set() (単一真実源, 教訓 5.29), so the readout — bound to
             store.centerLon — reflects the new center. A preset jumps the continuous
             center to the preset longitude (0度中心 / 180度中心).

             FR-42 / FR-43 表示階層レベル (深度) 結線 (教訓 5.7 実機報告「表示する階層の
             レベルを変更する UI なくないですか?」): the U34 setGlobalDepth /
             setDisplayFocus / … actions + resolveDisplayFor were already implemented;
             only this UI was missing. Mounted BESIDE 経度シフト so the two 上部バー view
             controls 併存する (FR-43). Same normal-flow 上部バー row → never overlaps the
             map input layer (教訓 5.14). */
          <>
            <LongitudeShiftPanel store={store} rendererRef={rendererRef} />
            <GlobalDepthPanel store={store} />
            {/* FR-13 グリッド ON/OFF 結線 (教訓 5.7 結線漏れ): the グリッド表示 quick-toggle,
                mounted in the SAME normal-flow 上部バー row beside the other view controls.
                A FIXED, static button (constant-width label) so it does NOT make the row's
                占有幅 depend on selection/measurement state — preserving the topBar 不変量
                (a4f6be9). Bound to the LIVE store; a toggle re-reads the host's gridVisible
                getter on the next redraw (即時反映). */}
            <GridToggleControl store={store} />
            {/* U37 測量モード (FR-14/15/16 結線): the 補助モード toggle + クリア +
                読取パネル, mounted in the SAME normal-flow 上部バー row as the two
                view controls above — it never overlaps the map input layer (教訓
                5.14) and is NOT gated on editability (View でも使える, U37 §2.1). */}
            <SurveyControls store={store} />
          </>
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
              // FR-98: the LIVE detail document, resolved at the CURRENT time per call
              // (the SAME「現在時刻で都度解決」discipline detailFeatureLookup uses —
              // never a stale capture, 教訓 5.6). Was an honest '' stub until the
              // FR-98 editor landed; the floating panel itself stays VIEW-ONLY (the
              // edit surface is the sidebar PropertyPanel).
              detailDocumentOf={(fid) =>
                featuresAt(store.getState().domain, store.getState().currentTime).find(
                  (f) => f.id === fid,
                )?.detailDocument ?? ''
              }
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
              // fr96 本結線 — the DYNAMIC path: compose the U36 model per request from
              // the LIVE store + single-source lookups, and route a chosen item to its
              // existing flow (dispatchMenuItem → registry / runEditDelete / armEditTool
              // / runUnshare). Supplying these flips the mount off the LEGACY 2-item
              // static render (教訓 5.7 の完了トリガー).
              composeFor={composeContextMenuFor}
              onSelectItem={onSelectMenuItem}
              // Codex F1a: menu-open suspension boundary (onDrawingChange 同型) — an
              // open menu ORs into shortcutsSuspended so Ctrl+Z 等 cannot mutate the
              // domain out from under the frozen menu model.
              onOpenChange={setContextMenuOpen}
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
              onBaseMapImageChange={handleBaseMapImageChange}
              registerBasemapReplace={registerBasemapReplace}
              onModalOpenChange={setFileModalOpen}
            />
            {/* HB-8 / HB-9 INTEGRATION (教訓 5.7 / 5.13): register the ツール
                (設定 / 検索) と ヘルプ (バージョン情報 / ショートカット一覧 / 診断情報)
                command handlers on the SAME registry the menu + shortcuts dispatch,
                and render the views they open. Before this the five ids were
                未登録==無効 — the menu items rendered permanently grayed (HB-4 class
                of dead command). The handlers are torn down on unmount (useEffect
                cleanup unregister). 設定 reuses the U38 dialog bound to the live
                store; the rest are minimal views over existing pure logic. */}
            <HelpToolsController
              store={store}
              registry={registry}
              onRequestBasemapReplace={handleRequestBasemapReplace}
              onCommitPaletteChange={commitPaletteChange}
              onModalOpenChange={setHelpModalOpen}
            />
            {/* 第6工程 NOTE: the six TOOL controllers (add / knife / merge / reparent /
                ring-edit / drill) moved to the map-anchored `mapOverlay` slot above —
                their transparent input bridges must inherit the REAL map cell box.
                They used to live HERE in the full-shell overlay with a shell-grid
                MIRROR whose empty auto rows collapsed, so each bridge spanned the
                whole shell height in the map column and covered the 上部バー
                (階層深度ボタン横取り) and timeline bands (教訓 5.14 / depth-control
                e2e). Only shell-scoped things remain here: markers, modals, panels. */}
            {/* U37 INTEGRATION (教訓 5.7 / 5.2): the survey-mode controller, bound to
                the SAME store. It is HEADLESS and mounted ALWAYS (even while survey is
                OFF) so the confirmed survey lines keep drawing through the dedicated
                persistent survey layer until an explicit clear (FR-15); the transparent
                input bridge lives in the MAP CELL (AppShell mapOverlay, below) and
                exists only while 測量モード is active. Was unreachable — domain/survey
                + ui/survey/survey-batch existed but no UI consumed them (audit:
                「ドメイン完備・UI 皆無」, FR-14/15/16). */}
            <SurveyToolController
              store={store}
              drawSink={surveyDrawSink}
              onDrawingChange={setSurveyDrafting}
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
    </ErrorBoundary>
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

  // HB3-1 (裁定 2026-08-06): absolute longitude jump. The widget passes a value the
  // domain already parsed/folded (`parseAbsoluteCenterLon`), so this writes it
  // verbatim through the SAME camera path as a preset (単一真実源, 教訓 5.29).
  const onSetCenter = useCallback(
    (nextCenterLon: number): void => {
      const ports = rendererRef.current;
      if (ports === null) return;
      const { camera } = ports.readCamera();
      ports.writeCamera({ ...camera, centerLon: nextCenterLon });
    },
    [rendererRef],
  );

  return (
    <LongitudeShiftControl
      centerLon={centerLon}
      onShift={onShift}
      onPreset={onPreset}
      onSetCenter={onSetCenter}
    />
  );
}

/**
 * FR-42 / FR-43 表示階層レベル (深度) panel: mounts the U34 {@link GlobalDepthControl}
 * bound to the LIVE session store's displayControl slice (教訓 5.7 合成ルートの結線漏れ
 * — the store's setGlobalDepth / setDisplayFocus / setFocusDepth / setFocusEmphasize /
 * clearDisplayFocus and resolveDisplayFor were all implemented; only this UI was
 * missing, exactly like FR-12 経度シフト once was).
 *
 * The truth is the store's `displayControl` (グローバル深度 N + 個別フォーカス M); the
 * widget renders it and reports intent through the SAME store actions the display
 * resolution reads (単一真実源, 教訓 5.29). A depth/focus write swaps `displayControl`
 * wholesale, which the render subscription already redraws on (App line「s.displayControl
 * === prevDisplay」guard) and buildCommittedFeatures re-derives from, so a slider move
 * rolls features up / expands them with no second pipeline. FR-42 非干渉: this axis
 * never touches mode/tool/selection.
 *
 * The slider's upper bound is the LIVE forest's max derivable depth (U08
 * maxDerivedDepth over the area features effective now), so it reflects the actual
 * hierarchy; 個別フォーカス targets the current selection (FR-43「選択中地物」).
 */
function GlobalDepthPanel(props: {
  readonly store: ReturnType<typeof createSessionStore<DomainRoot>>;
}): JSX.Element {
  const { store } = props;
  const displayControl = useStore(store, (s) => s.displayControl);
  const domain = useStore(store, (s) => s.domain);
  const currentTime = useStore(store, (s) => s.currentTime);
  const activeFeature = useStore(store, (s) => s.activeFeature);

  // The slider's upper bound: the maximum derivable depth over the LIVE area forest at
  // the current time (FR-42 / FR-38). Memoized on (domain, currentTime) — a structural
  // or time change re-derives it; a pure depth/focus change does not (教訓 5.3).
  const maxDepth = useMemo(() => {
    const areas = featuresAt(domain, currentTime).filter(
      (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
    );
    return maxDerivedDepth(buildForest(areas));
  }, [domain, currentTime]);

  // The focus target's short label (name→id fallback), or null when nothing is selected.
  const activeFeatureLabel = useMemo(() => {
    if (activeFeature === null) return null;
    const f = featuresAt(domain, currentTime).find((x) => x.id === activeFeature);
    return f ? featureDisplayName(f) : (activeFeature as unknown as string);
  }, [activeFeature, domain, currentTime]);

  const onGlobalDepth = useCallback(
    (depth: number): void => {
      store.getState().setGlobalDepth(depth);
    },
    [store],
  );
  // Apply 個別フォーカス onto the selected feature: deep-dive its 縦方向領域 at the
  // current per-focus depth M AND emphasize it (FR-43 / FR-82). The user can then
  // toggle emphasis / adjust M / clear. Reads the live selection fresh (教訓 5.6).
  const onApplyFocus = useCallback((): void => {
    const s = store.getState();
    if (s.activeFeature === null) return;
    s.setDisplayFocus({
      originId: s.activeFeature,
      depth: s.displayControl.focus.depth,
      emphasize: true,
    });
  }, [store]);
  const onFocusDepth = useCallback(
    (depth: number): void => {
      store.getState().setFocusDepth(depth);
    },
    [store],
  );
  const onEmphasize = useCallback(
    (on: boolean): void => {
      store.getState().setFocusEmphasize(on);
    },
    [store],
  );
  const onClearFocus = useCallback((): void => {
    store.getState().clearDisplayFocus();
  }, [store]);

  return (
    <GlobalDepthControl
      globalDepth={displayControl.globalDepth}
      maxDepth={maxDepth}
      onGlobalDepth={onGlobalDepth}
      activeFeatureLabel={activeFeatureLabel}
      focusActive={displayControl.focus.originId !== null}
      focusDepth={displayControl.focus.depth}
      focusEmphasize={displayControl.focus.emphasize}
      onApplyFocus={onApplyFocus}
      onFocusDepth={onFocusDepth}
      onEmphasize={onEmphasize}
      onClearFocus={onClearFocus}
    />
  );
}

/**
 * The state the App holds while a confirmation is paused on conflicts (U35). The
 * `applyResolutions` adapter is already bound to the paused proposal, so the modal
 * is generic over the domain root only (it never sees the snapshot type).
 */
interface ConflictPending {
  readonly pending: ConflictsPendingResult<DomainRoot>;
  readonly applyResolutions: ApplyResolutions<DomainRoot>;
  /**
   * fr100: the PAUSED proposal's anchor time, stashed so the eventual modal commit
   * recolors at the SAME time the edit anchors at (コマンドの anchorTime — the view
   * time cannot drift while the modal owns input, but the proposal time is the
   * truth). Optional only for backward shape-compat; every setter supplies it.
   */
  readonly anchorTime?: TimePoint;
  /**
   * The selection preference for the eventual commit (教訓 5.11). A direct add /
   * knife commit promotes the new feature / inheritor; a commit that went THROUGH
   * the conflict modal must promote the SAME element, so we carry it from the
   * paused edit and forward it on conflict commit (it was being lost before). Typed
   * as the full {@link NextTargetPreference} so a vertex-delete conflict can also
   * carry a surviving vertex set (the other tools only ever set `featureId`).
   */
  readonly preference?: NextTargetPreference;
  /**
   * The vertex-owner whose vertex selection MUST be cleared once THIS conflict
   * commits — set ONLY by a SURVIVE vertex-delete (bughunt5 HOLE-1). All selected
   * vertices were deleted, but reresolve cannot prune them (makeCommand reports
   * deletion at feature-history level, not per vertex), so the modal-commit path must
   * clear them explicitly, mirroring the DIRECT survive commit's
   * recordCommit → clearVertexSelection order. Absent for every other tool
   * (backward-compatible — a conflict commit with no owner clears nothing).
   */
  readonly clearVertexOwner?: FeatureId;
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

// W3-A: the knife 対象面強調 no longer mirrors the store selection into React state.
// The emphasis is resolved INSIDE KnifeToolController from the tool's OWN target
// (`knife.state.targetId` → the host's `resolveLeafShape`), the same live-lookup the
// 対象取得 (`leafAtPoint`) picks from — one truth for「取得した対象」と「強調される形」
// (教訓 5.29), and no App-level store.subscribe on the camera-hot path at all
// (技術方針 2.3「camera は React 描画パスに乗せない」: the removed hook had to GUARD
// against per-frame recomputes; the resolution now happens only when the tool's
// session state changes).

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
  createAnchorIntervalCommandForRoot,
  anchorIntervalRecolorTime,
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
import type { FeatureId, VertexId } from '../domain/ids';
import type {
  ResolveFeature,
  ResolveVertexStore,
  StartSplitProcess,
  FeatureAtPoint,
  ResolveLeafShape as KnifeResolveLeafShape,
} from './knife/index';
import type { SplitIdPorts, SplitSnapshot } from '../domain/knife/index';

export interface KnifeBootstrap<S> {
  readonly ids: SplitIdPorts;
  readonly resolveFeature: ResolveFeature;
  readonly resolveStore: ResolveVertexStore;
  readonly featureAtPoint: FeatureAtPoint;
  /** Resolve a target id → its leaf shape at the current time (W3-A 対象面強調). */
  readonly resolveLeafShape: KnifeResolveLeafShape;
  readonly startProcess: StartSplitProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused split proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<SplitSnapshot>,
  ) => ApplyResolutions<S>;
}

export function createKnifeBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
  mint: SharedIdMint,
  isVisibleTarget: (featureId: FeatureId) => boolean,
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
  // FR-113 (W3-AB fix-forward): the visibility gate is NOT just an acquisition-time
  // filter. `resolveFeature` backs the confirm / save geometry path, so leaving it
  // ungated let a target acquired while visible stay splittable after the user hid it
  // (個別非表示 / 種別オフ) — the very 不変条件「非表示地物はツール取得からも消える
  // (描画==ヒット==分割対象)」W3-A declared. Gating it here makes the invariant hold for
  // the WHOLE session, not just the click (多重防御: the controller also drops such a
  // target, but the geometry path must never depend on that).
  const resolveFeature: ResolveFeature = (featureId): Feature | undefined =>
    isVisibleTarget(featureId)
      ? featuresAt(getRoot(), getTime()).find((f) => f.id === featureId)
      : undefined;
  const resolveStore: ResolveVertexStore = (): VertexStore => verticesAt(getRoot(), getTime());
  // W3-A: 対象面探索は INDIVIDUAL LEAF を拾う `leafAtPoint` — merge / reparent / ring-edit
  // / drill と同じ規約 (HB3-16 と同型). ナイフだけが表示解決の `drawnAreaAt` に残っていて、
  // 「取得した対象(描かれている集約体 id)」と「強調表示(生リーフ形状 leafShapeAt)」が別解決
  // = 二重真実源だった。既定の集約表示 (N=0) で症状が出る:
  //   - FR-35 の真の集約体(shapeless)を返すと leafShapeAt が undefined → 強調ゼロ、かつ
  //     hook の LEAF ゲートに必ず弾かれて分割そのものが到達不能 (深度を上げるまで切れない);
  //   - FR-37 の直轄領構成(子を持つ末端)では丸め先の親 id が返り、強調されるのは親の生形状
  //     = クリックした場所と別の場所が光る (hb4-1-b2-child-click.png)。
  // FR-44「集約地物は直接分割できない」は「集約体を対象にして拒否する」ではなく「クリック
  // 位置の末端リーフへ解決する」で満たす (HB3-16 前例: 集約表示中でも集約体の下の個別リーフ
  // を直接ターゲットにできなければならない)。描かれていないリーフを選ぶ違和感は、下の
  // `resolveLeafShape` によるツール側の対象面強調で「選んだ形が地図上に見える」ことで解消
  // する(両方セットで意味を持つ)。hook の LEAF ゲートは多重防御として残す。
  // FR-113 (Codex F1): 個別非表示 / 種別オフ / 深度フィルタで隠れたリーフは対象から外す
  // (描画==ヒット==分割対象)。Read at call time (教訓 5.6 / 5.29)。
  const featureAtPoint: FeatureAtPoint = (point): FeatureId | null => {
    const leafId = leafAtPoint(getRoot(), getTime(), point);
    return leafId !== null && isVisibleTarget(leafId) ? leafId : null;
  };
  // 単一真実源: 対象取得 (`leafAtPoint`) と対象面強調 (`leafShapeAt`) は同じ live-lookup
  // 由来なので、強調される形 == クリックで取得した対象 == 実際に切られる形。
  // W3-AB fix-forward: the SAME FR-113 gate `featureAtPoint` applies, so「取得できない形は
  // 強調もされない」— the emphasis and the acquisition share ONE visibility verdict, and a
  // target hidden AFTER acquisition resolves to `undefined` (which the controller reads as
  // 「対象が消えた」and returns to 対象選択).
  const resolveLeafShape: KnifeResolveLeafShape = (featureId) =>
    isVisibleTarget(featureId)
      ? (leafShapeAt(getRoot(), getTime(), featureId) ?? undefined)
      : undefined;

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
    resolveLeafShape,
    startProcess,
    applyResolutionsFor,
  };
}

// --- The ring-edit bootstrap (id ports + live-lookup + the U24/U13 seam) -------

import type {
  ResolveFeature as RingResolveFeature,
  ResolveVertexStore as RingResolveStore,
  ResolveCurrent as RingResolveCurrent,
  StartRingEditProcess,
  FeatureAtPoint as RingFeatureAtPoint,
} from './ring-edit/index';
import { confirmRingEdit, type RingIdPorts } from '../domain/ring-edit/index';
import type { FeatureSnapshot as RingFeatureSnapshot } from '../domain/editing/index';

interface RingEditBootstrap<S> {
  readonly ids: RingIdPorts;
  readonly resolveFeature: RingResolveFeature;
  readonly resolveStore: RingResolveStore;
  readonly current: RingResolveCurrent<S>;
  readonly featureAtPoint: RingFeatureAtPoint;
  readonly startProcess: StartRingEditProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused ring-edit proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<RingFeatureSnapshot>,
  ) => ApplyResolutions<S>;
}

function createRingEditBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
  mint: SharedIdMint,
  isVisibleTarget: (featureId: FeatureId) => boolean,
): RingEditBootstrap<DomainRoot> {
  // Ids minted through the SAME shared minter add / knife / merge use (finding 3): one
  // generator + a project-wide reservation set, so a ring-edit-minted id (the new hole
  // / enclave ring + its vertices) can collide with neither another tool's output nor
  // loaded data (教訓 5.37).
  const ids: RingIdPorts = {
    nextRingId: () => asRingId(mint('r')),
    nextVertexId: () => asVertexId(mint('v')),
  };

  // LIVE domain-lookup ports (P0-B): resolve against the CURRENT committed root at the
  // CURRENT time, read at call time so a load / time move / edit is reflected without a
  // stale capture (教訓 5.6). They share the SAME live-lookup rule the consistency
  // binding uses (二重真実源を作らない, 教訓 5.29). featureAtPoint picks an INDIVIDUAL
  // leaf (like merge) — ring-edit targets one末端 face's ring set, so a child inside an
  // aggregate must be directly pickable (HB3-16 と同型).
  const resolveFeature: RingResolveFeature = (featureId): Feature | undefined =>
    featuresAt(getRoot(), getTime()).find((f) => f.id === featureId);
  const resolveStore: RingResolveStore = (): VertexStore => verticesAt(getRoot(), getTime());
  // FR-113 (Codex F1): reject an FR-113-hidden leaf so a 個別非表示 / 種別オフ / 深度 leaf
  // is never a ring-edit target (raw-leaf picking preserved; only visibility layered on).
  const featureAtPoint: RingFeatureAtPoint = (point): FeatureId | null => {
    const leafId = leafAtPoint(getRoot(), getTime(), point);
    return leafId !== null && isVisibleTarget(leafId) ? leafId : null;
  };

  // U44 — the LIVE U13 binding for ring-edit (FR-22/24 は U13 スタブを回避できる大きな
  // 利点): confirmRingEdit → confirmRelease → ConsistencyPorts<DomainRoot,
  // FeatureSnapshot> = the SAME live `createLiveEditBinding` the edit-session drag
  // confirm uses (applyProposal = applyEditProposal). So an add-hole / delete-ring
  // actually reaches Committed, exactly like an edit-mode vertex drag.
  const live = createLiveEditBinding({ getRoot: () => getRoot() });
  const ports = live.ports;
  // The hook's StartRingEditProcess is the confirm entry: assemble the ONE complete-
  // state proposal (snapshot) and drive U24→U13. add / delete are always a real change
  // (changed: true), so the no-op guard never suppresses them (教訓 5.24).
  const startProcess: StartRingEditProcess<DomainRoot> = (snapshot, anchorTime, current) =>
    confirmRingEdit<DomainRoot>({ snapshot, anchorTime, current, ports, changed: true });
  const applyResolutionsFor = (
    proposal: EditProposal<RingFeatureSnapshot>,
  ): ApplyResolutions<DomainRoot> => live.applyResolutionsFor(proposal);

  return {
    ids,
    resolveFeature,
    resolveStore,
    current: () => getRoot(),
    featureAtPoint,
    startProcess,
    applyResolutionsFor,
  };
}

// --- The drill bootstrap (id ports + live-lookup + the U13 seam) ---------------

import type {
  ResolveFeature as DrillResolveFeature,
  ResolveVertexStore as DrillResolveStore,
  StartDrillProcess,
  FeatureAtPoint as DrillFeatureAtPoint,
} from './drill/index';
import { createLiveDrillBinding } from './consistency-binding';
import type { DrillIdPorts, DrillSnapshot } from '../domain/drill/index';

interface DrillBootstrap<S> {
  readonly ids: DrillIdPorts;
  readonly resolveFeature: DrillResolveFeature;
  readonly resolveStore: DrillResolveStore;
  readonly featureAtPoint: DrillFeatureAtPoint;
  readonly startProcess: StartDrillProcess<S>;
  /** Build the U35 apply-resolutions adapter bound to ONE paused drill proposal. */
  readonly applyResolutionsFor: (
    proposal: EditProposal<DrillSnapshot>,
  ) => ApplyResolutions<S>;
}

function createDrillBootstrap(
  getRoot: () => DomainRoot,
  getTime: () => TimePoint,
  mint: SharedIdMint,
  isVisibleTarget: (featureId: FeatureId) => boolean,
): DrillBootstrap<DomainRoot> {
  // Ids minted through the SAME shared minter add / knife / merge / ring-edit use
  // (finding 3): one generator + a project-wide reservation set, so a drill-minted id
  // (the new feature + its ring + its vertices) can collide with neither another tool's
  // output nor loaded data (教訓 5.37).
  const ids: DrillIdPorts = {
    nextFeatureId: () => asFeatureId(mint('f')),
    nextVertexId: () => asVertexId(mint('v')),
    nextRingId: () => asRingId(mint('r')),
  };

  // LIVE domain-lookup ports (P0-B): resolve against the CURRENT committed root at the
  // CURRENT time, read at call time so a load / time move / edit is reflected without a
  // stale capture (教訓 5.6). They share the SAME live-lookup rule the consistency
  // binding uses (二重真実源を作らない, 教訓 5.29). featureAtPoint picks an INDIVIDUAL
  // leaf (like merge / ring-edit) — drill targets one末端 face, so a child inside an
  // aggregate must be directly pickable (HB3-16 と同型); the hook's LEAF gate +
  // checkDrillable's NotTerminal reject a body-click that resolves to an aggregate.
  const resolveFeature: DrillResolveFeature = (featureId): Feature | undefined =>
    featuresAt(getRoot(), getTime()).find((f) => f.id === featureId);
  const resolveStore: DrillResolveStore = (): VertexStore => verticesAt(getRoot(), getTime());
  // FR-113 (Codex F1): reject an FR-113-hidden leaf as a drill target (raw-leaf preserved).
  const featureAtPoint: DrillFeatureAtPoint = (point): FeatureId | null => {
    const leafId = leafAtPoint(getRoot(), getTime(), point);
    return leafId !== null && isVisibleTarget(leafId) ? leafId : null;
  };

  // U44 — the LIVE U13 binding for drill. The proposal handed to startProcess is ALREADY
  // a U13 EditProposal<DrillSnapshot> (toDrillEditProposal ran in the hook), so the swap
  // is contract-clean; applyProposal = applyDrillProposal (原末端への穴形成 + 新地物生成).
  const live = createLiveDrillBinding({
    getRoot,
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  });
  const startProcess = live.startProcess;
  const applyResolutionsFor = (
    proposal: EditProposal<DrillSnapshot>,
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
  isVisibleTarget: (featureId: FeatureId) => boolean,
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
  // FR-113 (Codex F1): reject an FR-113-hidden leaf as a merge target (raw-leaf preserved —
  // an aggregated-but-visible child is still targetable; only 個別非表示 / 種別 / 深度 hide it).
  const featureAtPoint: MergeFeatureAtPoint = (point): FeatureId | null => {
    const leafId = leafAtPoint(getRoot(), getTime(), point);
    return leafId !== null && isVisibleTarget(leafId) ? leafId : null;
  };
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
  ResolveVertexStore as ReparentResolveStore,
  StartAffiliationProcess,
  FeatureAtPoint as ReparentFeatureAtPoint,
} from './reparent/index';
import type { AffiliationSnapshot } from '../domain/editing/apply-proposal';

interface ReparentBootstrap<S> {
  readonly resolveFeatures: ReparentResolveFeatures;
  /** Live vertices at the anchor time → enables the post-reparent 形状=和 check (基準 5). */
  readonly resolveStore: ReparentResolveStore;
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
  isVisibleTarget: (featureId: FeatureId) => boolean,
): ReparentBootstrap<DomainRoot> {
  // LIVE live-lookup ports (P0-B): the features effective at the CURRENT time, read at
  // call time so a load / time move / edit is reflected without a stale capture (教訓
  // 5.6). They share the SAME live-lookup rule (live-lookup.ts) the knife / merge
  // bootstraps and the consistency binding use, so reparent target / parent selection
  // and U28 legality 検証 can never disagree with what is drawn (二重真実源を作らない,
  // 教訓 5.29). No id ports: the existing-parent reparent mints nothing (aggregates are
  // shapeless, FR-35; a `create` decision would mint inside buildAffiliationProposal).
  const resolveFeatures: ReparentResolveFeatures = () => featuresAt(getRoot(), getTime());
  // The vertices effective at the SAME anchor time (the SAME live-lookup the knife / merge
  // bootstraps use, 単一真実源 教訓 5.29). Threaded into buildAffiliationProposal so the
  // post-reparent 形状=和・隙間なし check (checkAggregateShapes via validateHierarchy) runs
  // (基準 5 / FR-35) — previously omitted, so the shape-gap check was silently skipped on
  // every reparent (bughunt). Read at call time so a load / time move / edit is reflected
  // without a stale capture (教訓 5.6).
  const resolveStore: ReparentResolveStore = () => verticesAt(getRoot(), getTime());
  // HB3-16: 所属変更の対象/上位探索も INDIVIDUAL LEAF を拾う `leafAtPoint` (DECISIONS HB3-16).
  // 集約表示中(N=0)に集約体の下に隠れた個別 leaf を直接ターゲット/新上位に選べる必要がある。
  // `drawnAreaAt` だと描画されている集約体 id を返すため、同じ集約に属する兄弟 A,B を続けて
  // 選ぶと両方が同一 id へ解決し、2回目クリックが pick の same-id ルールで1回目を toggle off
  // してしまう = HB3-15(b)「後から選択が消える」の同一親解決バグ。`leafAtPoint` は各 leaf を
  // 別 id へ解決するのでこれが解消する(別の上位領域へ移す操作が成立)。描画されていない leaf を
  // 選ぶ違和感は HB3-15(c) のツール専用ハイライト(resolveLeafShape → buildReparentHighlight)
  // で見えるようにすることで解消(両方セットで実装)。単一真実源 (教訓 5.6 / 5.29)。
  // FR-113 (Codex F1): reject an FR-113-hidden leaf as a reparent target / new-parent
  // (raw-leaf preserved; only 個別非表示 / 種別 / 深度 hide it).
  const featureAtPoint: ReparentFeatureAtPoint = (point): FeatureId | null => {
    const leafId = leafAtPoint(getRoot(), getTime(), point);
    return leafId !== null && isVisibleTarget(leafId) ? leafId : null;
  };
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

  return {
    resolveFeatures,
    resolveStore,
    featureAtPoint,
    resolveLeafShape,
    startProcess,
    applyResolutionsFor,
  };
}
