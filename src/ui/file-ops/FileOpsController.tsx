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
import type { LoadResponse, NamedAsset, SaveRequest, TimeMapApi } from '../../shell/ipc/contract';
import type { ZoomRange } from '../../render/camera';

import type { SessionStore } from '../state/store';
import { DEFAULT_APP_SETTINGS, DEFAULT_PROJECT_SETTINGS } from '../state/settings';
import { COMMAND_ID, type CommandRegistry } from '../shell/commands';

import { buildFileCommandPorts, cameraZoomRange, type FileOpsHost } from './bridge';
import {
  fromPersistedUiSettings,
  toPersistedUiSettings,
} from './ui-settings-bridge';
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
  contextWithoutSaveTarget,
  needsSaveAs,
  type SaveContext,
} from './save-context';
import { dropLoadCommand } from './file-commands';
import { runBasemapReplace } from './basemap-replace';
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

/**
 * Register the FR-04 base-map REPLACE runner with the host (the settings dialog's
 * 差し替えボタン invokes it through the host). The host stores the supplied `run` and
 * calls it when the user requests a replacement; `run` picks an image via U15 IPC,
 * guards it, and on a valid pick swaps the store domain baseMap + retains the SAVE
 * bytes + pushes the DISPLAY bytes. Returns an optional cleanup run on unmount. This
 * mirrors {@link WindowCloseHook}: the controller owns the capability (it holds the
 * asset refs + the IPC api), the host holds the trigger.
 */
