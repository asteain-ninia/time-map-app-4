// UI/session state layer: settings boundary (FR-109 / FR-110, 教訓 5.36).
//
// This module fixes the boundary between PROJECT-specific settings (FR-109) and
// APP-wide settings (FR-110) *before* any UI consumes them (教訓 5.36「境界を先
// に定義する」). Each setting key is classified once, by a constant, so the
// "where is this saved / where does it reflect" decision is single-sourced and
// can never drift per call site (教訓 5.19: classification goes through a
// constant, not an ad-hoc string).
//
// This module is framework-free: it imports nothing from React / Zustand /
// Canvas. The store (`store.ts`) layers the reactive notification on top; the
// physical persistence I/O and Zod schema validation belong to a later
// persistence unit (spec スコープ「やらないこと」). Here we own only the
// classification (what is saved where) and the defaults.

import {
  MAX_RENDER_FPS as DOMAIN_MAX_RENDER_FPS,
  MIN_RENDER_FPS as DOMAIN_MIN_RENDER_FPS,
  ZOOM_LIMIT_CEIL as DOMAIN_ZOOM_LIMIT_CEIL,
  ZOOM_LIMIT_FLOOR as DOMAIN_ZOOM_LIMIT_FLOOR,
} from '../../domain/persistence/settings-constraints';
import { DEFAULT_HISTORY_LIMIT } from '../../domain/command/history';
import { type TimePoint, timePointYear } from '../../domain/time/time-point';

// --- Classification (the boundary) ------------------------------------------

/**
 * Where a setting lives. Project settings are part of the project document
 * (dirty-tracked, saved into the `.tmap`); app settings are persisted at the
 * application level (independent of any project). This discriminant is the
 * single source of truth for save-context routing (教訓 5.36).
 */
export const SETTINGS_SCOPE = {
  /** FR-109: part of the project document — dirty-marks the project on change. */
  Project: 'project',
  /** FR-110: app-wide — persisted at the application level. */
  App: 'app',
} as const;

export type SettingsScope = (typeof SETTINGS_SCOPE)[keyof typeof SETTINGS_SCOPE];

// --- Project-specific settings (FR-109) -------------------------------------

/** A named color (hex string). Validation/sanitization is a persistence-unit concern. */
export type ColorHex = string;

/** A palette theme identifier (FR-100 default palette theme). */
export type PaletteThemeId = string;

/**
 * Project-specific settings (FR-109): project name/description, equator length,
 * flattening, timeline min/max year, grid spacing/color/opacity, base-map
 * reference, area-label screen-occupancy threshold, new-area auto-color default,
 * default palette theme, custom palette. All belong to the project document.
 */
export interface ProjectSettings {
  readonly projectName: string;
  readonly projectDescription: string;
  /** Equator length in km (FR-109; feeds the geodesy module, 技術方針 2.9). */
  readonly equatorLengthKm: number;
  /** Flattening f (FR-109; 0 == true sphere). */
  readonly flattening: number;
  /** Inclusive timeline lower bound (year, may be negative). */
  readonly timelineMinYear: number;
  /** Inclusive timeline upper bound (year). */
  readonly timelineMaxYear: number;
  /** Grid line spacing in degrees. */
  readonly gridSpacingDeg: number;
  readonly gridColor: ColorHex;
  /** Grid opacity in [0, 1]. */
  readonly gridOpacity: number;
  /** Base-map identifier / reference (resolved by the render unit). */
  readonly baseMapId: string;
  /** Area-label visibility threshold as a fraction of screen occupancy [0, 1]. */
  readonly areaLabelOccupancyThreshold: number;
  /** Default for "auto-color enabled" on newly created areas (FR-100). */
  readonly newAreaAutoColorDefault: boolean;
  readonly defaultPaletteTheme: PaletteThemeId;
  /** Custom palette colors (FR-109). */
  readonly customPalette: readonly ColorHex[];
  /**
   * The currently-effective minimum zoom magnification (FR-10). Supplied to the
   * camera (U17) as the lower clamp bound. Default {@link DEFAULT_ZOOM_MIN}; the
   * user-settable allowed range is [{@link ZOOM_LIMIT_FLOOR}, {@link ZOOM_LIMIT_CEIL}].
   * A project-scoped setting so a change marks the project dirty and reflects
   * immediately (FR-109). Always kept zoomMin ≤ zoomMax (validated at the boundary).
   */
  readonly zoomMin: number;
  /** The currently-effective maximum zoom magnification (FR-10). Default {@link DEFAULT_ZOOM_MAX}. */
  readonly zoomMax: number;
}

// --- App-wide settings (FR-110) ---------------------------------------------

/**
 * App-wide settings (FR-110): shared-vertex snap distance (default 50px),
 * render update rate (1〜60 FPS, default 60), all-vertex-marker display cap.
 */
