// Domain layer (time): calendar configuration.
//
// All time calculations (normalize / denormalize / compare / duration /
// isWithin / validate) take a Calendar as an argument. Calendar constants
// (days-per-year, per-month day counts, leap-year rule) are NEVER hardcoded
// inside the calculation functions. This is the seam for future custom
// calendars (要件 7.1); the initial implementation provides only Gregorian.
//
// 教訓 5.19: calendar selection goes through a typed factory / constant, not
// stringly-typed branching.

/**
 * Identifies a calendar system. Extended (not freely widened) as future
 * custom calendars are added. Branch on this via the factory, never on a
 * bare string literal.
 */
export type CalendarId = 'gregorian';

/**
 * A calendar configuration. Holds the month-length table and leap-year rule.
 * The base unit of the normalized representation is exactly one day.
 *
 * Year 0 convention: this module uses an ASTRONOMICAL continuous year count
 * where year 0 exists and negative years are years before it. UI-level BC/AD
 * labeling (negative-year display transform) is a separate unit's concern.
 * Every function in this module obeys this single convention.
 */
export interface Calendar {
  readonly id: CalendarId;
  /**
   * Day counts for each month of a COMMON (non-leap) year, in order.
   * Length defines the number of months in a year.
   */
  readonly commonMonthDays: readonly number[];
  /** Returns true when {@link year} is a leap year under this calendar. */
  readonly isLeapYear: (year: number) => boolean;
  /** Extra day(s) added in a leap year and the 1-based month they belong to. */
  readonly leapMonthIndex: number; // 1-based month that gains a day in leap years
}

function gregorianIsLeapYear(year: number): boolean {
  // Standard Gregorian rule: divisible by 4, except centuries unless by 400.
  // Works for negative (astronomical) years because the modulo of a multiple
  // is 0 regardless of sign.
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

const GREGORIAN: Calendar = {
  id: 'gregorian',
  commonMonthDays: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  isLeapYear: gregorianIsLeapYear,
  leapMonthIndex: 2, // February gains the 29th
};

const CALENDARS: Readonly<Record<CalendarId, Calendar>> = {
  gregorian: GREGORIAN,
};

/**
 * Returns the calendar configuration for the given id. Use this factory rather
 * than referencing calendar constants by string literal at call sites.
 */
export function getCalendar(id: CalendarId): Calendar {
  return CALENDARS[id];
}

/** Number of months in a year for the given calendar. */
export function monthsPerYear(calendar: Calendar): number {
  return calendar.commonMonthDays.length;
}

/**
 * Number of days in the given 1-based month of the given year, accounting for
 * leap years. Caller MUST pass an in-range month (1..monthsPerYear); range is
 * checked by {@link validate} before normalization/denormalization.
 */
export function daysInMonth(calendar: Calendar, year: number, month: number): number {
  // month is 1-based; guard satisfies noUncheckedIndexedAccess.
  const base = calendar.commonMonthDays[month - 1];
  if (base === undefined) {
    throw new RangeError(`month ${month} is out of range for calendar ${calendar.id}`);
  }
  if (month === calendar.leapMonthIndex && calendar.isLeapYear(year)) {
    return base + 1;
  }
  return base;
}

/** Number of days in the given year, accounting for leap years. */
export function daysInYear(calendar: Calendar, year: number): number {
  const common = calendar.commonMonthDays.reduce((sum, d) => sum + d, 0);
  return calendar.isLeapYear(year) ? common + 1 : common;
}
