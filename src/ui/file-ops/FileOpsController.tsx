// UI layer (U39): the React CONTROLLER that mounts the file-operation flows into
// the live app (spec §A/B/C/D/E / 受け入れ基準 1-6). It is the bridge the review
// flagged as missing on App.tsx: it
//   - registers the ファイル menu commands (新規 / 開く / 保存 / 名前を付けて保存)
//     on the U20 command registry, so menu + shortcut + D&D all dispatch them
//     (教訓 5.6 同一ガード・同一フロー);
//   - drives the U20 modal vessels: the 3-choice unsaved warning (FR-107) and the
//     auto-repair UI (FR-106), each as a promise the flow awaits;
//   - reflects a loaded / repaired project + its save context into the U16 store
//     (確定後のみ, 教訓 5.22);
//   - supplies the current zoom CLAMP range to U17 on every settings change
//     (FR-10 / FR-109 即時反映) via the host's `setZoomRange`;
//   - intervenes on the window-close request with the SAME quit guard (FR-107).
//
// All file I/O goes through U15's typed IPC (`window.timeMapApi`); the renderer
// never touches `fs` (FR-02). The branch/flow logic lives in the pure modules
// (unsaved-guard / load-flow / repair-flow / save-context); this controller only
// supplies the live ports + React presentation (受け入れ基準 7).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { Calendar } from '../../domain/time/calendar';
import type { ConsistencyReport, DomainProject } from '../../domain/persistence/index';
import { serialize } from '../../domain/persistence/index';
import type { SaveRequest, TimeMapApi } from '../../shell/ipc/contract';
import type { ZoomRange } from '../../render/camera';

import type { SessionStore } from '../state/store';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';

import { buildFileCommandPorts, cameraZoomRange, type FileOpsHost } from './bridge';
import {
  openCommand,
  newProjectCommand,
  saveCommand,
  saveAsCommand,
  quitGuard,
  type FileCommandPorts,
} from './file-commands';
import {
  buildEmptyProject,
  buildNewProjectContext,
  contextAfterSave,
  contextForLoadedFile,
  needsSaveAs,
  type SaveContext,
} from './save-context';
import { dropLoadCommand } from './file-commands';
import { UnsavedWarningDialog } from './UnsavedWarningDialog';
import { RepairDialog } from './RepairDialog';
import type { RepairChoices } from './repair-flow';
import type { UnsavedChoice } from './unsaved-guard';

/** Supply the camera clamp range to U17 (the renderer host). */
export type SupplyZoomRange = (range: ZoomRange) => void;

/**
 * Register the quit-guard RUNNER with the host (FR-107 終了確認ガード). The host
 * stores the supplied `runGuard` and, on a window-close request, awaits it and
 * closes ONLY when it resolves true. Returns an optional cleanup the controller
 * calls on unmount to detach the runner.
 */
export type WindowCloseHook = (
  runGuard: () => Promise<boolean>,
) => (() => void) | void;

/**
 * The native drag-and-drop handlers (FR-105 D&D 読み込み). Exposed so the host
 * binds them onto a POINTER-ACTIVE element that actually receives drop events in a
 * real browser (Electron Chromium) — the U20 map area / app root. The controller's
 * own container sits in the front overlay (pointer-events:none, 教訓 5.14) so it
 * never steals click / pan from the map; it therefore CANNOT be the drop target in
 * a real DOM hit-test. The host binds these on a layer that does receive pointers,
 * and drop events bubbling up from the map input layer reach them.
 */
export interface FileDropHandlers {
  /** dragover: must preventDefault so the element is a valid drop target. */
  readonly onDragOver: (e: React.DragEvent) => void;
  /** drop: extracts the dropped path and runs the SAME load flow as the menu (教訓 5.6). */
  readonly onDrop: (e: React.DragEvent) => void;
}

/**
 * Register the D&D handlers with the host (FR-105). The host binds the supplied
 * handlers onto a pointer-active element (the app root over the map area) so a real
 * browser drop reaches the load flow. Returns an optional cleanup run on unmount.
 */
export type DropTargetHook = (handlers: FileDropHandlers) => (() => void) | void;

