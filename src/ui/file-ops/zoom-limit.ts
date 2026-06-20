// UI layer (U39): zoom-limit validation + the ZoomRange supply to the camera (FR-10).
//
// This module owns the PURE zoom-limit logic that the spec requires to be unit-
// testable without Electron / OS dialogs (受け入れ基準 7 / NFR 5.8): validating a
// user-entered min/max against the FR-10 allowed boundary, and deriving the
// currently-effective clamp range a camera (U17) consumes.
//
// SINGLE SOURCE OF TRUTH (spec §E 設定値のハードコード禁止, 教訓 5.19):
//   - the FR-10 default (1×..50×) and the allowed input boundary (0.1×..10000×)
//     are owned ONCE by U16 (`../state/settings`) and imported here; they are
//     never re-declared at a call site. The render layer's `DEFAULT_ZOOM_RANGE`
//     (= 1×..50×) mirrors the same default by spec contract.
//
// CLAMP IS SUPPLIED, NOT COMPUTED (spec §E / 注意点「クランプは供給に徹する」): the
// clamp arithmetic lives in U17 (`render/camera` clampZoom / `vtransform`
// zoomAtCursor). This module produces the {@link ZoomRange} VALUE; it never
// re-implements the clamp judgement (単一の真実源).

import {
  ZOOM_LIMIT_CEIL,
  ZOOM_LIMIT_FLOOR,
  type ProjectSettings,
} from '../state/settings';

/**
 * The render-layer clamp shape (`render/camera#ZoomRange`) reproduced here as a
 * pure value type so this ui module does not import the render layer just for a
 * 2-field shape (it stays `ui → domain/ui-state` only, 技術方針 2.13). The
 * ui-wiring bridge passes a `{ minZoom, maxZoom }` produced here to U17, which
 * accepts exactly this structural shape (教訓 5.33: contract fixed by both sides).
 */
export interface ZoomRangeValue {
  readonly minZoom: number;
  readonly maxZoom: number;
}

// --- validation result (教訓 5.26: テスト可能な戻り値 + 日本語拒否理由) --------

/** A validation error keyed to the offending field, with a Japanese reason. */
export interface ZoomLimitError {
  /** `zoomMin` or `zoomMax` (so the UI can place the error inline). */
  readonly field: 'zoomMin' | 'zoomMax';
  /** The Japanese rejection reason (FR-115). */
  readonly message: string;
}

/** The validated min/max pair on success, or the list of Japanese reasons. */
export type ZoomLimitValidation =
  | { readonly ok: true; readonly zoomMin: number; readonly zoomMax: number }
  | { readonly ok: false; readonly errors: readonly ZoomLimitError[] };

// --- Japanese rejection messages (single map, FR-115) -----------------------

export const ZOOM_LIMIT_REJECTION = {
  notANumber: '数値を入力してください。',
  outOfRange: `ズーム倍率は ${String(ZOOM_LIMIT_FLOOR)} 倍から ${String(
    ZOOM_LIMIT_CEIL,
  )} 倍の範囲で入力してください。`,
  order: '最小ズーム倍率は最大ズーム倍率以下にしてください。',
} as const;

function isFiniteNumber(n: number): boolean {
  return typeof n === 'number' && Number.isFinite(n);
}

/** True iff `v` is within the FR-10 user-settable boundary [0.1×, 10000×]. */
export function isWithinZoomBoundary(v: number): boolean {
  return isFiniteNumber(v) && v >= ZOOM_LIMIT_FLOOR && v <= ZOOM_LIMIT_CEIL;
}

/**
 * Validate a user-entered zoom-limit pair (FR-10, spec §E). Both values must lie
 * within the allowed boundary [0.1×, 10000×] AND satisfy zoomMin ≤ zoomMax. The
 * SAME function backs the dialog's inline error and any non-UI confirm entry, so
 * an out-of-range / reversed pair can never reach the store (教訓 5.26 確定前検証).
 * Returns the clean pair on success or the full list of Japanese reasons; never
 * throws (the rejection is a value, not an exception).
 */
export function validateZoomLimits(
  zoomMin: number,
  zoomMax: number,
): ZoomLimitValidation {
  const errors: ZoomLimitError[] = [];

  if (!isFiniteNumber(zoomMin)) {
    errors.push({ field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.notANumber });
  } else if (!isWithinZoomBoundary(zoomMin)) {
    errors.push({ field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.outOfRange });
  }

  if (!isFiniteNumber(zoomMax)) {
    errors.push({ field: 'zoomMax', message: ZOOM_LIMIT_REJECTION.notANumber });
  } else if (!isWithinZoomBoundary(zoomMax)) {
    errors.push({ field: 'zoomMax', message: ZOOM_LIMIT_REJECTION.outOfRange });
  }

  // The order check is only meaningful once both values are finite numbers; a
  // reversed pair (min > max) is rejected even when both are individually in
  // range (受け入れ基準 5: 最小>最大の入力が無効として弾かれる).
  if (
    isFiniteNumber(zoomMin) &&
    isFiniteNumber(zoomMax) &&
    isWithinZoomBoundary(zoomMin) &&
    isWithinZoomBoundary(zoomMax) &&
    zoomMin > zoomMax
  ) {
    errors.push({ field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.order });
  }

  return errors.length === 0
    ? { ok: true, zoomMin, zoomMax }
    : { ok: false, errors };
}

/**
 * Derive the currently-effective {@link ZoomRangeValue} the camera (U17) clamps
 * against, from the project settings (FR-10 / FR-109 即時反映). The bridge passes
 * this VALUE to U17 on every settings change so the new limit takes effect at
 * once; U17 applies the clamp (this module never does, spec §E). The stored
 * values are already validated, so this is a plain projection (no re-clamping of
 * the bounds themselves — that would silently hide a bad stored value).
 */
export function zoomRangeOf(settings: ProjectSettings): ZoomRangeValue {
  return { minZoom: settings.zoomMin, maxZoom: settings.zoomMax };
}
