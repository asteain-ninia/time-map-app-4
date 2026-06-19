// UI layer (U21 / timeline): pure step (前進/後退) arithmetic.
//
// Step always moves the current time by exactly 1 unit (year/month/day),
// FR-68. The arithmetic itself (month-end, year boundary, leap year, BC
// boundary) is delegated to U02: we complete any unspecified month/day via the
// calendar default (1月1日, NOT `month || 1` — 教訓 5.18), normalize, add the
// unit's day offset where day-based, or recompose for year/month steps, then
// denormalize back to a complete value. No calendar constant is computed here
// (受け入れ基準 6).

import { daysInMonth, monthsPerYear, type Calendar } from '../../domain/time/calendar';
import {
  denormalize,
  normalize,
  type Normalized,
} from '../../domain/time/normalized';
import {
  complete,
  timePointYearMonthDay,
  type CompleteTimePoint,
  type TimePoint,
} from '../../domain/time/time-point';

/** The unit a step advances by (FR-68: 年・月・日, initial = 年). */
export const STEP_UNIT = {
  Year: 'year',
  Month: 'month',
  Day: 'day',
} as const;

export type StepUnit = (typeof STEP_UNIT)[keyof typeof STEP_UNIT];

/** Direction of a step. */
export type StepDirection = 1 | -1;

/**
 * Advances `point` by exactly one `unit` in `direction`. Month/day that are
 * unspecified are completed to the calendar default first (1月1日) via U02's
 * single completion path, then the unit is added. The result is a COMPLETE
 * y/m/d TimePoint (完全値で受け渡し, 教訓 5.16).
 *
 * - day:   add/subtract one day via U02 normalize/denormalize (handles month-
 *          end, year and BC boundaries, leap years exactly).
 * - month: shift the month, carrying into the year; clamp the day to the new
 *          month's length using U02's daysInMonth (no UI day table).
 * - year:  shift the year; clamp the day to the new year's month length (leap
 *          Feb 29 -> 28 in a common year) using U02's daysInMonth.
 */
export function stepTimePoint(
  point: TimePoint,
  unit: StepUnit,
  direction: StepDirection,
  calendar: Calendar,
): TimePoint {
  const c: CompleteTimePoint = complete(point);

  if (unit === STEP_UNIT.Day) {
    const n = normalize(timePointYearMonthDay(c.year, c.month, c.day), calendar);
    const next = ((n as number) + direction) as Normalized;
    const d = denormalize(next, calendar);
    return timePointYearMonthDay(d.year, d.month, d.day);
  }

  if (unit === STEP_UNIT.Month) {
    const months = monthsPerYear(calendar);
    // month is 1-based; convert to 0-based index for modular arithmetic.
    const idx = c.month - 1 + direction;
    const yearShift = Math.floor(idx / months);
    const newMonth = ((idx % months) + months) % months + 1;
    const newYear = c.year + yearShift;
    const maxDay = daysInMonth(calendar, newYear, newMonth);
    const newDay = c.day > maxDay ? maxDay : c.day;
    return timePointYearMonthDay(newYear, newMonth, newDay);
  }

  // unit === Year
  const newYear = c.year + direction;
  const maxDay = daysInMonth(calendar, newYear, c.month);
  const newDay = c.day > maxDay ? maxDay : c.day;
  return timePointYearMonthDay(newYear, c.month, newDay);
}
