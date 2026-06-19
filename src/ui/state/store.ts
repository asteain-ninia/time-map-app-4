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
import type { DomainId, FeatureId, VertexId } from '../../domain/ids';
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
  type EditMode,
  type ToolId,
  type VertexSelectionContext,
  DEFAULT_CAMERA,
  EDIT_MODE,
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
  readonly activeFeature: ActiveFeature;
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
  /** Replace the domain-state reference and re-resolve selection from the result. */
  applyCommandResult(nextDomain: S, result: CommandResult): void;
  /** Replace the domain-state reference without a command result (e.g. load). */
  setDomainState(nextDomain: S): void;

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

  // settings
  updateProjectSetting<K extends ProjectSettingKey>(key: K, value: ProjectSettings[K]): void;
  updateAppSetting<K extends AppSettingKey>(key: K, value: AppSettings[K]): void;
  /** Clear the project-dirty flag (called after a save by the persistence unit). */
  markProjectSaved(): void;
}

export type SessionStore<S> = SessionStoreState<S> & SessionStoreActions<S>;

// --- Re-validation (教訓 5.5 / 5.6: result-state, all paths) -----------------
//
// Given the post-change session state, recompute the time-dependent selection.
// This is invoked by EVERY time-changing path (no per-path gate). It returns the
// selection slice only, so callers merge it back atomically.

interface SelectionSlice {
  readonly activeFeature: ActiveFeature;
  readonly vertexSelection: VertexSelectionContext | null;
}

function revalidateSelectionForTime(
  selection: SelectionSlice,
  time: TimePoint,
  existence: ExistenceResolver,
): SelectionSlice {
  // Active feature: drop it if it no longer exists at the new time (FR-71).
  let activeFeature = selection.activeFeature;
  if (activeFeature !== null && !existence.featureExistsAt(activeFeature, time)) {
    activeFeature = null;
  }

  // Vertex selection: drop vertices that no longer exist; resolve the context
  // away if it becomes empty (or its owner feature is gone).
  let vertexSelection = selection.vertexSelection;
  if (vertexSelection !== null) {
    const owner = vertexSelection.ownerFeatureId;
    if (!existence.featureExistsAt(owner, time)) {
      vertexSelection = null;
    } else {
      const kept = new Set<VertexId>();
      for (const vid of vertexSelection.vertexIds) {
        if (existence.vertexExistsAt(owner, vid, time)) kept.add(vid);
      }
      vertexSelection = kept.size === 0 ? null : { ownerFeatureId: owner, vertexIds: kept };
    }
  }

  return { activeFeature, vertexSelection };
}

// --- Selection re-resolution from a command result (教訓 5.11) --------------
//
// After a structure-changing command, do NOT blanket-clear. Use the result's
// deleted/survived/created sets to re-resolve selection: drop selections of
// deleted IDs, keep the rest.

function reresolveSelectionForCommand(
  selection: SelectionSlice,
  result: CommandResult,
): SelectionSlice {
  const deleted: ReadonlySet<DomainId> = result.deleted;

  let activeFeature = selection.activeFeature;
  if (activeFeature !== null && deleted.has(activeFeature)) {
    activeFeature = null;
  }

  let vertexSelection = selection.vertexSelection;
  if (vertexSelection !== null) {
    if (deleted.has(vertexSelection.ownerFeatureId)) {
      vertexSelection = null;
    } else {
      const kept = new Set<VertexId>();
      for (const vid of vertexSelection.vertexIds) {
        if (!deleted.has(vid)) kept.add(vid);
      }
      vertexSelection =
        kept.size === 0
          ? null
          : { ownerFeatureId: vertexSelection.ownerFeatureId, vertexIds: kept };
    }
  }

  return { activeFeature, vertexSelection };
}

// --- Reset契約 (教訓 5.2: discard temporary UI state on all paths) ----------
//
// The store does not hold the actual draft/preview values (those live in the
// edit-tool unit). It holds the session selection it CAN clear, and exposes the
// reset as the single entry every mode/tool/selection-clear path runs through.

