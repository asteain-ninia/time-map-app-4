// UI layer (U38 / settings): PURE validation + defaults factory + draft→commit
// diff. Framework-free (imports nothing from React / Canvas / Electron): every
// function here is a pure input→output mapping, single-run under Vitest
// (NFR 5.8 / 受け入れ基準 8). The React dialog (`SettingsDialog.tsx`) and the
// confirm-entry validation BOTH call these same functions, so an unvalidated
// value can never reach the store even on a non-UI confirm path (教訓 5.26).
//
// SINGLE SOURCE OF TRUTH (教訓 5.19 / 5.36):
//   - the setting types, per-key classification (project vs app) and the default
//     values are owned ONCE by U16 (`../state/settings`). This module imports
//     them and never re-defines them. The defaults factory below is a thin
//     re-export of U16's `DEFAULT_PROJECT_SETTINGS` so the dialog's initial
//     display, the new-project initialisation (U39) and the test expectations all
//     read the same value (受け入れ基準 4 / 5).

import { isGridSpacing, GRID_SPACINGS_DEG } from '../../domain/basemap/grid';
import {
  OCCUPANCY_MAX as DOMAIN_OCCUPANCY_MAX,
  OCCUPANCY_MIN as DOMAIN_OCCUPANCY_MIN,
  OPACITY_MAX as DOMAIN_OPACITY_MAX,
  OPACITY_MIN as DOMAIN_OPACITY_MIN,
  SNAP_DISTANCE_MIN as DOMAIN_SNAP_DISTANCE_MIN,
  UNDO_STACK_SIZE_MIN as DOMAIN_UNDO_STACK_SIZE_MIN,
  VERTEX_MARKER_CAP_MIN as DOMAIN_VERTEX_MARKER_CAP_MIN,
} from '../../domain/persistence/settings-constraints';
import {
  type AppSettings,
  type ProjectSettings,
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  MAX_RENDER_FPS,
  MIN_RENDER_FPS,
} from '../state/settings';
// U39 owns the FR-10 zoom-limit validation (range 0.1×..10000× + min ≤ max). The
// project-settings confirm path runs it BEFORE writing the store (確定前検証,
// 教訓 5.26), so an out-of-range / reversed zoom limit can never be saved — even on
// a non-UI confirm. Single source: the rule lives once in U39 (単一の真実源).
import { validateZoomLimits } from '../file-ops/zoom-limit';
// The persistence load schema (READ side) enforces every persisted year as an
// integer within ±MAX_YEAR (yearSchema). The timeline-range confirm path (WRITE
// side) MUST reject the same set, or a value the form accepts but the schema
// rejects is saved and makes the .gimoza un-loadable on reopen (教訓 6.4.15 片側 shim).
// Both sides share the ONE predicate + bound below (単一の真実源).
import { MAX_YEAR, isPersistedYear } from '../../domain/time/validate';
import { SETTINGS_REJECTION_TEXT } from './strings';

// --- Defaults factory (新規プロジェクト初期化の入口, 受け入れ基準 5) ----------

/**
 * The default PROJECT settings used to initialise a new project (受け入れ基準 5).
 * Re-exports U16's single default constant so the new-project path (U39), the
 * dialog's initial display and the tests all share ONE value (教訓 5.19 / 5.36).
 * Returns a frozen copy each call so a caller cannot mutate the shared default.
 */
export function defaultProjectSettings(): ProjectSettings {
  return { ...DEFAULT_PROJECT_SETTINGS, customPalette: [...DEFAULT_PROJECT_SETTINGS.customPalette] };
}

/** The default APP settings (FR-110 defaults: snap 50px, 60 FPS). Single source. */
export function defaultAppSettings(): AppSettings {
  return { ...DEFAULT_APP_SETTINGS };
}

// --- Validation result (教訓 5.26: テスト可能な戻り値 + 拒否理由) --------------

/** A validation error keyed to the offending field, with a Japanese reason. */
export interface SettingsValidationError {
  /** The field key the error belongs to (so the UI can place it inline). */
  readonly field: string;
  /** The Japanese rejection reason (FR-115). */
  readonly message: string;
}

/** The result of validating a draft. Ok carries the clean value; otherwise errors. */
export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly SettingsValidationError[] };

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value };
}

function err<T>(errors: readonly SettingsValidationError[]): ValidationResult<T> {
  return { ok: false, errors };
}

// --- Bounds (single place each numeric rule lives, 教訓 5.19) -----------------

