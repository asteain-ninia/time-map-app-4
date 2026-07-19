// UI/session state layer: the thin Zustand store + domain bridge (U16).
//
// This is the single truth source (技術方針 2.5): UI/session state AND a
// reference to the current immutable domain state both live here. The Canvas
// subscribes to this store ONLY and never rides the React render path
// (技術方針 2.3 / 2.5). The store is built on `zustand/vanilla` so it is
// framework-free — React binds to it separately via `useStore`, but the store
// itself (and its `subscribe` bridge) needs no React (技術方針 2.5「React 外の
// ドメインストアを subscribe でブリッジ」).
//
// What this store does NOT do (spec スコープ「やらないこと」):
//   - It does not define or mutate the domain truth. Domain updates flow through
//     U12 commands; this store receives the resulting NEW immutable state and a
//     CommandResult, and re-resolves selection from that result (教訓 5.11).
//   - It does not implement time resolution. Existence-at-time is INJECTED
//     (existence.ts) and called opaquely (単一の真実源).
//   - It does not hold temporary draft/preview state; it only provides the
//     RESET entry point that every mode/tool/selection-clear path runs through
//     so a later edit-tool unit can discard its drafts (教訓 5.2).

import { createStore, type StoreApi } from 'zustand/vanilla';

import type { CommandResult } from '../../domain/command/result';
import type { FeatureId, VertexId } from '../../domain/ids';
import {
  EMPTY_SELECTION,
  type ExistenceAtTime,
  type NextTargetPreference,
  type SelectionState,
  addVertices,
  replaceVertices,
  reresolveAfterStructureChange,
  revalidateForDisplay,
  revalidateForTime,
  toggleVertex,
  withActiveFeature,
  withoutVertexSet,
} from '../../domain/selection';
import {
  cancelDraft as surveyCancelDraftTransition,
  clearSurvey as surveyClearTransition,
  clickPoint as surveyClickPointTransition,
  disableSurveyMode,
  enableSurveyMode,
  initialSurveyState,
  updateHover as surveyUpdateHoverTransition,
  type SurveyState,
} from '../../domain/survey/index';
import type { WorldCoordinate } from '../../domain/coordinate';
import { getCalendar, type Calendar } from '../../domain/time/calendar';
import { compareNormalized, normalize } from '../../domain/time/normalized';
import { type TimePoint, timePointYear } from '../../domain/time/time-point';

import {
  DEFAULT_FILTER_STATE,
  clearIndividualOverrides,
  reconcileToLiveFeatures,
  setDepthThreshold,
  setIndividualHidden,
  setKindVisible,
  setOpacity,
  type FeatureKindAxis,
  type FilterState,
} from '../discovery/index';

import type { ExistenceResolver } from './existence';
import { ALWAYS_PRESENT_RESOLVER } from './existence';
import type { DisplayGrabbabilityResolver } from './grabbability';
import {
  type AppSettingKey,
  type AppSettings,
  type ProjectSettingKey,
  type ProjectSettings,
  type SettingsScope,
  SETTINGS_SCOPE,
  appSettingDirtiesProject,
  classifySettingKey,
  clampRenderFps,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_TIMELINE_MAX,
  DEFAULT_TIMELINE_MIN,
} from './settings';
import { isDocumentAffectingAppNoOp, isProjectNoOp } from '../settings/diff';
import {
  type ActiveFeature,
  type Camera,
  type DisplayControl,
  type DisplayFocus,
  type EditMode,
  type ToolId,
  type VertexSelectionContext,
  DEFAULT_CAMERA,
  DEFAULT_DISPLAY_CONTROL,
  EDIT_MODE,
  NO_DISPLAY_FOCUS,
  vertexSelectionContextOf,
} from './session';

// --- Time-change provenance (for回帰テスト, NOT for gating) ------------------

/**
 * Identifies which path set the current time. This is recorded for
 * observability/回帰テスト ONLY. Re-validation is NEVER gated on it
 * (教訓 5.6: detect on the resulting state, not the input path). Every path
 * funnels through the same `setCurrentTime` and the same re-validation.
 */
export const TIME_CHANGE_SOURCE = {
  Slider: 'slider',
  NumericJump: 'numericJump',
  AnchorSync: 'anchorSync',
  Playback: 'playback',
} as const;

export type TimeChangeSource =
  (typeof TIME_CHANGE_SOURCE)[keyof typeof TIME_CHANGE_SOURCE];

// --- Settings-change notification (FR-109 / FR-110, 教訓 5.35) ---------------

/**
 * A settings change event delivered to subscribers. Carries the changed key and
 * its scope so a subscriber (map render vs. edit/draw behavior) reflects only
 * what it cares about, with no subscriber left holding a stale value
 * (教訓 5.35: notify ALL dependents of a shared-resource update).
 */
export interface SettingsChange {
  readonly scope: SettingsScope;
  readonly key: ProjectSettingKey | AppSettingKey;
}

// --- Store state shape ------------------------------------------------------

/**
 * The complete store value. Session state + the domain-state reference slot +
 * settings. Generic over the opaque domain-state root `S` (owned by U03/U12);
 * this store never reaches into it (spec 依存: ルート状態を不変に受け渡す).
 */
export interface SessionStoreState<S> {
  // -- domain state reference (the bridge slot; NOT a copy of the truth) ------
  /**
   * The current immutable domain state. Swapped wholesale by `applyCommand
   * Result` / `setDomainState`; subscribers observe the new value. This is a
   * REFERENCE to the domain truth, never a duplicate of features/anchors
   * (技術方針 2.5: ドメインの真実を Zustand に複製しない).
   */
  readonly domain: S;

  // -- selection (FR-79 / FR-80 / FR-81) -------------------------------------
  //
  // The selection TRUTH is U22's `SelectionState` (domain/selection): the store
  // holds it whole and mirrors the reducer / re-resolution output (技術方針 2.5,
  // 教訓 5.29). It NEVER re-implements selection logic. `activeFeature` and
  // `vertexSelection` are READ-ONLY mirrors derived from `selection` so existing
  // subscribers (panels / Canvas) keep their shape without a parallel truth.
  /** The single selection truth (U22). All selection mutation flows through it. */
  readonly selection: SelectionState;
  /** Derived mirror of `selection.activeFeature` (FR-79). Do not set directly. */
  readonly activeFeature: ActiveFeature;
  /** Derived mirror of `selection`'s vertex set/owner (FR-80/81). Do not set directly. */
  readonly vertexSelection: VertexSelectionContext | null;

  // -- mode / tool (FR-75) ---------------------------------------------------
  readonly mode: EditMode;
  readonly activeTool: ToolId | null;

  // -- time (FR-64 / FR-66 / FR-70) ------------------------------------------
  readonly currentTime: TimePoint;
  readonly lastTimeChangeSource: TimeChangeSource | null;
  readonly timelineMin: TimePoint;
  readonly timelineMax: TimePoint;

  // -- camera / longitude shift (FR-12) --------------------------------------
  readonly camera: Camera;
  /** Current center longitude for the longitude shift (continuous scalar, FR-12). */
  readonly centerLon: number;

  // -- display control: hierarchy depth focus (FR-42 / FR-43, U34) -----------
  /**
   * The display-control slice (global depth N + individual focus M). A SEPARATE
   * AXIS from mode/tool/selection (FR-42 非干渉): the mode/tool/selection setters
   * NEVER write here, and these setters NEVER write mode/tool/selection, so a
   * display change cannot disturb an in-progress edit and a mode switch cannot
   * destroy the display state (受け入れ基準 2, 教訓 5.13).
   */
  readonly displayControl: DisplayControl;

  // -- survey mode (U37 / FR-14 / FR-15 / FR-16) ------------------------------
  /**
   * The survey 補助モード slice (U37): a SEPARATE axis from mode/tool/selection
   * (specs/U37 §2.1 — never a fourth EDIT_MODE). The store holds ONE domain
   * {@link SurveyState} and the actions below only call the pure domain
   * transitions (単一真実源 — no survey logic re-implemented here). This slice is
   * a NON-persisted temporary display (FR-15): it never reaches the `.tmap`
   * schema, never marks the project dirty, and is discarded wholesale on a
   * LOAD / NEW (U37 §4.5).
   */
  readonly survey: SurveyState;

  // -- display-control filter (FR-113, U41) ----------------------------------
  /**
   * The session-only display filter (種別 / 階層深度 / 個別非表示 / 不透明度 + 強調).
   * A SEPARATE axis from mode/tool/selection AND from FR-42 displayControl: it only
   * changes「どう見えるか」(which drawn features / at what opacity), NEVER the domain
   * truth or the FR-42 aggregation. Like {@link survey} it is NON-persisted (never in
   * the .tmap schema), never marks the project dirty, and is discarded wholesale on a
   * LOAD / NEW (受け入れ基準1, U41). The draw / hit-test / search母集合 all read the
   * SINGLE verdict this slice feeds resolveFilteredDisplay (教訓 5.29). DEFAULT is inert
   * (全表示・不透明度1.0・強調なし) so an untouched filter costs the render path nothing.
   */
  readonly filter: FilterState;

  // -- settings (FR-109 / FR-110) --------------------------------------------
  readonly projectSettings: ProjectSettings;
  readonly appSettings: AppSettings;
  /**
   * True when a PROJECT setting has changed since the last save (教訓 5.36: a
   * project-setting change marks the project document dirty). App-setting
   * changes do NOT set this — they persist at the app level.
   */
  readonly projectDirty: boolean;
  /** The most recent settings change, for subscriber notification (教訓 5.35). */
  readonly lastSettingsChange: SettingsChange | null;
  /**
   * Monotonic counter bumped ONLY by {@link SessionStoreActions.replaceBaseMap} (FR-04
   * base-map差し替え). The history owner (App) observes the domain reference change
   * through its store subscription and cannot otherwise tell a base-map-only replace
   * from an external whole-state swap (file LOAD / NEW), which it re-roots the edit
   * history on. A change in this counter alongside a domain swap identifies the replace
   * so App PRESERVES the undo/redo stacks instead of destroying them (F2, 教訓 5.6:
   * detect on the resulting state, not the input path). Starts at 0; never reset by a
   * load/new (a stale-vs-new compare is all App needs, not an absolute value).
   */
  readonly basemapReplaceNonce: number;
}

// --- Actions ----------------------------------------------------------------