export interface AppSettings {
  /** Shared-vertex snap distance in px (FR-110 default 50). */
  readonly snapDistancePx: number;
  /** Render update rate in FPS, clamped to [1, 60] (FR-110 default 60). */
  readonly renderFps: number;
  /** Upper bound on simultaneously rendered vertex markers (FR-110). */
  readonly vertexMarkerCap: number;
  /**
   * Undo-stack depth limit (FR-74「アンドゥ履歴の上限は設定変更可」). The maximum number
   * of undo units the live history retains; on overflow the OLDEST is evicted
   * (domain/command/history withLimit / trimUndoStack). Default
   * {@link DEFAULT_UNDO_STACK_SIZE} (== domain DEFAULT_HISTORY_LIMIT). A value < 1 is
   * clamped to 1 by the history itself. An APP-wide setting (FR-110): it governs
   * editing behaviour app-wide, so a change dirties the project (it is persisted in
   * the project file's uiSettings like the other document-affecting app settings).
   */
  readonly undoStackSize: number;
  /**
   * Whether the first-time guide for the conflict-resolution modal is shown
   * (FR-118). This is an APP-wide user-experience preference, NOT project data
   * (教訓 5.36: the guide-shown/suppressed state belongs to app settings, with a
   * single save/reflect home). `true` ⇒ show the guide; the user can suppress it
   * (set to `false`) and re-enable it later (set back to `true`).
   */
  readonly showConflictGuide: boolean;
}

// --- Keys + per-key classification (single source of truth) -----------------

export type ProjectSettingKey = keyof ProjectSettings;
export type AppSettingKey = keyof AppSettings;
export type SettingKey = ProjectSettingKey | AppSettingKey;

/**
 * Every project setting key, frozen. Used to classify a key and to assert the
 * project/app partition is exhaustive and disjoint (受け入れ基準 4).
 */
export const PROJECT_SETTING_KEYS = [
  'projectName',
  'projectDescription',
  'equatorLengthKm',
  'flattening',
  'timelineMinYear',
  'timelineMaxYear',
  'gridSpacingDeg',
  'gridColor',
  'gridOpacity',
  'baseMapId',
  'areaLabelOccupancyThreshold',
  'newAreaAutoColorDefault',
  'defaultPaletteTheme',
  'customPalette',
  'zoomMin',
  'zoomMax',
] as const satisfies readonly ProjectSettingKey[];

export const APP_SETTING_KEYS = [
  'snapDistancePx',
  'renderFps',
  'vertexMarkerCap',
  'showConflictGuide',
  'undoStackSize',
] as const satisfies readonly AppSettingKey[];

const PROJECT_KEY_SET: ReadonlySet<string> = new Set(PROJECT_SETTING_KEYS);
const APP_KEY_SET: ReadonlySet<string> = new Set(APP_SETTING_KEYS);

/** Classifies a setting key to its scope (single source of truth, 教訓 5.36). */
export function classifySettingKey(key: SettingKey): SettingsScope {
  if (PROJECT_KEY_SET.has(key)) return SETTINGS_SCOPE.Project;
  if (APP_KEY_SET.has(key)) return SETTINGS_SCOPE.App;
  // Unreachable for a well-typed key; kept as an explicit guard.
  throw new Error(`unknown setting key: ${String(key)}`);
}

export function isProjectSettingKey(key: SettingKey): key is ProjectSettingKey {
  return PROJECT_KEY_SET.has(key);
}

export function isAppSettingKey(key: SettingKey): key is AppSettingKey {
  return APP_KEY_SET.has(key);
}

/**
 * App settings that are PURE first-time / cosmetic UX preferences whose loss on
 * quit is harmless — they revert to a harmless default and never represent
 * document content (bughunt2 finding).
 *
 * WHY this set exists (reconciling 教訓 5.36 single-dirty-basis): app settings are
 * persisted ONLY inside the project file's uiSettings, so a change to a
 * DOCUMENT-AFFECTING app setting (snap distance, render FPS, vertex-marker cap)
 * MUST arm `projectDirty` or the change is silently lost on quit (受け入れ基準 2).
 * But `showConflictGuide` is different: it is a one-shot "do not show this hint
 * again" flag (FR-118). Dismissing the hint INSIDE the conflict modal and then
 * CANCELLING the edit would otherwise leave the project dirty purely because a UI
 * hint was hidden — a surprising false unsaved-changes warning on quit. Because
 * its default is "show" and losing the suppression merely re-shows a harmless
 * guide, this preference must NOT, on its own, dirty the document. It still
 * round-trips into the file on the next genuine save (the persistence bridge is
 * unchanged), so a real save preserves it.
 *
 * This is a single-sourced classification (教訓 5.19): the store consults this set
 * rather than hard-coding the key, so the dirty/no-dirty decision lives once.
 */
