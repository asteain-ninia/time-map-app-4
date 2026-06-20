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
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type CompleteTimePoint,
  type TimeGranularity,
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

// Granularity ordering (coarse -> fine). Used to keep a step from fabricating a
// finer field than either the input or the step unit actually pins down — so a
// step's inverse is identity at the DISPLAY/granularity level, not only at the
// normalized-instant level (op∘逆op=恒等). e.g. stepping a year-granularity
// point by 年 must stay year-granularity, otherwise "0年" would render as
// "0年1月1日" after forward+back.
const GRANULARITY_ORDER: Record<TimeGranularity, number> = {
  year: 0,
  yearMonth: 1,
  yearMonthDay: 2,
};

/** The granularity a step by `unit` resolves to (年→year, 月→yearMonth, 日→yearMonthDay). */
const STEP_UNIT_GRANULARITY: Record<StepUnit, TimeGranularity> = {
  year: 'year',
  month: 'yearMonth',
  day: 'yearMonthDay',
};

/** Returns the coarser-or-equal vs finer granularity (the more specified one). */
function maxGranularity(a: TimeGranularity, b: TimeGranularity): TimeGranularity {
  return GRANULARITY_ORDER[a] >= GRANULARITY_ORDER[b] ? a : b;
}

/**
 * Builds a result TimePoint from a complete y/m/d, keeping only the fields the
 * resolved granularity makes meaningful (未指定 は値を捏造しない, 教訓 5.18).
 */
function atGranularity(c: CompleteTimePoint, granularity: TimeGranularity): TimePoint {
  switch (granularity) {
    case 'year':
      return timePointYear(c.year);
    case 'yearMonth':
      return timePointYearMonth(c.year, c.month);
    case 'yearMonthDay':
      return timePointYearMonthDay(c.year, c.month, c.day);
  }
}

/**
 * Advances `point` by exactly one `unit` in `direction`. Month/day that are
 * unspecified are completed to the calendar default first (1月1日) via U02's
 * single completion path so the arithmetic (month-end, year/BC boundary, leap
 * year) is always exact and routed through U02 — never recomputed in the UI.
 *
 * The RESULT granularity is `max(point.granularity, unit's granularity)`: a step
 * only pins down the fields its unit (and the input) actually make meaningful,
 * and never fabricates a finer field. This keeps a step's inverse identity at
 * the display level too (op∘逆op=恒等): stepping a year-granularity point by 年
 * forward then back returns to "0年", not "0年1月1日". The completed y/m/d is
 * still used INTERNALLY for the calendar arithmetic (完全値で計算, 教訓 5.16);
 * only the fields the granularity exposes are emitted (未指定 は捏造しない,
 * 教訓 5.18).
 *
 * - day:   add/subtract one day via U02 normalize/denormalize (handles month-
 *          end, year and BC boundaries, leap years exactly); result is y/m/d.
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
  const resultGranularity = maxGranularity(
    point.granularity,
    STEP_UNIT_GRANULARITY[unit],
  );

  if (unit === STEP_UNIT.Day) {
    const n = normalize(timePointYearMonthDay(c.year, c.month, c.day), calendar);
    const next = ((n as number) + direction) as Normalized;
    const d = denormalize(next, calendar);
    return atGranularity(d, resultGranularity);
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
    return atGranularity({ year: newYear, month: newMonth, day: newDay }, resultGranularity);
  }

  // unit === Year
  const newYear = c.year + direction;
  const maxDay = daysInMonth(calendar, newYear, c.month);
  const newDay = c.day > maxDay ? maxDay : c.day;
  return atGranularity({ year: newYear, month: c.month, day: newDay }, resultGranularity);
}
