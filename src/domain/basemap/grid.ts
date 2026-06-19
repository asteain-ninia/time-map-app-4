// Lat/lon graticule grid model (U18 / FR-13). Domain layer: pure, framework-free.
//
// SCOPE (spec §緯線・経線グリッド FR-13):
//   - the allowed spacings (5 / 10 / 15 / 30°, default 10°),
//   - the SINGLE emphasis判定 for the equator (lat 0), prime meridian (lon 0) and
//     the ±180° meridian, shared by BOTH line drawing AND label drawing so they
//     can never drift (教訓 5.29 / §4 単一真実源, 受け入れ基準 8),
//   - enumeration of the grid latitudes / longitudes covering a viewport span
//     (the render layer turns these into line + label primitives),
//   - label TEXT formatting with U05 longitude normalization so a meridian label
//     reads the correct value across the seam (R3, 受け入れ基準 13).
//
// WHAT THIS MODULE DOES NOT DO (spec §やらないこと):
//   - it does not draw (no Canvas): the render layer consumes these pure values,
//   - it does not own the world↔screen transform, the wrap-replica turn counting
//     or the constant-on-screen font size — those are U17 / FR-17 (the render
//     layer applies them; this module only supplies world coordinates + text),
//   - it does not re-implement ±360° folding: longitude labels go through U05's
//     `wrapLonDeg` (single source, R3).

import { wrapLonDeg } from '../geo/longitude';

/**
 * The selectable grid spacings in degrees (spec FR-13: 5 / 10 / 15 / 30, default
 * 10). Frozen tuple so the UI <select> and validation share one list (教訓 5.19:
 * the option set is a constant, not scattered literals).
 */
export const GRID_SPACINGS_DEG = [5, 10, 15, 30] as const;

export type GridSpacingDeg = (typeof GRID_SPACINGS_DEG)[number];

/** The default grid spacing (spec FR-13 既定 10°). */
export const DEFAULT_GRID_SPACING_DEG: GridSpacingDeg = 10;

/** True iff `spacing` is one of the allowed grid spacings. */
export function isGridSpacing(spacing: number): spacing is GridSpacingDeg {
  return (GRID_SPACINGS_DEG as readonly number[]).includes(spacing);
}

/**
 * Coerce an arbitrary spacing to the nearest allowed value, defaulting to 10° when
 * the input is not one of the allowed values. Single place the "valid spacing"
 * rule is applied so a stale setting can never produce an off-list spacing
 * (教訓 5.18: a bad value resolves to the named default, not silently kept).
 */
export function coerceGridSpacing(spacing: number): GridSpacingDeg {
  return isGridSpacing(spacing) ? spacing : DEFAULT_GRID_SPACING_DEG;
}

// --- Emphasis判定 (single source, shared by line + label) -------------------

/**
 * The emphasized graticule lines (spec FR-13 強調表示): the equator (lat 0°), the
 * prime meridian (lon 0°) and the ±180° meridian. Modeled as a discriminant so
 * callers branch on a value, not a magic number.
 */
export const GRID_EMPHASIS = {
  None: 'none',
  Equator: 'equator',
  PrimeMeridian: 'primeMeridian',
  Antimeridian: 'antimeridian',
} as const;

export type GridEmphasis = (typeof GRID_EMPHASIS)[keyof typeof GRID_EMPHASIS];

/** Tolerance (deg) for treating a coordinate as exactly on an emphasized line. */
const EMPHASIS_EPSILON = 1e-9;

/**
 * The SINGLE emphasis判定 for a latitude line (spec 受け入れ基準 8: 単一の判定関数).
 * Returns `Equator` for lat 0 (within epsilon), else `None`. Both line drawing and
 * label drawing call THIS — they never re-test `lat === 0` independently
 * (教訓 5.29: 派生形状は単一判定で全経路を動かす).
 */
export function latitudeEmphasis(lat: number): GridEmphasis {
  return Math.abs(lat) <= EMPHASIS_EPSILON ? GRID_EMPHASIS.Equator : GRID_EMPHASIS.None;
}

/**
 * The SINGLE emphasis判定 for a longitude line. The input may be a continuous
 * scalar; it is folded through U05's `wrapLonDeg` FIRST so a meridian drawn at the
 * +360°-replica position is still recognised as the prime meridian / antimeridian
 * across the seam (R3, 受け入れ基準 13). `wrapLonDeg` maps +180 → −180, so the
 * antimeridian is detected at the single canonical −180 representative.
 */
