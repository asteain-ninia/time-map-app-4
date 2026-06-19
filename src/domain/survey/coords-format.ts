// Latitude / longitude display formatting for the survey mode (U37, FR-16).
//
// Pure, framework-free domain logic: turns a continuous-scalar world coordinate
// into the two display forms FR-16 requires — DECIMAL (十進) and
// DEGREES/MINUTES/SECONDS (度分秒) — with Japanese compass words (北緯/南緯/
// 東経/西経, FR-115). No side effects, no globals, no clock.
//
// Single source of truth for the seam fold (教訓 §4 / §5.30): longitude is a
// continuous scalar (it may carry whole +360k turns from an infinite-scroll
// click, U03 / 技術方針 R3). Before any formatting it is folded into the
// representative half-open interval [-180, 180) via U04's `wrapLonDeg` — this
// unit NEVER re-derives the ±360° fold. Latitude is non-periodic (FR-05) and is
// passed through verbatim (過剰共有の戒め — the longitude period must not leak
// onto latitude).
//
// Degenerate-input discipline (spec §4.6): a non-finite coordinate is reported
// as a placeholder string rather than throwing, so the UI never shows a broken
// numeric label to the user (FR-117).

import type { WorldCoordinate } from '../coordinate';
import { wrapLonDeg } from '../geo/longitude';

/** Decimal places used for the decimal (十進) form. 6 dp ≈ 0.1 m at the equator. */
export const DECIMAL_PLACES = 6;

/** Placeholder shown for a non-finite (corrupt) coordinate value (FR-117). */
export const INVALID_VALUE_TEXT = '—';

// --- Compass words (FR-115 Japanese UI) -------------------------------------

/** Japanese compass words for the four hemispheres. */
export const COMPASS = {
  north: '北緯',
  south: '南緯',
  east: '東経',
  west: '西経',
} as const;

// --- Representative normalization (single source: U04 wrapLonDeg) ------------

/**
 * Fold a click's continuous longitude scalar into the representative interval
 * [-180, 180) for display. Delegates the fold to U04 so the boundary convention
 * (+180 -> -180) lives in exactly one place (単一真実源). Latitude is NOT
 * touched here.
 */
export function representativeLon(lon: number): number {
  return wrapLonDeg(lon);
}

// --- Decimal form (十進) -----------------------------------------------------

/**
 * The decimal (十進) latitude string, e.g. `北緯 35.689400°`. The magnitude is
 * fixed to {@link DECIMAL_PLACES}; the hemisphere word is chosen by sign. Exactly
 * 0 is treated as the northern/positive label (a single, stable convention so the
 * equator does not flip labels across runs).
 */
export function formatLatDecimal(lat: number): string {
  if (!Number.isFinite(lat)) {
    return INVALID_VALUE_TEXT;
  }
  const word = lat < 0 ? COMPASS.south : COMPASS.north;
  return `${word} ${Math.abs(lat).toFixed(DECIMAL_PLACES)}°`;
}

/**
 * The decimal (十進) longitude string, e.g. `東経 139.750000°`. The scalar is
 * folded to [-180, 180) first (representativeLon). Exactly 0 / the folded -180
 * edge use the eastern/positive label for the same stable-convention reason.
 */
export function formatLonDecimal(lon: number): string {
  if (!Number.isFinite(lon)) {
    return INVALID_VALUE_TEXT;
  }
  const norm = representativeLon(lon);
  const word = norm < 0 ? COMPASS.west : COMPASS.east;
  return `${word} ${Math.abs(norm).toFixed(DECIMAL_PLACES)}°`;
}

// --- Degrees/minutes/seconds form (度分秒) -----------------------------------

/** A degrees/minutes/seconds decomposition of a non-negative magnitude. */
export interface DmsParts {
  readonly degrees: number;
  readonly minutes: number;
  /** Seconds, rounded to {@link DMS_SECOND_PLACES}; always in [0, 60). */
  readonly seconds: number;
}

/** Decimal places kept on the seconds component of the 度分秒 form. */
export const DMS_SECOND_PLACES = 2;

/**
 * Decompose a non-negative decimal-degree magnitude into degrees / minutes /
 * seconds, correctly handling the rounding carry: when the rounded seconds reach
 * 60 they carry into minutes, and 60 minutes carry into degrees. Without this the
 * boundary (e.g. 35.999999°) would print `59′60.00″` instead of the next whole
 * degree (spec §4.4 分秒の繰り上がり).
 */
export function toDmsParts(magnitudeDeg: number): DmsParts {
  const totalSeconds = magnitudeDeg * 3600;
  const factor = 10 ** DMS_SECOND_PLACES;
  // Round to the displayed second precision FIRST, then carry, so the carry is
  // computed on the value the user actually sees.
  let roundedSeconds = Math.round(totalSeconds * factor) / factor;
  let degrees = Math.floor(roundedSeconds / 3600);
  roundedSeconds -= degrees * 3600;
  let minutes = Math.floor(roundedSeconds / 60);
  let seconds = roundedSeconds - minutes * 60;
  // Defensive carry against any residual float landing exactly on 60.
  if (seconds >= 60) {
    seconds -= 60;
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }
  return { degrees, minutes, seconds };
}

function formatDmsBody(parts: DmsParts): string {
  const sec = parts.seconds.toFixed(DMS_SECOND_PLACES);
  return `${parts.degrees}°${parts.minutes}′${sec}″`;
}

/**
 * The 度分秒 latitude string, e.g. `北緯 35°41′21.84″`. The hemisphere word is
 * chosen by sign; the magnitude is decomposed with rounding-carry handling.
 */
export function formatLatDms(lat: number): string {
  if (!Number.isFinite(lat)) {
    return INVALID_VALUE_TEXT;
  }
  const word = lat < 0 ? COMPASS.south : COMPASS.north;
  return `${word} ${formatDmsBody(toDmsParts(Math.abs(lat)))}`;
}

/**
 * The 度分秒 longitude string, e.g. `東経 139°45′00.00″`. The scalar is folded
 * to [-180, 180) first; the hemisphere word is chosen by the folded sign.
 */
export function formatLonDms(lon: number): string {
  if (!Number.isFinite(lon)) {
    return INVALID_VALUE_TEXT;
  }
  const norm = representativeLon(lon);
  const word = norm < 0 ? COMPASS.west : COMPASS.east;
  return `${word} ${formatDmsBody(toDmsParts(Math.abs(norm)))}`;
}

// --- Combined coordinate display --------------------------------------------

/** Both display forms for one coordinate (FR-16 度分秒 AND 十進 both shown). */
export interface CoordinateDisplay {
  /** Latitude in 度分秒, e.g. `北緯 35°41′21.84″`. */
  readonly latDms: string;
  /** Longitude in 度分秒, e.g. `東経 139°45′00.00″`. */
  readonly lonDms: string;
  /** Latitude in 十進, e.g. `北緯 35.689400°`. */
  readonly latDecimal: string;
  /** Longitude in 十進, e.g. `東経 139.750000°`. */
  readonly lonDecimal: string;
}

/**
 * Build both display forms (度分秒 + 十進) for a clicked coordinate (FR-16). The
 * longitude scalar is folded to its representative interval inside the
 * formatters; latitude passes through. A degenerate (non-finite) input yields
 * placeholder strings rather than throwing (FR-117).
 */
export function formatCoordinate(coord: WorldCoordinate): CoordinateDisplay {
  return {
    latDms: formatLatDms(coord.lat),
    lonDms: formatLonDms(coord.lon),
    latDecimal: formatLatDecimal(coord.lat),
    lonDecimal: formatLonDecimal(coord.lon),
  };
}
