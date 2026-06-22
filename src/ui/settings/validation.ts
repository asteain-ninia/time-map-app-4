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

function isFiniteNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

// --- Rejection messages (single map, shared by UI + confirm entry, 教訓 5.26) -

/** Japanese rejection messages, produced from a single source (FR-115). */
export const REJECTION = {
  timelineOrder: 'タイムラインの最小年は最大年より小さくしてください。',
  equatorNonPositive: '赤道長は 0 より大きい値を入力してください。',
  flatteningRange: '扁平率は 0 以上 1 未満の値を入力してください。',
  // Derived from the single GRID_SPACINGS_DEG list (HB3-23) so the message can never
  // drift from the actual allowed spacings when the list changes.
  gridSpacing: `グリッド間隔は ${GRID_SPACINGS_DEG.join('・')} 度のいずれかを選んでください。`,
  gridOpacityRange: 'グリッド不透明度は 0 から 1 の範囲で入力してください。',
  occupancyRange: '面情報ラベル表示閾値は 0 から 1 の範囲で入力してください。',
  fpsRange: `描画更新頻度は ${String(MIN_RENDER_FPS)} から ${String(MAX_RENDER_FPS)} FPS の範囲で入力してください。`,
  snapDistanceRange: '共有頂点スナップ距離は 0 以上の数値で入力してください。',
  vertexMarkerCapRange: '全頂点マーカー表示上限は 0 以上の整数で入力してください。',
  notANumber: '数値を入力してください。',
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
  } else if (draft.timelineMinYear >= draft.timelineMaxYear) {
    errors.push({ field: 'timelineMinYear', message: REJECTION.timelineOrder });
  }

  if (!isGridSpacing(draft.gridSpacingDeg)) {
    errors.push({ field: 'gridSpacingDeg', message: REJECTION.gridSpacing });
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

  return errors.length === 0 ? ok(draft) : err(errors);
}
