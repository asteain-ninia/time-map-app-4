// Domain layer (time): calendar-aware validation of a TimePoint.
//
// Validation rejects out-of-range months, out-of-range days (accounting for
// leap years), non-integer values, and granularity mismatches. It returns a
// discriminated result with a machine-checkable reason rather than throwing,
// so callers (and tests) can assert on the rejection cause. Range checks here
// guard the un-checked indexed access in normalize/denormalize (注意点:
// noUncheckedIndexedAccess の月構成テーブル).

import { daysInMonth, monthsPerYear, type Calendar } from './calendar';
import type { TimePoint } from './time-point';

/** Why a TimePoint failed validation. */
export type TimeValidationError =
  | 'year-not-integer'
  | 'year-out-of-range'
  | 'month-not-integer'
  | 'day-not-integer'
  | 'month-out-of-range'
  | 'day-out-of-range';

export type TimeValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TimeValidationError };

/**
 * Inclusive magnitude bound on a year (astronomical convention, so the valid
 * range is [-MAX_YEAR, MAX_YEAR]).
 *
 * WHY a bound exists at all — the normalized representation is whole DAYS from
 * the epoch (≈ 365.25 × year). Two failure modes appear once `year` grows
 * without limit, and BOTH break invariants this module guarantees:
 *
 *  1. PRECISION COLLAPSE. `daysToYearStart` computes `commonLen * year`; for a
 *     huge year that product overflows `Number.MAX_SAFE_INTEGER`, after which
 *     the `+ day - 1` offset is silently lost. Distinct days in the same year
 *     then normalize to the SAME integer, so compare / duration / isWithin stop
 *     being exact (violating FR-70 / FR-72, the float-drift-free guarantee).
 *  2. UNBOUNDED LOOP / HANG. `denormalize` (and the custom-calendar fallback in
 *     `daysToYearStart`) walks year-by-year; an effectively-infinite normalized
 *     value turns that into a multi-quintillion-iteration hang.
 *
 * Reachable from a crafted persisted manifest (the persistence schema routes
 * its year refinement through THIS validator — 単一真実源), so the bound is the
 * load-time defence as well as the in-memory one.
 *
 * The value is chosen so the worst-case normalized magnitude
 * (366 × MAX_YEAR ≈ 3.66e8) sits far below `Number.MAX_SAFE_INTEGER` (≈ 9e15)
 * with overflow headroom for the +month/+day offsets and any subtraction, while
 * also keeping the per-year denormalize walk bounded (≤ MAX_YEAR iterations).
 * One million years comfortably exceeds any timeline a historical-map project
 * would express, so no legitimate point is excluded.
 */
export const MAX_YEAR = 1_000_000;

function isInteger(n: number): boolean {
  return Number.isInteger(n);
}

/**
 * Whether `n` is a valid PERSISTED year: an integer within ±{@link MAX_YEAR}.
 * This is the SAME bound the persistence `yearSchema` enforces on every persisted
 * year leaf (anchor start/end, attribute start/end, timeline bounds). Exported so
 * the UI settings validator (WRITE side) can reject exactly what the load schema
 * (READ side) rejects — otherwise a timeline year the form accepts but the schema
 * rejects gets saved into the .tmap and makes the file un-loadable on reopen
 * (教訓 6.4.15 片側 shim の防止 / round-trip 整合・書込⊆読込).
 */
export function isPersistedYear(n: number): boolean {
  return Number.isInteger(n) && n >= -MAX_YEAR && n <= MAX_YEAR;
}

/**
 * Validates a TimePoint against a calendar. Years may be negative
 * (astronomical convention) but must be integers within ±{@link MAX_YEAR} (the
 * magnitude bound that keeps the normalized day-count exact and the per-year
 * walks bounded — see MAX_YEAR). Month must be within 1..monthsPerYear; day
 * must be within 1..daysInMonth for the resolved month and year (so a leap day
 * is valid only in a leap year). Unspecified granularities (year / yearMonth)
 * skip the checks for the absent components.
 */
export function validate(point: TimePoint, calendar: Calendar): TimeValidation {
  if (!isInteger(point.year)) {
    return { ok: false, error: 'year-not-integer' };
  }
  if (point.year < -MAX_YEAR || point.year > MAX_YEAR) {
    return { ok: false, error: 'year-out-of-range' };
  }

  if (point.granularity === 'year') {
    return { ok: true };
  }

  // month is present for both 'yearMonth' and 'yearMonthDay'.
  const { month } = point;
  if (!isInteger(month)) {
    return { ok: false, error: 'month-not-integer' };
  }
  if (month < 1 || month > monthsPerYear(calendar)) {
    return { ok: false, error: 'month-out-of-range' };
  }

  if (point.granularity === 'yearMonth') {
    return { ok: true };
  }

  const { day } = point;
  if (!isInteger(day)) {
    return { ok: false, error: 'day-not-integer' };
  }
  // month is already range-checked, so daysInMonth is safe here.
  const maxDay = daysInMonth(calendar, point.year, month);
  if (day < 1 || day > maxDay) {
    return { ok: false, error: 'day-out-of-range' };
  }

  return { ok: true };
}

/** Convenience predicate over {@link validate}. */
export function isValid(point: TimePoint, calendar: Calendar): boolean {
  return validate(point, calendar).ok;
}