/** The typed action surface (薄いセッター + 派生). */
export interface SessionStoreActions<S> {
  // bridge
  /**
   * Replace the domain-state reference and re-resolve selection from the result
   * via U22's {@link reresolveAfterStructureChange} (教訓 5.11). The optional
   * `preference` promotes the operation's "next element to operate on" (the
   * merged feature, a kept split half, …); only the command's owning unit knows
   * it, so it is passed through rather than reinvented here.
   */
  applyCommandResult(
    nextDomain: S,
    result: CommandResult,
    preference?: NextTargetPreference,
  ): void;
  /**
   * Apply an UNDO / REDO step exactly like {@link applyCommandResult} (same domain
   * swap + U22 selection re-resolution + display-focus re-resolution) EXCEPT the
   * dirty flag is RECOMPUTED against the last SAVED baseline instead of being forced
   * true (bughunt: 全 undo 後も dirty が残り保存済みでも未保存警告が出る). When the
   * resulting domain is value-equal (injected `domainEquals`) to the saved baseline
   * the project is clean (`projectDirty = false`); otherwise it is dirty. If the
   * project was never saved (no baseline) it stays dirty. Every OTHER dirty-setting
   * path is unchanged — a fresh edit still marks dirty through {@link applyCommandResult}.
   */
  applyUndoRedoResult(
    nextDomain: S,
    result: CommandResult,
    preference?: NextTargetPreference,
  ): void;
  /** Replace the domain-state reference without a command result (e.g. load). */
  setDomainState(nextDomain: S): void;
  /**
   * FR-04 base-map差し替え: swap the domain reference for a BASE-MAP-ONLY replacement
   * and mark the project dirty (like any edit, 教訓 5.36), AND bump
   * {@link SessionStoreState.basemapReplaceNonce} so the history owner (App) knows this
   * is a replace — NOT an external load/new — and PRESERVES the edit undo/redo stacks
   * (F2). Unlike {@link resetToDomain} it does NOT discard selection / tool / mode /
   * focus: a replace changes only the base map, not the features/vertices a selection
   * points at, so the in-progress edit context must survive. The caller supplies a
   * domain whose ONLY change from the current one is `baseMap` (the pure decision lives
   * in file-ops/basemap-replace; this action is the single store sink).
   */
  replaceBaseMap(nextDomain: S): void;
  /**
   * Whole-state replacement for a LOAD / NEW (教訓 5.2 全経路で破棄 / 5.22 確定後のみ).
   * Swaps the domain AND atomically discards every piece of session state tied to
   * the OLD project — selection (active feature + vertex set), active tool, and the
   * individual display-control focus — in ONE transition, and marks the project
   * CLEAN (this is a fresh baseline, not an edit). Without this, a stale selection
   * pointing at a feature/vertex id that does not exist in the NEW domain, or a
   * focus origin from the old project, would survive the swap. Mode is reset to
   * View so no half-armed editing mode straddles the swap.
   */
  resetToDomain(nextDomain: S): void;

  // selection
  setActiveFeature(featureId: FeatureId | null): void;
  /** FR-80 single click: replace the vertex-selection set. */
  replaceVertexSelection(ownerFeatureId: FeatureId, vertexIds: Iterable<VertexId>): void;
  /** FR-80 shift+click: toggle one vertex in/out of the set. */
  toggleVertexSelection(ownerFeatureId: FeatureId, vertexId: VertexId): void;
  /** FR-80 drag rectangle: add a range of vertices to the set. */
  addVerticesToSelection(ownerFeatureId: FeatureId, vertexIds: Iterable<VertexId>): void;
  /** Clear all selection (active feature + vertex context). Runs the reset契約. */
  clearSelection(): void;
  /**
   * Restore a whole {@link SelectionState} verbatim (truth + derived mirrors).
   * Used to retain the committed selection across a tool re-arm whose
   * {@link setActiveTool} reset契約 would otherwise clear it (教訓 5.11 — a
   * structure-change commit's selection must survive the post-commit re-arm).
   * It re-applies U22's existing selection value; it re-implements no rule.
   */
  restoreSelection(selection: SelectionState): void;

  // mode / tool
  setMode(mode: EditMode): void;
  /**
   * Arm / clear the toolbar tool. By default it runs the reset契約 and CLEARS the
   * selection (教訓 5.2 全経路で破棄) — a deliberate tool switch must not carry a
   * stale selection context into the next operation.
   *
   * `preserveSelection` is the narrow exception for the post-conflict re-arm
   * (App.reArmActiveTool, 教訓 5.11): the re-arm has to toggle the tool null→prev
   * so the add / knife controllers funnel through resetForSwitch → start (discard
   * the tool DRAFT) ACROSS a microtask boundary, but the committed selection a
   * structure-change commit just promoted must SURVIVE that toggle. Passing the
   * captured {@link SelectionState} pins `activeFeature` (and its derived mirrors)
   * to that value in the SAME transition that changes `activeTool`, so no
   * subscriber (Canvas redraw / property panel / sidebar) ever observes a
   * transient empty-selection frame between the toggle steps. It re-applies U22's
   * existing selection value; it re-implements no rule.
   */
  setActiveTool(tool: ToolId | null, preserveSelection?: SelectionState): void;

  // time (every path goes through setCurrentTime -> re-validation)
  setCurrentTime(time: TimePoint, source: TimeChangeSource): void;
  setTimelineRange(min: TimePoint, max: TimePoint): void;

  // camera / longitude
  setCamera(camera: Camera): void;
  updateCamera(patch: Partial<Camera>): void;
  setCenterLon(centerLon: number): void;

  // display control (FR-42 / FR-43) — independent axis, no mode/selection writes
  /** Set the global hierarchy-depth threshold N (FR-42). */
  setGlobalDepth(depth: number): void;
  /**
   * Set the individual focus origin (FR-43). Passing null clears the focus
   * (deep-dive + emphasis revert to global N only). Other focus fields are kept.
   */
  setFocusOrigin(originId: FeatureId | null): void;
  /** Set the per-focus depth threshold M (FR-43). */
  setFocusDepth(depth: number): void;
  /** Toggle/replace the focus emphasis flag (FR-43 / FR-82). */
  setFocusEmphasize(emphasize: boolean): void;
  /** Replace the whole focus value (FR-43). */
  setDisplayFocus(focus: DisplayFocus): void;
  /** Clear the individual focus entirely (revert to global N only, 教訓 5.2). */
  clearDisplayFocus(): void;

  // survey mode (U37 / FR-14 / FR-15 / FR-16) — thin wrappers over domain/survey
  /**
   * Turn the survey 補助モード ON. In the SAME transition the active edit tool is
   * cleared (activeTool: null) so the map is covered by at most ONE input bridge
   * (入力軸の相互排他) — but the View/Add/Edit mode and the selection are NOT
   * touched (survey is a separate axis, U37 §2.1). Confirmed lines survive a
   * re-enable (FR-15).
   */
  surveyEnable(): void;
  /**
   * Turn the survey 補助モード OFF. Discards the in-progress DRAFT ONLY and KEEPS
   * the confirmed lines (FR-15 — the named U37 §6 pitfall: 解除≠クリア).
   */
  surveyDisable(): void;
  /** A confirming survey click (first = start, second = confirm a line). */
  surveyClickPoint(point: WorldCoordinate): void;
  /** Update the live hover preview point (draft のみ; identity no-op otherwise). */
  surveyUpdateHover(point: WorldCoordinate): void;
  /** Cancel the in-progress draft (Escape / mode switch); lines + active kept. */
  surveyCancelDraft(): void;
  /** Clear ALL survey results (確定線 + draft) — the only line-emptying path. */
  surveyClear(): void;

  // display-control filter (FR-113, U41) — session-only, no projectDirty / domain touch
  /** FR-113 種別軸: toggle a kind (点/線/面) on the display filter. */
  setFilterKindVisible(axis: FeatureKindAxis, visible: boolean): void;
  /** FR-113 階層深度軸: show features whose derived depth ≤ threshold; null = axis off. */
  setFilterDepthThreshold(threshold: number | null): void;
  /** FR-113 不透明度: the display opacity applied to passing features (already clamped). */
  setFilterOpacity(opacity: number): void;
  /** FR-113 個別地物軸: force-hide / unhide ONE feature (右クリック「この地物を非表示」). */
  setFeatureHidden(featureId: FeatureId, hidden: boolean): void;
  /** FR-113: clear EVERY 個別非表示 override (「個別非表示 n 件を全て再表示」). */
  showAllHiddenFeatures(): void;

  // settings
  updateProjectSetting<K extends ProjectSettingKey>(key: K, value: ProjectSettings[K]): void;
  /**
   * Write BOTH timeline-range bounds (timelineMinYear + timelineMaxYear) in ONE
   * transition (finding bughunt2). The per-key {@link updateProjectSetting} derives
   * the timeline state after EACH single key change, so writing the two bounds
   * sequentially passes through a transient inverted range
   * ({newMin, oldMax}) whenever the whole window is shifted forward — and
   * {@link deriveTimelineState} throws on an inverted range (precondition guard). A
   * caller that has validated the WHOLE draft (min < max) must therefore fold both
   * bounds into a single set() so no intermediate inversion is ever derived. This
   * action does exactly that: it writes both keys, derives the range/time ONCE from
   * the final (valid) pair, and emits a single timelineMaxYear change notification
   * (the upper bound is the last-written key, matching the per-key order). The
   * incoming pair MUST already satisfy min < max (validated by the confirm entry);
   * deriveTimelineState asserts it.
   */
  setProjectTimelineRangeYears(minYear: number, maxYear: number): void;
  updateAppSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  /**
   * Hydrate BOTH settings slices wholesale from a loaded / new project's persisted
   * settings (LOAD / NEW path). This is the missing half of the二重真実源 fix
   * (教訓 5.30 / 5.36): a load reflects the domain via {@link resetToDomain}, but the
   * UI settings live in THIS store, so without this call a loaded project's
   * zoom/timeline/grid/label settings never reach the UI and a previous project's
   * settings linger. Replaces the whole `projectSettings` / `appSettings` value
   * atomically and marks the project CLEAN (a load/new is the save baseline, not an
   * edit), so it must run in the SAME transition family as `resetToDomain`. Passing
   * `undefined` for either slice leaves that slice at its current (default) value —
   * the correct behaviour for a pre-`ui` manifest that carried no UI settings.
   */
  hydrateSettings(settings: {
    readonly projectSettings?: ProjectSettings;
    readonly appSettings?: AppSettings;
  }): void;
  /**
   * ATOMIC LOAD / NEW reflect (bughunt2 finding): swap the domain AND hydrate the
   * UI settings in ONE transition that fully rolls back on failure. The previous
   * two-call sequence — `resetToDomain(project)` THEN `hydrateSettings(...)` — was
   * NOT atomic: `resetToDomain` unconditionally swapped the domain (and cleared the
   * session state) BEFORE `hydrateSettings` ran, and `hydrateSettings` calls
   * `deriveTimelineState`, which THROWS on an inverted timeline range
   * (timelineMin >= timelineMax). A throw there left the store half-applied — the
   * NEW domain installed but the OLD project's settings (zoom clamp / timeline
   * range / grid / labels) still in place, with the slider range no longer matching
   * the domain. The schema (uiProjectSettingsSchema.superRefine) blocks an inverted
   * range at the parse boundary today, so this was latent rather than live; but any
   * future reflect path that synthesizes settings (a repair, a new importer) would
   * corrupt state. This action derives the timeline FIRST (the only throwing step),
   * so if the incoming settings are invalid NOTHING is mutated, then commits the
   * domain swap + session discard + settings hydrate + derived range/time in a
   * SINGLE set(). It carries the exact semantics of {@link resetToDomain} +
   * {@link hydrateSettings} run back-to-back, only fused and rollback-safe.
   */
  reflectLoadedProject(
    nextDomain: S,
    settings: {
      readonly projectSettings?: ProjectSettings;
      readonly appSettings?: AppSettings;
    },
  ): void;
  /** Clear the project-dirty flag (called after a save by the persistence unit). */
  markProjectSaved(): void;
}