const COSMETIC_APP_KEY_SET: ReadonlySet<string> = new Set<AppSettingKey>([
  'showConflictGuide',
]);

/**
 * Whether changing this app setting should mark the project document dirty.
 * `true` for document-affecting app settings (the default); `false` for pure
 * cosmetic/first-time-hint preferences (see {@link COSMETIC_APP_KEY_SET}).
 */
export function appSettingDirtiesProject(key: AppSettingKey): boolean {
  return !COSMETIC_APP_KEY_SET.has(key);
}

// --- Defaults ---------------------------------------------------------------

/**
 * FR-74 default undo-stack depth. Single-sourced to the domain history's
 * {@link DEFAULT_HISTORY_LIMIT} (== 100) so the UI default and the history default
 * can never drift (教訓 5.19 単一の真実源).
 */
export const DEFAULT_UNDO_STACK_SIZE = DEFAULT_HISTORY_LIMIT;

/** FR-110 defaults: snap 50px, 60 FPS. Vertex-marker cap a conservative default. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  snapDistancePx: 50,
  renderFps: 60,
  vertexMarkerCap: 2000,
  // FR-118: the conflict-resolution guide is shown by default on first use.
  showConflictGuide: true,
  // FR-74: the undo history retains 100 units by default (== DEFAULT_HISTORY_LIMIT).
  undoStackSize: DEFAULT_UNDO_STACK_SIZE,
};

// Inclusive FPS bounds (FR-110: 1〜60 FPS). Single-sourced in the domain
// settings-constraints module (shared with the persistence load boundary so the
// form and the file can never disagree); re-exported here for the existing UI
// call sites that read them from this module.
export const MIN_RENDER_FPS = DOMAIN_MIN_RENDER_FPS;
export const MAX_RENDER_FPS = DOMAIN_MAX_RENDER_FPS;

// --- Zoom-limit single source of truth (FR-10, U39) -------------------------
//
// The FR-10 default zoom clamp (最小 1 倍〜最大 50 倍) and the user-settable
// allowed boundary (最小 0.1 倍〜最大 10000 倍) live here ONCE so neither the
// default nor the input bounds are ever re-declared at a call site (単一の真実源,
// 教訓 5.19 / spec §E 設定値のハードコード禁止). The render layer's
// `DEFAULT_ZOOM_RANGE` (= 1×..50×) mirrors this default by spec contract; the
// ui-wiring bridge supplies the live values from the store so they agree.

/** FR-10 default minimum zoom magnification (1×). */
export const DEFAULT_ZOOM_MIN = 1;
/** FR-10 default maximum zoom magnification (50×). */
export const DEFAULT_ZOOM_MAX = 50;
// FR-10 user-settable zoom boundary [0.1×, 10000×]. Single-sourced in the domain
// settings-constraints module (shared with the persistence load boundary);
// re-exported here for the existing UI call sites that read them from this module.
export const ZOOM_LIMIT_FLOOR = DOMAIN_ZOOM_LIMIT_FLOOR;
export const ZOOM_LIMIT_CEIL = DOMAIN_ZOOM_LIMIT_CEIL;

/**
 * Default timeline range as TimePoints (year granularity; 教訓 5.16 完全値).
 * FR-66 規定の既定値「0 年〜10000 年」を単一の真実源として供給する。
 */
export const DEFAULT_TIMELINE_MIN: TimePoint = timePointYear(0);
export const DEFAULT_TIMELINE_MAX: TimePoint = timePointYear(10000);

/** FR-109 defaults. Equator length ~Earth; flattening 0 (true sphere, 技術方針 2.9). */
export const DEFAULT_PROJECT_SETTINGS: ProjectSettings = {
  projectName: '',
  projectDescription: '',
  equatorLengthKm: 40075,
  flattening: 0,
  // FR-66 / U38 受け入れ基準 4・5: タイムライン既定範囲は 0 年〜10000 年。
  timelineMinYear: 0,
  timelineMaxYear: 10000,
  gridSpacingDeg: 10,
  gridColor: '#888888',
  gridOpacity: 0.5,
  baseMapId: '',
  areaLabelOccupancyThreshold: 0.02,
  newAreaAutoColorDefault: true,
  defaultPaletteTheme: 'default',
  customPalette: [],
  // FR-10 既定のズーム制限: 最小 1 倍〜最大 50 倍 (単一の真実源)。
  zoomMin: DEFAULT_ZOOM_MIN,
  zoomMax: DEFAULT_ZOOM_MAX,
};

/** Clamp FPS to the FR-110 range. Single place the range rule is applied. */
export function clampRenderFps(fps: number): number {
  if (fps < MIN_RENDER_FPS) return MIN_RENDER_FPS;
  if (fps > MAX_RENDER_FPS) return MAX_RENDER_FPS;
  return fps;
}
