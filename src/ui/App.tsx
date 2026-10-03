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
import { TOOL_ID, isSelectTool } from './shell/tools';
import { APP_STRINGS, MENU_ITEM_LABELS } from './shell/strings';
import { AppShell, SIDEBAR_SECTION } from './shell';
import { buildSidebarContent } from './shell/SidebarContent';
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
// 作中時刻を画面・ログへ出す整形は U21 の `formatTimePoint` が単一の真実源
// （紀元前の表記と、未指定の月日を捏造しない規約がここに集約されている）。
// ここで `String(currentTime)` としていたものは、TimePoint がオブジェクトなので
// 「[object Object]」になっていた（診断ログの作中時刻が全滅していた）。
import { formatTimePoint } from './timeline/time-display';
import { CommandRegistry } from './shell/commands';
import './shell/shell.css';
import './property/property.css';
import './file-ops/file-ops.css';
// 増分 8E（G-10）: 背景地図の縦横比を聞く板。
import './file-ops/basemap-aspect.css';
import './help-tools/help-tools.css';

import { getCalendar } from '../domain/time/calendar';
import {
  DiagnosticLogger,
  ErrorBoundary,
  logSessionStart,
  resolveDiagnosticLogSink,
  wireGlobalErrorHandlers,
} from './discovery/index';
import { DisplayOptionsSlot } from './discovery/DisplayOptions';
import { JumpPalette } from './discovery/JumpPalette';
import { LEDGER_COMMAND, LedgerCommandStore } from './discovery/ledger-commands';
import { LedgerFilterFocusStore } from './discovery/ledger-focus';
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
import type { AddHostPorts } from './add/host-ports';
import { AddDraftStore } from './add/add-draft-store';
import { createAddSnapPorts } from './add/snap-ports';
import { ADD_STRINGS } from './add/strings';
import { ToolOptionBar } from './shell/ToolOptionBar';
import type { Camera as RenderCameraInput, Viewport } from '../render';
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
import {
  REPARENT_CHOICE,
  ReparentToolController,
  type ReparentChoice,
  type ReparentDrawSink,
} from './reparent/index';
import './reparent/reparent.css';
import {
  SurveyToolController,
  SurveyMapBridge,
  SurveyMeasurementPanel,
  SurveyOptionBar,
  type SurveyDrawSink,
} from './survey/index';
import './survey/survey.css';
import { HelpToolsController } from './help-tools/index';
import type { DrawPrimitive } from '../render/map-renderer';
import { buildMarkedHighlight } from '../render/reaffiliation-batch';
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
// 増分 8E（V13）: 重なり解決の色見本と、解消したあとの状態行の文。
import { participantFillColor } from './conflict/participant-color';
import { conflictResolvedMessage } from './conflict/resolved-message';
import { RESOLVED_STRINGS } from './conflict/strings';
// 増分 8E（G-14）: 穴・飛び地の形を壊す編集を断ったときの文。
import { editRejectionMessage } from './ring-hierarchy-gate';
import type { RejectedResult } from '../domain/consistency/index';
// 増分 8E（G-21）: ズームの上下限を理由つきで断る。
import { ZoomLimitNoteStore, zoomLimitRefusal } from './map/zoom-limit-notice';
import { ZoomLimitNoteView } from './map/ZoomLimitNote';
import './map/zoom-limit-note.css';
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
import {
  COMMAND_ID,
  COMMAND_REFUSAL,
  type CommandId,
  type CommandRefusal,
} from './shell/commands';
import { featureByIdAt, featuresAt, verticesAt, leafShapeAt, leafAtPoint } from './live-lookup';
import {
  buildVertexDeletePlan,
  runEditDelete,
  type EditDeleteSelection,
} from './vertex-delete';
import { runUnshare } from './live-unshare';
import { createLiveExistenceResolver } from './live-existence';
import { createLiveGrabbabilityResolver } from './live-grabbability';
import type { ZoomDirection } from './map/keyboard-zoom';
import { CursorPositionStore } from './shell/cursor-position';
import { registerE2eHarnessAction } from './e2e/harness';
import {
  buildSyntheticAnchorProject,
  buildSyntheticNestedProject,
  buildSyntheticProject,
} from './e2e/synthetic-project';
import { AppIdentity } from './shell/AppIdentity';
import { StatusBarContent } from './shell/StatusBarContent';
import { StatusMessageStore } from './shell/status-message';
import { commandLabelJa, RESULT_STRINGS, UI_COMMAND_LABEL } from './shell/command-result';
import { BulkKindLabelDialog } from './property/BulkKindLabelDialog';
import { ImpactConfirmDialog } from './shell/ImpactConfirmDialog';
import { markedDrawInputs } from './discovery/marked-shapes';
import { buildWindowTitle, fileNameOf } from './shell/status-format';
import type { SaveStatus } from './file-ops/save-context';
import { projectStats } from './e2e/project-stats';
import { OptionBar } from './shell/OptionBar';
import { OptionBarStore, type OptionBarAction } from './shell/option-bar';
import { PersistentOptionSlot } from './shell/PersistentOptionSlot';
import {
  FOCUS_OWNER,
  deriveFocusOwner,
  explainsRefusal,
  suspendsShortcuts,
  type FocusOwner,
} from './shell/focus-owner';
import { ESCAPE_STEP, escapeHasWork, nextEscapeStep } from './shell/escape-ladder';
import { useTextFocused } from './shell/useTextFocused';
import { SidebarFocusStore } from './shell/sidebar-focus';
import {
  LongitudeShiftControl,
  GlobalDepthControl,
  GridToggleControl,
  type MapCameraInput,
} from './map/index';
import { FirstRunGuide } from './shell/FirstRunGuide';
import { DepthOptions } from './map/DepthOptions';
import { MapViewControls } from './map/MapViewControls';
import { VertexCandidateList } from './map/VertexCandidateList';
import { VertexCandidateStore } from './map/vertex-candidates';
import './map/grid-toggle.css';
import { buildForest } from '../domain/hierarchy/forest';
// 増分 7: 所属変更の対象展開（FR-48 後半）と、削除の影響の説明（設計書 §A.3）。
import { planAffiliationTargets } from '../domain/affiliation/index';
import { childrenPromotedByEnding, hasOwnSeries } from '../domain/affiliation/materialize';
import { deletionStateFromHistories, describeDeletionImpact } from '../domain/deletion/index';
import { maxDerivedDepth } from '../domain/hierarchy/depth';
import { FEATURE_KIND, featureDisplayName } from '../domain/feature';
import { findHistoryContaining } from '../domain/editing/apply-proposal';
import { compare as compareTimePoints } from '../domain/time/normalized';
import { toYearPoint } from '../domain/time/time-point';
import {
  EDIT_PLAN_STRINGS,
  PROPERTY_STRINGS,
  buildDeleteImpactView,
  AnchorStartEditStore,
  anchorDeleteImpactView,
  buildDeleteAnchorIntent,
  buildEndHereImpactView,
  buildSetEndIntent,
  isYearAligned,
  type DeleteImpactView,
  type EndHereImpactView,
} from './property/index';
import { formatYear } from './timeline/time-display';
import type { ContextMenuRequest } from './map/live-context-menu-port';
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
import { describeForcedDraw } from './map/always-drawn';
import { derivedDepths, isDepthUndefined } from '../domain/hierarchy';
import {
  isEmphasizedByOtherAxisUnderFilter,
  isFeatureVisibleUnderFilter,
} from './map/filtered-display';
// (fr100) the U33 auto-recolor funnel wrapper — structure + recolor as ONE undo unit.
import { maybeComposeAutoRecolor } from './coloring/recolor-binding';
// (FR-109 follow-up) the undoable default-palette change command — routed through the
// SAME recordCommand funnel so a palette change + its auto-recolor land as ONE undo unit.
import { createPaletteChangeCommand } from './coloring/palette-command';
import { toPersistedUiSettings } from './file-ops/ui-settings-bridge';
import type { PaletteSelection } from './state/settings';
import {
  HIT_KIND,
  ownerLookupFromMap,
  withoutVertexSet,
  type NextTargetPreference,
} from '../domain/selection';
import type { FeatureSnapshot } from '../domain/editing/index';
import { EDIT_REFUSAL, type EditRefusalKind } from '../domain/editing/index';
// 地図マウントの結線は 4 つに割ってある（描画 / 当たり判定 / 入力 / 観測）。onMapMount は
// それらを順に呼んで繋ぐだけの骨組みで、規則そのものは各モジュールが 1 か所ずつ持つ。
import { createMountHitTest } from './map/mount/hit-test';
import { createMountInput } from './map/mount/input';
import { createMountObservation } from './map/mount/observation';
import { createMountRender } from './map/mount/render';
import type { MountTransients } from './map/mount/shared';
import {
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
          // **母集合は「どこかの年に居る地物」**（司令塔の決定 (10)）。旧版は
          // `histories.map(h => h.featureId)` ＝「自分の系列を持つ地物」だったので、
          // **まとめ役の子（実データで 86 件）が最初から母集合に居ない**。だから
          // その子に付けた印も、その子に掛けた個別の表示条件も、次の確定で黙って
          // 消えていた（バグ狩り #8）。錨の中に居る地物まで数えれば、消された地物
          // だけが母集合から落ちる ―― 取り消しで戻れば母集合にも戻る。
          const ids = new Set<FeatureId>();
          for (const history of root.histories) {
            ids.add(history.featureId);
            for (const entry of history.series.entries) {
              for (const f of entry.anchor.snapshot.features) ids.add(f.id);
            }
          }
          return ids;
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
      contextTimeLabel: formatTimePoint(store.getState().currentTime),
    });
  }, [logger, store]);

  // FR-117 ROOT FIX — install the window-level (non-React) error handlers ONCE at
  // startup. installGlobalErrorHandlers (unhandledrejection / error 捕捉) had no
  // production caller, so void-ed IPC/IO rejections were silent (教訓 5.7). We wire
  // it here to the SAME logger and route each caught error's message to the EXISTING
  // notification surface (globalThis.alert — the sink FileOpsController.notify uses),
  // introducing NO new toast UI (§7.4 非目標). The uninstall runs on cleanup so a
  // re-mount (StrictMode double-invoke in dev) never leaks / double-installs listeners
  // (教訓 5.2 全経路で破棄). The作中時刻 for the log context is the live現在時刻 rendered
  // through U21 の `formatTimePoint`（「紀元前27年」等。件数でも本文でもない非機微な値。
  // 教訓 5.15 — 記録時刻＝実時間とは別のフィールドに入る）.
  useEffect(() => {
    const uninstall = wireGlobalErrorHandlers(window, {
      logger,
      contextTimeLabel: () => formatTimePoint(store.getState().currentTime),
    });
    return uninstall;
  }, [logger, store]);

  // E2E 専用の規模観測（T-2）。受け入れ条件が実データの規模で書かれている（775 地物・
  // 表示名の重複 12 件・2,230 頂点の地物・錨 689 件）のに、そのどれも画面からは数えられない
  // ——一覧の行は名前しか運ばず、頂点数はどこにも出ない。ドメインの値をそのまま数える口を
  // 1 つだけ開ける。E2E ブリッジが無い本番ビルドでは何も生えない（登録が no-op になる）。
  useEffect(
    () =>
      registerE2eHarnessAction(globalThis, 'getProjectStats', () =>
        projectStats(store.getState().domain),
      ),
    [store],
  );

  // 増分 4: **5,000 行の合成データ**の投入口（T-2）。受け入れ条件が「5,000 行で台帳の
  // DOM ノードが 20 個以下」なので、その規模を実アプリで作れないと測れない。読み込みと
  // 同じ 1 本（`reflectLoadedProject`）を通すので、載ったあとの画面は「開いたとき」と
  // まったく同じ状態になる（一覧の絞り込み・束・選択も捨てられる）。
  useEffect(
    () =>
      registerE2eHarnessAction(globalThis, 'loadSyntheticProject', (count) => {
        const s = store.getState();
        s.reflectLoadedProject(buildSyntheticProject(s.domain, count), {});
      }),
    [store],
  );

  // 増分 6: **1 地物が 5 万錨**の投入口（T-2）。設計書 §F.2 の受け入れ条件がその規模で
  // 書かれている。まとめ役の子の形も作れる ―― 系列を引く経路が違うので別に測る。
  useEffect(
    () =>
      registerE2eHarnessAction(globalThis, 'loadSyntheticAnchors', (count, options) => {
        const s = store.getState();
        s.reflectLoadedProject(
          buildSyntheticAnchorProject(s.domain, count, options),
          {},
        );
      }),
    [store],
  );

  // 記録の置き場の検査のための入れ子（増分 7 の手直し A）。
  useEffect(
    () =>
      registerE2eHarnessAction(globalThis, 'loadSyntheticNested', (childCount, years) => {
        const s = store.getState();
        s.reflectLoadedProject(
          buildSyntheticNestedProject(s.domain, childCount, years ?? [1000, 1200]),
          {},
        );
      }),
    [store],
  );

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
  //
  // **増分 5 の手直し A1: 渡すのは真偽値ではなく「鍵盤の持ち主」そのもの。** 右クリックの
  // 扱いは 2 通りに分かれる ―― ダイアログが持っているときは **要求ごと捨てる**、道具が
  // 下書きを持っているときは **メニューは開くが選択を変えない**。真偽値 1 個では後者を
  // 表現できず、作図中の右クリックが下書きを壊していた（バグ狩り #1。重症度 4）。
  const focusOwnerRef = useRef<FocusOwner>(FOCUS_OWNER.None);
  /**
   * **道具が下書きを持っているか**（増分 5 の手直し A1）。右クリックの昇格を止める
   * 判定に使う。持ち主の値（`focusOwner`）は文字入力が前に立つと `text` になるので、
   * 「下書きを持っている」がその陰に隠れる ―― 素性を打っている最中の右クリックが
   * 下書きを壊さないよう、畳む前の値を別に写す。
   */
  const toolDraftRef = useRef(false);

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
  // 増分 8E（G-21）: 拡大 / 縮小を押す前の知らせ口と、ズームボタンの脇の文の置き場。
  // 上下限に着いていて何も変わらない 1 押しを、理由つきで断る（脇と状態行）。
  const zoomCommandNoticeRef = useRef<
    ((direction: ZoomDirection, zoomBefore: number, range: ZoomRange) => void) | null
  >(null);
  const zoomLimitNoteStoreRef = useRef<ZoomLimitNoteStore | null>(null);
  zoomLimitNoteStoreRef.current ??= new ZoomLimitNoteStore();
  const zoomLimitNoteStore = zoomLimitNoteStoreRef.current;

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

  // 頂点の候補一覧（設計書 §B.5 の台帳 #12 / V9。増分 6）。押した位置の掴める距離に
  // 頂点が 2 つ以上あるときだけ出す。cursorPositionStore と同じ理由で ref に置く。
  const vertexCandidateStoreRef = useRef<VertexCandidateStore | null>(null);
  vertexCandidateStoreRef.current ??= new VertexCandidateStore();
  const vertexCandidateStore = vertexCandidateStoreRef.current;
  /** 候補一覧から選んだ頂点を選択にする（マウント後に結線される late-bound）。 */
  const selectVertexRef = useRef<((featureId: FeatureId, vertexId: VertexId) => void) | null>(
    null,
  );

  // オプションバー（設計書 §C.4）の内容置き場。道具の実装が押し込み、OptionBar の 1 ノード
  // だけが購読する。cursorPositionStore と同じ理由で ref に置く: useMemo は React が捨てうる
  // ので、押し込む側と購読する側が別インスタンスに割れて無言で結線が切れる。
  const optionBarStoreRef = useRef<OptionBarStore | null>(null);
  optionBarStoreRef.current ??= new OptionBarStore();
  const optionBarStore = optionBarStoreRef.current;

  // 右パネルの「どの区画に注目させるか」の口（増分 4 / 結合点 #3）。右クリックの
  // 「プロパティを編集」と追加の確定がここを呼ぶ。React の外に置くのは `OptionBarStore`
  // と同じ理由で、押し込む側が描画の外から呼ぶためである。
  const sidebarFocusStoreRef = useRef<SidebarFocusStore | null>(null);
  sidebarFocusStoreRef.current ??= new SidebarFocusStore();
  const sidebarFocusStore = sidebarFocusStoreRef.current;

  // 一覧の絞り込み欄へ焦点を入れる口（Ctrl+F ＝「地物を検索」の行き先。E-6）。
  const ledgerFilterFocusStoreRef = useRef<LedgerFilterFocusStore | null>(null);
  ledgerFilterFocusStoreRef.current ??= new LedgerFilterFocusStore();
  const ledgerFilterFocusStore = ledgerFilterFocusStoreRef.current;

  // 一覧への指図（Alt+↑ / Alt+↓ / F2）の口（増分 4 の手直し B8）。メニューと
  // ショートカット一覧に載る 1 本を、一覧の中身へ届ける細い口である。
  const ledgerCommandStoreRef = useRef<LedgerCommandStore | null>(null);
  ledgerCommandStoreRef.current ??= new LedgerCommandStore();
  const ledgerCommandStore = ledgerCommandStoreRef.current;

  /** 「どこへでも移動」（Ctrl+P）が開いているか（設計書 §C.2 の 26）。 */
  const [jumpOpen, setJumpOpen] = useState(false);

  /**
   * いまの根と年を読む口。**参照を固定する**（`useCallback`）のが要点で、描画のたびに
   * 新しい関数を作ると、これを依存に持つ部品（表示 ▾ の常設スロット・どこへでも移動）が
   * 毎回作り直されて **開いていたポップオーバーが閉じる**（教訓 5.2 の裏面: 捨ててよい
   * 一時状態と、捨ててはいけない一時状態を取り違える）。
   */
  const getDomainRoot = useCallback((): DomainProject => store.getState().domain, [store]);
  const getCurrentTime = useCallback((): TimePoint => store.getState().currentTime, [store]);

  // 追加を確定したあとの素性入力を **右パネルの素性欄**へ渡す口（N-15 / 設計書 §C.2 の 27）。
  // 道具は地図セルの覆いの中、素性欄はサイドバーの中に居て React の木の上では兄弟ですら
  // ないので、細い pub/sub を 1 本渡す。ref に置く理由は上の 2 つと同じ。
  const addDraftStoreRef = useRef<AddDraftStore | null>(null);
  addDraftStoreRef.current ??= new AddDraftStore();
  const addDraftStore = addDraftStoreRef.current;

  // 状態行の「直前の結果」枠（設計書 §H.5）。成功も失敗も映す唯一の常設の場所で、
  // **時間では消えない**（教訓 5.12 / K-7）。押し込む側はシェルの外に散らばるので、
  // cursorPositionStore と同じく ref に置いた React 外の pub/sub にする。
  const statusMessageStoreRef = useRef<StatusMessageStore | null>(null);
  statusMessageStoreRef.current ??= new StatusMessageStore();
  const statusMessageStore = statusMessageStoreRef.current;

  // 編集の結果を状態行へ渡す **唯一の口**（設計書 §H.5 / D1）。これまで「直前の結果」に
  // 届いていたのは保存の成否だけで、追加・編集・削除・所属変更・結合・分割・穴あけ・
  // スタイル変更・取り消し・やり直しは 1 つも出ていなかった（`recordCommand` という
  // 1 本の漏斗を通っているのに、そこから結果が出ていなかった）。ここを通せば、
  // あとから増える編集経路も自動で状態行に載る（教訓 5.6: 経路ごとに別の口を作らない）。
  const announceResult = useCallback(
    (text: string): void => {
      statusMessageStore.success(text);
    },
    [statusMessageStore],
  );

  /**
   * **拒否理由の共通枠**（増分 4 の中身 10 / G-20・G-23 の 87 件の出口。設計書 §H.5）。
   *
   * 断りは 2 か所に出す。**状態行の「直前の結果」**（消えない。K-7）と、
   * **オプションバーの「次の一手」**（長い理由もここなら 1 行で読める）である。
   * 枠は増分 1 で作ったものをそのまま使い、新しい置き場を作らない（教訓 5.29）。
   *
   * 押し込みは帯の持ち主を見ない規約なので（`option-bar.ts` の `claim` 注記 3）、
   * 道具を構えていないときでも「次の一手」に理由が出る。
   */
  const announceRefusal = useCallback(
    (text: string | null, actions: readonly OptionBarAction[] = []): void => {
      // **`null` は「さっきの断りを取り下げる」**（増分 4 の手直し B11）。同じ操作を
      // やり直して通ったのに理由が残っていると、直っていないように読める（教訓 5.12 の
      // 裏面: 消す契機を「意味を持つイベント」に限る ―― やり直して通ったのは、まさに
      // その契機である）。**状態行の「直前の結果」は消さない**（K-7: 起きた事実は残す）。
      if (text === null) {
        optionBarStore.setNextStep(null);
        return;
      }
      statusMessageStore.failure(text);
      // **次の一手をボタンで置く**（増分 4 の手直し E1 / 設計書 §H.5）。文だけでは
      // 「では何をすればよいか」が残るので、断った側が 1 手を渡せる口を通す。
      optionBarStore.setNextStep(text, actions);
    },
    [statusMessageStore, optionBarStore],
  );

  // 保存の素性（いまの保存先と最後に保存できた時刻）。FileOpsController だけが知っている
  // 事実を、ウィンドウタイトルと状態行が読めるようにここへ上げる（設計書 §H.6 / V12）。
  // 保存は稀な操作なので React state でよい（60Hz の経路ではない）。
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({
    savePath: null,
    savedAtMs: null,
    autoSaveArmed: false,
    destinationRetracted: false,
  });

  // ウィンドウタイトルとアプリバーの素性表示が読む 2 つ（設計書 §H.6）。どちらも稀にしか
  // 変わらないので、細いセレクタで購読しておけば再レンダーの負担にならない。
  // `projectDirty` は「未保存かどうか」の唯一の真実源で、ドメインの編集と
  // プロジェクト設定の変更の両方が立てる（保存で下りる）。これまで画面に出ていたのは
  // 診断ダイアログの中だけだった。
  const projectDirty = useStore(store, (s) => s.projectDirty);
  const worldName = useStore(store, (s) => s.projectSettings.projectName);
  /**
   * 対象の印（`markedFeatures`。増分 7 / 設計書 §D.5）。**選択とは別概念**で、2 件以上に
   * なりうる集合である。地図の対象色・所属変更の対象・右クリックの「まとめて…」の 3 つが
   * この 1 つを読む。
   */
  const markedFeatures = useStore(store, (s) => s.ledger.marked);
  /**
   * 存続期間コマンドの遅延束縛（増分 7）。「この年に終わったことにする」は右クリックからも
   * 素性欄からも来るが、その口（`anchorIntervalDispatch`）は下のほうで組み立てられる。
   * **写しを作らずに 1 本を共有する**ため、`recordCommitRef` と同じ形で ref に late-bind する
   * （教訓 5.44: 共通ロジックの写しを残さない）。
   */
  const anchorIntervalDispatchRef = useRef<AnchorIntervalEditDispatch | null>(null);
  /**
   * 印を配列で渡す口（所属変更の道具は配列を受ける）。集合の同一性で memo するので、
   * 印が動いたときだけ新しい配列になる。
   */
  const markedFeatureIdList = useMemo(() => [...markedFeatures], [markedFeatures]);
  /** 対象色を引き直す契機（形は時刻とドメインで変わる）。細いセレクタで購読する。 */
  const openFileName = fileNameOf(saveStatus.savePath);

  // ウィンドウタイトル（設計書 §H.6）。**書き換えるコードはこれまでリポジトリに 0 件**で、
  // index.html の静的文字列のままだった。タスクバーやウィンドウ一覧から選ぶときはタイトル
  // しか見えないので、画面の中と同じ 3 つ（世界名・ファイル名・未保存の印）を出す。
  useEffect(() => {
    document.title = buildWindowTitle({
      worldName,
      fileName: openFileName,
      dirty: projectDirty,
      destinationRetracted: saveStatus.destinationRetracted,
    });
  }, [worldName, openFileName, projectDirty, saveStatus.destinationRetracted]);

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

  // 確定の関門が編集を断ったときに理由を状態行へ出す口（増分 3 の手直し A5 / A6）。
  // `recordCommitRef` と同じく ref に置く ―― 編集セッションの口は地図マウント時に 1 度だけ
  // 組み立てられるので、毎レンダーの関数を直接渡すと地図を組み直すことになる（技術方針 2.3）。
  const announceEditRefusalRef = useRef<((reason: EditRefusalKind) => void) | null>(null);
  // 増分 8E（G-14）: 確定の手続きが編集を断ったとき（穴・飛び地の形を壊す編集など）の理由を
  // 状態行へ出す口。上と同じく ref に置く（地図マウント時に 1 度だけ組み立てるため）。
  const announceEditRejectionRef = useRef<((rejected: RejectedResult) => void) | null>(null);

  // 共有頂点の移動を「その年より後ろの記録へも反映した」ことを報せる口
  // （増分 3 の手直し 2 回目 / A1）。引き継ぎ自体は 1 回目で入れたが、**画面へ出す配線が
  // 無かった**ので、利用者から見ると「この年しか直っていない」と思い込むままだった。
  const announceCarryForwardRef = useRef<
    ((fromYear: number, toYear: number, anchorCount: number) => void) | null
  >(null);

  // The shared vertex-id minter, held behind a ref so the imperatively-created
  // edit-session port (built in `onMapMount`) can RESERVE a new vertex id for an
  // FR-87 edge-add without re-mounting the map when the minter memo changes. Assigned
  // from the SAME `sharedMint` add / knife use (below), so an edge-add-minted id can
  // collide with neither stored data nor another tool's output (教訓 5.37 重複チェック).
  const nextVertexIdRef = useRef<(() => VertexId) | null>(null);
  // U4 study — the RING-id twin of the vertex minter ref above, for the U06 conflict-
  // resolution write-back of the EDIT bindings (edit-drag / vertex-delete / property
  // edit). Those bindings are created inside onMapMount (before `sharedMint` is in
  // scope), so they reach the shared minter lazily through this ref, exactly like the
  // edge-add vertex minter. Without BOTH minters applyResolutionAt refuses every
  // resolution (consistency-binding: undefined ⇒ return undefined) — conflict
  // resolution was structurally impossible on those paths.
  const nextRingIdRef = useRef<(() => RingId) | null>(null);

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

  /**
   * **地図が載ったか**（増分 5 の手直し A4）。鍵盤の持ち主の 6 値のうち `none`
   * （まだ誰も持っていない）は、この値が偽のあいだだけ出る。渡さないと `none` は
   * 永久に出ず、語彙が 1 つ死ぬ ―― 「地図が鍵盤を持っている（＝打鍵が全部通る）」と
   * 「まだ載っていないので行き先が無い」は違う状態なので、区別そのものは要る。
   *
   * 書き手は下の `onMapMount` の 1 か所だけで、`setMapReady` は同一性が変わらないので
   * `onMapMount` の同一性も変わらない（＝地図は再マウントされない）。
   */
  const [mapReady, setMapReady] = useState(false);
  /**
   * **この地図が何回目のマウントかの印**（増分 5 の手直し F2 / GPT #15）。
   *
   * 「地図を再マウントしていない」という受け入れ条件を、いままで **カメラの値が
   * 保たれること**で見ていた。カメラは外の店（`store.camera`）に居るので、
   * **地図セルが作り直されても同じ値を復元できてしまう** ―― 検査は緑のまま、
   * Canvas も入力の途中も一時的な予告も失われる、という抜け方がある。
   *
   * そこで **要素そのものに印を書く**。マウントのたびに番号が 1 つ増え、DOM 属性
   * （`data-mount-id`）として読めるので、E2E は「帯の中身・右パネルの幅・窓の大きさを
   * 変えても印が変わらない」を直接見られる。印は観測だけで、真実は 1 つも持たない
   * （技術方針 2.5）。
   */
  const mapMountCountRef = useRef(0);

  const onMapMount = useCallback((el: HTMLDivElement): (() => void) => {
    // 部品どうしをまたぐ「先に宣言して後から差し替える」参照は、この 1 個の箱にまとめる。
    //
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
    //
    // Drain a throttled redraw before a pointerdown hit-test so drawn == live state
    // (bughunt round-2: stale-frame hit-test window). Assigned once the redraw
    // scheduler is built below; a no-op until then (the early base paint is already
    // synchronous, so a press before the scheduler exists has nothing to flush).
    const transients: MountTransients = {
      liveEditSession: null,
      scheduleEditPreviewRedraw: (): void => {},
      flushRedraw: (): void => {},
    };

    // 観測（HB-1 / HB-14 / HB3-9）を最初に作る。取り付け先（`hookTarget` / `mapCell`）の
    // 解決もここが持っており、`createAddHostPorts` は最初の描画で同期に `onCameraChange`
    // を呼ぶので、`hookTarget` はレンダラより先に存在していなければならない。
    const observation = createMountObservation({ el, store, rendererRef });
    // 描画: レンダラホスト（何を描くかの getter 一式）+ カメラ操作 + 再描画スケジューラ。
    const render = createMountRender({
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
      publishCameraHooks: observation.publishCameraHooks,
      publishVisibleCountHook: observation.publishVisibleCountHook,
      publishFrameHook: observation.publishFrameHook,
    });
    // 当たり判定: クリック解決 → 選択 / 編集ドラッグ / 右クリックメニューの 4 つの口。
    const hitTest = createMountHitTest({
      store,
      ports: render.ports,
      hookTarget: observation.hookTarget,
      transients,
      nextVertexIdRef,
      nextRingIdRef,
      recordCommitRef,
      announceEditRefusalRef,
      announceCarryForwardRef,
      announceEditRejectionRef,
      contextMenuOpenerRef,
      focusOwnerRef,
      toolDraftRef,
    });
    // 入力: U40 ディスパッチャ + DOM リスナー + ツールのオーバーレイへ渡すカメラ入口。
    const input = createMountInput({
      store,
      ports: render.ports,
      hookTarget: observation.hookTarget,
      mapCell: observation.mapCell,
      transients,
      cursorPositionStore,
      cameraInputRef,
      hitTester: hitTest.hitTester,
      selectionPort: hitTest.selectionPort,
      editSession: hitTest.editSession,
      contextMenu: hitTest.contextMenu,
      // 頂点の候補一覧（#12）。押した位置の候補は当たり判定と **同じ 1 本** から出る。
      vertexCandidates: {
        store: vertexCandidateStore,
        probe: hitTest.probeVertexCandidates,
        nameOf: (id) =>
          featureByIdAt(store.getState().domain, store.getState().currentTime, id)?.attributes
            .name ?? '',
      },
    });
    selectVertexRef.current = hitTest.selectVertex;
    // ストア購読による再描画は最後に起こす（分割前と同じ位置 = 入力側のモード中断の購読
    // より後）。購読の登録順と、ホスト自身の再描画が throttle に載る時点を分割前と揃える。
    render.startRedrawScheduling();

    // 地図が載った（鍵盤の持ち主が `none` から `map` へ移る）。
    setMapReady(true);
    // 何回目のマウントかを要素へ書く（F2 の観測。数えるのは 1 か所だけ）。
    mapMountCountRef.current += 1;
    el.dataset['mountId'] = String(mapMountCountRef.current);

    // 後始末は「入力 → 描画 → 観測」の順で呼ぶ。分割前は 1 本の cleanup が
    // 購読解除 → リスナー剥がし → カーソル読み取り停止 → ホスト破棄 → 遅延結線の解除
    // と並んでいた。部品ごとの cleanup ではその並びを 1 行ずつ再現できないので、
    // **同じ効き目になる並び**を選んである: 「カーソル読み取りの停止（入力側）が
    // `ports.dispose()`（描画側）より前」という唯一の順序の制約は保たれている。
    return () => {
      setMapReady(false);
      // 頂点の候補一覧の口も一緒に外す（教訓 5.2: 一時状態は全経路で捨てる）。
      // 残すと、地図が載っていないのに古いマウントの選択書き込みが生きてしまう。
      selectVertexRef.current = null;
      vertexCandidateStore.clear();
      input.dispose();
      render.dispose();
      observation.dispose();
    };
    // `cursorPositionStore` is listed for honesty even though it is ref-backed and
    // therefore never changes identity: had it stayed a useMemo, a discarded cache would
    // have re-created it WITHOUT re-mounting the map, leaving these listeners pushing into
    // the abandoned store while the readout subscribed to the new one.
    // `vertexCandidateStore` も同じ理由で並べる（ref 由来なので同一性は動かない）。
  }, [store, cursorPositionStore, vertexCandidateStore]);

  // Bridge the {@link MapContextMenu} mount's open-setter to the imperative live
  // context-menu port (assigned to the opener ref the port reads). Stable so the
  // mount's effect binds once; null on unmount (教訓 5.2 全経路で破棄).
  const bindContextMenuOpener = useCallback(
    (opener: ContextMenuOpener | null): void => {
      contextMenuOpenerRef.current = opener;
    },
    [],
  );

  /**
   * **一覧の行の右クリック**（設計書 §I.3 の「台帳の行」。増分 5 からの送り）。
   *
   * **地図と同じ 1 本を通す** ―― 組み立て（`composeContextMenuFor`）も発火
   * （`onSelectMenuItem`）も既にあるので、ここがやるのは「その行の地物を選択へ引き上げ、
   * 地物の当たりとして開く」だけである（教訓 5.29: 右クリックの体系を 2 つ作らない）。
   * 選択へ引き上げるのは地図の右クリックと同じ規約で、押した相手がコマンドの相手になる
   * （教訓 5.11）。
   */
  const openLedgerRowMenu = useCallback(
    (featureId: FeatureId, clientX: number, clientY: number): void => {
      store.getState().setActiveFeature(featureId);
      contextMenuOpenerRef.current?.open({
        clientX,
        clientY,
        hit: { kind: HIT_KIND.FeatureBody, featureId },
      });
    },
    [store],
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
  /**
   * いま描いているカメラと画面の大きさ（増分 3 の吸着が「画面上の距離」を測るのに要る）。
   * 地図がまだ載っていなければ null ―― そのときは吸着そのものが成り立たない。
   * **描画と同じ 1 本**（`ports.readCamera`）を読む（教訓 5.29）。
   */
  const readCamera = useCallback(
    (): { readonly camera: RenderCameraInput; readonly viewport: Viewport } | null =>
      rendererRef.current?.readCamera() ?? null,
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

  /**
   * **対象色**（`markedFeatures` を地図へ描く。増分 7 / 設計書 §D.5・結合点 #4）。
   *
   * **道具のオーバーレイとは別のスロット**（`drawMarked`）へ押し込む ―― 印は道具を
   * 持っていなくても立っているので、道具が排他で使う 1 枚に相乗りさせると道具を降りた
   * 瞬間に消える（測量の層を別にしてあるのと同じ理由）。
   *
   * 形は確定と同じ live-lookup（`leafShapeAt`）で解く ―― 描いたものと、まとめて直す
   * 相手が食い違わない（教訓 5.29）。印が空なら `[]` を押し込んで消える（教訓 5.18）。
   */
  //
  // **App はドメインと時刻を丸ごと購読しない**（反証 2-8）。旧版は引き直しの契機として
  // `useStore(s => s.domain)` と `useStore(s => s.currentTime)` を読んでいたので、
  // **時刻を 1 年動かすたびに App 全体（数千行の木）が再レンダー**していた。引き直しの
  // 契機は `store.subscribe` で拾い、React の再レンダーには乗せない（教訓 5.74 の
  // 「描き直しは購読で、組み直しは state で」）。
  const markedFeaturesRef = useRef<ReadonlySet<FeatureId>>(markedFeatures);
  markedFeaturesRef.current = markedFeatures;
  useEffect(() => {
    const paint = (): void => {
      const s = store.getState();
      rendererRef.current?.drawMarked(
        buildMarkedHighlight(markedDrawInputs(s.domain, s.currentTime, markedFeaturesRef.current)),
      );
    };
    paint();
    let lastDomain = store.getState().domain;
    let lastTime = store.getState().currentTime;
    return store.subscribe((s) => {
      if (s.domain === lastDomain && s.currentTime === lastTime) return;
      const timeMoved = s.currentTime !== lastTime;
      lastDomain = s.domain;
      lastTime = s.currentTime;
      // **その年に居なくなった印は外す**（Fable #5）。印は「まとめて直す相手」なので、
      // 居ない地物を数え続けると帯の件数と実際に直せる件数が食い違う。外した件数は
      // 黙って減らさずに状態行へ出す（教訓 5.12）。
      if (timeMoved && markedFeaturesRef.current.size > 0) {
        const alive = new Set(featuresAt(s.domain, s.currentTime).map((f) => f.id));
        const kept = [...markedFeaturesRef.current].filter((id) => alive.has(id));
        const dropped = markedFeaturesRef.current.size - kept.length;
        if (dropped > 0) {
          s.setFeatureMarks(kept);
          statusMessageStore.notice(APP_STRINGS.markDroppedByTime(dropped));
        }
      }
      paint();
    });
    // 印が動いたときは React 側から、ドメイン・時刻が動いたときは購読から引き直す。
  }, [store, markedFeatures, statusMessageStore]);

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
  nextRingIdRef.current = () => asRingId(sharedMint('r'));

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
  // `anchorTime` is REQUIRED and is the COMMAND's own commit/anchor time — NOT read
  // from the store here — because each commit path states the time it actually wrote
  // at. 素性の保存は **現在時刻**（増分 2 / 設計書 §D.3。以前は「選択中の錨の開始時刻」
  // だったが、その契約はもう無い）、存続期間の編集は動かした錨の時刻で、どちらも
  // 描画中の時刻とずれうる。各呼び出し元が自分の時刻を言う（全コミット経路 threaded below）。 maybeComposeAutoRecolor SHORT-
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
      // D1: 全編集経路がここを通るので、結果もここから 1 回だけ出す。語彙の混在
      // （内部の英語 5 / 日本語 4）は `commandLabelJa` の写像表で出口 1 か所で解く
      // （開発ガイド §5.51 / 現状.md B7）。対象の名前を運ぶのは別の作業なので、
      // 名前を知っている呼び出し元（削除）だけが直後に自分の文言で上書きする。
      announceResult(RESULT_STRINGS.done(commandLabelJa(wrapped.label)));
    },
    [store, refreshUndoRedoEnabled, announceResult],
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

  // 断りの理由を状態行の「直前の結果」へ（A5 / A6）。成功と同じ 1 つの枠に出す
  // （設計書 §H.5: 失敗も同じ場所。無反応にしない）。
  announceCarryForwardRef.current = (
    fromYear: number,
    toYear: number,
    anchorCount: number,
  ): void => {
    announceResult(APP_STRINGS.vertexCarriedForward(fromYear, toYear, anchorCount));
  };

  zoomCommandNoticeRef.current = (
    direction: ZoomDirection,
    zoomBefore: number,
    range: ZoomRange,
  ): void => {
    const refusal = zoomLimitRefusal(direction, zoomBefore, range, store.getState().projectSettings);
    if (refusal === null) {
      zoomLimitNoteStore.clear();
      return;
    }
    zoomLimitNoteStore.show(refusal.side, zoomBefore);
    statusMessageStore.failure(refusal.status);
  };

  announceEditRejectionRef.current = (rejected: RejectedResult): void => {
    statusMessageStore.failure(editRejectionMessage(rejected));
  };

  announceEditRefusalRef.current = (reason: EditRefusalKind): void => {
    statusMessageStore.failure(
      reason === EDIT_REFUSAL.LongDrag
        ? APP_STRINGS.editRefusedLongDrag
        : APP_STRINGS.editRefusedOutsideWorld,
    );
  };

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
      // D1: これから取り消される操作の名前は、**取り消す前の** undo スタックの先頭にある。
      const undoneLabel = historyRef.current.undoStack.at(-1)?.label;
      const step = historyUndo(historyRef.current);
      if (step.history === historyRef.current) return; // empty stack: no-op
      // bughunt (全 undo 後の dirty 解消): an undo recomputes projectDirty against the
      // last SAVED baseline (applyUndoRedoResult) instead of forcing it true, so undoing
      // back to the saved state clears the unsaved-changes warning. An ordinary edit
      // still dirties through applyCommandResult (recordCommand) — that path is unchanged.
      applyHistoryStep(step, undefined);
      statusMessageStore.success(RESULT_STRINGS.undone(commandLabelJa(undoneLabel)));
    };
    const runRedo = (): void => {
      // Recover the preference the commit promoted for the command redo re-applies
      // (the top of the CURRENT redo stack) BEFORE the transition pops it, so the
      // promoted selection is restored on redo (第6波 redo-drops-selection-preference).
      const preference = redoPreferenceRef.current.preferenceForNextRedo(
        historyRef.current,
      );
      // D1: やり直される操作の名前は、**やり直す前の** redo スタックの先頭にある。
      const redoneLabel = historyRef.current.redoStack.at(-1)?.label;
      const step = historyRedo(historyRef.current);
      if (step.history === historyRef.current) return;
      // Symmetric to runUndo: a redo recomputes dirty against the saved baseline (redoing
      // away from the saved state re-dirties; redoing back onto it stays clean).
      applyHistoryStep(step, preference);
      statusMessageStore.success(RESULT_STRINGS.redone(commandLabelJa(redoneLabel)));
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
  }, [registry, store, refreshUndoRedoEnabled, statusMessageStore]);

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
    () =>
      createLiveEditBinding({
        getRoot: () => store.getState().domain,
        // U4 study fix — id minters for the U06 resolution write-back (shared series;
        // without them a vertex-delete conflict could never be resolved, only Cancelled).
        nextVertexId: () => asVertexId(sharedMint('v')),
        nextRingId: () => asRingId(sharedMint('r')),
      }),
    [store, sharedMint],
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
  // A8 — 削除の確認を **3 経路で 1 つ**にする。
  //
  // **これまで確認があったのは素性欄のボタンだけだった。** Delete キーと右クリックの
  // 「削除」は同じ「地物の全錨削除」を確認なしで即座に実行し、しかも画面には何も
  // 出なかった（消えたことに気づかないまま作業が進む）。所有者の裁定は「消す前に何が
  // 起きるかを必ず見せる」なので、どの経路も同じ `DeleteConfirmDialog` を通す。
  // 影響の一覧（道連れになる集約地物・昇格する子）の本格版は増分 7 に入る。
  /**
   * 「この年に終わったことにする」の断りを、右クリックの組み立てからも引けるようにする
   * （反証 2-9）。判定は下の `endHereRefusalFor` 1 か所にあり、宣言の順が逆なので
   * 参照だけを持ち回す（`resolveDeleteImpactRef` と同じ形）。
   */
  const endHereRefusalForRef = useRef<((featureId: FeatureId) => string | null) | null>(null);

  const [pendingDelete, setPendingDelete] = useState<{
    readonly featureId: FeatureId;
    readonly name: string | null;
    /**
     * **押した瞬間に 1 度だけ**数えた影響（反証 2-7）。render のたびに数え直すと、
     * 全錨の走査（実データで 400 地物 × 全錨）が板を開いている間ずっと回る。
     */
    readonly view: DeleteImpactView;
  } | null>(null);
  /**
   * 影響の数え上げは下（`resolveDeleteImpactFor`）で作るが、削除の漏斗はそれより上に
   * 居る。宣言の順を入れ替えると読み筋が壊れるので、参照だけを持ち回す。
   */
  const resolveDeleteImpactRef = useRef<((featureId: FeatureId) => DeleteImpactView) | null>(
    null,
  );

  /** いま有効な地物の表示名（分からなければ null）。確認と結果の文言に使う。 */
  const featureNameOf = useCallback(
    (featureId: FeatureId): string | null => {
      const s = store.getState();
      return featureByIdAt(s.domain, s.currentTime, featureId)?.attributes.name ?? null;
    },
    [store],
  );

  /**
   * 確認が済んだ削除を実行する（3 経路の合流点）。U31 の全錨削除を **1 つの取り消し
   * 単位**として記録し、状態行に「〈名前〉を削除しました」を出す。対象が既に居ない
   * ときは何もしない（幽霊の取り消し単位を作らない＝教訓 5.24）。
   */
  const commitFeatureDelete = useCallback(
    (featureId: FeatureId): void => {
      const name = featureNameOf(featureId);
      const command = createDeleteFeatureCommandForRoot(store.getState().domain, featureId);
      if (command === null) return;
      // fr100: the 全錨 delete has no single anchor time (it sweeps every anchor);
      // the recolor evaluates at the CURRENT view time.
      recordCommand(command, undefined, store.getState().currentTime);
      // recordCommand は「地物の削除しました」まで出すので、名前を知っているここが
      // 「〈名前〉を削除しました」で上書きする（削除だけは何を消したかを名指しする）。
      statusMessageStore.success(RESULT_STRINGS.deleted(name));
    },
    [store, recordCommand, featureNameOf, statusMessageStore],
  );

  /**
   * **頂点を消す前の確認**（N-05 / 設計書 §A.3。増分 7 の中身 7）。
   *
   * 頂点の削除だけは確認が無く、しかも **残る頂点が形として成り立たない数になると
   * 地物ごと消える**。取り消せるとはいえ、何が起きるかを言わずに消すのは削除の作法から
   * 外れているので、地物の削除・錨の削除・輪郭の削除と **同じ器**を通す。
   */
  const [pendingVertexDelete, setPendingVertexDelete] = useState<{
    readonly selection: EditDeleteSelection;
    /**
     * この削除で **地物そのものが消えるか**（Fable #3 / バグ狩り #4）。以前は条件なしに
     * 「この地物そのものが消えます」と出していたので、3 個ある頂点のうち 1 個を消す
     * だけでも「消えます」と脅していた。押した瞬間にドメインの計画（`buildVertexDeletePlan`）
     * を 1 度だけ引いて、実際に閾値を割るときだけ出す。
     */
    readonly wholeFeature: boolean;
  } | null>(null);

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
          // A8: Delete キー / 編集メニュー / 右クリックの「削除」は、ここで **確認を
          // 挟む**（これまでは即座に消えていた）。実際の削除は commitFeatureDelete。
          // 対象が既に居なければ確認も出さない（教訓 5.24 の no-op ガードを前倒し）。
          if (createDeleteFeatureCommandForRoot(store.getState().domain, featureId) === null) {
            return;
          }
          const view = resolveDeleteImpactRef.current?.(featureId);
          if (view === undefined) return;
          setPendingDelete({ featureId, name: featureNameOf(featureId), view });
        },
        // 増分 8E の手直し: 頂点の削除が穴・飛び地の関門で断られたら、理由を状態行へ出す。
        onRejected: (rejected) => announceEditRejectionRef.current?.(rejected),
      });
    },
    [store, recordCommit, vertexDeleteBinding, featureNameOf],
  );

  /**
   * 削除の入口（Delete キー / 編集メニュー / 右クリック）。**頂点を選んでいるときは
   * 確認を挟む**（増分 7 の中身 7）。地物を選んでいるだけのときは、漏斗の中の
   * `deleteFeatureAllAnchors` が影響の一覧を出すので、ここでは素通しする。
   */
  const requestDelete = useCallback(
    (selection: EditDeleteSelection): void => {
      if (selection.vertexIds.size > 0 && selection.vertexOwner !== null) {
        const plan = buildVertexDeletePlan(
          { getRoot: () => store.getState().domain, getTime: () => store.getState().currentTime },
          { ownerFeatureId: selection.vertexOwner, vertexIds: selection.vertexIds },
        );
        if (plan === null) return; // 何も起きない（教訓 5.24 幽霊の取り消しを作らない）。
        setPendingVertexDelete({ selection, wholeFeature: plan.kind === 'delete-feature' });
        return;
      }
      runDeleteFunnel(selection);
    },
    [runDeleteFunnel, store],
  );

  useEffect(() => {
    const deleteSelected = (): void => {
      // The live selection is the target (Delete キー / 編集メニュー path).
      requestDelete(store.getState().selection);
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
  }, [registry, store, requestDelete]);

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
  // SAME store transitions the toolbar buttons drive (単一真実源, 教訓 5.29): arm the
  // tool WITH the current selection pinned so the just-right-clicked target stays
  // selected across the reset契約 (教訓 5.11; setActiveTool clears by default).
  //
  // **増分 5b: `setMode(Edit)` を先に立てるのをやめた。** モードは道具から導出される
  // ようになったので（設計書 §D.1）、ここで立てるのは二重であり、しかも **鍵が
  // 閉じているときに黙って開けてしまう**（K-6 の抜け道）。鍵が閉じていれば
  // `setActiveTool` 自身が構えを断る。
  const armEditTool = useCallback(
    (tool: ToolId): void => {
      const s = store.getState();
      const retained = s.selection;
      s.setActiveTool(tool, retained);
    },
    [store],
  );

  // fr96 EditProperties — 右パネルの「選んだ地物」の区画へ寄せる（増分 4 / 結合点 #3）。
  //
  // **旧: `document.getElementById('sidebar-tab-properties')?.click()`。** タブの DOM が
  // 在ることと、押すと切り替わることの両方に依存していて、**排他タブをやめて上下 2 区画に
  // した瞬間に成り立たなくなる**（同じ箇所のコメント自身が「明示的なタブ状態 API は
  // shell の改修になるので後回し」と認めていた）。増分 4 でその API を作ったので、
  // ここは口を 1 回呼ぶだけになった（教訓 5.33: 層をまたぐ契約は型で固定する）。
  //
  // 2 区画なので「切り替える」ではなく「その区画を先頭まで戻して印を移す」である
  // （設計書 §I.3）。対象の地物は呼び出し側が既に `setActiveFeature` で選んでいる。
  const focusPropertyTab = useCallback((): void => {
    sidebarFocusStore.focus(SIDEBAR_SECTION.Properties);
  }, [sidebarFocusStore]);

  /**
   * その時刻ちょうどに錨があるか（＝この保存は上書きか、新設か）。**編集が実際に
   * 書き込まれる系列**をドメインと同じ `findHistoryContaining` で引いて判定する
   * （まとめ役の子は親の系列に書かれる、設計書 §C.6 / 教訓 5.30 単一真実源）。
   */
  const anchorExistsAt = useCallback(
    (featureId: FeatureId, at: TimePoint): boolean => {
      const root = store.getState().domain;
      const found = findHistoryContaining(root, featureId, at, calendar);
      if (found === undefined) return false;
      return found.history.series.entries.some(
        (e) => compareTimePoints(e.start, at, calendar) === 0,
      );
    },
    [store, calendar],
  );

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
        // 「この年に錨を作る」の出し分け（増分 2 の手直し A5 / GPT#9）。組み立ては純粋で
        // 錨の系列を知らないので、**対象の地物を組み立てと同じ判定で解いてから**ここで
        // ドメインを引く。既に錨がある年では出したまま灰色にして理由を見せる
        // （「押せる項目を押したら拒否される」をなくす、出す=起きる, 教訓 5.6）。
        hasAnchorAt: (fid) => anchorExistsAt(fid, toYearPoint(s.currentTime)),
        // 「この年に終わったことにする」の出し分け（反証 2-9）。**素性欄のボタンと
        // 同じ関数**で判定する ―― 素性欄では灰色なのに右クリックでは押せて、押すと
        // 状態行に断りが出るだけ、という不揃いを無くす（出す=起きる, 教訓 5.6）。
        endHereBlocked: (fid) => endHereRefusalForRef.current?.(fid) != null,
        // 対象の印（増分 7 / 設計書 §D.5・§I.3）。**右クリックした瞬間の集合**を模型が
        // 運ぶので、「選んだ n 件をまとめて…」は出したときと同じ相手に発火する。
        markedFeatureIds: s.ledger.marked,
      });
    },
    [store, anchorExistsAt],
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
  /**
   * まとめ役の **全下位領域**へ印をつける（FR-48 後半 / 増分 7 の中身 3）。展開は
   * ドメインの `resolveTargetLeaves` に任せる ―― 「対象は末端に限る」という制約は
   * その関数が守っているので、ここで 2 つ目の展開規則を書かない（教訓 5.29）。
   */
  const markSubtreeOf = useCallback(
    (featureId: FeatureId): void => {
      const s = store.getState();
      // **孫まで**広げる（反証 2-10）。旧版は `resolveTargetLeaves` を 1 段しか通して
      // いなかったので、まとめ役の下にまとめ役が居ると「全下位領域」と言いながら
      // まとめ役だけに印が付いていた。確定と同じ洗い直し（`planAffiliationTargets`）を
      // 通せば、末端まで畳んだ集合が返る（教訓 5.29: 予告と確定が同じ規則を見る）。
      const leaves = planAffiliationTargets(featuresAt(s.domain, s.currentTime), [featureId])
        .leafIds;
      if (leaves.length === 0) {
        statusMessageStore.failure(APP_STRINGS.markSubtreeEmpty);
        return;
      }
      s.setFeatureMarks(leaves);
      statusMessageStore.success(APP_STRINGS.markSubtreeDone(leaves.length));
    },
    [store, statusMessageStore],
  );

  /**
   * 対象のうち **自分の歴史をまだ持っていない**件数（司令塔の決定 (1) の予告に使う）。
   * まとめ役の錨に居候している地物は、所属を変えた瞬間に自分の系列が起きる。
   */
  const countWithoutOwnSeries = useCallback(
    (featureIds: readonly FeatureId[]): number => {
      const histories = store.getState().domain.histories;
      return featureIds.filter((id) => !hasOwnSeries(histories, id)).length;
    },
    [store],
  );

  /**
   * 印を付けた地物の所属をまとめて変える（増分 7 の中身 2b / V8）。印はそのままにして
   * **所属変更の道具を構えるだけ** ―― 道具が印を対象として引き継ぐ（`markedFeatureIds`）。
   */
  const reparentMarked = useCallback(
    (featureIds: ReadonlySet<FeatureId>): void => {
      store.getState().setFeatureMarks(featureIds);
      armEditTool(TOOL_ID.EditReparent);
    },
    [store, armEditTool],
  );

  /**
   * まとめて種別を付ける板を開く（増分 7 の中身 8）。確定は 1 つの複合コマンドになるので、
   * 335 件でも Ctrl+Z 1 回で戻る。
   */
  const [bulkKindTargets, setBulkKindTargets] = useState<readonly FeatureId[] | null>(null);
  const openBulkKindLabel = useCallback((featureIds: ReadonlySet<FeatureId>): void => {
    if (featureIds.size === 0) return;
    setBulkKindTargets([...featureIds]);
  }, []);

  const commitBulkKindLabel = useCallback(
    (kindLabel: string): void => {
      const targets = bulkKindTargets;
      if (targets === null) return;
      const s = store.getState();
      const at = toYearPoint(s.currentTime);
      const built = createBulkKindLabelCommandForRoot(s.domain, targets, kindLabel, at);
      setBulkKindTargets(null);
      if (built === null) {
        statusMessageStore.failure(PROPERTY_STRINGS.bulkKindNoChange);
        return;
      }
      recordCommand(built.command, undefined, at);
      statusMessageStore.success(
        PROPERTY_STRINGS.bulkKindDone(built.changedIds.length, kindLabel),
      );
    },
    [bulkKindTargets, store, recordCommand, statusMessageStore],
  );

  /**
   * 「この年に終わったことにする」（設計書 §A.3 の削除の入口 A / 増分 7 の中身 5）。
   *
   * **削除ではない。** いま見ている年に効いている錨の存続期間へ終了を打つ（U09 の
   * `setEnd`）。取り消しは Ctrl+Z 1 手で、既存の存続期間コマンド 1 本を通す
   * （2 つ目の経路を作らない＝教訓 5.30）。
   */
  const endHereRefusalFor = useCallback(
    (featureId: FeatureId): string | null => {
      const s = store.getState();
      const own = s.domain.histories.find((h) => h.featureId === featureId);
      if (own !== undefined) return null;
      // まとめ役の子（実データで 86 件）は自分の系列を持たない。親の錨に終了を打つと
      // **親が終わって**しまうので、ここからは断って上位領域へ案内する（設計書 §C.6）。
      // **親欄と同じ源から引く**（Fable #7）。旧版は「記録を持っている歴史の持ち主」
      // だけを見ていたので、所属を変えた直後は **移す前の親の名前**が出ていた（古い名前）。
      // まず地物自身の `parentId`（＝素性欄の親欄が出しているもの）を見て、それが
      // 引けないときだけ記録の持ち主へ落ちる。どちらも引けなければ名前を出さない。
      const feature = featureByIdAt(s.domain, s.currentTime, featureId);
      const byParent =
        feature?.parentId === undefined
          ? undefined
          : featureByIdAt(s.domain, s.currentTime, feature.parentId)?.attributes.name;
      const found = findHistoryContaining(s.domain, featureId, s.currentTime, calendar);
      const byHistory =
        found === undefined
          ? undefined
          : featureByIdAt(s.domain, s.currentTime, found.history.featureId)?.attributes.name;
      const ownerName = byParent ?? byHistory;
      return ownerName === undefined || ownerName === ''
        ? PROPERTY_STRINGS.endHereNoOwnSeriesUnnamed
        : PROPERTY_STRINGS.endHereNoOwnSeries(ownerName);
    },
    [store, calendar],
  );
  // 右クリックの組み立てから同じ判定を引けるようにする（反証 2-9）。
  endHereRefusalForRef.current = endHereRefusalFor;

  /**
   * 終わりを打つ本体（板を通った後も、板を出さない地物も、ここ 1 本を通る）。
   * `at` は **押した瞬間の年**（板が出ているあいだに年が動くことは無いが、控えた値で打つ）。
   */
  const commitEndHere = useCallback(
    (featureId: FeatureId, at: TimePoint, name: string): void => {
      const s = store.getState();
      const history = s.domain.histories.find((h) => h.featureId === featureId);
      if (history === undefined) return;
      // いまの年に効いている錨（開始が現在時刻以下のうち最後のもの）。
      const entry = [...history.series.entries]
        .reverse()
        .find((e) => compareTimePoints(e.start, at, calendar) <= 0);
      if (entry === undefined) {
        statusMessageStore.failure(PROPERTY_STRINGS.endHereNoOwnSeries(''));
        return;
      }
      try {
        anchorIntervalDispatchRef.current?.dispatchAnchorInterval(
          buildSetEndIntent(featureId, entry.anchor.id, at),
        );
        // **終わらせても選択は保つ**（司令塔の決定 (12)）。確定後の選択の洗い直しは
        // 「その年に居ない地物」を外すので、押した瞬間に素性欄もレーンも空になり、
        // **終端が見えないまま**になっていた。ここで選び直せば、レーンに終端の印が
        // 立っているのが読める（読むだけでも選べる＝増分 2 の裁定と同じ立場）。
        store.getState().setActiveFeature(featureId);
        statusMessageStore.success(PROPERTY_STRINGS.endHereDone(name, formatYear(at.year)));
      } catch (e) {
        statusMessageStore.failure(e instanceof Error ? e.message : String(e));
      }
    },
    [store, calendar, statusMessageStore],
  );

  /**
   * **まとめ役を終わらせる前の影響の板**（司令塔の決定 (2)）。素性欄のボタンと右クリックの
   * 項目は、どちらもこの `endFeatureHere` に合流するので、板もここ 1 か所で出す。
   */
  // --- 項目 6: 時刻レールの右クリック（設計書 §I.3）---------------------------
  /** 「この錨の開始年を変える」の口（素性欄の存続期間の欄を開いて焦点を置く）。 */
  const anchorStartEditRef = useRef<AnchorStartEditStore | null>(null);
  anchorStartEditRef.current ??= new AnchorStartEditStore();
  const anchorStartEditStore = anchorStartEditRef.current;
  const requestRailAnchorStartEdit = useCallback(
    (entry: AnchorEntry): void => {
      focusPropertyTab();
      anchorStartEditStore.request(entry.anchor.id);
    },
    [focusPropertyTab, anchorStartEditStore],
  );
  /** 「この錨を消す」の板（押した瞬間の対象を控える）。 */
  const [pendingRailAnchorDelete, setPendingRailAnchorDelete] = useState<{
    readonly featureId: FeatureId;
    readonly entry: AnchorEntry;
  } | null>(null);
  const requestRailAnchorDelete = useCallback(
    (entry: AnchorEntry): void => {
      const featureId = store.getState().selection.activeFeature;
      if (featureId === null) return;
      setPendingRailAnchorDelete({ featureId, entry });
    },
    [store],
  );

  const [pendingEndHere, setPendingEndHere] = useState<{
    readonly featureId: FeatureId;
    readonly at: TimePoint;
    readonly name: string;
    /** 押した瞬間に 1 度だけ数えた影響（板を開いているあいだ数え直さない）。 */
    readonly view: EndHereImpactView;
  } | null>(null);

  const endFeatureHere = useCallback(
    (featureId: FeatureId): void => {
      const refusal = endHereRefusalFor(featureId);
      if (refusal !== null) {
        statusMessageStore.failure(refusal);
        return;
      }
      const s = store.getState();
      const at = toYearPoint(s.currentTime);
      // **名前は打つ前に取る**（Fable #6 / バグ狩り #6）。終了を打つとその年には
      // 居なくなるので、あとから引くと必ず空になり、状態行が「を 1500 年に終わった
      // ことにしました」と読めない文になっていた。
      const name = featureNameOf(featureId) ?? '';
      // **子が居るときだけ板を出す**（決定 (2) / 実装係 2 の判断。進捗 増分7.md §12.6）。
      // 数え上げは確定（`createAnchorIntervalCommandForRoot`）と同じ
      // `childrenPromotedByEnding`（居候＋自分の系列を持つ子）を通し（教訓 5.26 / 5.29:
      // 予告と確定で別の数え方を作らない）、そのうち **この年に居る**子だけを「この年から
      // 最上位になります」と言う ―― それより前に終わっていた子は画面上の姿が変わらない。
      // 子が 1 件も居なければ、起きることは「この地物が終わる」だけで、それはボタンの文が
      // そのまま言っている（Ctrl+Z 1 回で戻る）ので、板は出さない。
      const promoted = childrenPromotedByEnding(s.domain.histories, featureId, at, calendar).filter(
        (id) => featureByIdAt(s.domain, at, id) !== null,
      );
      if (promoted.length === 0) {
        commitEndHere(featureId, at, name);
        return;
      }
      const promotedNames = promoted
        .map((id) => featureByIdAt(s.domain, at, id)?.attributes.name ?? '')
        .filter((n) => n !== '');
      setPendingEndHere({
        featureId,
        at,
        name,
        view: buildEndHereImpactView({
          targetName: name,
          yearLabel: formatYear(at.year),
          promotedCount: promoted.length,
          promotedNames,
        }),
      });
    },
    [store, calendar, endHereRefusalFor, statusMessageStore, featureNameOf, commitEndHere],
  );

  /**
   * **素性欄の親欄の 3 ボタンから所属変更へ入る**（G-3 / FR-46 must / 設計書 §C.6 の
   * 「保存の対象」。増分 7 の中身 3b）。
   *
   * **素性欄は所属変更の別の入口であって、別の実装ではない** ―― 押すと、道具と同じ
   * 手順・同じ確認・同じ進行表示・同じ分け残しの名前欄に合流する。ここがやるのは
   * 「その地物を対象にして道具を構え、板をどの枝で開くかを言う」だけである。
   */
  const [reparentOpenRequest, setReparentOpenRequest] = useState<{
    readonly nonce: number;
    readonly choice: ReparentChoice;
  } | null>(null);
  const reparentOpenNonceRef = useRef(0);
  const enterReparentFor = useCallback(
    (featureId: FeatureId, choice: ReparentChoice): void => {
      store.getState().setFeatureMarks([featureId]);
      armEditTool(TOOL_ID.EditReparent);
      reparentOpenNonceRef.current += 1;
      setReparentOpenRequest({ nonce: reparentOpenNonceRef.current, choice });
    },
    [store, armEditTool],
  );

  /**
   * 「全部の年から消す」の前に見せる影響の一覧（設計書 §A.3 / 増分 7 の中身 6）。
   * 全錨を平らにしてドメインの説明器へ渡し、返ってきた件数と ID を文にする。
   * **押した瞬間に 1 度だけ**呼ばれる（全錨の走査なので、画面に居るあいだ回さない）。
   */
  const resolveDeleteImpactFor = useCallback(
    (featureId: FeatureId): DeleteImpactView => {
      const s = store.getState();
      // 実行（createDeleteFeatureCommandForRoot）と同じ「時刻ごとの全系列の束」の見方で数える
      // （教訓 5.26）。錨 1 枚だけで数えると、子が自分の系列を持つまとめ役を
      // 「自動で消える」と誤って予告する。
      const { state: deletionState } = deletionStateFromHistories(s.domain.histories, calendar);
      const ownYears = (s.domain.histories.find((h) => h.featureId === featureId)?.series.entries ??
        []).map((e) => e.start.year);
      const impact = describeDeletionImpact(deletionState, featureId, ownYears);
      return buildDeleteImpactView({
        impact,
        targetName: featureNameOf(featureId) ?? '',
        nameOf: (id) => featureByIdAt(s.domain, s.currentTime, id)?.attributes.name ?? null,
      });
    },
    [store, featureNameOf, calendar],
  );
  // 上の漏斗から呼べるようにする（宣言の順を入れ替えずに済ませる）。
  resolveDeleteImpactRef.current = resolveDeleteImpactFor;

  const onSelectMenuItem = useCallback(
    (itemKind: MenuItemKind, model: ContextMenuModel): void => {
      launchMenuItem(itemKind, model, {
        getRoot: () => store.getState().domain,
        getTime: () => store.getState().currentTime,
        dispatchEditDelete: () => registry.dispatch(COMMAND_ID.EditDelete),
        deleteVertices: (ownerFeatureId, vertexIds) =>
          requestDelete({ activeFeature: null, vertexOwner: ownerFeatureId, vertexIds }),
        openProperties: (featureId) => {
          store.getState().setActiveFeature(featureId);
          focusPropertyTab();
        },
        // 増分 2 の中身 3「この年に錨を作る」(FR-57 / 設計書 §D.3): 右クリックからも
        // **既存のコマンド 1 本**を投げるだけにする。まず対象を選び (zustand の set は同期なので、
        // 次の行の dispatch は必ずこの選択を見る)、そのうえで COMMAND_ID.EditCreateAnchorHere を
        // 投げる。「その年に錨が無いときだけ効く」「年ちょうどのときだけ効く」の判定は
        // そのコマンドの canRun 1 か所にあり、右クリック用の 2 つ目の判定は書かない
        // (教訓 5.13 / 5.30)。既に錨がある年なら canRun が偽なので何も起きない
        // (幽霊の取り消しを作らない、教訓 5.24)。読むだけのときは編集項目そのものが
        // 組み立てられない (compose の canEdit 一括無効化) ので、この経路には来ない。
        createAnchorHere: requestCreateAnchorHere,
        armEditTool,
        unshare: (vertexIds, ownerFeatureId) => runUnshareIntent(vertexIds, ownerFeatureId),
        // FR-113 個別非表示: force-hide the right-clicked feature through the session
        // display filter (no domain mutation / history / dirty). Works in View mode too.
        hideFeature: (featureId) => store.getState().setFeatureHidden(featureId, true),
        // FR-113 Phase 2 強調/強調解除: session display filter only (no domain mutation /
        // history / dirty). Works in View mode too, symmetric with 個別非表示.
        setFeatureEmphasized: (featureId, emphasized) =>
          store.getState().setFeatureEmphasized(featureId, emphasized),
        // --- 増分 7: 対象の印とまとめての編集（設計書 §D.5 / §I.3）-----------------
        setFeatureMarked: (featureId) => store.getState().toggleFeatureMark(featureId),
        markSubtree: markSubtreeOf,
        reparentMarked,
        bulkKindLabel: openBulkKindLabel,
        endHere: endFeatureHere,
      });
    },
    [
      store,
      registry,
      requestDelete,
      focusPropertyTab,
      armEditTool,
      runUnshareIntent,
      markSubtreeOf,
      reparentMarked,
      openBulkKindLabel,
      endFeatureHere,
    ],
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
    /**
     * **Escape の階段の下 3 段**（設計書 §D.4 / `shell/escape-ladder.ts`。増分 5c）。
     *
     * 旧版は 1 回で `clearSelection()`（頂点と地物を同時に空）だった。頂点を 3 つ
     * 選んだあと「地物だけ選んだ状態へ戻したい」ときに戻り道が無く、選び直しに
     * なっていた。**1 段ずつ戻す**ことで「連打すれば必ず素の状態」と「1 つ前へ戻る」
     * の両方が成り立つ。
     *
     * 上の段（板・ポップオーバー・入力欄・道具の下書き）は、それぞれの部品が捕捉段の
     * Escape を持っていて下へ流さないので、ここへは来ない。
     */
    const ladderInput = (): {
      hasVertexSelection: boolean;
      hasActiveFeature: boolean;
      hasNonSelectTool: boolean;
    } => {
      const s = store.getState();
      return {
        hasVertexSelection: s.selection.vertexIds.size > 0 && s.selection.vertexOwner !== null,
        hasActiveFeature: s.selection.activeFeature !== null,
        hasNonSelectTool: !isSelectTool(s.activeTool),
      };
    };
    registry.register(COMMAND_ID.EditDeselect, {
      run: () => {
        const s = store.getState();
        switch (nextEscapeStep(ladderInput())) {
          case ESCAPE_STEP.ClearVertices:
            s.restoreSelection(withoutVertexSet(s.selection));
            return;
          case ESCAPE_STEP.ClearFeature:
            s.clearSelection();
            return;
          case ESCAPE_STEP.ResetTool:
            // 「選ぶ」＝ 道具を外した状態。選択はもう空なので、ここで消えるものは無い。
            s.setActiveTool(null);
            return;
          case ESCAPE_STEP.None:
            return;
        }
      },
      canRun: () => escapeHasWork(ladderInput()),
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
  /**
   * **B39 は根治を試して、いったん戻した**（`docs/現状.md` の B39。増分 7）。
   *
   * **試したこと**: 追加の確定のあとに、所属変更と同じ経路（直轄領の生成 → 末端→集約の
   * 遷移）を 1 度だけ通し、追加と遷移を 1 つの取り消し単位に畳む ―― 実装計画が
   * 「筋としては正しい」と書いていた形である。実装は動き、`leaf-with-children` は
   * 消え、開き直しの修復も出なくなった。
   *
   * **それでも戻した理由**: **2 人目以降の入れ子が 1 段ずつ深くなる。** 1 人目を確定した
   * 時点で親は集約になり、親の「分け残し（直轄領）」という **新しい面**が生まれる。その
   * あと同じ親の中に 2 人目を描くと、いちばん内側にある面は **その分け残し**なので、
   * B33 の入れ子の既定は分け残しを指す ―― 確定するとまた分け残しが生まれ、
   * 「親 直轄領 直轄領」の鎖ができる。実アプリで確認した（`snap-share-fixes.spec.ts` の
   * B2 が、2 人目の既定が親ではなく新しく生まれた面になることで落ちた）。
   *
   * **いまの挙動（修復で受ける）のほうが結果は正しい。** 読み込み時の修復は **子を全部
   * 足し終えたあと 1 回だけ**遷移させるので、親 →［子1, 子2, 子3, 直轄領］という平らな
   * 形になる。毎回の確定で遷移させると、その「1 回だけ」が「N 回」になる。
   *
   * **残っている問いは「2 人目以降をどう扱うか」**である（分け残しの下に入れ子にするのか、
   * 分け残しを分けるのか）。分け残しを分けるのは実質「分ける（ナイフ）」の操作なので、
   * **分割の UI を作り直す増分 8B** で決めるのが筋である。`docs/現状.md` の B39 に
   * この分析を書いた。
   */
  const onAddCommitted = useCallback(
    (
      result: ProcessResult<DomainRoot>,
      newFeatureId: FeatureId,
      committed?: { readonly sharedVertexCount: number },
    ) => {
      recordCommit(result, { featureId: newFeatureId }, store.getState().currentTime);
      // 増分 3: **吸着して境界を共有したことを、状態行の「直前の結果」に日本語で出す**
      // （設計書 §H.5。成功を一度も知らせない＝ C6 への手当ての 1 件）。`recordCommit` が
      // 出す「地物の追加を行いました」を、共有したときだけ上書きする。
      const shared = committed?.sharedVertexCount ?? 0;
      if (result.status === PROCESS_STATUS.Committed && shared > 0) {
        announceResult(APP_STRINGS.addedWithSharedVertices(shared));
      }
    },
    [recordCommit, store, announceResult],
  );

  // KNIFE COMMIT (C3 — 教訓 5.11 / U12): record as one history unit and promote the
  // inheritor (SplitSnapshot.touchedFeatureIds[0]) so selection re-resolves to it
  // rather than blanket-clearing (FR-94 / split-after selection retention).
  const onKnifeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: SplitSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      const inheritorId = snapshot.touchedFeatureIds[0] ?? snapshot.inheritorFeatureId;
      recordCommit(result, { featureId: inheritorId }, store.getState().currentTime);
      // **確定しても道具は降りない**（増分 5 の手直し B2 / GPT #10。設計書 §D.2）。
      //
      // 旧版はここで `setActiveTool(null)` を呼んでいた ―― HB3-17（分割が済んだのに
      // ツールバーのボタンが押されたまま残る）への手当てだったが、**5 道具のうち
      // ナイフだけが降りる**という不統一になっていた。続けて分けたい人は毎回ナイフを
      // 選び直すことになる。いまは道具の側（`useKnifeTool` の確定）が「対象選択へ戻す」
      // 再武装をするので、ボタンの押された状態とセッションの状態は食い違わない
      // （HB3-17 が言っていたデシンクは起きない）。
    },
    [recordCommit],
  );

  // MERGE COMMIT (教訓 5.11 / U12): record as one history unit and promote the result
  // feature (MergeSnapshot.resultFeatureId) so selection re-resolves to the merged
  // 地物 rather than blanket-clearing (FR-94 / merge-after selection retention).
  const onMergeCommitted = useCallback(
    (result: ProcessResult<DomainRoot>, snapshot: MergeSnapshot) => {
      if (result.status !== PROCESS_STATUS.Committed) return;
      recordCommit(result, { featureId: snapshot.resultFeatureId }, store.getState().currentTime);
      // 確定したら印を捨てる（設計書 §D.5「捨てる契機: 確定」。所属変更と揃える）。
      store.getState().clearFeatureMarks();
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
      // **確定したら印を捨てる**（Fable #5 / 設計書 §D.5「捨てる契機: 確定」）。
      // 残しておくと、道具を構え直した瞬間に同じ 3 件がまた対象になり、
      // 「もう 1 度動かすつもりは無かったのに動かせてしまう」状態になる。
      // まとめて種別を付ける側は既に捨てているので、不揃いも直る。
      store.getState().clearFeatureMarks();
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
  // A4 (c): 素性欄の「打ちかけを捨てますか」（N-04）が出ているあいだも鍵盤は確認のもの
  // である。Ctrl+K で背後に錨が増えたり、Delete で対象そのものが消えたりしないようにする
  // （教訓 5.14: 重なる UI は入力を受ける層も同時に設計する）。
  const [draftConfirmOpen, setDraftConfirmOpen] = useState(false);
  /**
   * **いま開いている「◯◯ ▾」の名前**（増分 5c / 設計書 §D.1 の `popover`）。
   *
   * 真偽値 1 個ではなく **名前の集合**にしてある。板が 2 枚以上あるとき（1 枚を開いた
   * まま別の 1 枚を開くと、閉じる報せと開く報せの順序は保証されない）、数える形だと
   * 「閉じたのに開いていることになる」「開いているのに閉じたことになる」がどちらも
   * 起きる。名前で持てば順序に依らない（教訓 5.6: 結果状態で判定する）。
   */
  const [openPopovers, setOpenPopovers] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  /**
   * **報せ口は id ごとに 1 個だけ作って使い回す**（増分 5 の手直し C4 / Opus 反証 ⑮）。
   *
   * 素直に「毎回新しい関数を返す」形にすると、それを props に持つ部品（深さ ▾・座標 ▾・
   * 表示 ▾）の要素の同一性が毎レンダー変わり、**設定欄の常設スロットが毎レンダー
   * 登録し直される** ―― 帯が毎回組み直され、地図の入力とは関係のない再レンダーが
   * オプションバー全体へ広がる（技術方針 2.3 の部分後退）。
   */
  const popoverChangeCache = useRef(new Map<string, (open: boolean) => void>());
  const popoverOpenChange = useCallback((id: string): ((open: boolean) => void) => {
    const cache = popoverChangeCache.current;
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const fn = (open: boolean): void => {
      setOpenPopovers((prev) => {
        if (prev.has(id) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    };
    cache.set(id, fn);
    return fn;
  }, []);
  /**
   * **いま開いている「本物のモーダル」の名前**（増分 5 の手直し A4 / GPT #5）。
   *
   * ポップオーバーと同じく **名前の集合**で持つ。真偽値を道具の数だけ並べると、足すたびに
   * `modalOwnsKeyboard` の OR 鎖へ 1 項目ずつ書き足す作業が要り、実際に
   * `MergeOptionsDialog` と `InheritorModal` が **抜けたまま**だった ―― どちらも本物の
   * モーダルなのに「対象を持っている」という理由だけで下書き扱いになっていたので、
   * 素性の入力や継承先の選択の途中で Ctrl+S / Ctrl+N / Ctrl+O が背後で走った。
   *
   * 名前で持てば、道具が増えても直すのは「その道具が `onModalChange` を配線する」の
   * 1 か所だけになる（教訓 5.6: 順序に依らない結果状態で持つ）。
   */
  const [openToolModals, setOpenToolModals] = useState<ReadonlySet<string>>(
    () => new Set<string>(),
  );
  // 報せ口は id ごとに 1 個だけ作って使い回す（`popoverOpenChange` と同じ理由）。
  const toolModalChangeCache = useRef(new Map<string, (open: boolean) => void>());
  const toolModalChange = useCallback((id: string): ((open: boolean) => void) => {
    const cache = toolModalChangeCache.current;
    const cached = cache.get(id);
    if (cached !== undefined) return cached;
    const fn = (open: boolean): void => {
      setOpenToolModals((prev) => {
        if (prev.has(id) === open) return prev;
        const next = new Set(prev);
        if (open) next.add(id);
        else next.delete(id);
        return next;
      });
    };
    cache.set(id, fn);
    return fn;
  }, []);
  /**
   * **常設スロットの中身は同一性を保つ**（増分 5 の手直し C4）。`PersistentOptionSlot` の
   * 登録は node の同一性で依存を張るので、ここで毎レンダー新しい要素を作ると帯が毎回
   * 組み直される。報せ口（`popoverOpenChange`）は id ごとに使い回すので、この memo は
   * 実際に永久に効く。
   */
  const depthSlotNode = useMemo(
    () => (
      <DepthOptions<DomainRoot> store={store} onOpenChange={popoverOpenChange('depth')}>
        <GlobalDepthPanel store={store} />
      </DepthOptions>
    ),
    [store, popoverOpenChange],
  );
  const gridSlotNode = useMemo(() => <GridToggleControl store={store} />, [store]);
  const surveySlotNode = useMemo(
    () => (
      <SurveyMeasurementPanel
        store={store}
        onCoordsOpenChange={popoverOpenChange('survey-coords')}
      />
    ),
    [store, popoverOpenChange],
  );

  /**
   * **メニューバーが開いているか**（増分 5 の手直し A4 / GPT #3）。標準メニューは
   * `openKey` を自分の中に閉じていて、開いていることを誰にも報せていなかった。
   * だから **メニューを開いたまま Ctrl+Z / Delete を押すと背後の地図が編集され**、
   * Escape は大域の側が先に動いて「選択解除とメニュー閉鎖」が同時に起きた。
   */
  const [menuBarOpen, setMenuBarOpen] = useState(false);
  // 鍵盤を持っているのが「ダイアログ」なのか「道具」なのかを分けて数える（増分 3）。
  // 止める理由が違えば、止めている間に通してよいものも違う。
  const modalOwnsKeyboard =
    conflictState !== null ||
    helpModalOpen ||
    fileModalOpen ||
    contextMenuOpen ||
    menuBarOpen ||
    // 道具が出した本物のモーダル（結合の選択板・継承先の板・新地物の素性入力・
    // 追加の「捨てますか」）。増分 5 の手直し A4。
    openToolModals.size > 0 ||
    draftConfirmOpen ||
    // 増分 4: 「どこへでも移動」（Ctrl+P）が開いている間は、打鍵はその入力欄のもの。
    // 開いたまま Ctrl+Z が背後へ抜けると、打っている最中に世界が巻き戻る（教訓 5.14）。
    jumpOpen;
    // NOTE（司令塔の決定 (13)）: 板ごとの真偽値をここへ書き足すのはやめた。増分 7 で
    // 足した板 5 枚（素性欄の削除・錨の削除・複数頂点の削除・輪郭の削除・まとめて種別）
    // が **まるごと書き漏れて**いて、板の上で Delete を押すと板が 2 枚重なり、Ctrl+Z が
    // 背後で走った。いまはどの板も `useModalRegistration` で自分から名乗り、
    // `openToolModals` に載る。板を足す人が直すのは「その板へ `onModalChange` を配線する」
    // 1 か所だけになる（`modal-registration.test.tsx` が名乗り漏れを総当たりで見る）。
  const toolOwnsKeyboard =
    addDrawing ||
    knifeDrawing ||
    mergeDrawing ||
    reparentDrawing ||
    ringEditDrawing ||
    drillDrawing ||
    surveyDrafting;
  /**
   * **鍵盤の持ち主**（設計書 §D.1 / §D.4、結合点 #5。増分 5c）。
   *
   * 旧版はここが **11 項目を手で OR した 1 つの真偽値**で、足すたびに「止める条件・
   * 通す集合・断りを出す条件」の 3 か所を同時に直す必要があった。実際に穴が空いて
   * いて、**所属変更の確定直後の Ctrl+Z が無反応**（報告 04 §3.5）だったのはこれが
   * 原因である ―― 道具を構えているだけで全部止まっていた。
   *
   * いまは「いちばん前に居るのは誰か」を 1 つの値に畳み、そこから可否を表で決める
   * （`shell/focus-owner.ts`）。**新しい板を足すときに直すのはこの入力 1 か所だけ。**
   */
  const textFocused = useTextFocused();
  const focusOwner = deriveFocusOwner({
    modalOpen: modalOwnsKeyboard,
    popoverOpen: openPopovers.size > 0,
    textFocused,
    toolDrawing: toolOwnsKeyboard,
    // `none`（まだ誰も持っていない）は **地図が載る前**のためにある値である。
    // 渡さないと `none` が永久に出ず、6 値のうち 1 つが死んだ語彙になる
    // （増分 5 の手直し A4 / GPT の「`none` は mapReady を渡すか消す」）。
    mapReady,
  });
  const shortcutsSuspended = suspendsShortcuts(focusOwner);
  /**
   * **道具が鍵盤を持っている間でも保存だけは通す**（増分 3。増分 1 の申し送り
   * 「追加モードで入力層が出ているあいだは Ctrl+S が届かない」）。
   *
   * 作図中の下書きはプロジェクトの一部ではないので、保存しても失われるものは無い。
   * 逆に**ダイアログが持っているときは通さない** ―― 確認の背後で保存が走ると、
   * 「何に対して答えたのか」が分からなくなる。
   */
  //
  // **B64 / Fable #8: 戻す点を持たない道具では、取り消しは大域へ譲る**（実装係 2 の判断。
  // 依頼書の候補 ①。進捗 増分7.md §12.6）。所属変更の道具は「対象を掴んでいる」ことが
  // 下書きにあたるので鍵盤の持ち主は `tool-drawing` になるが、この道具には **1 つ戻す点が
  // 無い**（`ReparentToolController` の keydown は Ctrl+Z を受けない）。だから大域を
  // 止めると Ctrl+Z / Ctrl+Y は **誰にも受けられず、画面にも何も出なかった**。止める理由
  // （道具の Ctrl+Z と二重に走らせない＝bughunt3 H2）がこの道具には無いので、通す。
  // 板が出れば持ち主は `modal` になってここは閉じる。取り消しで対象の地物が消えても、
  // 道具は確定の直前に対象を洗い直して居ないものを外す（`planAffiliationTargets`）ので
  // 対象は壊れない ―― 年を動かしたときと同じ扱いである。
  const reparentOnlyDrawing =
    reparentDrawing &&
    !addDrawing &&
    !knifeDrawing &&
    !mergeDrawing &&
    !ringEditDrawing &&
    !drillDrawing &&
    !surveyDrafting;
  const alwaysAllowedShortcuts =
    focusOwner === FOCUS_OWNER.ToolDrawing
      ? reparentOnlyDrawing
        ? HISTORY_AND_SAVE_WHILE_REPARENT_HOLDS_TARGET
        : SAVE_WHILE_TOOL_OWNS_KEYBOARD
      : undefined;
  /**
   * **止めている間に押された打鍵の理由を出す**（増分 3。現状.md B28 の第 2 の理由 /
   * 「打ちかけの確認中に Ctrl+K を押したとき、止まるだけでなく理由を出す」）。
   *
   * ダイアログが鍵盤を持っているときだけ渡す。道具が持っているときは Escape / Ctrl+Z が
   * 道具側で**実際に効いている**ので、断り文を出すと嘘になる。Escape（選択解除）は
   * ダイアログ自身が閉じる打鍵なので黙って通す。
   */
  const onSuspendedShortcut = useCallback(
    (id: CommandId): void => {
      if (id === COMMAND_ID.EditDeselect) return; // Escape はダイアログを閉じる打鍵。
      // **止めている理由が違えば、次の一手も違う**（増分 5 の手直し A4）。確認は
      // 「答える」、板は「閉じる（Esc）」である。同じ文を使い回すと、板を開いている
      // 利用者に「答えるべき確認」を探させることになる。
      const label = MENU_ITEM_LABELS[id];
      statusMessageStore.failure(
        focusOwnerRef.current === FOCUS_OWNER.Popover
          ? APP_STRINGS.shortcutBusyPopover(label)
          : APP_STRINGS.shortcutBusy(label),
      );
    },
    [statusMessageStore],
  );
  // fr96: 右クリックの口が読む ref へ、鍵盤の持ち主を毎レンダー写す（命令的に作られた
  // 口が常に現在値を見るようにするため。教訓 5.6: 古い写しを掴まない）。
  //
  // **増分 5c: 右クリックは「ダイアログが持っているとき」だけ止める**（設計書 §D.4 の
  // 表 / §I.3 の原則①「いつでも開ける ―― 道具を持っている間も」）。旧版は打鍵の門と
  // 同じ 1 本の真偽値を使い回していたので、**道具を構えているあいだ右クリックが
  // 死んでいた**。止める理由が違うものを同じ値で決めない（教訓 5.30）。
  //
  // **増分 5 の手直し A1: 判定を口の側へ移した。** 「捨てる」と「昇格させない」は別の
  // ふるまいなので、ここで真偽値へ潰さず、持ち主そのものを渡す。
  focusOwnerRef.current = focusOwner;
  toolDraftRef.current = toolOwnsKeyboard;

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
      // 増分 8E（設計書 §E.1 の V13 ⑦）: **どの重なりを片付けたのか**を状態行に残す。
      // `recordCommit` が出した「◯◯を行いました」（止まっていた操作の名前）を、こちらの
      // 文で上書きする ―― 利用者が最後に答えたのは重なりの解決だからである。年は止まって
      // いた編集の錨の年（重なりを見つけた年）を言う。状態行は時間では消えない（K-7）。
      if (result.status === PROCESS_STATUS.Committed && conflictState !== null) {
        const resolvedText = conflictResolvedMessage(
          conflictState.pending.conflicts,
          conflictState.anchorTime ?? store.getState().currentTime,
        );
        if (resolvedText !== null) statusMessageStoreRef.current?.success(resolvedText);
      }
      setConflictState(null);
      reArmActiveTool();
    },
    [recordCommit, reArmActiveTool, conflictState, store],
  );

  const onConflictCancel = useCallback(() => {
    // 増分 8E: やめたことを状態行に言う（止まっていた頂点を追加の道具が「捨てました」と
    // 言わなくなったので、その代わり。`AddToolController` の draftSizeRef の注記）。
    statusMessageStoreRef.current?.notice(RESOLVED_STRINGS.cancelled);
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
  // 増分 8E（設計書 §J.4 の結合点 #12）: **プロジェクトを開き直したら詳細パネルを全部閉じる。**
  // 上の掃除は「その id の地物がドメインから消えたか」で見るので、**同じファイルを開き直す**と
  // id が同じまま残り、前のプロジェクトのパネルが新しいプロジェクトの上に浮いたままになって
  // いた（実機の探針で確認）。読み込み・新規で必ず動く印（`projectLoadNonce`。一覧が先頭へ
  // 戻るのと同じ印）で閉じる。パネルは「前のプロジェクトの一時状態」であり、開き直しで
  // 捨てる側に属する（教訓 5.2 全経路で破棄）。
  useEffect(() => {
    let prevNonce = store.getState().projectLoadNonce;
    return store.subscribe(() => {
      const nonce = store.getState().projectLoadNonce;
      if (nonce === prevNonce) return;
      prevNonce = nonce;
      setDetailPanels((s) => (s.panels.length === 0 ? s : EMPTY_DETAIL_PANELS));
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
  // 素性の保存は行き先で **意味がまるで違う**（増分 2 / 設計書 §D.3）ので、状態行に出す
  // 操作名も分ける。束ねは label ごとに 1 つずつ作る（label は束ねの生成時に固定される）。
  const propertyEditBindings = useMemo(() => {
    const access = {
      getRoot: () => store.getState().domain,
      // U4 study fix — id minters for the U06 resolution write-back (shared series).
      // A pure attribute edit has unchanged geometry so a conflict is unlikely, but
      // the binding contract (DomainRootAccess) should never hand U13 a pipeline
      // whose resolution arm is structurally dead.
      nextVertexId: () => asVertexId(sharedMint('v')),
      nextRingId: () => asRingId(sharedMint('r')),
    };
    return {
      overwrite: createLiveEditBinding(access, UI_COMMAND_LABEL.EditOverwrite),
      newAnchor: createLiveEditBinding(access, UI_COMMAND_LABEL.EditNewAnchor),
      createAnchor: createLiveEditBinding(access, UI_COMMAND_LABEL.CreateAnchor),
    };
  }, [store, sharedMint]);
  /**
   * 「この年に錨を作る」を **鍵盤・メニュー・右クリック・素性欄の 4 経路から同じ 1 本へ
   * 流す**入口（増分 2 の中身 3。教訓 5.13 / 5.30）。
   *
   * **押せない理由を決めるのはこの 1 つの関数だけ**であり、コマンドの `canRun`、鍵盤から
   * 断られたときの理由表示、右クリックの出し分けのすべてがこれを使う（増分 2 の手直し
   * A5。教訓 5.30 過少共有と過剰共有）。戻り値は「断る理由」か null（押せる）。
   * **権限（読むだけ）はここに入れない** — それは permissions.ts の EDITING_COMMANDS が
   * 一括で行う（教訓 5.13。ここに 2 つ目の権限判定を書かない）。
   */
  const createAnchorRefusalFor = useCallback(
    (featureId: FeatureId | null): string | null => {
      if (featureId === null) return EDIT_PLAN_STRINGS.createAnchorHereNoTarget;
      const at = store.getState().currentTime;
      if (!isYearAligned(at)) {
        return EDIT_PLAN_STRINGS.reasonNotYearAligned(formatTimePoint(at), formatYear(at.year));
      }
      if (anchorExistsAt(featureId, toYearPoint(at))) {
        return EDIT_PLAN_STRINGS.createAnchorHereDisabledReason(formatYear(at.year));
      }
      return null;
    },
    [store, anchorExistsAt],
  );

  /**
   * 断った理由を状態行へ出す（設計書 §H.5「次の一手を見せる」）。**鍵盤から押しても
   * 素性欄から押しても同じ文が出る**（バグ狩り #2 / 反証 F5: Ctrl+K が黙って終わっていた）。
   */
  const reportCreateAnchorRefusal = useCallback(
    (reason: CommandRefusal): void => {
      if (reason === COMMAND_REFUSAL.ViewOnly) {
        statusMessageStore.failure(EDIT_PLAN_STRINGS.createAnchorHereViewOnly);
        return;
      }
      statusMessageStore.failure(
        createAnchorRefusalFor(store.getState().selection.activeFeature) ??
          EDIT_PLAN_STRINGS.createAnchorHereNoTarget,
      );
    },
    [store, statusMessageStore, createAnchorRefusalFor],
  );

  /**
   * 素性欄のボタン・右クリック・メニューからの入口。**可否を確かめてから選択を動かす**
   * （反証 F10: 先に選択を移していたので、断られたときだけ選択が動いて戻らなかった）。
   */
  const requestCreateAnchorHere = useCallback(
    (featureId: FeatureId): void => {
      const refusal = createAnchorRefusalFor(featureId);
      if (refusal !== null) {
        statusMessageStore.failure(refusal);
        return;
      }
      store.getState().setActiveFeature(featureId);
      if (registry.dispatch(COMMAND_ID.EditCreateAnchorHere)) return;
      // ここへ来るのはコマンドが未登録のときだけ（canRun は上とまったく同じ判定）。
      statusMessageStore.failure(EDIT_PLAN_STRINGS.createAnchorHereNoTarget);
    },
    [store, registry, statusMessageStore, createAnchorRefusalFor],
  );

  /**
   * 素性の保存（増分 2）。**編集時刻は現在時刻**で、パネルが年へ丸めて渡してくる
   * （設計書 §D.3 / 裁定 §N-2 の (A)）。保存の対象は名前・種別ラベル・見た目・詳細文書の
   * 4 つ（§C.6）で、1 回の押下＝1 つの取り消し単位に収まる。
   */
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
        const nextFeature = withDetailDocument(
          withKindLabel(
            withColor(
              // 飾りの開始年／終了年は保存の対象ではない（A7 / GPT#8）。地物が持って
              // いる値をそのまま持ち越す（画面では読み取り専用に出している）。
              withAttributes(
                feature,
                createBasicAttributes(
                  v.name,
                  feature.attributes.startYear,
                  feature.attributes.endYear,
                ),
              ),
              createColorInfo(
                v.autoColorEnabled,
                v.fillColor,
                v.selectedColor,
                v.borderColor,
                v.paletteTheme,
                v.fillOpacity,
                v.selectedOpacity,
              ),
            ),
            // 空文字 = 付いていない（ドメインが absent へ正規化する唯一の空の形）。
            v.kindLabel === '' ? undefined : v.kindLabel,
          ),
          v.detailDocument,
        );
        // Attribute / style edit: geometry is unchanged, so no vertex body moves.
        const snapshot: FeatureSnapshot = { feature: nextFeature, vertices: [] };
        const proposal = createEditProposal(intent.featureId, intent.editTime, snapshot);
        const binding = anchorExistsAt(intent.featureId, intent.editTime)
          ? propertyEditBindings.overwrite
          : propertyEditBindings.newAnchor;
        const result = binding.startProcess(proposal);
        if (result.status === PROCESS_STATUS.Committed) {
          // fr100: the recolor anchors at intent.editTime (コマンドの時刻).
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
    [store, propertyEditBindings, recordCommit, anchorExistsAt],
  );

  /**
   * 「この年に錨を作る」（Ctrl+K, 実装計画 増分 2 の中身 3 / 設計書 §D.3）。
   *
   * **保存ボタンとは別のコマンドである。** 素性欄の保存は `isNoOpEdit` の関門を持ち、
   * 値が同じなら dispatch しない（教訓 5.24: 幽霊の取り消しを作らない）。だから
   * 「1500 年から同じ姿が続くことを記録したい」は保存ボタンでは表せず、専用の経路が
   * 要る（設計書 §O の GPT V6）。中身は「現在時刻の実効スナップショットをそのまま
   * 新しい錨にする」＝ 値を変えない編集案を `applyPastEdit` へ通すことである。
   * 取り消しは 1 手（既存の recordCommit がそのまま 1 単位にする）。
   */
  const createAnchorHere = useCallback(
    (featureId: FeatureId, at: TimePoint): void => {
      const feature = featuresAt(store.getState().domain, at).find((f) => f.id === featureId);
      if (feature === undefined) return;
      const snapshot: FeatureSnapshot = { feature, vertices: [] };
      const proposal = createEditProposal(featureId, at, snapshot);
      const result = propertyEditBindings.createAnchor.startProcess(proposal);
      if (result.status === PROCESS_STATUS.Committed) {
        recordCommit(result, { featureId }, at);
      }
    },
    [store, propertyEditBindings, recordCommit],
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
  // 素性欄のボタンは自分で確認ダイアログを出してから呼ぶので、ここは合流点だけを呼ぶ
  // （3 経路とも同じ `DeleteConfirmDialog` と同じ結果の文言を通る = A8）。
  // 増分 2 の中身 3 — 「この年に錨を作る」（Ctrl+K）の登録。保存ボタンとは別の
  // コマンドで、**値を変えていなくても錨を 1 本増やす**（素性欄の `isNoOpEdit` に飲まれない）。
  // 押せるのは「地物を選んでいて」かつ「現在時刻にまだ錨が無い」ときだけで、既にある年で
  // 押しても何も増えない（幽霊の取り消しを作らない、教訓 5.24）。年ちょうどでない時刻でも
  // 押せない — 錨の開始は年だけで記録する（U-14）。読むだけでの防ぐは permissions.ts の
  // EDITING_COMMANDS が一括で行う（教訓 5.13 — ここに 2 つ目の判定を書かない）。
  useEffect(() => {
    registry.register(COMMAND_ID.EditCreateAnchorHere, {
      run: () => {
        const live = store.getState();
        const featureId = live.selection.activeFeature;
        if (featureId === null) return;
        createAnchorHere(featureId, toYearPoint(live.currentTime));
      },
      // 可否は `createAnchorRefusalFor` 1 本に寄せた（増分 2 の手直し A5）。ここに
      // 2 つ目の判定を書かない（教訓 5.30）。
      canRun: () => createAnchorRefusalFor(store.getState().selection.activeFeature) === null,
      // **黙って終わらせない。** 鍵盤（Ctrl+K）から断られたときも、素性欄のボタンや
      // 右クリックと同じ文が状態行に出る（バグ狩り #2 / 反証 F5）。
      onRefused: reportCreateAnchorRefusal,
    });
    return () => {
      registry.unregister(COMMAND_ID.EditCreateAnchorHere);
    };
  }, [registry, store, createAnchorHere, createAnchorRefusalFor, reportCreateAnchorRefusal]);

  // --- 増分 4: 探す口を 1 本にする（E-6）と「どこへでも移動」（設計書 §C.2 の 26）---
  //
  // **「地物を検索」（Ctrl+F）の行き先を変えた。** 旧: 独立した検索モーダル。母集団が
  // 一覧と別に組まれ（N-41）、年を属性の検索対象に入れていたので数字 1 文字でほぼ全件が
  // 一致した（C10）。新: **一覧の区画へ寄せて、絞り込み欄に焦点を入れる**だけ。
  // 探す・見る・直すが 1 本の母集団で閉じる。
  useEffect(() => {
    registry.register(COMMAND_ID.ToolsSearch, {
      run: () => {
        sidebarFocusStore.focus(SIDEBAR_SECTION.List);
        ledgerFilterFocusStore.focus();
      },
    });
    registry.register(COMMAND_ID.ToolsJump, { run: () => setJumpOpen(true) });
    // 増分 4 の手直し B8: 一覧の送りと改名を鍵盤・メニューから届かせる。**画面の
    // ボタンとまったく同じ 1 本**（`LedgerCommandStore` → 一覧の `stepBundle` /
    // `startEdit`）を通すので、押し方が 2 通りに分かれない（教訓 5.30）。
    registry.register(COMMAND_ID.ListBundlePrev, {
      run: () => {
        ledgerCommandStore.send(LEDGER_COMMAND.BundlePrev);
      },
      canRun: () => store.getState().ledger.bundle !== null,
    });
    registry.register(COMMAND_ID.ListBundleNext, {
      run: () => {
        ledgerCommandStore.send(LEDGER_COMMAND.BundleNext);
      },
      canRun: () => store.getState().ledger.bundle !== null,
    });
    registry.register(COMMAND_ID.ListRename, {
      run: () => {
        ledgerCommandStore.send(LEDGER_COMMAND.Rename);
      },
      canRun: () => store.getState().activeFeature !== null,
    });
    return () => {
      registry.unregister(COMMAND_ID.ToolsSearch);
      registry.unregister(COMMAND_ID.ToolsJump);
      registry.unregister(COMMAND_ID.ListBundlePrev);
      registry.unregister(COMMAND_ID.ListBundleNext);
      registry.unregister(COMMAND_ID.ListRename);
    };
  }, [registry, store, sidebarFocusStore, ledgerFilterFocusStore, ledgerCommandStore]);

  const propertyDeleteFeature = commitFeatureDelete;

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
  // 「この年に終わったことにする」が使う口を late-bind する（写しを作らない＝教訓 5.44）。
  anchorIntervalDispatchRef.current = anchorIntervalDispatch;

  // HB5-3 — the anchor-origin camera focus handed to the「錨一覧」rows. Stable
  // (reads the late-bound fit ref), so it never re-builds the sidebar memo. The
  // event-row click calls this AFTER promoting the feature + syncing time, so the
  // fit resolves the feature's shape at the錨の開始 time and writes the camera through
  // the single ports.writeCamera path. Only this錨導線 calls it — a map-click
  // selection routes through the live-selection-port and never moves the view.
  /**
   * いま選んでいる地物へ視点を合わせる（増分 3 の手直し 2 回目 / D1）。作図中は
   * `focusCameraOnFeature` が視点を止めるので、**下書きを片付けた追加の道具**が
   * このあとで呼び直す（設計書 §D.2「捨てる（確認つき）＋カメラを合わせる」）。
   */
  const focusCameraOnSelection = useCallback((): void => {
    const featureId = store.getState().activeFeature;
    if (featureId === null) return;
    if (!isToolTargetVisible(featureId)) return;
    fitCameraToFeatureRef.current?.(featureId);
  }, [store, isToolTargetVisible]);

  const focusCameraOnFeature = useCallback(
    (featureId: FeatureId): void => {
      // **作図中は視点を飛ばさない**（増分 3 の手直し D2。バグ狩り #7）。打ちかけの下書きを
      // 抱えたまま一覧の行を押すと、地図だけが世界の反対側へ飛び、そのあと打った点が
      // **世界をまたぐ形**になった（下書きは残るので、利用者は何が起きたか分からない）。
      // 一覧で選ぶこと自体は妨げない ―― 素性を見たいだけのことがあるので。
      if (addDrawing) return;

      const s = store.getState();
      // **隠れている地物でも、選んでいるなら視点を合わせる**（2026-09-06、2 回目の手直し）。
      //
      // 旧版はここで「表示条件を通っていなければ何もしない」と門を閉じていた。すると
      // 隠れた行を一覧で選んでも **視点は動かず、状態行も黙ったまま**で、しかも地図には
      // §D.6 規則①の「必ず描く」で当人だけが描かれている ―― 描いてあるのに、どこに
      // 描いたかを教えない、という一番たちの悪い形だった（R1d の D-6）。
      //
      // 選んでいる 1 件は必ず描かれるので、視点を合わせる資格がある。**選んでいない**
      // 地物に対する直接の呼び出しだけは、従来どおり表示条件の門で止める（FR-113 の
      // 保険。道具の取得と同じ判定を使う）。
      const forcedDrawn = s.activeFeature === featureId;
      const visibleUnderFilter = isToolTargetVisible(featureId);
      if (!visibleUnderFilter && !forcedDrawn) return;

      fitCameraToFeatureRef.current?.(featureId);
      const feature = featureByIdAt(s.domain, s.currentTime, featureId);
      if (feature === undefined) return;

      // **表示条件で隠されている**ときは、畳み込みの話ではなく「隠している」ことを言う。
      // 深さで畳まれた（＝隠していないが自分の形は描かれない）ときとは理由が違うので、
      // 同じ文でごまかさない（R1d の D-6。設計書 §D.6 の規則 2 / §H.5）。
      if (!visibleUnderFilter) {
        announceResult(APP_STRINGS.hiddenButDrawn(featureDisplayName(feature)));
        return;
      }

      // **選んだものが地図に見えているか**を確かめ、見えていなければ理由を状態行へ出す
      // （増分 4 の中身 9 / 設計書 §D.6 の規則 2）。描くこと自体は描画側
      // （`committed-features` の「必ず描く」）が構造的に受け持つので、ここは
      // **黙って特別扱いしない**ための知らせだけを担う。
      const resolution = resolveDisplayFor(s.domain, s.currentTime, s.displayControl);
      const drawnIds = new Set(resolution.resolved.shapes.map((sh) => sh.featureId));
      // **点・線は描画済みとみなす**（増分 4 の手直し B6）。`resolved.shapes` は面の
      // 列（FR-42 の畳み込みの結果）なので、点情報・線情報は最初から入っていない。
      // それを「描かれていない」と読んでいたせいで、点や線を一覧で選ぶと **必ず**
      // 「描かれないので選んでいるあいだだけ描いています」と嘘の知らせが出ていた。
      // 点と線は畳み込みを受けないので、この知らせの対象そのものではない。
      for (const f of resolution.features) {
        if (f.kind === FEATURE_KIND.Point || f.kind === FEATURE_KIND.Line) {
          drawnIds.add(f.id);
        }
      }
      const depth = derivedDepths(resolution.forest).get(featureId);
      const note = describeForcedDraw(
        drawnIds,
        featureId,
        depth === undefined || isDepthUndefined(depth) ? null : depth,
        (d) => APP_STRINGS.forcedDraw(featureDisplayName(feature), d),
      );
      if (note !== null) announceResult(note);
    },
    [isToolTargetVisible, addDrawing, store, announceResult],
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
        assetResolver: NO_ASSET_RESOLVER,
        onDeleteFeature: propertyDeleteFeature,
        // 増分 2 の中身 3: 素性欄の「この年に錨を作る」を、メニューと Ctrl+K と
        // **同じコマンド 1 本**へ繋ぐ（権限の関門も可否の判定もそこで 1 回だけ
        // 行われる、教訓 5.13 / 5.30）。選ばれている地物に対して動くので、押す前に
        // その地物を選び直す（素性欄が出している地物と選択は同じはずだが、
        // 頃合いの差で食い違うのを防ぐ）。
        onCreateAnchorHere: requestCreateAnchorHere,
        // A4 (c): 打ちかけの確認が出ているあいだ、大域ショートカットを止める。
        onDraftConfirmChange: setDraftConfirmOpen,
        // 素性欄の中の板（錨の削除の確認）も鍵盤の持ち主として名乗る（決定 (13)）。
        onPropertyModalChange: toolModalChange('anchor-delete-impact'),
        // 項目 6: 時刻レールの右クリック「この錨の開始年を変える」の受け口。
        anchorStartEdit: anchorStartEditStore,
        onFocusFeatureCamera: focusCameraOnFeature,
        // 増分 3 / N-15: 追加を確定したあとの素性入力を **素性欄の位置**に出す。
        addDraft: addDraftStore,
        // 増分 4 / 結合点 #3: 右クリックと追加の確定が「選んだ地物」の区画へ寄せる口。
        focusStore: sidebarFocusStore,
        // 増分 4 / G-20・G-23: 一覧のその場編集が断られたときの理由の出口。
        onRefusal: announceRefusal,
        // 増分 4 の 2 回目の手直し: やり直して通ったことを状態行へ出す口（古い断りの上書き）。
        onResult: announceResult,
        // 増分 4 / E-6: Ctrl+F（「地物を検索」）の行き先。
        filterFocus: ledgerFilterFocusStore,
        // 増分 4 の手直し B8: Alt+↑ / Alt+↓ / F2 の行き先。
        ledgerCommands: ledgerCommandStore,
        // 増分 7（設計書 §I.3 / 増分 5 からの送り）: 一覧の行の右クリック。
        onRowContextMenu: openLedgerRowMenu,
        // --- 増分 7 -------------------------------------------------------------
        // 親欄の 3 ボタン（G-3 / FR-46 must）。**押した瞬間に所属変更の手順へ入る**
        // ―― 素性欄の保存ボタンでは親を変えない（設計書 §C.6 の「保存の対象」）。
        onParentPick: (featureId) => enterReparentFor(featureId, REPARENT_CHOICE.Existing),
        onParentCreate: (featureId) => enterReparentFor(featureId, REPARENT_CHOICE.Create),
        onParentClear: (featureId) => enterReparentFor(featureId, REPARENT_CHOICE.None),
        // 削除の入口 A（設計書 §A.3）。
        onEndHere: endFeatureHere,
        endHereDisabledReason: endHereRefusalFor,
        // 削除の入口 B の前に見せる影響の一覧（設計書 §A.3 / 中身 6）。
        resolveDeleteImpact: resolveDeleteImpactFor,
      }),
    [
      store,
      requestCreateAnchorHere,
      calendar,
      onOpenDetail,
      propertyEditDispatch,
      anchorIntervalDispatch,
      propertyDeleteFeature,
      focusCameraOnFeature,
      addDraftStore,
      sidebarFocusStore,
      announceRefusal,
      announceResult,
      ledgerFilterFocusStore,
      ledgerCommandStore,
      openLedgerRowMenu,
      enterReparentFor,
      endFeatureHere,
      endHereRefusalFor,
      resolveDeleteImpactFor,
      anchorStartEditStore,
    ],
  );

  // 追加の確定で「新規の姿」が開いたら、**プロパティタブへ寄せる**（増分 3 / 設計書
  // §C.2 の 27）。一覧タブを見ている人には出た瞬間が見えないので、既存の 1 本
  // （`focusPropertyTab`。利用者がタブを押すのと同じ経路）を使って寄せる。
  useEffect(() => {
    let wasOpen = addDraftStore.get() !== null;
    return addDraftStore.subscribe((prompt) => {
      const open = prompt !== null;
      if (open && !wasOpen) focusPropertyTab();
      wasOpen = open;
    });
  }, [addDraftStore, focusPropertyTab]);

  // 増分 3 の中身 9: `Shift+F` で面を描く道具を構える（設計書 §I.2）。**メニューにも
  // 載せてある**（`menu.ts`）ので、結合点 #10「メニューに載っているのに実体が登録
  // されていない」を作らない。読むだけのときは `EDITING_COMMANDS` の関門が止める。
  useEffect(() => {
    registry.register(COMMAND_ID.ToolsAddFace, {
      run: () => {
        // 増分 5b: 面の道具を構えれば `mode` は `add` になる（設計書 §D.1）。
        // 先に `setMode(Add)` を立てる必要はない ―― 立てると道具が外れる。
        store.getState().setActiveTool(TOOL_ID.AddArea);
      },
    });
    return () => registry.unregister(COMMAND_ID.ToolsAddFace);
  }, [registry, store]);

  return (
    // U41 INTEGRATION (FR-117, 受け入れ基準3): wrap the whole shell in the React
    // error boundary bound to the SAME shared logger the global handlers use, so a
    // render-time exception is caught, logged through the single pipeline and shown
    // as the日本語 fallback instead of crashing the app (教訓 5.6 全経路網羅). The
    // non-React paths are covered by the global handlers installed above.
    <ErrorBoundary
      logger={logger}
      contextTimeLabel={() => formatTimePoint(store.getState().currentTime)}
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
        alwaysAllowedShortcuts={alwaysAllowedShortcuts}
        onSuspendedShortcut={explainsRefusal(focusOwner) ? onSuspendedShortcut : undefined}
        // 標準メニューを開いているあいだは鍵盤がメニューのもの（増分 5 の手直し A4 /
        // GPT #3）。開いたまま Ctrl+Z / Delete が背後の地図へ抜けないようにする。
        onMenuOpenChange={setMenuBarOpen}
        onMapMount={onMapMount}
        /* 設計書 §C.4 のオプションバー。この増分では器と API だけで、中身は各道具が
           後の増分で押し込む（既定は「選ぶ／（選んでいません）／地図か地物一覧から
           選ぶ／（設定なし）／空の確定欄」）。 */
        optionBar={
          <OptionBar
            store={optionBarStore}
            // 「≫」を開いているあいだも鍵盤は板のもの（増分 5 の手直し D2 / A4）。
            onOverflowOpenChange={popoverOpenChange('overflow')}
          />
        }
        /* 時刻レール（増分 6 / 設計書 §C.7）。時間の 11 コマンドは **レールが登録簿へ
           足す**（結合点 #10: メニューに載っているのに実体が無い項目を作らない）。
           断りの文（範囲外・端・錨が無い）は状態行の「直前の結果」枠へ出す ――
           レールは 112px 固定なので、断りで帯が伸びる経路を作らない。 */
        timeline={
          <Timeline
            store={store}
            registry={registry}
            statusMessages={statusMessageStore}
            onPopoverOpenChange={popoverOpenChange('rail')}
            getRoot={getDomainRoot}
            /* 決定 (8)（2026-09-07）: **板が開いたら再生を止める。** 板の後ろで年が
               進み続けると、確認に答えるあいだに現在時刻が動き、答えた内容が
               「どの年に対する答えだったのか」が変わってしまう（板は鍵盤を持つので
               Space でも止められない）。閉じても自動では再開しない。 */
            modalOpen={modalOwnsKeyboard}
            // 項目 6（設計書 §I.3）: レールの右クリック。開閉は鍵盤の持ち主へ名乗り、
            // 中身は既存の経路（錨表と同じ影響の板・存続期間の欄）へ渡すだけ。
            onMenuOpenChange={toolModalChange('rail-menu')}
            onRequestAnchorDelete={requestRailAnchorDelete}
            onRequestAnchorStartEdit={requestRailAnchorStartEdit}
          />
        }
/* 状態行 5 枠（設計書 §C.8）。60Hz で動く値（カーソル座標・縮尺）は
           **それぞれの葉ノードだけ** が購読するので、パンでは再レンダーが起きない
           （技術方針 2.3）。座標は React の外の CursorPositionStore から来る。
           地図の外へカーソルが出たときは、**枠を残して「—」だけを差し替える**
           （増分 1 で状態行が 5 枠になった。以前ここに書いてあった「準備完了を出す」は
           座標 1 項目だけだった頃の記述で、いまは CursorCoordinateStatus が「—」を返す）。 */
        appIdentity={
          <AppIdentity
            worldName={worldName}
            fileName={openFileName}
            dirty={projectDirty}
            destinationRetracted={saveStatus.destinationRetracted}
          />
        }
        status={
          <StatusBarContent
            store={store}
            cursorStore={cursorPositionStore}
            messageStore={statusMessageStore}
            undo={{
              canUndo: historyCanUndo(historyRef.current),
              // 設計書 §C.8 は「元に戻せます: 南ケナ州の改名（Ctrl+Z）」まで出すとしているが、
              // ここではまだ **可否だけ** を出す。`Command.label` の語彙の混在（ドメイン側の
              // 4 か所が日本語「所属変更」「地物の削除」「自動配色」「結合」、UI 側の 5 か所が
              // 内部の英語 'edit' / 'delete' / 'interval' / 'palette' / 'unshare'）は
              // `shell/command-result.ts` の写像表で解けるようになったが、設計書の例は
              // 操作名だけでなく **対象の名前** も含んでおり、どの label もそれを持っていない。
              // 対象の名前を運ぶのは全コミット経路に触る別の作業（現状.md へ申し送り）。
              // なお「直前の結果」枠には、同じ写像表を通した操作名が既に出ている。
              lastLabel: null,
            }}
            lastSavedAtMs={saveStatus.savedAtMs}
            /* A4-a: 自動保存は上書き先を確認するまで本体ファイルに書かない。書いて
               いないことを黙っていると誤解のまま作業が進むので、最終保存の枠に出す。 */
            autoSaveArmed={saveStatus.autoSaveArmed}
          />
        }
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
            {/* 設計書 §B.5 の台帳 #10・#11（増分 6。増分 5 から送られた 3 部品のうち 2 つ）。
                層は `pointer-events: none` で、ボタンの矩形だけが押下を受ける（K-2）。 */}
            <MapViewControls<DomainRoot> store={store} registry={registry} />
            {/* 増分 8E（G-21 / §B.5 の台帳 #27）: ズームの上下限で断った理由を脇に出す。押せない。 */}
            <ZoomLimitNoteView<DomainRoot> store={store} noteStore={zoomLimitNoteStore} />
            {/* 同 #12。押した位置の掴める距離に頂点が 2 つ以上あるときだけ出る一時部品。 */}
            <VertexCandidateList
              store={vertexCandidateStore}
              onPick={(featureId, vertexId) => selectVertexRef.current?.(featureId, vertexId)}
            />
            <SurveyMapBridge
              store={store}
              screenToWorld={screenToWorld}
              mapCameraInput={mapCameraInput}
            />
            {/* 編集モードの 8 つの道具の帯（増分 3 の手直し C3）。DOM は 1 つも作らず、
                道具名と対象だけをオプションバーへ押し込む。追加モードのときは帯を持たない
                ので、`AddToolController` と喧嘩しない（`OptionBarStore.claim` の規約）。 */}
            <ToolOptionBar<DomainRoot>
              store={store}
              optionBar={optionBarStore}
              resolveFeature={featureByIdAt}
            />
            {/* 増分 5a: アプリバーを 32px 固定にするために、深さ・格子・測量の読み取りを
                オプションバーの設定欄へ降ろした（設計書 §B.4「個別フォーカスの 4 部品は
                アプリバーから降ろす」）。**どれも道具に属さない常設の部品**なので、道具が
                帯を持ち直しても落ちない口（`registerPersistentSlot`）へ差し込む。

                **並びは登録した順で、狭い窓では「≫」へ後ろから送られる**（増分 5 の手直し
                D2）。道具の設定（吸着 ▾ ほか）は常設より **前**に並ぶので（`option-bar.ts` の
                `republishSlots`）、いちばん先に「≫」へ送られるのはここの最後である。
                だから **落としたくないものほど先に登録する**:
                測量の読み取り（測っている最中だけ出る＝いま見ている値そのもの）→
                表示 ▾（作業中いちばん触る）→ 深さ ▾ → 格子（1 押しのトグルなので
                「≫」の中でも手数が変わらない）。 */}
            <PersistentOptionSlot optionBar={optionBarStore} id="survey">
              {surveySlotNode}
            </PersistentOptionSlot>
            <DisplayOptionsSlot<DomainRoot>
              store={store}
              optionBar={optionBarStore}
              getRoot={getDomainRoot}
              getTime={getCurrentTime}
              onOpenChange={popoverOpenChange('display')}
            />
            <PersistentOptionSlot optionBar={optionBarStore} id="depth">
              {depthSlotNode}
            </PersistentOptionSlot>
            {/* FR-13 グリッド ON/OFF 結線 (教訓 5.7 結線漏れ)。**畳まずにそのまま置く**
                ―― 1 クリックで効く固定幅のボタンなので、ポップオーバーの中へ入れると
                手数が増えるだけである。 */}
            <PersistentOptionSlot optionBar={optionBarStore} id="grid">
              {gridSlotNode}
            </PersistentOptionSlot>
            {/* 司令塔の決定 (4): 測るは別の軸のまま残すが、オプションバーの 5 区画を使う。
                DOM は作らない（道具名・対象・次の一手・確定を押し込むだけ）。 */}
            <SurveyOptionBar<DomainRoot> store={store} optionBar={optionBarStore} />
            <AddToolControllerWithParents
              store={store}
              startProcess={hostBootstrap.startProcess}
              ids={hostBootstrap.ids}
              nextRingId={hostBootstrap.nextRingId}
              screenToWorld={screenToWorld}
              readCamera={readCamera}
              drawSink={drawSink}
              mapCameraInput={mapCameraInput}
              optionBar={optionBarStore}
              addDraft={addDraftStore}
              onCommitted={onAddCommitted}
              onConflicts={onAddConflicts}
              onDrawingChange={setAddDrawing}
              onModalChange={toolModalChange('add-discard-confirm')}
              onSnapPopoverOpenChange={popoverOpenChange('snap')}
              onDraftDiscarded={(count) => {
                // D1: 打ちかけを黙って消さない（設計書 §H.5 の「直前の結果」へ報せる）。
                statusMessageStore.notice(ADD_STRINGS.draftDiscarded(count));
              }}
              onFocusSelection={focusCameraOnSelection}
            />
            <KnifeToolController<DomainRoot>
              store={store}
              optionBar={optionBarStore}
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
              addDraft={addDraftStore}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onKnifeCommitted}
              onConflicts={onKnifeConflicts}
              onDrawingChange={setKnifeDrawing}
              onModalChange={toolModalChange('knife')}
              onDraftDiscarded={(count) => {
                // 打ちかけを黙って消さない（設計書 §D.4.1 / §H.5 の「直前の結果」）。
                statusMessageStore.notice(ADD_STRINGS.draftDiscarded(count));
              }}
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
              optionBar={optionBarStore}
              onCommitted={onMergeCommitted}
              onConflicts={onMergeConflicts}
              onDrawingChange={setMergeDrawing}
              onModalChange={toolModalChange('merge')}
              markedFeatureIds={markedFeatureIdList}
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
              optionBar={optionBarStore}
              onCommitted={onReparentCommitted}
              onConflicts={onReparentConflicts}
              onDrawingChange={setReparentDrawing}
              onModalChange={toolModalChange('reparent')}
              markedFeatureIds={markedFeatureIdList}
              openOptionsRequest={reparentOpenRequest}
              countWithoutOwnSeries={countWithoutOwnSeries}
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
              optionBar={optionBarStore}
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
              onModalChange={toolModalChange('ring-edit')}
              onImpactModalChange={toolModalChange('ring-delete-impact')}
              onDraftDiscarded={(count) => {
                statusMessageStore.notice(ADD_STRINGS.draftDiscarded(count));
              }}
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
              optionBar={optionBarStore}
              startProcess={drillBootstrap.startProcess}
              ids={drillBootstrap.ids}
              resolveFeature={drillBootstrap.resolveFeature}
              resolveStore={drillBootstrap.resolveStore}
              anchorTime={() => store.getState().currentTime}
              screenToWorld={screenToWorld}
              featureAtPoint={drillBootstrap.featureAtPoint}
              drawSink={drillDrawSink}
              mapCameraInput={mapCameraInput}
              addDraft={addDraftStore}
              defaultColor={KNIFE_DEFAULT_COLOR}
              onCommitted={onDrillCommitted}
              onConflicts={onDrillConflicts}
              onDrawingChange={setDrillDrawing}
              onModalChange={toolModalChange('drill')}
              onDraftDiscarded={(count) => {
                statusMessageStore.notice(ADD_STRINGS.draftDiscarded(count));
              }}
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
            {/* 増分 5b: 測量の入口は **道具の 1 段の中**（`Toolbar`）へ移った。
                読み取り・案内・クリアはオプションバーの設定欄にある（増分 5a）。 */}
          </>
        }
        overlay={
          <>
            {/* 初回起動のガイド 4 枚（FR-118 / 設計書 §H.3。増分 6）。地図には重ねない。 */}
            <FirstRunGuide<DomainRoot> store={store} />
            {/* Observability marker (回帰観点 E2E): mirrors the live selection truth
                (store.selection.activeFeature) so a regression test can assert the
                inheritor stays selected after a split (教訓 5.11). Hidden; it holds
                NO truth — it只 reflects the store (技術方針 2.5). */}
            <ActiveFeatureMarker store={store} />
            {/* 増分 4 / 設計書 §C.2 の 26: どこへでも移動（Ctrl+P）。母集団は一覧と
                同じ 1 本で、**数字だけなら年の候補しか出さない**（C10 の罠を作り直さない）。
                地図に重なる層ではなくシェルの前面層なので、K-2 の事故は起きない。 */}
            <JumpPalette<DomainRoot>
              store={store}
              registry={registry}
              getRoot={getDomainRoot}
              getTime={getCurrentTime}
              open={jumpOpen}
              onClose={() => setJumpOpen(false)}
              onFocusFeatureCamera={focusCameraOnFeature}
              // 手直し C3:「ほかに n 件」＝ 打った語で一覧を絞り込み、一覧へ寄せる。
              onShowInList={(q) => {
                store.getState().setLedgerQuery(q);
                sidebarFocusStore.focus(SIDEBAR_SECTION.List);
                ledgerFilterFocusStore.focus();
              }}
            />
            {/* HB3-11: the feature detail panels (FR-99後段) — draggable/closable, one
                per feature, showing all attributes (dl) + an empty document-body stub.
                Selecting from a panel promotes through the SAME store.setActiveFeature
                path every selection uses (no second selection source, 教訓 5.29). */}
            <DetailPanels
              state={detailPanels}
              featureLookup={detailFeatureLookup}
              // 増分 8E（結合点 #12）: 年を動かしてその地物が無くなったら、その場で消す。
              liveStore={store}
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
            {/* **鍵盤の持ち主の隠し観測**（増分 5c / T-2「隠し観測は足す一方にする」）。
                「打鍵が効かない」の原因が **誰が持っているか**にあることを、検査から
                直接指せるようにする ―― 旧版は 11 項目の OR が真偽値 1 個に潰れていて、
                赤くなっても「どれが真だったのか」が分からなかった。 */}
            <span data-testid="app-focus-owner" hidden>
              {focusOwner}
            </span>
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
              // 増分 7（増分 5 からの送り / 設計書 §I.3）: 道具が下書きを持っている
              // 局面の項目（確定・やめる）。中身はオプションバーの確定欄そのもの。
              optionBar={optionBarStore}
            />
            {/* U39 INTEGRATION (受け入れ基準 1-6): the file-ops controller registers
                the ファイル menu / shortcut commands on the SAME registry the shell
                dispatches, drives the FR-107 unsaved warning + FR-106 repair modals,
                reflects loaded / repaired projects into the store, supplies the
                FR-10 zoom clamp range to U17, and intercepts window-close with the
                quit guard. All file I/O routes through U15's typed IPC
                (window.timeMapApi); the renderer never touches fs (FR-02). */}
            {/* A8: Delete キー / 編集メニュー / 右クリックの「削除」が出す確認。素性欄の
                ボタンが出すものと **同じ部品・同じ文言** である（3 経路で 1 つ）。
                「キャンセル」と Esc は何もしない（教訓 5.22 確定までドメインを壊さない）。 */}
            {/* **増分 7 でこの 3 経路も影響の一覧を通る**（設計書 §A.3 / 中身 6）。
                素性欄のボタンと同じ器（`ImpactConfirmDialog`）で、消える錨・頂点、
                最上位へ移る下位領域、自動で消える集約まで **消す前に**出す。 */}
            {pendingDelete !== null &&
              (() => {
                const view = pendingDelete.view;
                return (
                  <ImpactConfirmDialog
                    testIdPrefix="delete-impact"
                    title={view.title}
                    groups={view.groups}
                    blockedReason={view.blockedReason}
                    confirmLabel={view.confirmLabel}
                    cancelLabel={view.cancelLabel}
                    note={view.note}
                    onConfirm={() => {
                      const target = pendingDelete.featureId;
                      setPendingDelete(null);
                      commitFeatureDelete(target);
                    }}
                    onCancel={() => setPendingDelete(null)}
                    onModalChange={toolModalChange('delete-impact')}
                  />
                );
              })()}

            {/* **頂点を消す前の確認**（N-05 / 設計書 §A.3。増分 7 の中身 7）。地物・錨・
                輪郭の削除と同じ器で、**残る頂点が足りなくなると地物ごと消える**ことを
                事前に文で出す。 */}
            {pendingVertexDelete !== null && (
              <ImpactConfirmDialog
                testIdPrefix="vertex-delete-impact"
                title={PROPERTY_STRINGS.vertexDeleteTitle(
                  pendingVertexDelete.selection.vertexIds.size,
                )}
                groups={[
                  {
                    testId: 'gone',
                    heading: PROPERTY_STRINGS.impactHeadingGone,
                    lines: [
                      PROPERTY_STRINGS.vertexDeleteLineCount(
                        pendingVertexDelete.selection.vertexIds.size,
                      ),
                      // 閾値を割るときだけ「地物ごと消える」と言う（Fable #3）。
                      ...(pendingVertexDelete.wholeFeature
                        ? [PROPERTY_STRINGS.vertexDeleteLineBelowThreshold]
                        : [PROPERTY_STRINGS.vertexDeleteLineSurvives]),
                    ],
                  },
                ]}
                confirmLabel={PROPERTY_STRINGS.vertexDeleteConfirm}
                cancelLabel={PROPERTY_STRINGS.impactCancel}
                note={PROPERTY_STRINGS.impactUndoNote}
                onConfirm={() => {
                  const target = pendingVertexDelete.selection;
                  setPendingVertexDelete(null);
                  runDeleteFunnel(target);
                }}
                onCancel={() => setPendingVertexDelete(null)}
                onModalChange={toolModalChange('vertex-delete-impact')}
              />
            )}

            {/* 時刻レールの右クリック「この錨を消す」（項目 6）。素性欄の錨表と **同じ中身**
                （`anchorDeleteImpactView`）・同じ intent（`buildDeleteAnchorIntent`）。 */}
            {pendingRailAnchorDelete !== null && (
              <ImpactConfirmDialog
                testIdPrefix="anchor-delete-impact"
                {...anchorDeleteImpactView(pendingRailAnchorDelete.entry.start)}
                onConfirm={() => {
                  const target = pendingRailAnchorDelete;
                  setPendingRailAnchorDelete(null);
                  try {
                    anchorIntervalDispatchRef.current?.dispatchAnchorInterval(
                      buildDeleteAnchorIntent(target.featureId, target.entry.anchor.id),
                    );
                  } catch (e) {
                    statusMessageStore.failure(e instanceof Error ? e.message : String(e));
                  }
                }}
                onCancel={() => setPendingRailAnchorDelete(null)}
                onModalChange={toolModalChange('rail-anchor-delete-impact')}
              />
            )}

            {/* **まとめ役を終わらせる前の影響の板**（司令塔の決定 (2)）。素性欄のボタンと
                右クリックの項目の両方がここを通る。削除と同じ器・同じ作法（鍵盤の持ち主へ
                自分で名乗る＝決定 (13)）。 */}
            {pendingEndHere !== null && (
              <ImpactConfirmDialog
                testIdPrefix="end-here-impact"
                title={pendingEndHere.view.title}
                groups={pendingEndHere.view.groups}
                confirmLabel={pendingEndHere.view.confirmLabel}
                cancelLabel={pendingEndHere.view.cancelLabel}
                note={pendingEndHere.view.note}
                onConfirm={() => {
                  const target = pendingEndHere;
                  setPendingEndHere(null);
                  commitEndHere(target.featureId, target.at, target.name);
                }}
                onCancel={() => setPendingEndHere(null)}
                onModalChange={toolModalChange('end-here-impact')}
              />
            )}

            {/* まとめて種別を付ける板（増分 7 の中身 8）。確定は 1 つの複合コマンドに
                畳まれるので、335 件でも Ctrl+Z 1 回で戻る。 */}
            {bulkKindTargets !== null && (
              <BulkKindLabelDialog
                count={bulkKindTargets.length}
                onConfirm={commitBulkKindLabel}
                onCancel={() => setBulkKindTargets(null)}
                onModalChange={toolModalChange('bulk-kind')}
              />
            )}
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
              // 増分 8E（G-10）: 背景地図の縦横比を聞く板も鍵盤の持ち主へ名乗る。
              onBasemapAspectModalChange={toolModalChange('basemap-aspect')}
              onSaveStatusChange={setSaveStatus}
              statusMessages={statusMessageStore}
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
              /* N-34: 診断情報のエラーログ欄は、ロガーもファイル沈め口も動いているのに
                 **表示側だけ未結線**で固定の空文言を描いていた（G-19）。App が持っている
                 唯一のロガーを渡すだけで生きる。 */
              logger={logger}
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
                colorFor={participantFillColor}
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
/**
 * 道具が鍵盤を持っている間でも通すコマンド（増分 3）。**保存だけ**である。
 * 作図中の下書きはプロジェクトの一部ではないので、保存しても失われるものは無い。
 * 取り消し（Ctrl+Z）と Escape はここに入れない ―― 作図中はその 2 つを **道具自身が
 * 自分のリスナーで受けている**（頂点 1 つ戻す / 下書きを捨てる）ので、大域の側でも
 * 走らせると 1 回の打鍵で 2 つ起きる（bughunt3 H2 の二重 undo）。
 */
const SAVE_WHILE_TOOL_OWNS_KEYBOARD: ReadonlySet<CommandId> = new Set<CommandId>([
  COMMAND_ID.FileSave,
  COMMAND_ID.FileSaveAs,
  // **ファイルを開く・新規も通す**（増分 3 の手直し 2 回目）。メニューの「新規」は
  // 作図中でも動くのに **Ctrl+N だけが無反応**で、同じ操作が入口によって効いたり効かな
  // かったりしていた（実測）。どちらも打ちかけの下書きより外側の操作で、未保存の確認は
  // ファイル側が別に持っている。
  COMMAND_ID.FileNew,
  COMMAND_ID.FileOpen,
]);

/**
 * 所属変更の道具が対象を掴んでいるあいだに通すコマンド（B64）。保存の一式に **取り消し・
 * やり直し**を足したもの。所属変更には「1 つ戻す点」が無いので、ここで止めると打鍵が
 * 誰にも受けられず黙る（`App` の `reparentOnlyDrawing` の注記）。
 */
const HISTORY_AND_SAVE_WHILE_REPARENT_HOLDS_TARGET: ReadonlySet<CommandId> = new Set<CommandId>([
  ...SAVE_WHILE_TOOL_OWNS_KEYBOARD,
  COMMAND_ID.EditUndo,
  COMMAND_ID.EditRedo,
]);

const KNIFE_DEFAULT_COLOR = withFillOpacity(
  createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
);


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
  props: Omit<
    AddToolControllerProps<DomainRoot>,
    | 'parentCandidates'
    | 'resolveProximity'
    | 'terminalAt'
    | 'featureNameOf'
    | 'facesContaining'
  > & {
    readonly readCamera: () => {
      readonly camera: RenderCameraInput;
      readonly viewport: Viewport;
    } | null;
  },
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

  // C1 の配線（増分 3）: 吸着と FR-29 の関門の供給元。**ここが「実装コードに 1 つも
  // 無い」と現状分析が書いた口である。** 中身は既にある当たり判定 2 本を呼ぶだけで、
  // 新しい判定は書かない（`ui/add/snap-ports.ts`）。
  //
  // 世界はポートの中で **呼ばれるたびに読み直す**（`store.getState()`）。React の
  // 依存で作り直す形にすると、下書き中に時刻や表示条件が変わったときに古い写しへ
  // 吸着し続ける（教訓 5.3 / 5.5）。ポート自身は store 参照だけに依存するので同一性が
  // 安定し、`useAddTool` の useCallback が毎レンダー作り直されることもない。
  const { store } = props;
  const readCamera = props.readCamera;
  const snapPorts = useMemo(
    () =>
      createAddSnapPorts({
        readContext: () => {
          const s = store.getState();
          return {
            root: s.domain as DomainProject,
            time: s.currentTime,
            displayControl: s.displayControl,
            filter: s.filter,
            snap: s.snapSettings,
          };
        },
        readCamera,
      }),
    [store, readCamera],
  );

  return (
    <AddToolController<DomainRoot>
      {...props}
      parentCandidates={candidates}
      resolveProximity={snapPorts.resolveProximity}
      terminalAt={snapPorts.terminalAt}
      featureNameOf={snapPorts.featureNameOf}
      facesContaining={snapPorts.facesContaining}
    />
  );
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
import type { AnchorEntry } from '../domain/anchor-series';
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
  createBulkKindLabelCommandForRoot,
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
import {
  withAttributes,
  withColor,
  withDetailDocument,
  withKindLabel,
  type Feature,
} from '../domain/feature';
import type { FeatureId, RingId, VertexId } from '../domain/ids';
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
  const access = {
    getRoot: () => getRoot(),
    // U4 study fix — the ring-edit confirm CAN surface a spatial conflict (a new
    // enclave/hole ring against a neighbour); the U06 resolution write-back needs the
    // SAME shared minters the bootstrap's RingIdPorts use (one series, 教訓 5.37).
    nextVertexId: ids.nextVertexId,
    nextRingId: ids.nextRingId,
  };
  // **確定の報せを「穴・飛び地の追加／削除」にする**（増分 5 の手直し E2 / バグ狩り #8）。
  //
  // 旧版は label を渡さずに 1 本だけ作っていたので、`createLiveEditBinding` の既定
  // （`UI_COMMAND_LABEL.Edit`）へ落ち、**輪郭を確定しても状態行に「素性の変更を行いました」
  // としか出なかった** ―― 何が起きたのか読み取れない（教訓 5.12）。
  //
  // 追加か削除かは **確定した形そのもの**から決める（環の数が増えたか減ったか）。
  // 道具の局面（`subMode`）を確定の入口まで運ぶ道を新設するより、結果から見るほうが
  // 経路が 1 本で済む（教訓 5.6: 経路ではなく結果状態で判定する）。
  const liveAdd = createLiveEditBinding(access, UI_COMMAND_LABEL.RingAdd);
  const liveDelete = createLiveEditBinding(access, UI_COMMAND_LABEL.RingDelete);
  /** その地物がいま持っている環の数（引けなければ 0）。 */
  const ringCountOf = (root: DomainRoot, featureId: FeatureId): number => {
    const f = featuresAt(root, getTime()).find((x) => x.id === featureId);
    return f !== undefined && f.kind === FEATURE_KIND.Leaf ? f.shape.rings.length : 0;
  };
  const bindingFor = (snapshot: RingFeatureSnapshot): ReturnType<typeof createLiveEditBinding> => {
    const after = snapshot.feature;
    if (after === undefined || after.kind !== FEATURE_KIND.Leaf) return liveAdd;
    return after.shape.rings.length >= ringCountOf(getRoot(), after.id) ? liveAdd : liveDelete;
  };
  // The hook's StartRingEditProcess is the confirm entry: assemble the ONE complete-
  // state proposal (snapshot) and drive U24→U13. add / delete are always a real change
  // (changed: true), so the no-op guard never suppresses them (教訓 5.24).
  const startProcess: StartRingEditProcess<DomainRoot> = (snapshot, anchorTime, current) =>
    confirmRingEdit<DomainRoot>({
      snapshot,
      anchorTime,
      current,
      ports: bindingFor(snapshot).ports,
      changed: true,
    });
  const applyResolutionsFor = (
    proposal: EditProposal<RingFeatureSnapshot>,
  ): ApplyResolutions<DomainRoot> => bindingFor(proposal.snapshot).applyResolutionsFor(proposal);

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