export interface FileOpsControllerProps {
  /** The U16 session store holding the DomainProject + UI settings. */
  readonly store: StoreApi<SessionStore<DomainProject>>;
  /** The U20 command registry the ファイル menu / shortcuts dispatch through. */
  readonly registry: CommandRegistry;
  /** U15 typed IPC. Defaults to `window.timeMapApi` (the only file-I/O path). */
  readonly api?: TimeMapApi;
  /** The active calendar for U14 consistency checks. */
  readonly calendar: Calendar;
  /** Supply the camera clamp range to U17 (FR-10). No-op until the map mounts. */
  readonly supplyZoomRange?: SupplyZoomRange;
  /**
   * Register a window-close interceptor with the host (FR-107 終了確認ガード). The
   * host calls the supplied `request()` and closes only when it resolves true.
   */
  readonly registerWindowClose?: WindowCloseHook;
  /**
   * Register the D&D handlers with the host (FR-105). The host binds them onto a
   * pointer-active element (the app root over the map area) so a real-browser drop
   * actually reaches the load flow — the overlay container cannot (教訓 5.14).
   */
  readonly registerDropTarget?: DropTargetHook;
}

/** The pending unsaved-warning modal (a resolver the dialog feeds the choice to). */
interface PendingUnsaved {
  readonly resolve: (choice: UnsavedChoice) => void;
}

/** The pending repair modal (the report to present + a resolver for the choices). */
interface PendingRepair {
  readonly report: ConsistencyReport;
  readonly resolve: (choices: RepairChoices | null) => void;
}

/** Read the live U15 API, defaulting to the contextBridge-exposed global. */
function liveApi(injected?: TimeMapApi): TimeMapApi | null {
  if (injected !== undefined) return injected;
  const w = globalThis as { timeMapApi?: TimeMapApi };
  return w.timeMapApi ?? null;
}