// Single-sourced in the domain settings-constraints module (shared with the
// persistence load boundary so the form and the file can never disagree);
// re-exported here for the existing UI call sites / tests that read them.
export const OPACITY_MIN = DOMAIN_OPACITY_MIN;
export const OPACITY_MAX = DOMAIN_OPACITY_MAX;
export const OCCUPANCY_MIN = DOMAIN_OCCUPANCY_MIN;
export const OCCUPANCY_MAX = DOMAIN_OCCUPANCY_MAX;
/** Snap distance must be non-negative (a non-positive radius disables snapping). */
export const SNAP_DISTANCE_MIN = DOMAIN_SNAP_DISTANCE_MIN;
/** Marker cap must be a non-negative integer (0 == show none). */
export const VERTEX_MARKER_CAP_MIN = DOMAIN_VERTEX_MARKER_CAP_MIN;
/** Undo-stack depth limit must be a positive integer (FR-74; at least 1). */
export const UNDO_STACK_SIZE_MIN = DOMAIN_UNDO_STACK_SIZE_MIN;

function isFiniteNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

// --- Rejection messages (single map, shared by UI + confirm entry, 教訓 5.26) -

/** Japanese rejection messages, produced from a single source (FR-115). */
export const REJECTION = {
  timelineOrder: SETTINGS_REJECTION_TEXT.timelineOrder,
  timelineYearBound: SETTINGS_REJECTION_TEXT.timelineYearBound(String(MAX_YEAR)),
  equatorNonPositive: SETTINGS_REJECTION_TEXT.equatorNonPositive,
  flatteningRange: SETTINGS_REJECTION_TEXT.flatteningRange,
  // Derived from the single GRID_SPACINGS_DEG list (HB3-23) so the message can never
  // drift from the actual allowed spacings when the list changes.
  gridSpacing: SETTINGS_REJECTION_TEXT.gridSpacing(GRID_SPACINGS_DEG.join(SETTINGS_REJECTION_TEXT.gridSpacingSeparator)),
  gridVisibleType: SETTINGS_REJECTION_TEXT.gridVisibleType,
  gridOpacityRange: SETTINGS_REJECTION_TEXT.gridOpacityRange,
  occupancyRange: SETTINGS_REJECTION_TEXT.occupancyRange,
  fpsRange: SETTINGS_REJECTION_TEXT.fpsRange(String(MIN_RENDER_FPS), String(MAX_RENDER_FPS)),
  snapDistanceRange: SETTINGS_REJECTION_TEXT.snapDistanceRange,
  vertexMarkerCapRange: SETTINGS_REJECTION_TEXT.vertexMarkerCapRange,
  undoStackSizeRange: SETTINGS_REJECTION_TEXT.undoStackSizeRange,
  notANumber: SETTINGS_REJECTION_TEXT.notANumber,
} as const;

// --- Project-settings validation --------------------------------------------

/**
 * Validate a draft of the PROJECT settings (FR-109). Every numeric/range rule is
 * applied here so the UI form and the confirm entry agree (教訓 5.26). Returns the
 * clean value on success; otherwise the full list of Japanese rejection reasons
 * (受け入れ基準 7: 拒否理由を戻り値としても扱う).
 */
