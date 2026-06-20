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
] as const satisfies readonly ProjectSettingKey[];

export const APP_SETTING_KEYS = [
  'snapDistancePx',
  'renderFps',
  'vertexMarkerCap',
  'showConflictGuide',
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

// --- Defaults ---------------------------------------------------------------

/** FR-110 defaults: snap 50px, 60 FPS. Vertex-marker cap a conservative default. */
export const DEFAULT_APP_SETTINGS: AppSettings = {
  snapDistancePx: 50,
  renderFps: 60,
  vertexMarkerCap: 2000,
  // FR-118: the conflict-resolution guide is shown by default on first use.
  showConflictGuide: true,
};

/** Inclusive FPS bounds (FR-110: 1〜60 FPS). */
export const MIN_RENDER_FPS = 1;
export const MAX_RENDER_FPS = 60;

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
};

/** Clamp FPS to the FR-110 range. Single place the range rule is applied. */
export function clampRenderFps(fps: number): number {
  if (fps < MIN_RENDER_FPS) return MIN_RENDER_FPS;
  if (fps > MAX_RENDER_FPS) return MAX_RENDER_FPS;
  return fps;
}