function clearedSelectionSlice(): SelectionSlice {
  return { activeFeature: null, vertexSelection: null };
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

  return createStore<SessionStore<S>>((set, get) => ({
    // -- initial state -------------------------------------------------------
    domain: options.initialDomain,
    activeFeature: init.activeFeature ?? null,
    vertexSelection: init.vertexSelection ?? null,
    mode: init.mode ?? EDIT_MODE.View,
    activeTool: init.activeTool ?? null,
    currentTime: init.currentTime ?? DEFAULT_TIMELINE_MIN,
    lastTimeChangeSource: null,
    timelineMin: DEFAULT_TIMELINE_MIN,
    timelineMax: DEFAULT_TIMELINE_MAX,
    camera: init.camera ?? DEFAULT_CAMERA,
    centerLon: init.centerLon ?? 0,
    projectSettings: init.projectSettings ?? DEFAULT_PROJECT_SETTINGS,
    appSettings: init.appSettings ?? DEFAULT_APP_SETTINGS,
    projectDirty: false,
    lastSettingsChange: null,

    // -- bridge --------------------------------------------------------------
    applyCommandResult(nextDomain, result) {
      const s = get();
      const reresolved = reresolveSelectionForCommand(
        { activeFeature: s.activeFeature, vertexSelection: s.vertexSelection },
        result,
      );
      set({
        domain: nextDomain,
        activeFeature: reresolved.activeFeature,
        vertexSelection: reresolved.vertexSelection,
      });
    },

    setDomainState(nextDomain) {
      set({ domain: nextDomain });
    },

    // -- selection -----------------------------------------------------------
    setActiveFeature(featureId) {
      set({ activeFeature: featureId });
    },

    replaceVertexSelection(ownerFeatureId, vertexIds) {
      const ids = new Set(vertexIds);
      set({
        vertexSelection:
          ids.size === 0 ? null : { ownerFeatureId, vertexIds: ids },
      });
    },

    toggleVertexSelection(ownerFeatureId, vertexId) {
      const current = get().vertexSelection;
      // A toggle that changes owner starts a fresh context (FR-81: one owner).
      const base =
        current !== null && current.ownerFeatureId === ownerFeatureId
          ? new Set(current.vertexIds)
          : new Set<VertexId>();
      if (base.has(vertexId)) base.delete(vertexId);
      else base.add(vertexId);
      set({
        vertexSelection:
          base.size === 0 ? null : { ownerFeatureId, vertexIds: base },
      });
    },

    addVerticesToSelection(ownerFeatureId, vertexIds) {
      const current = get().vertexSelection;
      const base =
        current !== null && current.ownerFeatureId === ownerFeatureId
          ? new Set(current.vertexIds)
          : new Set<VertexId>();
      for (const vid of vertexIds) base.add(vid);
      set({
        vertexSelection:
          base.size === 0 ? null : { ownerFeatureId, vertexIds: base },
      });
    },

    clearSelection() {
      set(clearedSelectionSlice());
    },

    // -- mode / tool (reset契約 on every path, 教訓 5.2) --------------------
    setMode(mode) {
      // Mode switch discards transient selection (教訓 5.2 全経路で破棄).
      set({ mode, activeTool: null, ...clearedSelectionSlice() });
    },

    setActiveTool(tool) {
      // Tool switch also runs the reset契約.
      set({ activeTool: tool, ...clearedSelectionSlice() });
    },

    // -- time (single re-validation funnel, 教訓 5.5 / 5.6) -----------------
    setCurrentTime(time, source) {
      const s = get();
      const revalidated = revalidateSelectionForTime(
        { activeFeature: s.activeFeature, vertexSelection: s.vertexSelection },
        time,
        existence,
      );
      set({
        currentTime: time,
        lastTimeChangeSource: source,
        activeFeature: revalidated.activeFeature,
        vertexSelection: revalidated.vertexSelection,
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
