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
  | 'month-not-integer'
  | 'day-not-integer'
  | 'month-out-of-range'
  | 'day-out-of-range';

export type TimeValidation =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: TimeValidationError };

function isInteger(n: number): boolean {
  return Number.isInteger(n);
}

/**
 * Validates a TimePoint against a calendar. Years may be negative
 * (astronomical convention) but must be integers. Month must be within
 * 1..monthsPerYear; day must be within 1..daysInMonth for the resolved month
 * and year (so a leap day is valid only in a leap year). Unspecified
 * granularities (year / yearMonth) skip the checks for the absent components.
 */
export function validate(point: TimePoint, calendar: Calendar): TimeValidation {
  if (!isInteger(point.year)) {
    return { ok: false, error: 'year-not-integer' };
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
