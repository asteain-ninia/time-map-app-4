// Longitude shift conversion + center-longitude presets (U18 / FR-12). Domain
// layer: pure, framework-free.
//
// SCOPE (spec §経度シフト UI FR-12):
//   - the SINGLE "slider操作量 → 中心経度移動量" conversion, scaled by zoom so the
//     on-screen pan feel is constant: the SAME slider delta moves the center less
//     when zoomed in (受け入れ基準 12). Zoom is multiplied in EXACTLY one place
//     here so no caller can double-apply it (教訓 5.16 倍率の二重適用防止),
//   - the center-longitude presets (prime-meridian-center 0° / pacific-center 180°),
//   - the representative center-longitude for the numeric display, folded through
//     U05 so ±180 reads canonically (R3).
//
// WHAT THIS MODULE DOES NOT DO (spec §やらないこと):
//   - it does not hold the center-longitude state (that is U16's session store),
//   - it does not own the camera transform (U17): it returns a NEW continuous
//     center longitude scalar for the caller to push into the camera (教訓 5.17),
//   - it does not re-implement ±360° folding (U05 `wrapLonDeg`, single source).

import { wrapLonDeg } from '../geo/longitude';

/**
 * Pixels of on-screen pan that one unit of slider value should produce. The slider
 * value is in abstract "shift units"; this constant converts a unit to a screen-px
 * pan intent, which {@link shiftToLonDelta} then divides by zoom (CSS px per
 * degree) to get a degree delta. Keeping the px-per-unit here means the conversion
 * is "constant on-screen feel" by construction.
 */
export const SHIFT_PX_PER_UNIT = 100;

/**
 * Convert a slider/shift操作量 to a center-longitude delta (degrees), scaled by
 * zoom so the on-screen pan distance is constant regardless of zoom (FR-12 §シフト
 * 量はズームレベルに依存 / 受け入れ基準 12).
 *
 * `zoom` is CSS pixels per degree (U17 camera scale). The on-screen pan a slider
 * unit should produce is `shift * SHIFT_PX_PER_UNIT` pixels; dividing by `zoom`
 * (px/deg) yields degrees. Therefore a HIGHER zoom (more px per degree) yields a
 * SMALLER degree delta for the same slider amount — the画面上の移動感 stays
 * constant. Zoom is divided in EXACTLY this one place (教訓 5.16: the caller must
 * NOT also scale by zoom, or the factor double-applies).
 *
 * Returns 0 for a non-positive / non-finite zoom (a not-yet-measured camera),
 * never NaN/Infinity (病的入力の安全性).
 */
export function shiftToLonDelta(shift: number, zoom: number): number {
  if (!Number.isFinite(zoom) || zoom <= 0 || !Number.isFinite(shift)) {
    return 0;
  }
  return (shift * SHIFT_PX_PER_UNIT) / zoom;
}

/**
 * Apply a shift操作量 to a continuous-scalar center longitude, returning the NEW
 * continuous center longitude (NOT folded — the camera keeps a continuous scalar,
 * FR-07; folding happens only at display time, see {@link representativeCenterLon}).
 * Pure; the only zoom multiplication is inside {@link shiftToLonDelta} (教訓 5.16).
 */
export function applyLongitudeShift(
  centerLon: number,
  shift: number,
  zoom: number,
): number {
  return centerLon + shiftToLonDelta(shift, zoom);
}

// --- Center-longitude presets (FR-12 0度中心 / 180度中心) --------------------

/**
 * Named center-longitude presets (spec FR-12: 0度中心 / 180度中心 等). The
 * value is the representative center longitude in [−180, 180); the caller sets the
 * continuous center to this (a representative value is itself a valid continuous
 * scalar). Frozen so the UI buttons and any test share one list (教訓 5.19).
 */
export const CENTER_LON_PRESET = {
  /** Prime-meridian-centered view (center longitude 0°). */
  PrimeMeridian: 'primeMeridian',
  /** Pacific-centered view (center longitude 180°). */
  Pacific: 'pacific',
} as const;

export type CenterLonPreset =
  (typeof CENTER_LON_PRESET)[keyof typeof CENTER_LON_PRESET];

/** The center longitude (deg) for each preset. */
export const CENTER_LON_PRESET_VALUE: Readonly<Record<CenterLonPreset, number>> = {
  [CENTER_LON_PRESET.PrimeMeridian]: 0,
  [CENTER_LON_PRESET.Pacific]: 180,
};

/**
 * The continuous center longitude to adopt for a preset. The caller pushes this
 * into the camera center (continuous scalar). Pure.
 */
export function centerLonForPreset(preset: CenterLonPreset): number {
  return CENTER_LON_PRESET_VALUE[preset];
}

/**
 * Parse the 絶対経度指定 text-input value (HB3-1 裁定 2026-08-06: 相対ジョグに加え
 * 中心経度の直接入力を提供する) into a continuous center longitude, or `null` when
 * the text is not a finite number (empty / whitespace / non-numeric — the caller
 * disables the commit action rather than guessing). Out-of-range values are folded
 * through U05's `wrapLonDeg` (single source, R3) — e.g. "190" means 170°W — because
 * a representative value is itself a valid continuous scalar (same contract as
 * {@link centerLonForPreset}). Pure.
 */
export function parseAbsoluteCenterLon(raw: string): number | null {
  const trimmed = raw.trim();
  // Number('') === 0, so the empty guard must come BEFORE the conversion.
  if (trimmed === '') return null;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return null;
  return wrapLonDeg(value);
}

/**
 * The display-time representative center longitude (spec FR-12 §現在の中心経度を
 * 数値表示): fold the continuous center into [−180, 180) via U05's `wrapLonDeg`
 * (single source, R3) so the numeric readout is canonical near the seam. Pure.
 */
export function representativeCenterLon(centerLon: number): number {
  return wrapLonDeg(centerLon);
}

/**
 * Format the center longitude for the numeric display (e.g. "中心経度: 0°",
 * "中心経度: 170°E", "中心経度: 180°"). Uses the representative value so it reads
 * canonically across the seam (受け入れ基準 11). One decimal place so a shifted
 * center reads a continuous-looking value rather than snapping to whole degrees.
 */
export function formatCenterLonDisplay(centerLon: number): string {
  const rep = representativeCenterLon(centerLon);
  const rounded = Math.round(rep * 10) / 10;
  if (rounded === 0) return '0°';
  if (rounded === -180 || rounded === 180) return '180°';
  const hemi = rounded > 0 ? 'E' : 'W';
  return `${Math.abs(rounded)}°${hemi}`;
}