export type SessionStore<S> = SessionStoreState<S> & SessionStoreActions<S>;

// --- Selection mirroring (技術方針 2.5: the store MIRRORS U22's truth) -------
//
// The store does NOT re-implement re-validation (教訓 5.5/5.6) or re-resolution
// (教訓 5.11). Those rules live ONCE in U22 (domain/selection: revalidateForTime
// / reresolveAfterStructureChange). The store keeps the whole `SelectionState`
// and, on every change, re-derives the read-only mirrors subscribers consume.
// A single helper builds the patch so `selection` and its mirrors are written
// atomically and can never drift (二重の真実源 を作らない).

interface SelectionPatch {
  readonly selection: SelectionState;
  readonly activeFeature: ActiveFeature;
  readonly vertexSelection: VertexSelectionContext | null;
}

/** Build the atomic store patch (truth + derived mirrors) from a SelectionState. */
function selectionPatch(selection: SelectionState): SelectionPatch {
  return {
    selection,
    activeFeature: selection.activeFeature,
    vertexSelection: vertexSelectionContextOf(selection),
  };
}

/**
 * The display-control for a LOAD / NEW: the global depth N is project-independent
 * UI state and is intentionally KEPT, while the per-feature focus M (which points at
 * a specific feature of the OLD project) is cleared to {@link NO_DISPLAY_FOCUS}
 * (FR-42 / FR-43, 教訓 5.13).
 *
 * IDENTITY STABILITY (bughunt3 finding: displayControl identity churn on load): the
 * display pipeline's shared memos (resolveDisplayFor / buildCommittedFeatures) and
 * the Canvas redraw subscription all key on `displayControl` IDENTITY, treating a
 * reference match as a value match (the slice is swapped wholesale, never mutated).
 * The depth/focus SETTERS already preserve the reference on a no-op write to honour
 * that invariant; the reset paths must do the SAME. When the current focus is ALREADY
 * cleared (the common case — a fresh load with no active focus, e.g. globalDepth=0
 * default), spreading `{ ...dc, focus: NO_DISPLAY_FOCUS }` would mint a value-EQUAL
 * but reference-NEW object, busting every memo on each load and forcing a redundant
 * pipeline re-run + redraw even though depth and geometry are unchanged. So we return
 * the EXISTING reference unchanged when focus is already none, and only allocate a new
 * object when a stale focus actually has to be cleared (教訓 5.29: 単一真実源 = 単一
 * COMPUTATION — an unchanged input must not look like a new generation).
 */
function clearedFocusControl(dc: DisplayControl): DisplayControl {
  if (
    dc.focus.originId === NO_DISPLAY_FOCUS.originId &&
    dc.focus.depth === NO_DISPLAY_FOCUS.depth &&
    dc.focus.emphasize === NO_DISPLAY_FOCUS.emphasize
  ) {
    return dc;
  }
  return { ...dc, focus: NO_DISPLAY_FOCUS };
}

/**
 * Re-resolve the display-control's individual focus after a structure-changing
 * command (bughunt3): a merge / split / delete (including conflict resolution)
 * can REMOVE the very feature the focus origin points at. Selection is already
 * re-resolved against the {@link CommandResult} (deleted IDs dropped, 教訓 5.11)
 * — the focus origin is the ONE remaining per-feature reference that, without this,
 * would survive pointing at a deleted feature. We apply the SAME rule here: if the
 * command DELETED the current focus origin, clear the focus to {@link NO_DISPLAY_FOCUS}
 * (revert to global N, 教訓 5.2 stale を破棄). A focus whose origin survived (or no
 * active focus) is left untouched.
 *
 * IDENTITY STABILITY (same invariant as {@link clearedFocusControl}): when nothing
 * has to change — no focus, or the origin survived — we return the EXISTING
 * `displayControl` reference unchanged so the display memos / Canvas redraw, which
 * key on `displayControl` identity, are not busted by a value-equal-but-reference-new
 * object on every edit (教訓 5.29). Only an origin that was actually deleted allocates.
 */
function focusControlAfterStructureChange(
  dc: DisplayControl,
  result: CommandResult,
): DisplayControl {
  if (dc.focus.originId === null) return dc;
  if (!result.deleted.has(dc.focus.originId)) return dc;
  // The focused feature is gone — drop the per-feature focus, keep global depth N.
  return clearedFocusControl(dc);
}

/**
 * Adapt the store's injected {@link ExistenceResolver} to U22's
 * {@link revalidateForTime} existence port (教訓 5.34: the two layers meet at a
 * fixed contract, not by accident). The store still resolves NOTHING itself —
 * it just re-shapes the same injected predicates U22 calls with the time U22
 * passes in.
 */
function existenceAtTime(
  existence: ExistenceResolver,
): ExistenceAtTime<TimePoint> {
  return {
    featureExistsAt: (featureId, time) =>
      existence.featureExistsAt(featureId, time),
    vertexExistsAt: (ownerFeatureId, vertexId, time) =>
      existence.vertexExistsAt(ownerFeatureId, vertexId, time),
  };
}

/**
 * Clamp a candidate {@link TimePoint} into the inclusive [min, max] range using
 * U02 normalized (whole-day) comparison ONLY — the store does no calendar math of
 * its own, it defers to the injected/default calendar's normalize. Used when a
 * LOAD / NEW installs a new timeline range so a `currentTime` left over from the
 * previous project cannot dangle outside the new range (it would otherwise resolve
 * the domain at an out-of-range time and show nothing). Returns the candidate when
 * it is already inside, else the nearer bound.
 */
function clampTimeToRange(
  candidate: TimePoint,
  min: TimePoint,
  max: TimePoint,
  calendar: Calendar,
): TimePoint {
  const c = normalize(candidate, calendar);
  if (compareNormalized(c, normalize(min, calendar)) < 0) return min;
  if (compareNormalized(c, normalize(max, calendar)) > 0) return max;
  return candidate;
}

/**
 * The store patch that re-derives ALL project-dependent time state from a set of
 * project settings: the slider's range mirror (timelineMin/Max), a currentTime
 * re-clamped into that range, and the selection re-validated for the clamped time.
 *
 * This is the SINGLE place the timeline RANGE is derived from
 * projectSettings.timelineMin/MaxYear, so there is no second truth source
 * (技術方針 2.5). PRECONDITION: the incoming range MUST already satisfy
 * timelineMinYear < timelineMaxYear (validated by validateProjectSettings on every
 * write path); this function asserts it and throws on an inverted range rather than
 * clamping currentTime against a min>=max window. It is run from BOTH paths that can change the effective timeline
 * range: a LOAD / NEW hydrate ({@link SessionStoreActions.hydrateSettings}) AND a
 * live settings-dialog confirm ({@link SessionStoreActions.updateProjectSetting}
 * with a timeline key) — finding: pre-fix the dialog path wrote only
 * projectSettings, so the slider kept the OLD range and currentTime dangled
 * outside the new range until a reload. Both callers fold this patch into the SAME
 * set() as their own writes so settings and the derived range/time never drift.
 */
interface TimelineDerivation extends SelectionPatch {
  readonly timelineMin: TimePoint;
  readonly timelineMax: TimePoint;
  readonly currentTime: TimePoint;
}

function deriveTimelineState(
  effectiveProject: ProjectSettings,
  currentTime: TimePoint,
  selection: SelectionState,
  existence: ExistenceResolver,
  calendar: Calendar,
  // 選択 heal の対称性 (S4c): the timeline re-derive can MOVE currentTime (the clamp),
  // and a time move can change the display verdicts — so the same display
  // re-validation the setCurrentTime funnel runs must run here too, against the
  // CLAMPED time. Injected as a hook because this is a module-level pure function
  // while the display port lives in the store factory closure; the caller passes the
  // store's single revalidateDisplay bound to the live displayControl.
  displayHeal: (sel: SelectionState, time: TimePoint) => SelectionState,
): TimelineDerivation {
  const timelineMin = timePointYear(effectiveProject.timelineMinYear);
  const timelineMax = timePointYear(effectiveProject.timelineMaxYear);
  // PRECONDITION (finding): the range order rule timelineMinYear < timelineMaxYear
  // lives in U38's validateProjectSettings, which BOTH writing paths run before they
  // reach the store — the dialog/confirm entry validates the draft and the LOAD / NEW
  // hydrate comes through the persistence validation boundary. This is the SINGLE
  // place the range is derived (see above), so an inverted range here is a
  // programming error from an unvalidated caller, not a user input to clamp: without
  // this guard clampTimeToRange would silently snap currentTime against a min>=max
  // range (空表示 with no rejection). Reject it loudly so every (current and future)
  // caller is forced to pre-validate rather than letting an inverted range leak in.
  if (compareNormalized(
    normalize(timelineMin, calendar),
    normalize(timelineMax, calendar),
  ) >= 0) {
    throw new Error(
      `deriveTimelineState: inverted timeline range — timelineMinYear ` +
        `(${String(effectiveProject.timelineMinYear)}) must be < timelineMaxYear ` +
        `(${String(effectiveProject.timelineMaxYear)}); the range must be ` +
        `validated (validateProjectSettings) before it reaches the store.`,
    );
  }
  const clampedTime = clampTimeToRange(
    currentTime,
    timelineMin,
    timelineMax,
    calendar,
  );
  const revalidated = revalidateForTime(
    selection,
    clampedTime,
    existenceAtTime(existence),
  );
  // Display re-validation at the CLAMPED time (選択 heal の対称性, S4c): existence
  // pruning first (the anchor-level truth), then the display owner re-resolution —
  // the same two-step order the setCurrentTime funnel uses.
  const healed = displayHeal(revalidated, clampedTime);
  return {
    timelineMin,
    timelineMax,
    currentTime: clampedTime,
    ...selectionPatch(healed),
  };
}

// --- Store factory ----------------------------------------------------------