export function FileOpsController(props: FileOpsControllerProps): JSX.Element | null {
  const { store, registry, calendar, supplyZoomRange, registerWindowClose, registerDropTarget } =
    props;
  const api = useMemo(() => liveApi(props.api), [props.api]);

  // The file-operation SAVE CONTEXT (spec §D): one value swapped wholesale on new
  // / load / save. Held in a ref so the (async) ports always read the current
  // value without riding a re-render (the dialogs are the only React-visible state).
  //
  // NOTE on dirty (spec §B 単一基準 / 教訓 5.30 過少共有の戒め): the SaveContext still
  // carries a `dirty` field for value completeness, but it is NOT the dirty TRUTH.
  // The single dirty source is the U16 store's `projectDirty`, which BOTH a domain
  // edit (setDomainState / applyCommandResult) and a project-setting change
  // (updateProjectSetting, e.g. ズーム制限) set, and `markProjectSaved()` clears.
  // `isDirty()` reads ONLY that flag, so the unsaved guard observes setting changes
  // and domain edits through one basis (受け入れ基準 2 全経路).
  const contextRef = useRef<SaveContext>(buildNewProjectContext());
  const applyContext = useCallback((next: SaveContext) => {
    contextRef.current = next;
  }, []);

  // The domain reference that was SERIALIZED into the in-flight save request. A
  // save serializes the domain at save START (buildSaveRequest); the IPC write is
  // async. If the user edits DURING the wait, applyCommandResult swaps in a new
  // domain reference and re-arms projectDirty — but that edit is NOT on disk. So
  // onSaved must clear dirty ONLY when the live domain is still the exact reference
  // we wrote; otherwise the post-save state is genuinely unsaved and the flag must
  // stay set (教訓 5.36 単一基準: 保存済み扱いはディスク内容と一致する時だけ).
  const savedDomainRef = useRef<DomainProject | null>(null);

  // Clear the single dirty source ONLY if no edit landed during the save's async
  // write. The save path records the serialized domain in savedDomainRef; here we
  // compare it by reference identity (the store swaps the whole domain on any edit).
  const markClean = useCallback(() => {
    if (savedDomainRef.current !== store.getState().domain) return;
    store.getState().markProjectSaved();
  }, [store]);

  const [pendingUnsaved, setPendingUnsaved] = useState<PendingUnsaved | null>(null);
  const [pendingRepair, setPendingRepair] = useState<PendingRepair | null>(null);
  const [repairUnresolved, setRepairUnresolved] = useState(false);

  // --- the live host capabilities (each is a dependency-unit API) -----------
  const host: FileOpsHost | null = useMemo(() => {
    if (api === null) return null;
    const buildSaveRequest = (): SaveRequest => {
      // Capture the EXACT domain reference being serialized so onSaved can tell
      // whether an edit landed during the async write (lost-edit guard, finding 2).
      const domain = store.getState().domain;
      savedDomainRef.current = domain;
      return {
        // The manifest is serialized from the current domain (U14 serialize). Asset
        // bytes (base-map / attachments) are owned by the render/asset units; until
        // those are live-bound the request ships none — the SAVE path is fully wired
        // and reaches U15 (受け入れ基準 1), the asset payload activates when bound.
        manifest: serialize(domain),
        baseMapImage: new Uint8Array(),
        attachments: [],
      };
    };
    return {
      api,
      buildSaveRequest,
      needsSaveAs: () => needsSaveAs(contextRef.current),
      onSaved: (path: string) => {
        // Path / backupTarget update ALWAYS happens (it is independent of dirty):
        // a successful write established this file as the save target regardless of
        // whether a later edit re-dirtied the document (finding 2 切り離し).
        applyContext(contextAfterSave(contextRef.current, path));
        // Clear dirty ONLY if no edit landed during the async write (lost-edit
        // guard): markClean compares the live domain to the serialized reference.
        markClean();
      },
      // The SINGLE dirty basis (spec §B): the store's projectDirty, set by BOTH
      // domain edits and project-setting changes (e.g. ズーム制限, FR-109). Reading
      // it here means「設定だけ変更→未保存警告」も 3 経路すべてで出る (受け入れ基準 2).
      isDirty: () => store.getState().projectDirty,
      promptUnsaved: () =>
        new Promise<UnsavedChoice>((resolve) => {
          setPendingUnsaved({
            resolve: (choice) => {
              setPendingUnsaved(null);
              resolve(choice);
            },
          });
        }),
      promptRepair: (report: ConsistencyReport) =>
        new Promise<RepairChoices | null>((resolve) => {
          setPendingRepair({
            report,
            resolve: (choices) => {
              setPendingRepair(null);
              setRepairUnresolved(false);
              resolve(choices);
            },
          });
        }),
      reflectProject: (project: DomainProject, path: string) => {
        // 確定後のみ反映 (教訓 5.22): swap the domain, DISCARD the old project's
        // selection / tool / mode / focus, and clear dirty — all in ONE store
        // transition via resetToDomain (受け入れ基準 4 同時初期化, 教訓 5.2 全経路で破棄).
        // A stale selection or focus from the previous project would otherwise
        // dangle against the new domain (finding 4).
        store.getState().resetToDomain(project);
        applyContext(
          contextForLoadedFile({
            path,
            metadata: { name: project.baseMap.source, description: '' },
            baseMapId: project.baseMap.source,
          }),
        );
      },
      notify: (message: string) => {
        // FR-115: a Japanese notice. Surfaced through the host's alert hook; the
        // shell's toast unit can replace this without touching the flow.
        if (typeof globalThis.alert === 'function') globalThis.alert(message);
      },
      calendar,
    };
  }, [api, store, calendar, applyContext, markClean]);

  const ports: FileCommandPorts | null = useMemo(
    () => (host === null ? null : buildFileCommandPorts(host)),
    [host],
  );

  // --- register the ファイル menu commands on the U20 registry (教訓 5.6) -----
  useEffect(() => {
    if (ports === null) return undefined;
    const initialiseNewProject = (): void => {
      // Atomic new-project init: empty domain + discarded session state + clean
      // baseline + new save context (教訓 5.36 / 受け入れ基準 4: 同時初期化, 取り残さない,
      // 教訓 5.2 全経路で破棄). resetToDomain clears selection / tool / mode / focus so
      // nothing from the previous project survives into the empty one (finding 4).
      store.getState().resetToDomain(buildEmptyProject());
      applyContext(buildNewProjectContext());
    };
    registry.register(COMMAND_ID.FileNew, {
      run: () => void newProjectCommand(ports, initialiseNewProject),
    });
    registry.register(COMMAND_ID.FileOpen, { run: () => void openCommand(ports) });
    registry.register(COMMAND_ID.FileSave, {
      run: () => void saveCommand(ports, needsSaveAs(contextRef.current)),
    });
    registry.register(COMMAND_ID.FileSaveAs, { run: () => void saveAsCommand(ports) });
    return () => {
      registry.unregister(COMMAND_ID.FileNew);
      registry.unregister(COMMAND_ID.FileOpen);
      registry.unregister(COMMAND_ID.FileSave);
      registry.unregister(COMMAND_ID.FileSaveAs);
    };
  }, [ports, registry, store, applyContext]);

  // dirty tracking lives in ONE place now (spec §B 単一基準): the U16 store's
  // `projectDirty`, set by BOTH setDomainState / applyCommandResult (domain edits)
  // AND updateProjectSetting (project settings, e.g. ズーム制限 FR-109). The guard's
  // isDirty() reads that flag directly, so there is no second dirty source to drift
  // (教訓 5.30 過少共有の戒め) and no per-path subscribe hook to keep in sync.

  // --- window-close interception with the SAME quit guard (FR-107) ----------
  useEffect(() => {
    if (ports === null || registerWindowClose === undefined) return undefined;
    // Register the SAME guard the load / new paths use (教訓 5.6); the host awaits
    // it on a close request and closes only when it resolves true.
    const cleanup = registerWindowClose(() => quitGuard(ports));
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [ports, registerWindowClose]);

  // --- supply the camera clamp range to U17 on every settings change (FR-10) -
  useEffect(() => {
    if (supplyZoomRange === undefined) return undefined;
    const push = (s: SessionStore<DomainProject>): void => {
      const range = cameraZoomRange(s.projectSettings);
      supplyZoomRange({ minZoom: range.minZoom, maxZoom: range.maxZoom });
    };
    push(store.getState());
    return store.subscribe(push);
  }, [store, supplyZoomRange]);

  // --- D&D load entry: SAME flow as the menu load (教訓 5.6) -----------------
  // dragover MUST preventDefault so the bound element is a valid drop target; drop
  // extracts the dropped absolute path (Electron sets File.path) and joins the
  // common load flow. These are the handlers the host binds onto a pointer-active
  // layer (FR-105) — the overlay container is pointer-events:none and can never be
  // the real drop target in a browser hit-test (教訓 5.14).
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      if (ports === null) return;
      const file = e.dataTransfer.files[0];
      const droppedPath = (file as (File & { path?: string }) | undefined)?.path;
      if (droppedPath === undefined || droppedPath === '') return;
      void dropLoadCommand(ports, droppedPath);
    },
    [ports],
  );

  // --- register the D&D handlers with the host (FR-105) ---------------------
  // The host binds them onto the app root over the map area, which DOES receive
  // pointer / drop events (unlike the overlay container). Drop events bubble up
  // from the map input layer to that root, so a real-browser drop reaches the same
  // load flow as the ファイル menu (教訓 5.6 同一フロー). Re-registers whenever the
  // handlers change (i.e. when `ports` becomes live).
  useEffect(() => {
    if (registerDropTarget === undefined) return undefined;
    const cleanup = registerDropTarget({ onDragOver, onDrop });
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [registerDropTarget, onDragOver, onDrop]);

  // The controller's container lives in the front overlay (pointer-events:none,
  // 教訓 5.14) so it never steals click / pan from the map. The D&D drop target is
  // NOT this element — the host binds the exposed handlers onto a pointer-active
  // layer (see registerDropTarget). This container only hosts the modal vessels.
  // It still carries the handlers + test id so the standalone controller test can
  // exercise the real handler, but the live drop path is the host-bound one.
  return (
    <div
      className="file-ops-dropzone"
      data-testid="file-ops-dropzone"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      {pendingUnsaved !== null && (
        <UnsavedWarningDialog onChoose={pendingUnsaved.resolve} />
      )}
      {pendingRepair !== null && (
        <RepairDialog
          report={pendingRepair.report}
          onResolve={pendingRepair.resolve}
          unresolved={repairUnresolved}
        />
      )}
    </div>
  );
}
