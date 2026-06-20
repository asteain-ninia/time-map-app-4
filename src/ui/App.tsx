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
import { Timeline } from './timeline/Timeline';
import { CommandRegistry } from './shell/commands';
import './shell/shell.css';
import './property/property.css';
import './file-ops/file-ops.css';

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
  type AddDrawSink,
  type ScreenToWorld,
} from './add/AddToolController';
import { createAddHostPorts, type AddHostPorts } from './add/host-ports';
import {
  KnifeToolController,
  type KnifeDrawSink,
} from './knife/index';
import type { DrawPrimitive } from '../render/map-renderer';
import { createColorInfo } from '../domain/attributes';
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
import { COMMAND_ID } from './shell/commands';
import { featuresAt, verticesAt, leafAtPoint, leafShapeAt } from './live-lookup';
import { buildCommittedFeatures } from './map/committed-features';
import {
  PointerDispatcher,
  DISPATCH_TARGET,
  EMPTY_HIT_TESTER,
  NOOP_SELECTION_PORT,
  NOOP_ADD_PORT,
  NOOP_CONTEXT_MENU_PORT,
  type CameraPort,
} from './map/index';
import type { Camera as RenderCamera } from '../render/camera';
import { DEFAULT_LABEL_THRESHOLDS } from '../render/feature-layer';
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
  const store = useMemo(
    () => createSessionStore<DomainRoot>({ initialDomain: buildEmptyProject() }),
    [],
  );

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

    /** Reflect the live camera into the observation hooks (pan offset + zoom). */
    const publishCameraHooks = (camera: RenderCamera): void => {
      // Pan offset is the camera center displacement from the FR-11 origin (0,0);
      // a drag changes it, so the E2E reads a before/after delta. Zoom is verbatim.
      hookTarget.dataset['panX'] = String(camera.centerLon);
      hookTarget.dataset['panY'] = String(camera.centerLat);
      hookTarget.dataset['zoom'] = String(camera.zoom);
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
      // HB-1 観測フック: mirror the LIVE camera into DOM data-* attributes on the
      // map input layer so a behavioural E2E can read the pan offset + zoom and
      // assert they actually changed (既存 app-active-feature マーカーと同方式). The
      // attributes hold NO truth — they只 reflect the renderer camera (技術方針 2.5).
      onCameraChange: (camera) => publishCameraHooks(camera),
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
    const cameraPort: CameraPort = {
      read: () => ports.readCamera(),
      write: (camera) => {
        // The renderer is the camera the DRAW uses; write it first so the pan/zoom
        // is visible at once (its onCameraChange mirrors the observation hooks).
        ports.writeCamera(camera);
        // Mirror the live render camera into the U16 store truth (技術方針 2.5: the
        // camera STATE is owned by the session store). Nothing on the live draw path
        // reads it today, but the FR-12 中心経度 control / FR-13 grid panel bind to
        // store.centerLon — keeping it in sync means a later panel wiring sees the
        // real camera, not a stale 0, and there is never a second diverging truth
        // (二重真実源を作らない, 教訓 5.29). The render camera is a subset of the store
        // Camera (no panX/panY), so we patch only the三 transform fields.
        const s = store.getState();
        s.updateCamera({
          zoom: camera.zoom,
          centerLon: camera.centerLon,
          centerLat: camera.centerLat,
        });
        s.setCenterLon(camera.centerLon);
      },
    };
    const dispatcher = new PointerDispatcher({
      getMode: () => store.getState().mode,
      camera: cameraPort,
      hitTester: EMPTY_HIT_TESTER,
      selection: NOOP_SELECTION_PORT,
      add: NOOP_ADD_PORT,
      contextMenu: NOOP_CONTEXT_MENU_PORT,
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
      const { x, y } = toSurface(e.clientX, e.clientY);
      const target = dispatcher.pointerDown(PointerDispatcher.normalize(e, x, y));
      // Capture the pointer for a pan so the drag keeps tracking even if the cursor
      // leaves the layer mid-drag (受け入れ基準 3 押下→移動→解放の連続保証).
      if (target === DISPATCH_TARGET.Pan) hookTarget.setPointerCapture?.(e.pointerId);
    };
    const onPointerMove = (e: PointerEvent): void => {
      const { x, y } = toSurface(e.clientX, e.clientY);
      dispatcher.pointerMove(PointerDispatcher.normalize(e, x, y, true));
    };
    const onPointerUp = (e: PointerEvent): void => {
      const { x, y } = toSurface(e.clientX, e.clientY);
      dispatcher.pointerUp(PointerDispatcher.normalize(e, x, y));
      hookTarget.releasePointerCapture?.(e.pointerId);
    };
    const onPointerCancel = (e: PointerEvent): void => {
      dispatcher.pointerCancel(e.pointerId);
    };
    const onPointerLeave = (): void => dispatcher.pointerLeave();
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
    // `passive: false` so `preventDefault` actually suppresses page scroll on wheel.
    hookTarget.addEventListener('wheel', onWheel, { passive: false });

    // Abort any in-progress pan/selection on a mode change so a stale reference from
    // the previous mode cannot bleed into the next (教訓 5.2, 受け入れ基準 6).
    let prevMode = store.getState().mode;
    const unsubscribeMode = store.subscribe((s) => {
      if (s.mode === prevMode) return;
      prevMode = s.mode;
      dispatcher.onModeChange();
    });
    // Re-composite whenever the committed domain / current time / selection /
    // display-control / label-threshold setting changes so an added / edited /
    // split feature (or a slider / setting change) draws at once (P0-A / 教訓 5.5).
    // The Canvas subscribes to the store directly, OFF the React render path
    // (技術方針 2.3 / 2.5). A redraw after a tool overlay draw is idempotent (it
    // re-composites with the same last overlay), so there is no double-source risk.
    let prevDomain = store.getState().domain;
    let prevTime = store.getState().currentTime;
    let prevActive = store.getState().activeFeature;
    let prevDisplay = store.getState().displayControl;
    let prevAreaThreshold =
      store.getState().projectSettings.areaLabelOccupancyThreshold;
    const unsubscribe = store.subscribe((s) => {
      const areaThreshold = s.projectSettings.areaLabelOccupancyThreshold;
      if (
        s.domain === prevDomain &&
        s.currentTime === prevTime &&
        s.activeFeature === prevActive &&
        s.displayControl === prevDisplay &&
        areaThreshold === prevAreaThreshold
      ) {
        return;
      }
      prevDomain = s.domain;
      prevTime = s.currentTime;
      prevActive = s.activeFeature;
      prevDisplay = s.displayControl;
      prevAreaThreshold = areaThreshold;
      ports.redraw();
    });
    return () => {
      unsubscribe();
      unsubscribeMode();
      hookTarget.removeEventListener('pointerdown', onPointerDown);
      hookTarget.removeEventListener('pointermove', onPointerMove);
      hookTarget.removeEventListener('pointerup', onPointerUp);
      hookTarget.removeEventListener('pointercancel', onPointerCancel);
      hookTarget.removeEventListener('pointerleave', onPointerLeave);
      hookTarget.removeEventListener('wheel', onWheel);
      ports.dispose();
      rendererRef.current = null;
    };
  }, [store]);

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
  const recordCommit = useCallback(
    (
      result: ProcessResult<DomainRoot>,
      preference?: { readonly featureId: FeatureId },
    ): void => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const step = historyExecute(historyRef.current, result.command);
      historyRef.current = step.history;
      lastCommittedDomainRef.current = step.history.state;
      store.getState().applyCommandResult(step.history.state, step.result, preference);
      refreshUndoRedoEnabled();
    },
    [store, refreshUndoRedoEnabled],
  );

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
      ),
    [store, sharedMint],
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
  // resetForSwitch (discard) then start (fresh session). BUT the store's
  // setActiveTool runs the reset契約 and clears selection (store.ts), which would
  // wipe the feature a conflict commit JUST promoted (教訓 5.11 — selection must
  // survive a structure-change commit). So we capture the selection truth before
  // the toggle and restore it after the re-arm: only the TOOL DRAFT is discarded,
  // the selection is preserved (軽微UX).
  const reArmActiveTool = useCallback(() => {
    const s = store.getState();
    const tool = s.activeTool;
    const retained = s.selection;
    s.setActiveTool(null);
    queueMicrotask(() => {
      const next = store.getState();
      next.setActiveTool(tool);
      // Restore the selection the tool re-arm just cleared (active feature +
      // vertex context). Re-apply through the SAME truth-preserving setters so the
      // U22 selection state and its derived mirrors stay consistent (技術方針 2.5).
      next.restoreSelection(retained);
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
      }),
    [store, calendar],
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
        overlay={
          <>
            {/* Observability marker (回帰観点 E2E): mirrors the live selection truth
                (store.selection.activeFeature) so a regression test can assert the
                inheritor stays selected after a split (教訓 5.11). Hidden; it holds
                NO truth — it只 reflects the store (技術方針 2.5). */}
            <ActiveFeatureMarker store={store} />
            {/* HB-4 観測フック (回帰観点 E2E): mirror the live session mode + active
                tool truth (store.mode / store.activeTool) into hidden data-testid
                markers so a behavioural test can assert the 表示専用→編集 transition
                actually flips the mode and activates the edit tools (既存
                app-active-feature マーカーと同方式). They hold NO truth — pure mirrors
                of the store (技術方針 2.5). */}
            <SessionModeMarker store={store} />
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
            <AddToolController<DomainRoot>
              store={store}
              startProcess={hostBootstrap.startProcess}
              ids={hostBootstrap.ids}
              nextRingId={hostBootstrap.nextRingId}
              screenToWorld={screenToWorld}
              drawSink={drawSink}
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
              zoom={rendererRef.current?.zoom() ?? 1}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onKnifeCommitted}
              onConflicts={onKnifeConflicts}
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
const KNIFE_DEFAULT_COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

/**
 * A hidden marker reflecting the live selection's active feature id for回帰観点
 * E2E observability (教訓 5.11). It is a pure mirror of the store — no truth lives
 * here. Empty string when nothing is selected.
 */
function ActiveFeatureMarker(props: {
  readonly store: ReturnType<typeof createSessionStore<DomainRoot>>;
}): JSX.Element {
  const active = useStore(props.store, (s) => s.selection.activeFeature);
  return (
    <span data-testid="app-active-feature" hidden>
      {active ?? ''}
    </span>
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
 */
function useKnifeTargetShape(
  store: ReturnType<typeof createSessionStore<DomainRoot>>,
): GeoMultiPolygon | undefined {
  const [shape, setShape] = useState<GeoMultiPolygon | undefined>(undefined);
  useEffect(() => {
    const compute = (): GeoMultiPolygon | undefined => {
      const s = store.getState();
      const fid = s.activeFeature;
      if (fid === null) return undefined;
      return leafShapeAt(s.domain, s.currentTime, fid) ?? undefined;
    };
    setShape(compute());
    return store.subscribe(() => setShape(compute()));
  }, [store]);
  return shape;
}

// --- The add bootstrap (id ports + the U13 seam) ----------------------------

import {
  createIdGeneratorState,
  nextRawId,
  type IdGeneratorState,
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
  return (prefix: string): string => {
    const existing = collectProjectRawIds(getRoot());
    for (const id of issued) existing.add(id);
    const g = nextRawId(prefix, state, () => (tick += 1), existing);
    state = g.state;
    issued.add(g.value);
    return g.value;
  };
}
import {
  PROCESS_STATUS,
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
  createLiveKnifeBinding,
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
import type { Feature } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type {
  ResolveFeature,
  ResolveVertexStore,
  StartSplitProcess,
  FeatureAtPoint,
} from './knife/index';
import type { SplitIdPorts, SplitSnapshot } from '../domain/knife/index';

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
  const featureAtPoint: FeatureAtPoint = (point): FeatureId | null =>
    leafAtPoint(getRoot(), getTime(), point);

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