export type BasemapReplaceHook = (run: () => Promise<void>) => (() => void) | void;

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
  /**
   * Report whether a file-ops modal (FR-107 未保存警告 / FR-106 修復ダイアログ) is open
   * (bughunt3 H1). The modal-open state lives HERE, not in App.tsx, so the host needs
   * this lift to suspend the global shortcut dispatcher while the dialog owns the
   * keyboard — otherwise Ctrl+Z / Delete leak THROUGH the warning to a domain op.
   */
  readonly onModalOpenChange?: (open: boolean) => void;
  /**
   * S7 出界図 結線 — forward the DISPLAYED project's base-map image bytes to the renderer
   * host (App caches them and hands them to the map renderer's `baseMap` getter). Called
   * on every COMMITTED 破壊的置換: a load that actually reached the domain pushes the
   * file's `baseMapImage` bytes (the project map, feature-aligned) so the renderer paints
   * it instead of the bundled preset; a 新規 pushes empty bytes so it reverts to the
   * preset (FR-03). A load the user aborted at the FR-106 repair dialog pushes NOTHING —
   * display and retained bytes are promoted together, after the domain commits (UC1), so
   * the map never shows a project the store does not hold. The SAME reference
   * `loadedAssetsRef` retains for save round-trip is forwarded (no divergent truth).
   * Optional so the standalone controller test needs no renderer.
   */
  readonly onBaseMapImageChange?: (image: Uint8Array) => void;
  /**
   * FR-04 — register the base-map REPLACE runner with the host (the settings dialog's
   * 差し替えボタン triggers it). The controller owns the runner because it holds BOTH
   * the retained SAVE bytes (loadedAssetsRef → 保存往復) and the DISPLAY push
   * (onBaseMapImageChange → 即時再描画) AND the store domain — the three sinks a
   * replacement must update together (単一真実源). Optional so the standalone controller
   * test can omit it.
   */
  readonly registerBasemapReplace?: BasemapReplaceHook;
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

  // BUG #6 (data-loss) fix — the loaded ASSET BYTES, retained between load and save.
  //
  // The base-map image and attachment bytes live ONLY on the IPC `LoadResponse`
  // (they are NOT part of `DomainProject`, which carries just a `baseMap.source`
  // reference). Previously `buildSaveRequest` shipped `new Uint8Array()` / `[]` for
  // them, so the FIRST save overwrote the on-disk `.gimoza` with a zero-byte base-map
  // asset — permanently losing the loaded map image on round-trip. The renderer is
  // the only place that holds these bytes after a load, so we retain them here and
  // re-ship them on save until the live asset units rebind the base map. A new /
  // empty project carries no assets (empty image + no attachments). The ref holds the
  // assets of the COMMITTED project only: it is updated when a load reflects into the
  // domain (promotePendingAssets, see the staging holder below) or when FR-04 replaces
  // the base map, and reset on a new-project init, mirroring the save context's
  // lifecycle (教訓 5.36 同時初期化).
  /** The asset bytes belonging to one project (the save round-trip payload). */
  interface LoadedAssets {
    readonly baseMapImage: Uint8Array;
    readonly attachments: readonly NamedAsset[];
  }
  const loadedAssetsRef = useRef<LoadedAssets>({
    baseMapImage: new Uint8Array(),
    attachments: [],
  });
  const resetLoadedAssets = useCallback(() => {
    loadedAssetsRef.current = { baseMapImage: new Uint8Array(), attachments: [] };
  }, []);

  // UC1 (data-loss) fix — the STAGING holder for a load's asset bytes.
  //
  // The capture seam (below) is the ONLY place the renderer ever sees the raw
  // `LoadResponse.baseMapImage` / `.attachments` (the load-adapter strips them, BUG #6),
  // but that seam fires the moment the IPC read succeeds — LONG BEFORE the flow knows
  // whether the file will actually become the live project. Between the two lie the
  // FR-106 repair dialog, its retry, and the reject branches, EVERY one of which can end
  // the load with the domain untouched. Writing `loadedAssetsRef` (the SAVE bytes) and
  // pushing the DISPLAY bytes at the capture seam therefore left, on a repair 中止:
  //   - the domain on the PREVIOUS project, but the retained assets on the NEW file, so
  //     the next 保存 / 自動保存 wrote 旧 manifest + 新 asset into one `.gimoza` — a
  //     corrupt, self-inconsistent file (the manifest's base-map/attachment references
  //     no longer describe the embedded bytes);
  //   - the displayed base map flipped to the file the user just refused to open.
  // So the capture is now TWO-STAGE: the seam only STAGES the bytes here, and
  // {@link promotePendingAssets} moves them into `loadedAssetsRef` + pushes the display
  // ONLY from `reflectProject`, i.e. after the domain is committed (教訓 5.22 確定後のみ
  // 反映). Every non-reflecting exit — 修復中止 / 二度目も Unresolved / reject / cancel /
  // 例外 — discards the staged capture, leaving the previous project's assets AND display
  // untouched (教訓 5.2 全経路で破棄). 保存 is deliberately NOT gated by the file-ops
  // mutex, so a Ctrl+S while the repair dialog is open must read the committed assets too
  // — staging (not overwriting) is what makes that read honest.
  const pendingAssetsRef = useRef<LoadedAssets | null>(null);

  // UC1 round-2 保存「宛先」の遅延昇格 — the STAGING holder for a load's commit TOKEN.
  //
  // main no longer promotes the save target on a successful read; it stages `{token,path}`
  // and hands the token back on `LoadResponse.commitToken`. This ref stages that token IN
  // LOCKSTEP with the asset bytes (same capture seam, same discard points), and it is
  // committed back to main (`api.commitLoadedPath`) from the SAME commit point that
  // promotes the assets — reflectProject, i.e. after the domain is confirmed. So a load
  // aborted at the FR-106 repair dialog (or one that throws at reflect) never moves the
  // save destination onto the file the user refused to open (the HIGH data-loss path:
  // A を開く→不整合 B→修復中止→Ctrl+S が B.gimoza を A の内容で上書き破壊). `null` = nothing
  // staged (a no-op to promote / discard), mirroring `pendingAssetsRef`.
  const pendingLoadTokenRef = useRef<string | null>(null);

  // S7 出界図 結線 — the latest onBaseMapImageChange callback, held in a ref so the
  // asset-capture wrapper (inside the `host` memo) and the new-project init (inside an
  // effect) always call the CURRENT one without rebuilding those memos / re-running
  // those effects on a prop-identity change (教訓 5.6 — read live). Refreshed every
  // render so it never goes stale.
  const onBaseMapImageChangeRef = useRef(props.onBaseMapImageChange);
  onBaseMapImageChangeRef.current = props.onBaseMapImageChange;

  /**
   * UC1 — drop a STAGED (not yet committed) capture. Called on every load exit that did
   * not reflect: 修復中止 / 二度目も Unresolved / reject / cancel / 例外 (the exclusive
   * runner's `finally` makes this total for every load entry). A no-op when nothing is
   * staged, so it is safe to call unconditionally (教訓 5.2 全経路で破棄).
   */
  const discardPendingAssets = useCallback(() => {
    pendingAssetsRef.current = null;
    // UC1 round-2: the staged save-destination token is discarded together with the
    // assets, so a non-reflecting load never commits its path either (同・全経路で破棄).
    pendingLoadTokenRef.current = null;
  }, []);

  /**
   * UC1 — PROMOTE the staged capture to the committed assets: the SAVE bytes
   * (`loadedAssetsRef`, re-shipped by buildSaveRequest) and the DISPLAY push
   * (`onBaseMapImageChange`, S7) move together, in ONE step, from the SAME staged
   * reference (単一真実源 — no divergent bytes copy). This is the ONLY promotion site and
   * it runs ONLY from `reflectProject` AFTER the store transition committed, so a load
   * that never reaches the domain can never leave its bytes behind. Clearing the stage
   * first makes a second reflect in the same flow a no-op rather than a re-push.
   */
  const promotePendingAssets = useCallback(() => {
    const staged = pendingAssetsRef.current;
    if (staged === null) {
      // UC1 invariant (LOW#1): reflectProject runs ONLY from a committed load, and every
      // load that reaches reflect first STAGED its capture at the capturingApi seam — so a
      // null stage HERE is the mirror image of the leak this two-stage design prevents: a
      // reflect that has no captured bytes to promote. It is NOT fatal (the domain is
      // already committed; the display simply keeps the previous project's base map, which
      // is the safe direction), so we deliberately do NOT throw. We surface a DEV-only
      // warning so a future wiring regression — a reflect path that skipped the capture
      // seam — is caught in development instead of silently dropping the display update.
      if (import.meta.env.DEV) {
        console.warn(
          '[file-ops] promotePendingAssets: reflect committed but no staged capture; ' +
            'asset/display promotion skipped (UC1 invariant surfaced — not fatal).',
        );
      }
      return;
    }
    pendingAssetsRef.current = null;
    loadedAssetsRef.current = staged;
    // S7: display the loaded PROJECT base-map image (feature-aligned) instead of the
    // preset. Forwards the SAME bytes reference retained above (no copy); the renderer
    // host decodes it once and paints it under the grid. Empty bytes (a project saved
    // without a base-map image) resolve to the preset in the host.
    onBaseMapImageChangeRef.current?.(staged.baseMapImage);
  }, []);

  // The EXACT store snapshot that was serialized into the in-flight save request.
  // A save serializes a snapshot at save START (buildSaveRequest); the IPC write is
  // async. If the user changes ANYTHING that the save persisted DURING the wait, the
  // store swaps in a new reference for that slice and re-arms projectDirty — but that
  // change is NOT on disk. So onSaved must clear dirty ONLY when the live snapshot is
  // still the exact one we wrote; otherwise the post-save state is genuinely unsaved
  // and the flag must stay set (教訓 5.36 単一基準: 保存済み扱いはディスク内容と一致する時だけ).
  //
  // CRITICAL (the settings half of the lost-edit guard): the save request folds the
  // store's projectSettings + appSettings into the manifest's uiSettings, so a save
  // persists ALL THREE references (domain + the two settings slices). Comparing the
  // domain reference ALONE would clear dirty even when a mid-write setting change
  // (e.g. zoomMax via updateProjectSetting) re-armed projectDirty without touching
  // the domain — silently losing that setting (the very state this snapshot guards).
  // The store swaps each slice WHOLESALE on every change (new object reference), so a
  // per-slice identity compare detects a mid-write change to ANY persisted slice.
  interface SavedSnapshot {
    readonly domain: DomainProject;
    readonly projectSettings: SessionStore<DomainProject>['projectSettings'];
    readonly appSettings: SessionStore<DomainProject>['appSettings'];
  }
  const savedSnapshotRef = useRef<SavedSnapshot | null>(null);

  // MED (save/load レース) symmetric guard — the SaveContext captured at save START.
  // buildSaveRequest snapshots it; onSaved applies the save's path/backupTarget update
  // ONLY if the context is still that exact reference. If a load reflected DURING the
  // async write it swapped in the loaded file's context (a new reference), and rolling
  // that back onto this (older) save's path would desync the renderer from main — which
  // already keeps the loaded destination via its own load-commit generation guard. This
  // is the renderer half of the two-sided fix (main: loadCommitCounter; here: identity).
  const saveStartContextRef = useRef<SaveContext | null>(null);

  // Clear the single dirty source ONLY if NO change landed during the save's async
  // write to ANY slice the save persisted (domain + projectSettings + appSettings).
  // The save path records the serialized snapshot in savedSnapshotRef; here we
  // compare each slice by reference identity (the store swaps each whole slice on any
  // change). If any differs, the on-disk content no longer matches the live state, so
  // dirty must stay set (受け入れ基準 2 全経路: 設定だけの変更も取りこぼさない).
  const markClean = useCallback(() => {
    const snapshot = savedSnapshotRef.current;
    if (snapshot === null) return;
    const state = store.getState();
    if (
      snapshot.domain !== state.domain ||
      snapshot.projectSettings !== state.projectSettings ||
      snapshot.appSettings !== state.appSettings
    ) {
      return;
    }
    store.getState().markProjectSaved();
  }, [store]);

  // 破壊的置換フローの相互排他ラッチ (5th bughunt #1/#2/#3 — concurrency data-loss/UX 根治).
  // 開く / 新規 / D&D / 終了ガード は未保存警告(FR-107)や修復(FR-106)モーダルを await する間、
  // 単一の pendingUnsaved / pendingRepair スロットと store reflect を占有する。直列化しないと
  // 第1フローがモーダルで中断中に第2フローが走り、ハントが観測した3つの不具合を起こす:
  //   #1 [HIGH/data-loss] load A の修復ダイアログ表示中に load B(クリーン)が reflect 済みになった後、
  //      A の修復解決が自分のクロージャ捕捉した(古い)プロジェクトを B の上へ reflect し、
  //      読み込んだばかりの B を無言で握り潰す;
  //   #2 [data-loss] 第2 load の promptUnsaved が単一 pendingUnsaved スロットを上書きし、
  //      第1 resolver を孤児化する(await が永久に settle しない=フローの漏れ);
  //   #3 [ux] 開く/新規 の promptUnsaved 中断中に auto-save ティックが走り、
  //      レンダラ内警告と同時にネイティブ Save-As を開く。
  // 破壊的置換フローを1つのラッチで相互排他し、その3つを根で断つ (教訓 5.6 同一フロー):
  // ラッチ保持中の破壊的エントリは DROP(no-op、後続の再ディスパッチで再試行可)。auto-save
  // ティックはラッチを『取らない』が『譲る』(下の購読を参照)。保存同士(保存A→保存B)は本ラッチ
  // ではなく bridge の saveChain がキュー直列化する(lost-edit guard の担当)ので、ここでは
  // 保存を gate しない(掛けると保存Bをドロップし interleave 挙動を壊す・教訓 5.24 責務の単一化)。
  // ラッチは ref(React state 非経由)ゆえ再レンダーなしで async ランナーを門番でき、finally で
  // 必ず解放するので thrown/中断でも全 file 操作を wedge しない (教訓 5.2)。
  const opInFlightRef = useRef(false);
  const runExclusive = useCallback(
    async <T,>(op: () => Promise<T>): Promise<T | undefined> => {
      if (opInFlightRef.current) return undefined;
      opInFlightRef.current = true;
      try {
        return await op();
      } finally {
        opInFlightRef.current = false;
        // UC1: the TOTAL discard point for a staged asset capture. Every load entry
        // (開く / D&D) runs through here, so whatever path the flow took — reflected
        // (already promoted), 修復中止, 二度目も Unresolved, reject, cancel, or a throw —
        // no un-committed bytes survive the operation (教訓 5.2 全経路で破棄). A flow that
        // promoted has already cleared the stage, so this is then a no-op.
        discardPendingAssets();
      }
    },
    [discardPendingAssets],
  );

  const [pendingUnsaved, setPendingUnsaved] = useState<PendingUnsaved | null>(null);
  const [pendingRepair, setPendingRepair] = useState<PendingRepair | null>(null);
  const [repairUnresolved, setRepairUnresolved] = useState(false);

  // --- the live host capabilities (each is a dependency-unit API) -----------
  const host: FileOpsHost | null = useMemo(() => {
    if (api === null) return null;
    // BUG #6 fix (capture half): wrap the U15 load calls so a successful load KEEPS its
    // asset bytes before the load-adapter strips them (the adapter keeps only path +
    // manifest). This is the only seam where the renderer sees the raw
    // `LoadResponse.baseMapImage` / `.attachments`; without keeping them here the bytes
    // are gone by the time a save assembles its request.
    //
    // UC1 fix (the two-stage half): the seam only STAGES them. Success HERE means "the
    // file was read", NOT "this project is now live" — the FR-106 repair dialog, its
    // retry and the reject branches all still lie ahead and any of them can end the load
    // with the domain unchanged. Committing the bytes at this point produced a `.gimoza`
    // whose manifest (old project) and assets (new file) came from DIFFERENT projects on
    // the next save. `promotePendingAssets` (called from reflectProject, 確定後) is the
    // only writer of the committed assets + display; a failed / cancelled / repair-aborted
    // load leaves both untouched. All other api members pass through unchanged.
    const captureAssets = (response: LoadResponse): LoadResponse => {
      if (response.ok) {
        pendingAssetsRef.current = {
          baseMapImage: response.baseMapImage,
          attachments: response.attachments,
        };
        // UC1 round-2: stage the save-destination token beside the assets — both are
        // promoted from reflectProject and discarded on every non-reflecting exit, so the
        // destination moves iff the load reaches the domain. A response without a token
        // (defensive / non-production) stages null → the commit is a safe no-op.
        pendingLoadTokenRef.current = response.commitToken ?? null;
      } else {
        // A transport failure ends this load here: nothing to promote (the runner's
        // finally is the belt-and-braces discard for every other exit).
        discardPendingAssets();
      }
      return response;
    };
    const capturingApi: TimeMapApi = {
      ...api,
      load: async () => captureAssets(await api.load()),
      loadDropped: async (droppedPath: string) => captureAssets(await api.loadDropped(droppedPath)),
    };
    const buildSaveRequest = (): SaveRequest => {
      // Capture the EXACT snapshot the lost-edit guard compares against: the LIVE
      // store domain AND the two settings slices this save persists. onSaved can then
      // tell whether ANY persisted slice changed during the async write by reference
      // identity. We do NOT mutate any of them.
      const state = store.getState();
      const domain = state.domain;
      savedSnapshotRef.current = {
        domain,
        projectSettings: state.projectSettings,
        appSettings: state.appSettings,
      };
      // MED (save/load レース): snapshot the save context at START so onSaved can tell
      // whether a load reflected (swapped the context reference) during the async write.
      saveStartContextRef.current = contextRef.current;
      // 二重真実源 fix: the user settings live in the U16 store, NOT in
      // domain.settings, so serialize(domain) alone would drop every settings-panel
      // change (zoom / timeline / grid / label / palette …). Fold the LIVE store
      // settings into the domain as `uiSettings` for THIS save so they persist; the
      // merge is a fresh object (the store domain reference is untouched, so the
      // lost-edit guard's identity comparison still holds).
      const domainToSave: DomainProject = {
        ...domain,
        uiSettings: toPersistedUiSettings({
          projectSettings: state.projectSettings,
          appSettings: state.appSettings,
        }),
      };
      // BUG #6 fix: ship the RETAINED asset bytes (the base-map image + attachments
      // captured on the last successful load), NOT zero bytes. Without this the first
      // save wrote an empty base-map asset over the loaded one, permanently losing the
      // map image on a load→save round-trip. A new/empty project retains empty assets,
      // so this is a no-op there. The live asset units can later update the ref when
      // the base map is rebound in the renderer; the save path already reaches U15.
      const assets = loadedAssetsRef.current;
      return {
        // The manifest is serialized from the current domain (U14 serialize).
        manifest: serialize(domainToSave),
        baseMapImage: assets.baseMapImage,
        attachments: assets.attachments,
      };
    };
    return {
      api: capturingApi,
      buildSaveRequest,
      needsSaveAs: () => needsSaveAs(contextRef.current),
      onSaved: (path: string) => {
        // Path / backupTarget update happens independently of dirty: a successful write
        // establishes this file as the save target regardless of whether a later edit
        // re-dirtied the document (finding 2 切り離し).
        //
        // MED (save/load レース) symmetric guard: apply it ONLY if a load did NOT reflect
        // during this save's async write. buildSaveRequest snapshotted the context at save
        // start; a load that committed in between swapped contextRef to the loaded file's
        // context (a new reference). Rolling THAT back to this older save's path would
        // desync the renderer from main, which already keeps the loaded destination via its
        // own generation guard. A normal edit / settings change does NOT touch the context
        // (only new / load / save do), so the common path still applies here.
        if (contextRef.current === saveStartContextRef.current) {
          applyContext(contextAfterSave(contextRef.current, path));
        }
        // Clear dirty ONLY if no edit OR settings change landed during the async
        // write (lost-edit guard): markClean compares the live domain AND both
        // settings slices to the serialized snapshot.
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
      promptRepair: (report: ConsistencyReport, isRetry: boolean) =>
        new Promise<RepairChoices | null>((resolve) => {
          // BUG #2: a retry-open (the first chosen repairs left the project
          // inconsistent, REPAIR_OUTCOME.Unresolved) shows the『前回の修復では解消
          // できなかった』banner; a fresh first-open clears it. Without this the live
          // flow always passed unresolved={false}, so the banner (tested in isolation
          // in RepairDialog.test.tsx) was unreachable through the real load path.
          setRepairUnresolved(isRetry);
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
        // 二重真実源 fix (the load half): hydrate the U16 store settings from the
        // loaded project's persisted UI settings so the panel / zoom clamp / label
        // threshold reflect THIS project, and a previous project's settings do not
        // linger. A pre-`ui` manifest carries NO uiSettings — in that case we must
        // hydrate the EXPLICIT DEFAULTS, NOT pass an empty patch (finding). passing
        // `{}` makes the hydrate keep the CURRENT settings, and the domain swap does
        // not touch the settings slices, so a previous project's edited zoom / grid /
        // timeline settings would leak into the freshly-loaded old-format project. The
        // new-project path likewise hydrates buildEmptyProject's default uiSettings;
        // this is its load-half analog (教訓 5.2 全経路で破棄, 教訓 5.36 同時初期化).
        //
        // ATOMIC reflect (bughunt2): the domain swap and the settings hydrate run in
        // ONE store transition (reflectLoadedProject), not as resetToDomain THEN
        // hydrateSettings. The two-call form swapped the domain first, so if the
        // settings hydrate threw on an inverted timeline range it stranded the NEW
        // domain alongside the OLD settings/range; the fused action derives the
        // timeline before mutating, so an invalid project rolls back fully and the
        // store stays on the previous project.
        store.getState().reflectLoadedProject(
          project,
          project.uiSettings === undefined
            ? {
                projectSettings: DEFAULT_PROJECT_SETTINGS,
                appSettings: DEFAULT_APP_SETTINGS,
              }
            : fromPersistedUiSettings(project.uiSettings),
        );
        applyContext(
          contextForLoadedFile({
            path,
            metadata: { name: project.baseMap.source, description: '' },
            baseMapId: project.baseMap.source,
          }),
        );
        // UC1: the domain is COMMITTED (reflectLoadedProject is atomic and would have
        // thrown/rolled back otherwise), so — and only so — this file's asset bytes
        // become the retained SAVE bytes and the DISPLAYED base map. Placed AFTER the
        // store transition so an invalid project that rolls back keeps the previous
        // project's assets AND display (教訓 5.22 確定後のみ反映).
        //
        // ORDER RATIONALE (LOW#2 — corrected): the display push in App
        // (handleBaseMapImageChange) does a SYNCHRONOUS paint — it calls
        // `rendererRef.current.redraw()` directly, NOT the U19 redraw-scheduler (rAF), so
        // it is NOT "collapsed into one rAF frame" with the domain-swap redraw. What makes
        // the new order correct is that the bytes are pushed AFTER the domain commit: that
        // synchronous paint therefore sees a domain and base-map bytes that already agree,
        // so the base-map host resolves the desired image key once. Pushing the bytes
        // before/independent of the commit could paint an intermediate frame whose domain
        // still names the OLD base map while the bytes are the NEW one — a wasted decode of
        // a mismatched desiredKey. Confirmed-then-push removes that wasted intermediate.
        promotePendingAssets();
        // UC1 round-2: the domain is committed, so promote the SAVE DESTINATION too —
        // echo the staged token back to main, which moves `currentPath` onto this file
        // (the SAME commit point as the asset promotion).
        //
        // IPC ORDER DEPENDENCY (documented, 所見明文化): this commit is NOT awaited by the
        // load flow — a plain Save that follows is a separate user action. Correctness in the
        // happy path relies on per-renderer IPC send-order: both this commit and any later
        // save invoke are sent from THIS renderer in program order, so main processes the
        // commit (moving `currentPath` onto this file) BEFORE the save writes. We do not,
        // and cannot from here, order against a save that main is already mid-write on.
        //
        // HIGH-2 fail-safe (救済): the renderer has ALREADY adopted this file's path
        // (contextForLoadedFile above), but if the commit itself FAILS at main (reject /
        // throw), main's `currentPath` never moved onto it — so a following plain 保存 would
        // atomic-write THIS project's content to the PREVIOUS file's path (誤宛先=data-loss).
        // On failure we therefore RETRACT the renderer's save target (savePath→null) so the
        // next 保存 routes to 名前を付けて保存 (needsSaveAs=true) and main asks for a fresh
        // destination — it can never silently target the wrong file. Guarded by context
        // identity: retract ONLY if no later new/load/save swapped the context (that newer
        // context established its own correct destination and must not be clobbered).
        const commitToken = pendingLoadTokenRef.current;
        pendingLoadTokenRef.current = null;
        if (commitToken !== null) {
          const committedContext = contextRef.current;
          void (async () => {
            try {
              await api.commitLoadedPath(commitToken);
            } catch {
              if (contextRef.current === committedContext) {
                applyContext(contextWithoutSaveTarget(contextRef.current));
              }
            }
          })();
        }
      },
      notify: (message: string) => {
        // FR-115: a Japanese notice. Surfaced through the host's alert hook; the
        // shell's toast unit can replace this without touching the flow.
        if (typeof globalThis.alert === 'function') globalThis.alert(message);
      },
      calendar,
    };
  }, [api, store, calendar, applyContext, markClean, promotePendingAssets, discardPendingAssets]);

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
      // 教訓 5.2 全経路で破棄). reflectLoadedProject clears selection / tool / mode /
      // focus so nothing from the previous project survives into the empty one
      // (finding 4), AND resets the store settings to the new project's defaults so a
      // 新規 after editing settings clears the panel back to defaults rather than
      // carrying the previous project's settings (二重真実源 fix, the new-project
      // half, 教訓 5.2 全経路で破棄). buildEmptyProject always carries default
      // uiSettings, so the settings slice is always defined. As with the load path,
      // the domain swap and the settings hydrate run in ONE rollback-safe transition
      // (bughunt2): the timeline is derived before any mutation.
      const empty = buildEmptyProject();
      store.getState().reflectLoadedProject(
        empty,
        empty.uiSettings !== undefined
          ? fromPersistedUiSettings(empty.uiSettings)
          : {},
      );
      applyContext(buildNewProjectContext());
      // BUG #6 fix: a new project has NO loaded assets — drop any retained base-map /
      // attachment bytes from a previously-loaded project so 新規 after a load does not
      // write the old project's map image into the new file (教訓 5.2 全経路で破棄).
      resetLoadedAssets();
      // S7: a new project reverts the DISPLAY to the bundled preset (FR-03) — push empty
      // bytes so the renderer host drops any previously-loaded project's map image
      // (教訓 5.2 全経路で破棄, the display half of resetLoadedAssets).
      onBaseMapImageChangeRef.current?.(new Uint8Array());
    };
    // 破壊的置換フロー(開く/新規)はラッチ経由で相互排他 (5th bughunt #1/#2): モーダル中断中に
    // 発火した2つ目は DROP。保存/名前を付けて保存は bridge の saveChain がキュー直列化するので
    // ラッチを掛けない(掛けると保存Bをドロップし lost-edit guard の interleave 挙動を壊す)。
    registry.register(COMMAND_ID.FileNew, {
      run: () => void runExclusive(() => newProjectCommand(ports, initialiseNewProject)),
    });
    registry.register(COMMAND_ID.FileOpen, {
      run: () => void runExclusive(() => openCommand(ports)),
    });
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
  }, [ports, registry, store, applyContext, resetLoadedAssets, runExclusive]);

  // dirty tracking lives in ONE place now (spec §B 単一基準): the U16 store's
  // `projectDirty`, set by BOTH setDomainState / applyCommandResult (domain edits)
  // AND updateProjectSetting (project settings, e.g. ズーム制限 FR-109). The guard's
  // isDirty() reads that flag directly, so there is no second dirty source to drift
  // (教訓 5.30 過少共有の戒め) and no per-path subscribe hook to keep in sync.

  // --- auto-save tick subscription (FR-108 / 受け入れ基準 3) ------------------
  //
  // BUG #5 (wiring-gap) fix: the FR-108 auto-save chain was complete on the main side
  // (the scheduler ticks and `webContents.send(AutoSaveTick)` fires) and the preload
  // exposed `onAutoSaveTick`, but NO renderer effect subscribed to it — so every tick
  // fell into the void and auto-save silently never saved. Subscribe here and route
  // the tick through the SAME save decision the menu uses (saveCommand with the live
  // needsSaveAs, 教訓 5.6 同一フロー): a never-saved project auto-saves via 名前を付けて保存
  // (main owns the dialog), an established one saves to its path. The subscription
  // returns an Unsubscribe that detaches the listener on unmount / re-arm. ports being
  // live guarantees the save chain (serialized, lost-edit-guarded) is in place.
  useEffect(() => {
    if (api === null || ports === null) return undefined;
    // 5th bughunt #3: skip the tick while a 破壊的置換 flow (開く/新規/D&D/終了ガード) holds a
    // 未保存警告 / 修復 dialog — otherwise the tick's 保存→名前を付けて保存 opens a native
    // Save-As CONCURRENTLY with that dialog. The tick YIELDS to the latch (checks it) but
    // does NOT take it: an auto-save must never block a user's 開く/新規. Save-vs-save
    // ordering (incl. tick-vs-manual) is handled by the bridge's saveChain queue.
    return api.onAutoSaveTick(() => {
      if (opInFlightRef.current) return;
      void saveCommand(ports, needsSaveAs(contextRef.current));
    });
  }, [api, ports]);

  // --- window-close interception with the SAME quit guard (FR-107) ----------
  useEffect(() => {
    if (ports === null || registerWindowClose === undefined) return undefined;
    // Register the SAME guard the load / new paths use (教訓 5.6); the host awaits
    // it on a close request and closes only when it resolves true.
    // 5th bughunt #2: route the close guard through the SAME mutex. If a file op is
    // mid-flight (a dialog is open), refuse the close (return false) rather than open a
    // SECOND 未保存警告 over the first — which would orphan the first resolver. The user
    // resolves the open dialog first, then the close request works.
    const cleanup = registerWindowClose(
      async () => (await runExclusive(() => quitGuard(ports))) ?? false,
    );
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [ports, registerWindowClose, runExclusive]);

  // --- FR-04 base-map差し替え runner registration ---------------------------
  //
  // Register the replace RUNNER with the host (the settings dialog's差し替えボタン
  // triggers it). The controller is the natural owner: it holds BOTH the retained
  // SAVE bytes (loadedAssetsRef, re-shipped by buildSaveRequest → assets/basemap.img)
  // and the DISPLAY push (onBaseMapImageChangeRef → App.handleBaseMapImageChange →
  // 即時再描画), plus the store domain + the U15 IPC api — the exact set a replacement
  // must update in lock-step (単一真実源 — no divergent bytes copy). The pure decision
  // (pick → guard → decode-probe → keep meta / mark source) lives in {@link runBasemapReplace};
  // here we only wire the live effect ports. No-op when the IPC bridge is absent (jsdom).
  //
  // F1 (concurrency): the WHOLE replace runs through `runExclusive` (the SAME file-ops
  // mutex as 開く/新規/D&D/終了ガード), so it is serialized against load/save/new and can
  // NEVER interleave with an in-flight destructive flow. Without this, a replace firing
  // while a load's 修復/未保存 dialog is suspended would overwrite the load's captured
  // asset bytes (loadedAssetsRef) + display push, so the final reflect left domain(B) but
  // save/display bytes(R) — 資産とドメインの取り違え, next save writing R into B. A replace
  // that lands while the latch is held is dropped (no-op; the button re-dispatches).
  const registerBasemapReplace = props.registerBasemapReplace;
  useEffect(() => {
    if (api === null || registerBasemapReplace === undefined) return undefined;
    const run = (): Promise<void> =>
      runExclusive(() =>
        runBasemapReplace({
          // main opens the image dialog + reads the file; renderer gets bytes | null.
          pickImageBytes: () => api.openImage(),
          getBaseMap: () => store.getState().domain.baseMap,
          applyReplacement: ({ source, meta, bytes }) => {
            // (1) swap the domain baseMap reference via the HISTORY-PRESERVING store path
            //     (F2): replaceBaseMap marks projectDirty (教訓 5.36), drives the host
            //     getter to re-resolve preset→user on the next composite, AND signals a
            //     base-map replace so App keeps the edit undo/redo stacks (does NOT re-root
            //     the history as it would for an external load/new). Read the domain live
            //     (post-decode-probe) so no stale capture races a concurrent edit.
            const domain = store.getState().domain;
            store.getState().replaceBaseMap({ ...domain, baseMap: { source, meta } });
            // (2) retain the bytes for the SAVE round-trip (BUG #6 asset plumbing): the
            //     next save ships them into assets/basemap.img, so a later load reflects
            //     the replaced map (task §フェーズ1-3 保存/ロード往復).
            loadedAssetsRef.current = { ...loadedAssetsRef.current, baseMapImage: bytes };
            // (3) push the bytes to the renderer for immediate repaint through the SAME
            //     onBaseMapImageChange path load / 新規 use (教訓 5.35 即時反映).
            onBaseMapImageChangeRef.current?.(bytes);
          },
          // FR-115: a rejected image surfaces its日本語 reason on the existing alert sink.
          notify: (message: string) => {
            if (typeof globalThis.alert === 'function') globalThis.alert(message);
          },
        }),
      ).then(() => undefined);
    const cleanup = registerBasemapReplace(run);
    return typeof cleanup === 'function' ? cleanup : undefined;
  }, [api, store, registerBasemapReplace, runExclusive]);

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
      // Same mutex as the menu load (5th bughunt #1): a drop during an in-flight op is
      // dropped, never interleaved with a repair / unsaved dialog already in progress.
      void runExclusive(() => dropLoadCommand(ports, droppedPath));
    },
    [ports, runExclusive],
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

  // bughunt3 (H1): mirror "a file-ops modal is open" up to the host so it suspends the
  // global shortcut dispatcher while the 未保存警告 / 修復 dialog owns the keyboard. The
  // pending* state here is the single truth; we only reflect it (no duplicate flag).
  // Cleared on unmount so a torn-down controller never leaves the dispatcher suspended.
  const onModalOpenChange = props.onModalOpenChange;
  useEffect(() => {
    if (onModalOpenChange === undefined) return undefined;
    const open = pendingUnsaved !== null || pendingRepair !== null;
    onModalOpenChange(open);
    return () => onModalOpenChange(false);
  }, [pendingUnsaved, pendingRepair, onModalOpenChange]);

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
