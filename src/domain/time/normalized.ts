// Domain layer (time): the normalized integer representation and the core
// calculations built on it.
//
// The normalized value is an opaque branded integer measured in WHOLE DAYS
// from a fixed epoch (year 0, month 1, day 1 of the given calendar). The base
// unit (1 normalized step == 1 day) is defined ONCE here; no other function
// re-applies a multiplier (教訓 5.16, no double scaling). All comparison /
// duration / containment logic operates on this integer representation so
// results are free of floating-point drift (FR-70 / FR-72) and consistent
// across functions (単一の真実源).

import {
  daysInMonth,
  daysInYear,
  monthsPerYear,
  type Calendar,
} from './calendar';
import {
  complete,
  type CompleteTimePoint,
  type TimePoint,
} from './time-point';

declare const normalizedBrand: unique symbol;

/**
 * An opaque, branded integer representing a time point as whole days from the
 * calendar epoch. Cannot be assigned to/from a raw `number`, so a normalized
 * value can never be confused with an un-normalized scalar.
 */
export type Normalized = number & { readonly [normalizedBrand]: 'Normalized' };

/** Three-valued ordering result. */
export type Ordering = -1 | 0 | 1;

/**
 * Days from the epoch (year 0, Jan 1) to (year, Jan 1). Counts whole years,
 * each contributing its own length (so leap years are accounted for exactly).
 * Integer arithmetic only.
 */
function daysToYearStart(calendar: Calendar, year: number): number {
  let days = 0;
  if (year >= 0) {
    for (let y = 0; y < year; y++) {
      days += daysInYear(calendar, y);
    }
  } else {
    // Negative years: subtract the lengths of years from `year` up to 0.
    for (let y = -1; y >= year; y--) {
      days -= daysInYear(calendar, y);
    }
  }
  return days;
}

/**
 * Normalizes a TimePoint to its branded integer representation. Unspecified
 * month/day are completed to the calendar default (1月1日) via the single
 * completion path. Negative (BC) years are handled by the astronomical year
 * count. Assumes the point is valid for the calendar (see `validate`).
 */
export function normalize(point: TimePoint, calendar: Calendar): Normalized {
  const c: CompleteTimePoint = complete(point);
  let days = daysToYearStart(calendar, c.year);
  // Add days for whole months before the target month.
  for (let m = 1; m < c.month; m++) {
    days += daysInMonth(calendar, c.year, m);
  }
  // Day is 1-based; day 1 adds 0 offset.
  days += c.day - 1;
  return days as Normalized;
}

/**
 * Inverse of {@link normalize}. Returns a fully-resolved CompleteTimePoint
 * (year, month and day all concrete). The original "unspecified" granularity
 * is intentionally NOT recoverable — round-trip equality is defined against
 * the completed point (注意点: 往復一致の基準は補完後の完全値).
 */
export function denormalize(value: Normalized, calendar: Calendar): CompleteTimePoint {
  let remaining = value as number;
  // Locate the year by walking epoch-relative whole years.
  let year = 0;
  if (remaining >= 0) {
    for (;;) {
      const len = daysInYear(calendar, year);
      if (remaining < len) break;
      remaining -= len;
      year++;
    }
  } else {
    do {
      year--;
      remaining += daysInYear(calendar, year);
    } while (remaining < 0);
  }
  // remaining is now a 0-based day index within `year`.
  const months = monthsPerYear(calendar);
  let month = 1;
  while (month <= months) {
    const len = daysInMonth(calendar, year, month);
    if (remaining < len) break;
    remaining -= len;
    month++;
  }
  const day = remaining + 1;
  return { year, month, day };
}

/** Raw integer difference (in days) between two normalized values: b - a. */
function diff(a: Normalized, b: Normalized): number {
  return (b as number) - (a as number);
}

/**
 * Three-valued comparison of two normalized values: -1 if a is earlier, 0 if
 * simultaneous, +1 if a is later. Operates purely on the integer base unit.
 */
export function compareNormalized(a: Normalized, b: Normalized): Ordering {
  const d = diff(a, b);
  if (d > 0) return -1;
  if (d < 0) return 1;
  return 0;
}

/**
 * Three-valued comparison of two TimePoints under a calendar. Routes through
 * the same normalization used everywhere else, so it can never disagree with
 * duration / containment (単一の真実源).
 */
export function compare(a: TimePoint, b: TimePoint, calendar: Calendar): Ordering {
  return compareNormalized(normalize(a, calendar), normalize(b, calendar));
}

/**
 * Duration from `from` to `to`, in whole days (the single base unit). Positive
 * when `to` is later, negative when earlier, 0 when simultaneous. Computed as
 * the difference of normalized values — no multiplier is applied here.
 */
export function durationNormalized(from: Normalized, to: Normalized): number {
  return diff(from, to);
}

/** Duration in days between two TimePoints under a calendar (to - from). */
export function duration(from: TimePoint, to: TimePoint, calendar: Calendar): number {
  return durationNormalized(normalize(from, calendar), normalize(to, calendar));
}

/**
 * State-continuation test on normalized values: returns true when `point` lies
 * in the half-open interval [startInclusive, endExclusive). When
 * `endExclusive` is null the interval is open on the right (no end — the state
 * continues indefinitely), so the test is simply point >= start. This encodes
 * FR-55: a state continues from its start time up to (but not including) the
 * next anchor's start time.
 */
export function isWithinNormalized(
  point: Normalized,
  startInclusive: Normalized,
  endExclusive: Normalized | null,
): boolean {
  if (compareNormalized(point, startInclusive) < 0) return false;
  if (endExclusive === null) return true;
  return compareNormalized(point, endExclusive) < 0;
}

/**
 * State-continuation test on TimePoints under a calendar. Routes through the
 * same normalization and comparison as everything else (単一の真実源).
 * `endExclusive === null` means an open-ended interval.
 */
export function isWithin(
  point: TimePoint,
  startInclusive: TimePoint,
  endExclusive: TimePoint | null,
  calendar: Calendar,
): boolean {
  return isWithinNormalized(
    normalize(point, calendar),
    normalize(startInclusive, calendar),
    endExclusive === null ? null : normalize(endExclusive, calendar),
  );
}