export function longitudeEmphasis(lon: number): GridEmphasis {
  const rep = wrapLonDeg(lon);
  if (Math.abs(rep) <= EMPHASIS_EPSILON) return GRID_EMPHASIS.PrimeMeridian;
  // wrapLonDeg folds +180 to −180, so the antimeridian is the −180 representative.
  if (Math.abs(rep + 180) <= EMPHASIS_EPSILON) return GRID_EMPHASIS.Antimeridian;
  return GRID_EMPHASIS.None;
}

/** True iff a latitude/longitude line is emphasized (convenience over the判定). */
export function isLatitudeEmphasized(lat: number): boolean {
  return latitudeEmphasis(lat) !== GRID_EMPHASIS.None;
}

export function isLongitudeEmphasized(lon: number): boolean {
  return longitudeEmphasis(lon) !== GRID_EMPHASIS.None;
}

// --- Graticule enumeration --------------------------------------------------

/** Inclusive latitude bounds for graticule enumeration (clamped to ±90). */
export const LAT_MIN_DEG = -90;
export const LAT_MAX_DEG = 90;

/**
 * The latitudes (deg) at which to draw parallels, at `spacing` intervals, covering
 * the full world band [−90, +90] inclusive on multiples of the spacing. Always
 * includes 0 (the equator) because every allowed spacing divides 90. Pure;
 * returned ascending. The result is finite and bounded (≤ 180/spacing + 1 lines),
 * satisfying视野外クリッピング at the render layer which filters to the visible band.
 */
export function graticuleLatitudes(spacing: GridSpacingDeg): number[] {
  const out: number[] = [];
  // Start at the first multiple of `spacing` ≥ LAT_MIN, end at the last ≤ LAT_MAX.
  const first = Math.ceil(LAT_MIN_DEG / spacing) * spacing;
  for (let lat = first; lat <= LAT_MAX_DEG + EMPHASIS_EPSILON; lat += spacing) {
    out.push(lat);
  }
  return out;
}

/**
 * The CONTINUOUS-scalar longitudes (deg) at which to draw meridians within the
 * inclusive viewport longitude span [lonWest, lonEast], at `spacing` intervals on
 * the global multiples-of-spacing grid. Because the span is in continuous scalar
 * space (FR-07 無限横スクロール), this enumerates meridians across the seam without
 * a private ±360° calculation — the multiples are simply continued past ±180, and
 * the LABEL for each is normalized later via {@link formatLongitudeLabel}. Pure;
 * returned ascending. A degenerate span (west > east or non-finite) yields [].
 */
export function graticuleLongitudes(
  lonWest: number,
  lonEast: number,
  spacing: GridSpacingDeg,
): number[] {
  if (
    !Number.isFinite(lonWest) ||
    !Number.isFinite(lonEast) ||
    lonEast < lonWest
  ) {
    return [];
  }
  const out: number[] = [];
  const first = Math.ceil(lonWest / spacing) * spacing;
  for (let lon = first; lon <= lonEast + EMPHASIS_EPSILON; lon += spacing) {
    out.push(lon);
  }
  return out;
}

// --- Label TEXT (U05-normalized, 受け入れ基準 13) ---------------------------

/**
 * Format a parallel's label (e.g. "10°N", "30°S", "0°"). Latitude is never wrapped
 * (no latitude periodicity, FR-05). The equator reads "0°"; N/S suffix otherwise.
 * Rounded to the nearest integer degree (grid spacings are whole degrees).
 */
export function formatLatitudeLabel(lat: number): string {
  const rounded = Math.round(lat);
  if (rounded === 0) return '0°';
  const hemi = rounded > 0 ? 'N' : 'S';
  return `${Math.abs(rounded)}°${hemi}`;
}

/**
 * Format a meridian's label from a CONTINUOUS-scalar longitude. The value is folded
 * to the representative interval via U05's `wrapLonDeg` FIRST (single source, R3),
 * so a meridian drawn at the +1-turn replica (e.g. continuous 190°) reads its true
 * value (−170°W) rather than a winding 190° (受け入れ基準 13). Reads:
 *   - 0 → "0°",
 *   - +180 / −180 → "180°" (the antimeridian has one canonical label, no E/W),
 *   - east → "…°E", west → "…°W".
 */
export function formatLongitudeLabel(lon: number): string {
  const rep = wrapLonDeg(lon);
  const rounded = Math.round(rep);
  if (rounded === 0) return '0°';
  // wrapLonDeg yields −180 for the antimeridian; label it 180° without hemisphere.
  if (rounded === -180 || rounded === 180) return '180°';
  const hemi = rounded > 0 ? 'E' : 'W';
  return `${Math.abs(rounded)}°${hemi}`;
}
