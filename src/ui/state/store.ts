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
  revalidateForTime,
  toggleVertex,
  withActiveFeature,
} from '../../domain/selection';
import { getCalendar, type Calendar } from '../../domain/time/calendar';
import { compareNormalized, normalize } from '../../domain/time/normalized';
import { type TimePoint, timePointYear } from '../../domain/time/time-point';

import type { ExistenceResolver } from './existence';
import { ALWAYS_PRESENT_RESOLVER } from './existence';
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
  /** Replace the domain-state reference without a command result (e.g. load). */
  setDomainState(nextDomain: S): void;
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
  return {
    timelineMin,
    timelineMax,
    currentTime: clampedTime,
    ...selectionPatch(revalidated),
  };
}

// --- Store factory ----------------------------------------------------------

export interface CreateSessionStoreOptions<S> {
  /** The initial immutable domain state (the truth root). */
  readonly initialDomain: S;
  /** Injected time-existence predicates (单一真实源; defaults to always-present). */
  readonly existence?: ExistenceResolver;
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
  const calendar = options.calendar ?? getCalendar('gregorian');
  const init = options.initial ?? {};

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

  return createStore<SessionStore<S>>((set, get) => ({
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
    projectSettings: init.projectSettings ?? DEFAULT_PROJECT_SETTINGS,
    appSettings: init.appSettings ?? DEFAULT_APP_SETTINGS,
    projectDirty: false,
    lastSettingsChange: null,

    // -- bridge --------------------------------------------------------------
    applyCommandResult(nextDomain, result, preference) {
      // 教訓 5.11: re-resolve via U22 — drop deleted IDs, promote the caller's
      // next-target preference. The store does NOT re-implement this rule.
      const next = reresolveAfterStructureChange(
        get().selection,
        result,
        preference,
      );
      // A domain edit marks the project dirty (spec §B dirty 単一基準 / 教訓 5.36):
      // this is the SAME projectDirty a setting change sets, so the U39 unsaved
      // guard sees BOTH edit kinds through one flag (no second truth source).
      set({ domain: nextDomain, projectDirty: true, ...selectionPatch(next) });
    },

    setDomainState(nextDomain) {
      // A domain swap (any edit path) marks the project dirty (spec §B 単一基準).
      // A LOAD / NEW also swaps the domain but is a clean baseline; those paths
      // clear the flag with markProjectSaved() in the SAME transition (教訓 5.36),
      // so a clean load/new ends with projectDirty=false while an edit leaves it true.
      set({ domain: nextDomain, projectDirty: true });
    },

    resetToDomain(nextDomain) {
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
        ...selectionPatch(EMPTY_SELECTION),
      });
    },

    // -- selection (every mutation flows through U22's truth + builders) ------
    setActiveFeature(featureId) {
      set(selectionPatch(withActiveFeature(get().selection, featureId)));
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
      set({
        currentTime: clamped,
        lastTimeChangeSource: source,
        ...selectionPatch(next),
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
    setGlobalDepth(depth) {
      const dc = get().displayControl;
      if (dc.globalDepth === depth) return;
      set({ displayControl: { ...dc, globalDepth: depth } });
    },

    setFocusOrigin(originId) {
      const dc = get().displayControl;
      if (dc.focus.originId === originId) return;
      set({ displayControl: { ...dc, focus: { ...dc.focus, originId } } });
    },

    setFocusDepth(depth) {
      const dc = get().displayControl;
      if (dc.focus.depth === depth) return;
      set({ displayControl: { ...dc, focus: { ...dc.focus, depth } } });
    },

    setFocusEmphasize(emphasize) {
      const dc = get().displayControl;
      if (dc.focus.emphasize === emphasize) return;
      set({ displayControl: { ...dc, focus: { ...dc.focus, emphasize } } });
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
      set({ displayControl: { ...dc, focus } });
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
      set({ displayControl: { ...dc, focus: NO_DISPLAY_FOCUS } });
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
      const effectiveProject =
        settings.projectSettings ?? get().projectSettings;
      const timelinePatch = deriveTimelineState(
        effectiveProject,
        get().currentTime,
        get().selection,
        existence,
        calendar,
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
      const effectiveProject =
        settings.projectSettings ?? get().projectSettings;
      // resetToDomain clears the selection to EMPTY before hydrate derives the range,
      // so derive against EMPTY_SELECTION (the post-reset selection) — preserving the
      // exact result of the previous resetToDomain → hydrateSettings ordering.
      const timelinePatch = deriveTimelineState(
        effectiveProject,
        get().currentTime,
        EMPTY_SELECTION,
        existence,
        calendar,
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
      set({ projectDirty: false });
    },
  }));
}