export function validateProjectSettings(
  draft: ProjectSettings,
): ValidationResult<ProjectSettings> {
  const errors: SettingsValidationError[] = [];

  if (!isFiniteNumber(draft.equatorLengthKm)) {
    errors.push({ field: 'equatorLengthKm', message: REJECTION.notANumber });
  } else if (draft.equatorLengthKm <= 0) {
    errors.push({ field: 'equatorLengthKm', message: REJECTION.equatorNonPositive });
  }

  if (!isFiniteNumber(draft.flattening)) {
    errors.push({ field: 'flattening', message: REJECTION.notANumber });
  } else if (draft.flattening < 0 || draft.flattening >= 1) {
    errors.push({ field: 'flattening', message: REJECTION.flatteningRange });
  }

  if (!isFiniteNumber(draft.timelineMinYear) || !isFiniteNumber(draft.timelineMaxYear)) {
    errors.push({ field: 'timelineMinYear', message: REJECTION.notANumber });
  } else {
    // Reject exactly what the persistence yearSchema rejects (integer within
    // ±MAX_YEAR) so a saved timeline range is always re-loadable (書込⊆読込).
    const minOk = isPersistedYear(draft.timelineMinYear);
    const maxOk = isPersistedYear(draft.timelineMaxYear);
    if (!minOk) errors.push({ field: 'timelineMinYear', message: REJECTION.timelineYearBound });
    if (!maxOk) errors.push({ field: 'timelineMaxYear', message: REJECTION.timelineYearBound });
    // The order rule is only meaningful once both endpoints are valid years.
    if (minOk && maxOk && draft.timelineMinYear >= draft.timelineMaxYear) {
      errors.push({ field: 'timelineMinYear', message: REJECTION.timelineOrder });
    }
  }

  if (!isGridSpacing(draft.gridSpacingDeg)) {
    errors.push({ field: 'gridSpacingDeg', message: REJECTION.gridSpacing });
  }

  // FR-13 グリッド ON/OFF: the visibility flag must be a boolean. Defensive (the UI
  // checkbox always yields a boolean), mirroring the persistence schema's z.boolean()
  // so the form and the file agree an off-type value is rejected (書込⊆読込).
  if (typeof draft.gridVisible !== 'boolean') {
    errors.push({ field: 'gridVisible', message: REJECTION.gridVisibleType });
  }

  if (!isFiniteNumber(draft.gridOpacity)) {
    errors.push({ field: 'gridOpacity', message: REJECTION.notANumber });
  } else if (draft.gridOpacity < OPACITY_MIN || draft.gridOpacity > OPACITY_MAX) {
    errors.push({ field: 'gridOpacity', message: REJECTION.gridOpacityRange });
  }

  if (!isFiniteNumber(draft.areaLabelOccupancyThreshold)) {
    errors.push({ field: 'areaLabelOccupancyThreshold', message: REJECTION.notANumber });
  } else if (
    draft.areaLabelOccupancyThreshold < OCCUPANCY_MIN ||
    draft.areaLabelOccupancyThreshold > OCCUPANCY_MAX
  ) {
    errors.push({ field: 'areaLabelOccupancyThreshold', message: REJECTION.occupancyRange });
  }

  // FR-10 zoom-limit validation, delegated to U39 (range 0.1×..10000× + min ≤ max,
  // 単一の真実源). Map U39's field codes onto the settings error shape so the dialog
  // can place them inline next to the zoom inputs (教訓 5.26 通知と戻り値の両方).
  const zoom = validateZoomLimits(draft.zoomMin, draft.zoomMax);
  if (!zoom.ok) {
    for (const e of zoom.errors) {
      errors.push({ field: e.field, message: e.message });
    }
  }

  return errors.length === 0 ? ok(draft) : err(errors);
}

// --- App-settings validation -------------------------------------------------

/**
 * Validate a draft of the APP settings (FR-110). FPS range 1〜60, snap distance
 * non-negative, marker cap a non-negative integer. Same rules as the UI form
 * (教訓 5.26). Returns the clean value or the Japanese rejection reasons.
 */
export function validateAppSettings(draft: AppSettings): ValidationResult<AppSettings> {
  const errors: SettingsValidationError[] = [];

  if (!isFiniteNumber(draft.renderFps)) {
    errors.push({ field: 'renderFps', message: REJECTION.notANumber });
  } else if (draft.renderFps < MIN_RENDER_FPS || draft.renderFps > MAX_RENDER_FPS) {
    errors.push({ field: 'renderFps', message: REJECTION.fpsRange });
  }

  if (!isFiniteNumber(draft.snapDistancePx)) {
    errors.push({ field: 'snapDistancePx', message: REJECTION.notANumber });
  } else if (draft.snapDistancePx < SNAP_DISTANCE_MIN) {
    errors.push({ field: 'snapDistancePx', message: REJECTION.snapDistanceRange });
  }

  if (!isFiniteNumber(draft.vertexMarkerCap)) {
    errors.push({ field: 'vertexMarkerCap', message: REJECTION.notANumber });
  } else if (
    draft.vertexMarkerCap < VERTEX_MARKER_CAP_MIN ||
    !Number.isInteger(draft.vertexMarkerCap)
  ) {
    errors.push({ field: 'vertexMarkerCap', message: REJECTION.vertexMarkerCapRange });
  }

  if (!isFiniteNumber(draft.undoStackSize)) {
    errors.push({ field: 'undoStackSize', message: REJECTION.notANumber });
  } else if (
    draft.undoStackSize < UNDO_STACK_SIZE_MIN ||
    !Number.isInteger(draft.undoStackSize)
  ) {
    errors.push({ field: 'undoStackSize', message: REJECTION.undoStackSizeRange });
  }

  return errors.length === 0 ? ok(draft) : err(errors);
}
