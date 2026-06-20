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
import type { TimePoint } from '../../domain/time/time-point';

import type { ExistenceResolver } from './existence';
import { ALWAYS_PRESENT_RESOLVER } from './existence';
import {
  type AppSettingKey,
  type AppSettings,
  type ProjectSettingKey,
  type ProjectSettings,
  type SettingsScope,
  SETTINGS_SCOPE,
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
  setActiveTool(tool: ToolId | null): void;

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
  updateAppSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
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

// --- Store factory ----------------------------------------------------------

export interface CreateSessionStoreOptions<S> {
  /** The initial immutable domain state (the truth root). */
  readonly initialDomain: S;
  /** Injected time-existence predicates (单一真实源; defaults to always-present). */
  readonly existence?: ExistenceResolver;
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
        displayControl: { ...get().displayControl, focus: NO_DISPLAY_FOCUS },
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

    setActiveTool(tool) {
      // Tool switch also runs the reset契約.
      set({ activeTool: tool, ...selectionPatch(EMPTY_SELECTION) });
    },

    // -- time (single re-validation funnel, 教訓 5.5 / 5.6) -----------------
    setCurrentTime(time, source) {
      // 教訓 5.5/5.6: re-validate via U22 against the injected existence port.
      // The store resolves no time itself; every path funnels through here.
      const next = revalidateForTime(
        get().selection,
        time,
        existenceAtTime(existence),
      );
      set({
        currentTime: time,
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
      set({ camera: { ...get().camera, ...patch } });
    },

    setCenterLon(centerLon) {
      set({ centerLon });
    },

    // -- display control (FR-42 / FR-43): INDEPENDENT AXIS ------------------
    // Every setter writes ONLY `displayControl`. It never touches mode / tool /
    // selection / domain, so a depth or focus change cannot disturb an
    // in-progress edit (FR-42 非干渉, 受け入れ基準 2). The reverse — mode/tool
    // setters never write displayControl — is structurally true above.
    setGlobalDepth(depth) {
      set({ displayControl: { ...get().displayControl, globalDepth: depth } });
    },

    setFocusOrigin(originId) {
      const dc = get().displayControl;
      set({ displayControl: { ...dc, focus: { ...dc.focus, originId } } });
    },

    setFocusDepth(depth) {
      const dc = get().displayControl;
      set({ displayControl: { ...dc, focus: { ...dc.focus, depth } } });
    },

    setFocusEmphasize(emphasize) {
      const dc = get().displayControl;
      set({ displayControl: { ...dc, focus: { ...dc.focus, emphasize } } });
    },

    setDisplayFocus(focus) {
      set({ displayControl: { ...get().displayControl, focus } });
    },

    clearDisplayFocus() {
      // Revert focus to global-N-only; the global depth itself is untouched
      // (教訓 5.2: discard the transient focus on the clear path).
      set({ displayControl: { ...get().displayControl, focus: NO_DISPLAY_FOCUS } });
    },

    // -- settings (classify -> save context -> notify, 教訓 5.35 / 5.36) ----
    updateProjectSetting(key, value) {
      const scope = classifySettingKey(key);
      // Defensive: the typed key already guarantees scope, asserted in tests.
      if (scope !== SETTINGS_SCOPE.Project) {
        throw new Error(`not a project setting: ${String(key)}`);
      }
      set({
        projectSettings: { ...get().projectSettings, [key]: value },
        projectDirty: true,
        lastSettingsChange: { scope, key },
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
      set({
        appSettings: clamped,
        lastSettingsChange: { scope, key },
      });
    },

    markProjectSaved() {
      set({ projectDirty: false });
    },
  }));
}