export interface CreateSessionStoreOptions<S> {
  /** The initial immutable domain state (the truth root). */
  readonly initialDomain: S;
  /** Injected time-existence predicates (单一真实源; defaults to always-present). */
  readonly existence?: ExistenceResolver;
  /**
   * Value-equality for the opaque domain root `S`, used ONLY to recompute the
   * dirty flag after an undo / redo (bughunt: 全 undo 後も dirty が残る). The store
   * never reaches into `S` (spec 依存: ルート状態を不変に受け渡す), so the composition
   * root injects the domain's own equality (App.tsx wires `projectsEqual`). When an
   * undo / redo lands back on a state that is value-equal to the last SAVED baseline
   * the project is clean again — but commands rebuild the state via Immer, so the
   * restored reference is value-equal-but-NEW; a bare `===` would always look dirty.
   * Defaults to reference identity ({@link Object.is}) when not injected (tests with
   * an opaque/primitive domain), which still clears dirty for a literal round-trip.
   */
  readonly domainEquals?: (a: S, b: S) => boolean;
  /**
   * Injected display owner-lookup port (単一真実源; 選択 heal の対称性 — the
   * display-axis sibling of `existence` for the time axis, 教訓 5.5/5.6). Used to
   * re-validate the vertex selection whenever ANY display-resolution input changes:
   * a displayControl setter (depth / focus), a time change (setCurrentTime / timeline
   * re-derive) or a domain swap (applyCommandResult / applyUndoRedoResult — run AFTER
   * the commit so the port sees the live post-commit root, S4c). The composition root
   * wires it to resolveDisplayFor's `owners` map so「掴める」==「描画/ヒット対象」;
   * U22's revalidateForDisplay then re-resolves each selected vertex per-owner (a
   * shared vertex surviving through another drawn feature is KEPT with its owner
   * rewritten — never a blanket clear). When OMITTED the display re-validation is
   * skipped entirely (honest absence — pre-fix behaviour for opaque-domain tests).
   */
  readonly grabbability?: DisplayGrabbabilityResolver;
  /**
   * The live set of ALL feature ids that currently EXIST in the project (across all
   * time — the feature-history level, NOT effective-at-time). Injected so the store can
   * prune the FR-113 display filter's per-feature parts (個別非表示 / 強調 id) after any
   * structure-changing command via {@link reconcileToLiveFeatures} — the SAME
   * "derive from the live母集合, not gated on the input path" discipline the selection
   * heal uses (教訓 5.5/5.6). The store never reaches into the opaque domain `S` itself
   * (spec 依存: ルート状態を不変に受け渡す), so the composition root supplies this thunk
   * bound to the live root (mirror of {@link ExistenceResolver}). Read live per call —
   * the reconcile runs AFTER the domain commit so it sees the just-committed feature set.
   * When OMITTED the filter reconcile is SKIPPED (honest absence — framework-free tests
   * that never delete a hidden/emphasized feature are unaffected).
   */
  readonly liveFeatureIds?: () => ReadonlySet<FeatureId>;
  /**
   * Calendar used ONLY to clamp `currentTime` into the timeline range on a
   * LOAD / NEW hydrate (the store does not resolve time itself). Defaults to the
   * gregorian calendar (FR-67 initial 暦設定), matching the timeline hook.
   */
  readonly calendar?: Calendar;
  /** Initial session overrides (mostly for tests). */
  readonly initial?: Partial<
    Pick<
      SessionStoreState<S>,
      | 'activeFeature'
      | 'vertexSelection'
      | 'mode'
      | 'activeTool'
      | 'currentTime'
      | 'camera'
      | 'centerLon'
      | 'displayControl'
      | 'filter'
      | 'projectSettings'
      | 'appSettings'
    >
  >;
}

/**
 * Build a vanilla (framework-free) session store. The returned `StoreApi` has
 * `getState` / `setState` / `subscribe` — the Canvas uses `subscribe` directly
 * (no React), React binds via `useStore(store, selector)` (技術方針 2.5).
 */
export function createSessionStore<S>(
  options: CreateSessionStoreOptions<S>,
): StoreApi<SessionStore<S>> {
  const existence = options.existence ?? ALWAYS_PRESENT_RESOLVER;
  // May be undefined: display re-validation is then SKIPPED everywhere (honest
  // absence — no fabricated "always owned" truth; see the option doc).
  const grabbability = options.grabbability;
  // May be undefined: the FR-113 filter reconcile is then SKIPPED (honest absence —
  // the store never inspects the opaque domain to derive the live feature set itself).
  const liveFeatureIds = options.liveFeatureIds;
  const calendar = options.calendar ?? getCalendar('gregorian');
  const domainEquals = options.domainEquals ?? Object.is;
  const init = options.initial ?? {};

  // The SINGLE display re-validation entry (選択 heal の対称性, S4c): every branch
  // whose change can alter the display resolution — displayControl setters, the
  // setCurrentTime funnel, the timeline re-derive, and the post-commit tightening in
  // applyCommandResult / applyUndoRedoResult — funnels through THIS one helper, so
  // the rule cannot drift between branches (教訓 5.6 / 5.29). It defers entirely to
  // U22's revalidateForDisplay over the injected port's owner lookup (lazy — the
  // resolution runs only if a vertex is actually consulted); with no port injected
  // it is the identity.
  const revalidateDisplay = (
    selection: SelectionState,
    time: TimePoint,
    control: DisplayControl,
  ): SelectionState =>
    grabbability === undefined
      ? selection
      : revalidateForDisplay(selection, grabbability.displayOwnersAt(time, control));

  // The domain reference last established as the SAVED / CLEAN baseline (bughunt:
  // 全 undo 後の dirty 解消). It is the ONE reference an undo / redo compares against
  // to decide whether the project is back to its saved state. It is set by EVERY
  // clean-baseline path (markProjectSaved on save, and the LOAD / NEW reflects which
  // establish a fresh clean baseline) and stays null until the first save / load /
  // new — while null, an undo / redo can never be "clean" (a never-saved project is
  // always treated dirty once edited). It lives as a closure variable (not store
  // state) because it is internal bookkeeping no subscriber renders; the store keeps
  // a single dirty TRUTH (projectDirty), and this only feeds its recomputation.
  let savedDomain: S | null = null;

  // The SETTINGS half of the saved / clean baseline (bughunt2: undo-dirty ignored
  // settings). The persisted project file carries BOTH the domain and the ui
  // settings slice (projectSettings + the document-affecting appSettings), so the
  // clean/dirty truth must compare BOTH halves — not the domain alone. Without
  // these, a project that is domain-clean but settings-dirty (a setting changed
  // after the last save) was reported CLEAN after any unrelated undo / redo
  // (applyUndoRedoResult compared only the domain), so the user could lose
  // settings edits believing they were saved. Captured in lock-step with
  // `savedDomain` on EVERY clean-baseline path; stay null until the first save /
  // load / new, mirroring `savedDomain` (a never-saved project is always dirty).
  let savedProjectSettings: ProjectSettings | null = null;
  let savedAppSettings: AppSettings | null = null;

  // The BASE-MAP BYTES half of the saved / clean baseline (F2 確認レビュー 点4:
  // byte-only 背景地図差し替えの dirty 取りこぼし). The base-map IMAGE BYTES live
  // OUTSIDE the domain snapshot — App holds them (baseMapImageRef 表示 /
  // loadedAssetsRef 保存) and the domain carries only baseMap.source/meta. So the
  // injected `domainEquals` (App wires projectsEqual → baseMapsEqual) compares the base
  // map by source/meta ONLY, never the bytes. A replace that KEEPS source/meta (an
  // already-user project swapped for different bytes: basemap-replace stamps
  // REPLACED_BASEMAP_SOURCE only for a preset/empty project, else preserves source/meta)
  // changes ONLY the bytes — invisible to `domainEquals`. Without this flag, an
  // undo / redo AFTER such a replace found the domain value-equal to the saved baseline
  // and FALSELY cleared projectDirty (applyUndoRedoResult), so the unsaved byte
  // replacement read as saved and was lost on close. The store therefore keeps this
  // boolean: the base-map bytes MAY differ from the saved file since the last save. It
  // is SET true by the ONLY in-session path that changes the bytes while leaving the
  // domain value-equal ({@link SessionStoreActions.replaceBaseMap}) and CLEARED false by
  // EVERY clean-baseline path (a real save → markProjectSaved, and the LOAD / NEW
  // reflects) — the SAME sites that (re)establish `savedDomain`, since a save persists
  // the current bytes and a load/new installs a fresh bytes baseline. An undo / redo
  // NEVER clears it (only a real save persists the bytes), so it survives the dirty
  // RECOMPUTATION and is OR-ed into the clean check there. Like `savedDomain` it lives as
  // a closure variable (internal bookkeeping no subscriber renders): projectDirty stays
  // the single store-state dirty TRUTH the unsaved-changes guard reads — this only feeds
  // its recomputation. It cannot be a bytes SNAPSHOT (the store never sees the external
  // bytes), so it is a since-save-dirty boolean rather than a `savedDomain`-style value.
  let baseMapBytesDirtySinceSave = false;

  // Build the initial selection TRUTH (U22 SelectionState) from the test/init
  // overrides, then derive the mirrors from it — there is no second source.
  let initialSelection: SelectionState = EMPTY_SELECTION;
  if (init.activeFeature != null) {
    initialSelection = withActiveFeature(initialSelection, init.activeFeature);
  }
  if (init.vertexSelection != null) {
    initialSelection = replaceVertices(
      initialSelection,
      init.vertexSelection.ownerFeatureId,
      new Set(init.vertexSelection.vertexIds),
    );
  }
  const initialPatch = selectionPatch(initialSelection);

  return createStore<SessionStore<S>>((set, get) => {
    // Capture the CURRENT (live) domain + settings as the saved / clean baseline.
    // Every clean-establishing path routes through here so the three references can
    // never drift (single capture site, 二重の真実源 を作らない). `domain` is taken
    // from the caller-supplied value when it is being swapped in the SAME set()
    // (LOAD / NEW), else from the live store (save / settings hydrate). Defined
    // inside the store callback so it can read `get()` (the saved baseline lives in
    // the enclosing factory closure).
    const captureSavedBaseline = (domain: S): void => {
      savedDomain = domain;
      savedProjectSettings = get().projectSettings;
      savedAppSettings = get().appSettings;
      // A save persists the current base-map bytes and a LOAD / NEW installs a fresh
      // bytes baseline, so at every clean baseline the bytes match the saved file —
      // clear the byte-replace dirty flag (F2 点4). Every savedDomain-writing site does
      // this; hydrateSettings / reflectLoadedProject (which set savedDomain directly,
      // not via this helper) clear it explicitly for the same reason.
      baseMapBytesDirtySinceSave = false;
    };

    // True when the LIVE settings still match the saved baseline (both halves).
    // Reuses the settings diff helpers (structural, handle the customPalette array)
    // so the no-op predicate the dialog uses and the dirty baseline agree (教訓 5.19
    // 単一のキー一覧). A null baseline (never saved) is never settings-clean.
    //
    // bughunt-review: the APP half compares ONLY document-affecting keys
    // (isDocumentAffectingAppNoOp), consistent with `updateAppSetting`'s cosmetic
    // exception — a pure cosmetic preference (showConflictGuide) deliberately does
    // NOT dirty the project, so toggling it after a save and then undoing the domain
    // back to saved must still read CLEAN. Comparing all keys (isAppNoOp) falsely
    // reported settings-dirty and fired the unsaved-changes guard on quit. The
    // PROJECT half has no analogous cosmetic exception, so it compares all keys.
    const settingsMatchSaved = (): boolean =>
      savedProjectSettings !== null &&
      savedAppSettings !== null &&
      isProjectNoOp(savedProjectSettings, get().projectSettings) &&
      isDocumentAffectingAppNoOp(savedAppSettings, get().appSettings);

    // Commit a CHANGED display-control value AND heal the vertex selection against it
    // in ONE set() (選択 heal の対称性: the display-axis sibling of setCurrentTime's
    // revalidateForTime, 教訓 5.5/5.6). A depth/focus change can roll the vertex
    // selection's OWNER up into an aggregate (or omit it), so its vertices vanish
    // from the display owner lookup and the property panel would classify them as
    // CONTEXT_KIND.Unknown「所有地物を特定できません」. We re-validate through the
    // single revalidateDisplay funnel bound to the NEW control + the CURRENT time —
    // the SAME resolveDisplayFor owners map the renderer draws / hit-test grabs
    // (単一真実源, re-implementing no verdict logic). Folded into the SAME set() as
    // the display-control write so display and selection never drift.
    //
    // ONLY the six pure display-control setters below route through here (never a
    // NO-OP write — the callers return early on an unchanged value, preserving the
    // displayControl reference for the display memos, bughunt3). revalidateForDisplay
    // is idempotent (returns the SAME selection reference when nothing changes — the
    // common case, and it does not even consult the resolver for an empty/active-only
    // selection), so the selection mirrors are re-derived only on an actual change,
    // and the transient is preserved (FR-42 非干渉 — a display change never aborts a
    // gesture). A SHARED vertex surviving through another drawn owner is KEPT with
    // vertexOwner rewritten (Codex [MED], see revalidateForDisplay).
    const commitDisplayControl = (nextControl: DisplayControl): void => {
      const selection = get().selection;
      const healed = revalidateDisplay(selection, get().currentTime, nextControl);
      set({
        displayControl: nextControl,
        ...(healed !== selection ? selectionPatch(healed) : {}),
      });
    };

    // The deriveTimelineState display-heal hook (S4c): display re-validation at the
    // CLAMPED time under the CURRENT display control (unchanged on the settings /
    // hydrate branches that re-derive the timeline). Defined once here so all four
    // call sites pass the same funnel (教訓 5.6).
    const timelineDisplayHeal = (
      sel: SelectionState,
      t: TimePoint,
    ): SelectionState => revalidateDisplay(sel, t, get().displayControl);

    // The FR-113 filter reconcile funnel (教訓 5.5/5.6, mirror of the selection heal):
    // after ANY structure-changing command commits, prune the display filter's per-feature
    // parts (個別非表示 / 強調 id) against the LIVE feature母集合 so a deleted feature's id
    // can never dangle (and — via undo/redo replaying a recorded id — re-attach to a
    // DIFFERENT feature later, cross-domain display-state corruption; see
    // reconcileToLiveFeatures). MUST run AFTER the domain commit so `liveFeatureIds()`
    // reads the just-committed feature set (same ordering as the existence heal). Folded
    // into its own set() ONLY when the filter actually changed (reconcileToLiveFeatures
    // returns the SAME reference when nothing was pruned — the common case — so no spurious
    // redraw / memo bust). Skipped entirely when no resolver is injected (honest absence).
    const reconcileFilterToLive = (): void => {
      if (liveFeatureIds === undefined) return;
      const cur = get().filter;
      const next = reconcileToLiveFeatures(cur, liveFeatureIds());
      if (next !== cur) set({ filter: next });
    };

    return {
    // -- initial state -------------------------------------------------------
    domain: options.initialDomain,
    selection: initialPatch.selection,
    activeFeature: initialPatch.activeFeature,
    vertexSelection: initialPatch.vertexSelection,
    mode: init.mode ?? EDIT_MODE.View,
    activeTool: init.activeTool ?? null,
    currentTime: init.currentTime ?? DEFAULT_TIMELINE_MIN,
    lastTimeChangeSource: null,
    timelineMin: DEFAULT_TIMELINE_MIN,
    timelineMax: DEFAULT_TIMELINE_MAX,
    camera: init.camera ?? DEFAULT_CAMERA,
    centerLon: init.centerLon ?? 0,
    displayControl: init.displayControl ?? DEFAULT_DISPLAY_CONTROL,
    survey: initialSurveyState(),
    filter: init.filter ?? DEFAULT_FILTER_STATE,
    projectSettings: init.projectSettings ?? DEFAULT_PROJECT_SETTINGS,
    appSettings: init.appSettings ?? DEFAULT_APP_SETTINGS,
    projectDirty: false,
    lastSettingsChange: null,
    basemapReplaceNonce: 0,

    // -- bridge --------------------------------------------------------------
    applyCommandResult(nextDomain, result, preference) {
      // 教訓 5.11: re-resolve via U22 — drop deleted IDs, promote the caller's
      // next-target preference. The store does NOT re-implement this rule.
      const reresolved = reresolveAfterStructureChange(
        get().selection,
        result,
        preference,
      );
      // The per-feature display focus is the ONE remaining reference to a specific
      // feature that selection re-resolution does not cover; re-resolve it against
      // the SAME result so a focus origin the command DELETED (e.g. a feature merged
      // away by conflict resolution) does not dangle (bughunt3 — see
      // focusControlAfterStructureChange). Identity is preserved when the origin
      // survived, so an ordinary edit does not bust the display memos.
      const nextDisplayControl = focusControlAfterStructureChange(
        get().displayControl,
        result,
      );
      // A domain edit marks the project dirty (spec §B dirty 単一基準 / 教訓 5.36):
      // this is the SAME projectDirty a setting change sets, so the U39 unsaved
      // guard sees BOTH edit kinds through one flag (no second truth source).
      //
      // COMMIT THE DOMAIN FIRST (第10波 #5): the injected existence resolver reads
      // the LIVE committed root (App wires getRoot = () => store.getState().domain),
      // so the anchor-level re-validation below must run AFTER `nextDomain` is in the
      // store — otherwise it would resolve against the PRE-commit domain (where a
      // just-deleted time-slice feature is still present) and prune nothing. This set
      // reflects a fully-coherent post-commit state on its own (domain + focus +
      // feature-history-level re-resolved selection); the anchor-level tightening
      // below only ever REMOVES a ghost, never adds one.
      set({
        domain: nextDomain,
        projectDirty: true,
        displayControl: nextDisplayControl,
        ...selectionPatch(reresolved),
      });
      // 第10波 #5: reresolveAfterStructureChange works at the FEATURE-HISTORY level
      // (CommandResult survived/created/deleted). A multi-anchor feature's TIME-SLICE
      // delete (a below-threshold delete at ONE anchor) drops the feature only at the
      // CURRENT time, while its history survives via other anchors — so makeCommand
      // reports it as `survived`, reresolve keeps it, and a ghost activeFeature /
      // vertex selection lingers that draws nothing at this time and no-ops a second
      // Delete (App ring-edit last-territory ghost, App.tsx onRingEditCommitted, same
      // failure). We heal it by ALSO running the SAME anchor-level revalidateForTime
      // the time-change path uses (store setCurrentTime), against the injected
      // existence port at the CURRENT time — the single existence truth源, re-
      // implementing no time logic. Anything present at the current time (a normal
      // add/split/merge/reparent/drill/drag/attribute promotion) is PRESERVED;
      // anything the commit left absent at the current time drops out. We fold this
      // into a SECOND set() ONLY when it actually changed the selection (the common
      // case is a no-op — nothing absent — so no redundant notification / redraw and
      // no二重の真実源: the selection mirrors and truth are re-derived together).
      const revalidated = revalidateForTime(
        reresolved,
        get().currentTime,
        existenceAtTime(existence),
      );
      // 選択 heal の対称性 (S4c, Codex [HIGH]): the domain swap can ALSO change the
      // display resolution (e.g. an edit reparents the selection owner under an
      // aggregate → Omit at the current depth while every id SURVIVES). Re-validate
      // against the display owners over the LIVE (just-committed) root — the injected
      // port reads the root through getRoot at call time, so running AFTER the first
      // set() sees the post-commit root, the same ordering as the time tightening
      // above (第10波 #5). The displayControl used is the one committed in that set().
      const healed = revalidateDisplay(
        revalidated,
        get().currentTime,
        nextDisplayControl,
      );
      if (healed !== reresolved) {
        set(selectionPatch(healed));
      }
      // FR-113 (教訓 5.5/5.6): prune the display filter's per-feature ids against the
      // just-committed live feature set — a deleted 個別非表示 / 強調 target must not dangle.
      reconcileFilterToLive();
    },

    applyUndoRedoResult(nextDomain, result, preference) {
      // Same reflect as applyCommandResult (U22 selection + display-focus re-resolution,
      // 教訓 5.11 / bughunt3) — the ONLY difference is the dirty flag is recomputed
      // against the saved baseline rather than forced true (bughunt: 全 undo 後も dirty
      // が残る). When the restored domain is value-equal to the last SAVED reference the
      // project is back to its saved state (clean); otherwise it is dirty. A project that
      // was never saved (savedDomain === null) can never be clean here, so an undo that
      // empties the stack on a never-saved project keeps it dirty (correct: there is no
      // on-disk content to be "in sync" with).
      const next = reresolveAfterStructureChange(
        get().selection,
        result,
        preference,
      );
      const nextDisplayControl = focusControlAfterStructureChange(
        get().displayControl,
        result,
      );
      // Clean requires BOTH halves of the persisted baseline to match: the
      // restored domain value-equals the saved domain AND the live settings still
      // match the saved settings (bughunt2). An undo / redo never touches the
      // settings slice, so a project that was domain-clean but settings-dirty
      // (a setting changed after the last save) MUST stay dirty here — comparing
      // the domain alone falsely cleared it and silently discarded the settings
      // edit from the unsaved-changes guard's view.
      // A byte-only base-map replace since the last save (kept source/meta) is
      // INVISIBLE to domainEquals (bytes live outside the domain), so it must be OR-ed
      // in here: if the bytes diverge from the saved file the project is NOT clean, even
      // when the domain and settings both value-match the baseline (F2 点4 — the
      // previous hole). This recompute NEVER clears the flag (it only reads it); only a
      // real save / LOAD / NEW clears it, so the byte divergence survives every
      // undo / redo until the bytes are actually persisted.
      const clean =
        savedDomain !== null &&
        domainEquals(nextDomain, savedDomain) &&
        settingsMatchSaved() &&
        !baseMapBytesDirtySinceSave;
      // COMMIT THE DOMAIN FIRST (第11波 Fix C, #4=#5): symmetric with
      // applyCommandResult (694-754). The injected existence resolver reads the LIVE
      // committed root (App wires getRoot = () => store.getState().domain), so the
      // anchor-level re-validation below must run AFTER `nextDomain` is in the store —
      // otherwise it would resolve against the PRE-commit domain and prune nothing.
      // This set reflects a fully-coherent post-commit state on its own (domain +
      // recomputed dirty + focus + feature-history-level re-resolved selection); the
      // anchor-level tightening below only ever REMOVES a ghost, never adds one, and
      // never touches projectDirty.
      set({
        domain: nextDomain,
        projectDirty: !clean,
        displayControl: nextDisplayControl,
        ...selectionPatch(next),
      });
      // 第11波 Fix C (#4=#5): the sibling of the 第10波 #5 heal on applyCommandResult.
      // reresolveAfterStructureChange works at the FEATURE-HISTORY level, so undoing /
      // redoing a multi-anchor feature's TIME-SLICE delete (or a ring-edit last-
      // territory delete) — reported by makeCommand as `survived` because other anchors
      // keep the history alive — cannot prune a feature/vertex that is absent at the
      // CURRENT time but present at another anchor: a ghost activeFeature / vertex
      // selection revives and lingers (#5 recurring on the undo/redo path). We heal it
      // with the SAME anchor-level revalidateForTime the time-change path uses, against
      // the injected existence port at the CURRENT time — the single existence truth源,
      // re-implementing no time logic. Anything present at the current time (a normal
      // undo/redo whose target is still drawn) is PRESERVED; anything the restored
      // domain leaves absent at the current time drops out. Folded into a SECOND set()
      // ONLY when it actually changed the selection (revalidateForTime is idempotent —
      // no pruning ⇒ same reference), so the common case does no redundant redraw and
      // the dirty flag committed above is untouched.
      const revalidated = revalidateForTime(
        next,
        get().currentTime,
        existenceAtTime(existence),
      );
      // 選択 heal の対称性 (S4c, Codex [HIGH]): symmetric with applyCommandResult —
      // an undo / redo can restore a domain whose hierarchy differs (the selection
      // owner becomes / stops being an aggregate's child), changing the display
      // resolution while every id survives. Runs AFTER the first set() so the
      // injected port reads the post-commit root (第10波 #5 と同順序); never touches
      // projectDirty (prune / owner-rewrite only).
      const healed = revalidateDisplay(
        revalidated,
        get().currentTime,
        nextDisplayControl,
      );
      if (healed !== next) {
        set(selectionPatch(healed));
      }
      // FR-113 (教訓 5.5/5.6): symmetric with applyCommandResult — an undo / redo that
      // drops a feature (or replays a recorded id) reconciles the filter's per-feature
      // ids against the live母集合 so a stale 個別非表示 / 強調 id can never re-attach.
      reconcileFilterToLive();
    },

    setDomainState(nextDomain) {
      // A domain swap (any edit path) marks the project dirty (spec §B 単一基準).
      // A LOAD / NEW also swaps the domain but is a clean baseline; those paths
      // clear the flag with markProjectSaved() in the SAME transition (教訓 5.36),
      // so a clean load/new ends with projectDirty=false while an edit leaves it true.
      set({ domain: nextDomain, projectDirty: true });
    },

    replaceBaseMap(nextDomain) {
      // FR-04: a base-map-only replace. Dirty like any edit (教訓 5.36) AND bump the
      // nonce so App's history subscription treats it as a replace (preserve the edit
      // undo/redo stacks) rather than an external whole-state swap (re-root) — F2. It
      // deliberately does NOT touch selection / tool / mode / focus (a base-map swap
      // changes no features/vertices), so an in-progress edit context survives. The
      // nonce and the domain swap land in ONE transition so App observes them together.
      //
      // F2 点4: a replace may change ONLY the IMAGE BYTES (kept source/meta for an
      // already-user project), which live OUTSIDE the domain snapshot and so are
      // invisible to `domainEquals`. Mark the bytes-since-save flag so a later
      // undo / redo does NOT falsely clear projectDirty (see the flag declaration).
      // Only a real save clears it; setting projectDirty=true here is the immediate
      // dirty, the flag is what carries the byte divergence THROUGH the undo/redo
      // recomputation.
      baseMapBytesDirtySinceSave = true;
      set({
        domain: nextDomain,
        projectDirty: true,
        basemapReplaceNonce: get().basemapReplaceNonce + 1,
      });
    },

    resetToDomain(nextDomain) {
      // A LOAD / NEW is a fresh CLEAN baseline: record it (domain + the live
      // settings) as the saved reference so a later undo / redo back to this exact
      // state reads clean (bughunt 全 undo dirty + settings, bughunt2). resetToDomain
      // does NOT swap the settings slice, so the live projectSettings/appSettings ARE
      // the new baseline's settings.
      captureSavedBaseline(nextDomain);
      // Atomic whole-state swap for LOAD / NEW: new domain + discarded session
      // state + clean baseline, in ONE set() (教訓 5.2 全経路で破棄, 受け入れ基準 4
      // 同時初期化). selection/tool/mode/focus from the OLD project cannot survive:
      // a stale id selected against the NEW domain, or a stale focus origin, would
      // otherwise dangle. The display-control GLOBAL depth N is project-independent
      // UI state and is intentionally preserved; only the individual focus M
      // (originId / depth / emphasize) — which references a specific feature — is
      // cleared (FR-42 / FR-43, 教訓 5.13: focus is the per-feature part).
      set({
        domain: nextDomain,
        projectDirty: false,
        mode: EDIT_MODE.View,
        activeTool: null,
        // Keep the global depth N (project-independent) and clear only the per-feature
        // focus M; preserve the displayControl REFERENCE when focus is already cleared
        // so a load with no active focus does not bust the display memos (bughunt3 —
        // see clearedFocusControl).
        displayControl: clearedFocusControl(get().displayControl),
        // U37 §4.5: the survey slice (確定線 + draft + active) belongs to the OLD
        // project's session — discard it wholesale on a LOAD / NEW (教訓 5.2).
        survey: initialSurveyState(),
        // FR-113: the display filter (種別/深度/個別非表示/不透明度) is OLD-project session
        // state too — reset to the inert DEFAULT on a LOAD / NEW (受け入れ基準1, 教訓 5.2).
        // DEFAULT_FILTER_STATE is a module const, so an already-default filter keeps its
        // reference (no memo churn on a fresh load).
        filter: DEFAULT_FILTER_STATE,
        ...selectionPatch(EMPTY_SELECTION),
      });
    },

    // -- selection (every mutation flows through U22's truth + builders) ------
    setActiveFeature(featureId) {
      // 第10波 #2: setActiveFeature is called DIRECTLY by the panel / detail /
      // search / help-tools promotion paths (SidebarContent / App / HelpTools
      // Controller) — bypassing the U22 reducer's FeatureBody branch and
      // promoteHitToSelection, both of which掃除 the vertex set. If we only
      // re-applied withActiveFeature here, a vertex selection owned by a
      // DIFFERENT feature would linger, and runEditDelete reads vertexOwner /
      // vertexIds FIRST — so picking feature A from a panel while a vertex of
      // feature B is still selected, then pressing Delete, would delete B's
      // vertex (a feature the user did NOT pick). We heal the asymmetry ONCE at
      // this single setter (the callers stay untouched): when the new active
      // feature is NOT the current vertex owner we ALSO run U22's withoutVertex
      // Set (re-using the same rule the reducer applies, 単一真実源 — we
      // re-implement nothing). Re-selecting the SAME feature (activeFeature ==
      // owner) PRESERVES the vertex selection so a panel re-click of the owner
      // does not wipe a live vertex edit. Keying off the vertex OWNER (not the
      // previous activeFeature) also heals a stale activeFeature=A / vertexOwner=B
      // 食い違い. The reArmActiveTool restoreSelection path does not go through
      // here, so it is unaffected.
      const s = get();
      const withFeature = withActiveFeature(s.selection, featureId);
      const cleaned =
        featureId !== s.selection.vertexOwner
          ? withoutVertexSet(withFeature)
          : withFeature;
      set(selectionPatch(cleaned));
    },

    replaceVertexSelection(ownerFeatureId, vertexIds) {
      set(
        selectionPatch(
          replaceVertices(get().selection, ownerFeatureId, new Set(vertexIds)),
        ),
      );
    },

    toggleVertexSelection(ownerFeatureId, vertexId) {
      set(selectionPatch(toggleVertex(get().selection, ownerFeatureId, vertexId)));
    },

    addVerticesToSelection(ownerFeatureId, vertexIds) {
      set(
        selectionPatch(addVertices(get().selection, ownerFeatureId, vertexIds)),
      );
    },

    clearSelection() {
      set(selectionPatch(EMPTY_SELECTION));
    },

    restoreSelection(selection) {
      set(selectionPatch(selection));
    },

    // -- mode / tool (reset契約 on every path, 教訓 5.2) --------------------
    setMode(mode) {
      // Mode switch discards transient selection (教訓 5.2 全経路で破棄).
      set({ mode, activeTool: null, ...selectionPatch(EMPTY_SELECTION) });
    },

    setActiveTool(tool, preserveSelection) {
      // Tool switch also runs the reset契約 (clear selection) UNLESS the caller
      // explicitly pins a selection to preserve — the post-conflict re-arm carries
      // the committed selection so the null→prev toggle never paints an empty frame
      // (教訓 5.11). When preserved, only `activeTool` actually changes; the
      // selection mirrors are re-applied to the SAME value atomically.
      set({
        activeTool: tool,
        ...selectionPatch(preserveSelection ?? EMPTY_SELECTION),
      });
    },

    // -- time (single re-validation funnel, 教訓 5.5 / 5.6) -----------------
    setCurrentTime(time, source) {
      // 教訓 5.5/5.6: re-validate via U22 against the injected existence port.
      // The store resolves no time itself; every path funnels through here.
      //
      // Finding (bughunt2): clamp the incoming time into the live timeline range
      // BEFORE it is committed and BEFORE selection is re-validated, exactly as
      // deriveTimelineState does on the LOAD / NEW + dialog paths (clampTimeToRange).
      // The store — not each caller — must enforce the [timelineMin, timelineMax]
      // invariant: an out-of-range currentTime resolves the domain at a time with
      // no committed features (空表示) while selection is revalidated at that same
      // out-of-range time, so a stale selection would "survive but nothing draws".
      // All shipped UI callers already clamp (useTimeline / bounded playback), so
      // this is a no-op on every live path; it only closes the asymmetry for a
      // future non-UI caller or a playback edge that overshoots a bound.
      const { selection, timelineMin, timelineMax } = get();
      const clamped = clampTimeToRange(time, timelineMin, timelineMax, calendar);
      const next = revalidateForTime(
        selection,
        clamped,
        existenceAtTime(existence),
      );
      // 選択 heal の対称性 (S4c, Codex [HIGH]): a TIME change also changes the display
      // resolution — e.g. at the new time the selection owner becomes an aggregate's
      // child (Omit at the current depth) while still EXISTING, so revalidateForTime
      // keeps it but its vertices vanish from the display owners map (panel Unknown).
      // Re-validate against the display owners at the CLAMPED time + current control,
      // in the SAME set() (root unchanged on this branch, so pre-set is safe).
      const healed = revalidateDisplay(next, clamped, get().displayControl);
      set({
        currentTime: clamped,
        lastTimeChangeSource: source,
        ...selectionPatch(healed),
      });
    },

    setTimelineRange(min, max) {
      set({ timelineMin: min, timelineMax: max });
    },

    // -- camera / longitude --------------------------------------------------
    setCamera(camera) {
      set({ camera });
    },

    updateCamera(patch) {
      // The top-level `centerLon` (FR-12 longitude shift) and `camera.centerLon`
      // are the SAME longitude truth (App.tsx publishCameraHooks mirrors every
      // live render-camera center into both). Keep them in lock-step inside the
      // SINGLE set() so a live pan / wheel is ONE store transition — never a
      // `updateCamera` set() immediately followed by a separate `setCenterLon`
      // set(), which fired the subscription twice on the hottest path and could
      // momentarily diverge the two truths between the two transitions (二重真実源を
      // 作らない, 教訓 5.29). When the patch carries `centerLon` we mirror it; when it
      // does not (e.g. a zoom-only update) the top-level `centerLon` is untouched.
      const next: { camera: Camera; centerLon?: number } = {
        camera: { ...get().camera, ...patch },
      };
      if (patch.centerLon !== undefined) next.centerLon = patch.centerLon;
      set(next);
    },

    setCenterLon(centerLon) {
      set({ centerLon });
    },

    // -- display control (FR-42 / FR-43): INDEPENDENT AXIS ------------------
    // Every setter writes ONLY `displayControl`. It never touches mode / tool /
    // selection / domain, so a depth or focus change cannot disturb an
    // in-progress edit (FR-42 非干渉, 受け入れ基準 2). The reverse — mode/tool
    // setters never write displayControl — is structurally true above.
    //
    // IDENTITY STABILITY (bughunt3 finding: displayControl object identity churn):
    // every setter below is a NO-OP when the incoming value equals the current
    // value — it returns WITHOUT calling set(), so the `displayControl` reference
    // is preserved. The display pipeline's three shared memos (resolveDisplayFor,
    // buildCommittedFeatures) AND the Canvas redraw subscription (App.tsx) all key
    // on `displayControl` IDENTITY, treating a reference match as a value match
    // (the slice is swapped wholesale, never mutated). A slider drag emits MANY
    // events at the SAME integer depth (pointermove between steps); without this
    // guard each repeated-value call spread a fresh-but-equal `displayControl`
    // object, busting every memo and forcing a redundant pipeline run + redraw even
    // though geometry was unchanged. Skipping the no-op write keeps a single
    // identity for an unchanged depth/focus → cache HIT (教訓 5.29: 単一真実源 =
    // 単一 COMPUTATION — an unchanged input must not look like a new generation).
    // Each CHANGED write routes through commitDisplayControl, which folds in the
    // vertex-selection heal (revalidateForDisplay) so a depth/focus change that hides
    // the selection owner prunes the now-un-grabbable vertices in the SAME set()
    // (選択 heal の対称性: display-axis sibling of setCurrentTime). A NO-OP write still
    // returns early WITHOUT set(), preserving the displayControl reference (bughunt3).
    setGlobalDepth(depth) {
      const dc = get().displayControl;
      if (dc.globalDepth === depth) return;
      commitDisplayControl({ ...dc, globalDepth: depth });
    },

    setFocusOrigin(originId) {
      const dc = get().displayControl;
      if (dc.focus.originId === originId) return;
      commitDisplayControl({ ...dc, focus: { ...dc.focus, originId } });
    },

    setFocusDepth(depth) {
      const dc = get().displayControl;
      if (dc.focus.depth === depth) return;
      commitDisplayControl({ ...dc, focus: { ...dc.focus, depth } });
    },

    setFocusEmphasize(emphasize) {
      const dc = get().displayControl;
      if (dc.focus.emphasize === emphasize) return;
      commitDisplayControl({ ...dc, focus: { ...dc.focus, emphasize } });
    },

    setDisplayFocus(focus) {
      const dc = get().displayControl;
      // Value-equal replacement is a no-op: preserve the existing reference so the
      // display memos / redraw do not see a new generation for an unchanged focus.
      if (
        dc.focus.originId === focus.originId &&
        dc.focus.depth === focus.depth &&
        dc.focus.emphasize === focus.emphasize
      ) {
        return;
      }
      commitDisplayControl({ ...dc, focus });
    },

    clearDisplayFocus() {
      // Revert focus to global-N-only; the global depth itself is untouched
      // (教訓 5.2: discard the transient focus on the clear path). Already-cleared
      // is a no-op so the reference is preserved (identity stability, above).
      const dc = get().displayControl;
      if (
        dc.focus.originId === NO_DISPLAY_FOCUS.originId &&
        dc.focus.depth === NO_DISPLAY_FOCUS.depth &&
        dc.focus.emphasize === NO_DISPLAY_FOCUS.emphasize
      ) {
        return;
      }
      commitDisplayControl({ ...dc, focus: NO_DISPLAY_FOCUS });
    },

    // -- survey mode (U37): thin calls into domain/survey transitions ---------
    // Every action funnels the CURRENT slice through the pure domain transition
    // and writes the result back (単一真実源 — the store re-implements NO survey
    // rule). None of them touches projectDirty / domain / selection / mode: the
    // slice is non-persisted UI display (FR-15) on its own axis (U37 §2.1).
    // Identity-preserving no-op guard: a transition that returns the SAME state
    // reference (hover with no draft, cancel while idle, …) does NOT call set(),
    // so no subscriber (Canvas redraw) sees a spurious generation (教訓 5.29 —
    // the same discipline as the display-control setters above).
    surveyEnable() {
      // activeTool is cleared in the SAME set() so the edit-tool bridge unmounts
      // atomically with the survey bridge mounting (入力軸の相互排他 — at most one
      // map-covering input layer). Unlike setActiveTool this does NOT clear the
      // selection: survey is a viewing aid, not a tool switch (U37 §2.1).
      set({ survey: enableSurveyMode(get().survey), activeTool: null });
    },

    surveyDisable() {
      const cur = get().survey;
      const next = disableSurveyMode(cur);
      if (next !== cur) set({ survey: next });
    },

    surveyClickPoint(point) {
      const cur = get().survey;
      const next = surveyClickPointTransition(cur, point);
      if (next !== cur) set({ survey: next });
    },

    surveyUpdateHover(point) {
      const cur = get().survey;
      const next = surveyUpdateHoverTransition(cur, point);
      if (next !== cur) set({ survey: next });
    },

    surveyCancelDraft() {
      const cur = get().survey;
      const next = surveyCancelDraftTransition(cur);
      if (next !== cur) set({ survey: next });
    },

    surveyClear() {
      const cur = get().survey;
      const next = surveyClearTransition(cur);
      if (next !== cur) set({ survey: next });
    },

    // -- display-control filter (FR-113, U41): INDEPENDENT session axis ------
    // Every setter writes ONLY `filter` (never domain / selection / projectDirty /
    // displayControl), so a filter change cannot disturb an in-progress edit and is
    // never a persisted / dirty-marking change (受け入れ基準1). Each defers to the pure
    // filter-state.ts helper (単一真実源 — no filter logic re-implemented here). A NO-OP
    // write returns WITHOUT set() so the `filter` reference is preserved — the display
    // memos (resolveFilteredDisplay / buildCommittedFeatures) and the Canvas redraw
    // subscription key on filter IDENTITY, so an unchanged value must not look like a
    // new generation (教訓 5.29 — the SAME identity-stability discipline as the
    // displayControl setters). The reconcile of the id-keyed parts on structure change
    // lives in applyCommandResult / applyUndoRedoResult (reconcileFilterToLive).
    setFilterKindVisible(axis, visible) {
      const cur = get().filter;
      if (cur.kindVisible[axis] === visible) return;
      set({ filter: setKindVisible(cur, axis, visible) });
    },

    setFilterDepthThreshold(threshold) {
      const cur = get().filter;
      if (cur.depthThreshold === threshold) return;
      set({ filter: setDepthThreshold(cur, threshold) });
    },

    setFilterOpacity(opacity) {
      const cur = get().filter;
      if (cur.opacity === opacity) return;
      set({ filter: setOpacity(cur, opacity) });
    },

    setFeatureHidden(featureId, hidden) {
      const cur = get().filter;
      // No-op guard: unhiding a feature with no override, or setting the same hidden
      // state, preserves the reference (avoids a value-equal-but-new filter busting memos).
      const prev = cur.individual.get(featureId);
      if ((prev?.hidden ?? false) === hidden) return;
      set({ filter: setIndividualHidden(cur, featureId, hidden) });
    },

    showAllHiddenFeatures() {
      const cur = get().filter;
      const next = clearIndividualOverrides(cur);
      if (next !== cur) set({ filter: next });
    },

    // -- settings (classify -> save context -> notify, 教訓 5.35 / 5.36) ----
    updateProjectSetting(key, value) {
      const scope = classifySettingKey(key);
      // Defensive: the typed key already guarantees scope, asserted in tests.
      if (scope !== SETTINGS_SCOPE.Project) {
        throw new Error(`not a project setting: ${String(key)}`);
      }
      const nextProject: ProjectSettings = {
        ...get().projectSettings,
        [key]: value,
      };
      // finding: a live settings-dialog confirm changes the timeline range through
      // THIS path (not hydrateSettings). The slider reads the derived timelineMin/Max
      // mirror and currentTime, so a timeline-key change must re-derive the range,
      // re-clamp currentTime into it, and re-validate selection — otherwise the
      // slider keeps the OLD range (and currentTime dangles outside the new one)
      // until a reload. Non-timeline keys leave the time state untouched. Both the
      // settings write and the derived range/time land in ONE set() so they can
      // never drift (二重の真実源 を作らない, 単一の set()).
      const timelineChanged =
        key === 'timelineMinYear' || key === 'timelineMaxYear';
      const timelinePatch = timelineChanged
        ? deriveTimelineState(
            nextProject,
            get().currentTime,
            get().selection,
            existence,
            calendar,
            timelineDisplayHeal,
          )
        : null;
      set({
        projectSettings: nextProject,
        projectDirty: true,
        lastSettingsChange: { scope, key },
        ...(timelinePatch ?? {}),
      });
    },

    setProjectTimelineRangeYears(minYear, maxYear) {
      // finding bughunt2: the settings-dialog confirm writes changed project keys
      // one at a time, and the two timeline bounds are written in
      // PROJECT_SETTING_KEYS order (timelineMinYear before timelineMaxYear). When
      // the whole range is shifted FORWARD (e.g. [0,10000] -> [20000,30000]) the
      // per-key path first commits {min:20000, max:10000(old)} — an inverted range —
      // and deriveTimelineState THROWS on it (precondition), escaping the click
      // handler with the other already-written keys partially applied. Folding both
      // bounds into ONE set() (deriving the range/time ONCE from the final valid
      // pair) removes the transient inversion entirely. Both keys land together so
      // the projectSettings, the derived range mirror and currentTime never drift
      // (二重の真実源 を作らない, 単一の set()).
      const nextProject: ProjectSettings = {
        ...get().projectSettings,
        timelineMinYear: minYear,
        timelineMaxYear: maxYear,
      };
      const timelinePatch = deriveTimelineState(
        nextProject,
        get().currentTime,
        get().selection,
        existence,
        calendar,
        timelineDisplayHeal,
      );
      // Emit the upper-bound key as the change notification: it matches the
      // last-written key on the legacy per-key order, so subscribers keyed on
      // timelineMaxYear still fire and the slider re-reads the new range.
      set({
        projectSettings: nextProject,
        projectDirty: true,
        lastSettingsChange: {
          scope: SETTINGS_SCOPE.Project,
          key: 'timelineMaxYear',
        },
        ...timelinePatch,
      });
    },

    updateAppSetting(key, value) {
      const scope = classifySettingKey(key);
      if (scope !== SETTINGS_SCOPE.App) {
        throw new Error(`not an app setting: ${String(key)}`);
      }
      // FR-110: render FPS is clamped to [1, 60] at the single store boundary.
      const next: AppSettings = { ...get().appSettings, [key]: value };
      const clamped: AppSettings =
        key === 'renderFps'
          ? { ...next, renderFps: clampRenderFps(next.renderFps) }
          : next;
      // bughunt root: app settings are persisted ONLY inside the project file's
      // uiSettings (there is no separate app-settings store), and the unsaved-changes
      // guard reads `projectDirty` as its single basis. Without marking the project
      // dirty here, changing ONLY a document-affecting app setting (e.g. renderFps)
      // and quitting passed the guard with no warning and the change was silently
      // lost. The save path already folds appSettings into the manifest and the
      // lost-edit guard already treats appSettings as a persisted slice
      // (FileOpsController markClean), so such a change MUST arm the same dirty flag a
      // project-setting change does (受け入れ基準 2 全経路: 設定だけの変更も取りこぼ
      // さない, 教訓 5.36 単一基準).
      //
      // EXCEPTION (bughunt2 finding): a PURE cosmetic / first-time-hint preference
      // (showConflictGuide, FR-118) must NOT, on its own, dirty the document. It is
      // a one-shot "do not show this hint again" flag whose default is "show", so
      // losing the suppression on quit merely re-shows a harmless guide — never
      // document loss. Dismissing the hint INSIDE the conflict modal and then
      // CANCELLING the edit would otherwise leave the project dirty purely because a
      // UI hint was hidden, producing a surprising false unsaved-changes warning on
      // quit. The cosmetic classification is single-sourced in `settings.ts`
      // (appSettingDirtiesProject, 教訓 5.19), so the dirty basis stays singular and
      // the decision lives once. The setting still round-trips into the file on the
      // next genuine save (the persistence bridge is unchanged).
      const dirties = appSettingDirtiesProject(key);
      set({
        appSettings: clamped,
        ...(dirties ? { projectDirty: true } : {}),
        lastSettingsChange: { scope, key },
      });
    },

    hydrateSettings(settings) {
      // Whole-slice replacement from a loaded / new project (教訓 5.36 同時初期化).
      // A load / new is a clean baseline, so projectDirty is cleared in the SAME
      // transition (mirrors resetToDomain). We do NOT emit a lastSettingsChange:
      // this is a baseline hydrate, not a user edit, so subscribers (renderer /
      // zoom supply) re-read the new values via their own domain/settings
      // subscription rather than treating it as a discrete change event.
      //
      // PROJECT-DEPENDENT TIME STATE (finding): the timeline RANGE shown by the
      // slider (timelineMin/timelineMax, TimePoints) is a derived mirror of the
      // authoritative projectSettings.timelineMin/MaxYear — there is no second
      // truth source. So whenever the project settings are hydrated we re-derive
      // the range from the EFFECTIVE settings (the incoming slice, or the kept
      // current one for a pre-`ui` manifest), re-clamp currentTime into that new
      // range, and run the clamped time through U22's revalidateForTime so any
      // time-dependent state is re-validated against the (already-swapped) new
      // domain. Without this a previous project's range / out-of-range currentTime
      // would survive a LOAD / NEW and the domain would resolve at a time outside
      // the new range (空表示). This runs in the SAME set() as the slice swap so
      // settings and the derived range/time can never drift apart.
      // hydrateSettings is a clean baseline (LOAD / NEW settings hydrate) but does NOT
      // swap the domain — so the current domain becomes the saved reference (bughunt
      // 全 undo dirty), keeping savedDomain consistent with the cleared dirty flag.
      // Capture the SETTINGS half from the EFFECTIVE (post-hydrate) values — the
      // incoming slice when present, else the kept current one — NOT the live store
      // values, which are about to be replaced in the same set() (bughunt2). Reusing
      // captureSavedBaseline would read the pre-swap settings, so set the baseline
      // explicitly here.
      const effectiveProject =
        settings.projectSettings ?? get().projectSettings;
      const effectiveApp = settings.appSettings ?? get().appSettings;
      savedDomain = get().domain;
      savedProjectSettings = effectiveProject;
      savedAppSettings = effectiveApp;
      // Clean baseline: the current base-map bytes ARE the saved file's — clear the
      // byte-replace dirty flag (F2 点4; same as captureSavedBaseline, which this path
      // does not use because it sets savedDomain directly).
      baseMapBytesDirtySinceSave = false;
      const timelinePatch = deriveTimelineState(
        effectiveProject,
        get().currentTime,
        get().selection,
        existence,
        calendar,
        timelineDisplayHeal,
      );
      set({
        projectDirty: false,
        ...(settings.projectSettings !== undefined
          ? { projectSettings: settings.projectSettings }
          : {}),
        ...(settings.appSettings !== undefined
          ? { appSettings: settings.appSettings }
          : {}),
        ...timelinePatch,
      });
    },

    reflectLoadedProject(nextDomain, settings) {
      // ATOMIC reflect (bughunt2): derive the timeline BEFORE any set() so the only
      // step that can throw (deriveTimelineState on an inverted range) cannot leave
      // the store half-applied. The two-call form (resetToDomain THEN hydrateSettings)
      // swapped the domain first, so a throw in hydrateSettings stranded the NEW
      // domain alongside the OLD settings/range. Here, if the incoming settings are
      // invalid we throw with NOTHING mutated; on success the domain swap, session
      // discard, settings hydrate, and derived range/time all land in ONE set().
      // A LOAD / NEW is a fresh CLEAN baseline (this is the atomic resetToDomain +
      // hydrateSettings reflect); record the new domain AND the effective settings as
      // the saved reference so an undo / redo back to it reads clean (bughunt 全 undo
      // dirty + settings, bughunt2). The settings half must be the EFFECTIVE (post-
      // swap) values — incoming slice or kept current — not the live store values that
      // this same set() replaces.
      const effectiveProject =
        settings.projectSettings ?? get().projectSettings;
      const effectiveApp = settings.appSettings ?? get().appSettings;
      savedDomain = nextDomain;
      savedProjectSettings = effectiveProject;
      savedAppSettings = effectiveApp;
      // Clean baseline: a LOAD / NEW installs a fresh base-map bytes baseline — clear the
      // byte-replace dirty flag (F2 点4; same as captureSavedBaseline, which this atomic
      // reflect does not use because it sets savedDomain directly).
      baseMapBytesDirtySinceSave = false;
      // resetToDomain clears the selection to EMPTY before hydrate derives the range,
      // so derive against EMPTY_SELECTION (the post-reset selection) — preserving the
      // exact result of the previous resetToDomain → hydrateSettings ordering.
      const timelinePatch = deriveTimelineState(
        effectiveProject,
        get().currentTime,
        EMPTY_SELECTION,
        existence,
        calendar,
        // Selection is EMPTY on this branch, so the display heal is the identity —
        // passed for signature symmetry (the single funnel, 教訓 5.6).
        timelineDisplayHeal,
      );
      set({
        // -- resetToDomain half: new domain + discarded session state (教訓 5.2) --
        domain: nextDomain,
        mode: EDIT_MODE.View,
        activeTool: null,
        // Identity-preserving focus clear (bughunt3): keep global depth N, preserve the
        // displayControl reference when focus is already none so an atomic load with no
        // active focus does not bust the display memos (see clearedFocusControl).
        displayControl: clearedFocusControl(get().displayControl),
        // U37 §4.5: discard the survey slice wholesale (same as resetToDomain).
        survey: initialSurveyState(),
        // FR-113: reset the display filter to the inert DEFAULT (same as resetToDomain —
        // OLD-project session state, 受け入れ基準1, 教訓 5.2).
        filter: DEFAULT_FILTER_STATE,
        // -- hydrateSettings half: whole-slice settings swap (教訓 5.36) --
        ...(settings.projectSettings !== undefined
          ? { projectSettings: settings.projectSettings }
          : {}),
        ...(settings.appSettings !== undefined
          ? { appSettings: settings.appSettings }
          : {}),
        // -- clean baseline + derived range/time (both halves cleared dirty) --
        projectDirty: false,
        ...timelinePatch,
      });
    },

    markProjectSaved() {
      // A successful save makes the LIVE domain the new clean baseline (bughunt 全 undo
      // dirty): record it so a later undo / redo back to this state reads clean. The
      // persistence guard (FileOpsController.markClean) only calls this when the live
      // domain still matches what was written to disk, so get().domain here IS exactly
      // the on-disk content (the saved reference, 単一基準). Capture the SETTINGS half
      // too (the persisted file carries them): a setting changed after THIS save now
      // makes the project read dirty even after an unrelated undo / redo (bughunt2).
      captureSavedBaseline(get().domain);
      set({ projectDirty: false });
    },
    };
  });
}
