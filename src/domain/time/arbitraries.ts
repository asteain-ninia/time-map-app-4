// Domain layer (time): shared fast-check generators (技術方針 R7).
//
// Defined ONCE here and reused by every property test, so the boundary cases
// (negative/BC years, leap years, anchor boundaries, unspecified granularity)
// are generated consistently. Generators build TimePoints through the real
// construction helpers (教訓 5.39: fixtures go through entity factories, not
// bare literals), and only ever yield calendar-valid points.
//
// This file imports fast-check, which is a devDependency. It lives under
// src/domain only so the generators can sit next to the model they validate;
// it is consumed exclusively by *.test.ts files and never by production code.

import fc from 'fast-check';

import { daysInMonth, monthsPerYear, type Calendar, getCalendar } from './calendar';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimePoint,
} from './time-point';

/** The set of calendars under test. Currently only Gregorian. */
export function calendarArb(): fc.Arbitrary<Calendar> {
  return fc.constantFrom(getCalendar('gregorian'));
}

/**
 * Years spanning BC (negative), the year-0 boundary, and AD. The range is
 * kept moderate so the linear epoch walk in normalize/denormalize stays cheap
 * while still exercising leap-year boundaries and the 0 crossover.
 */
export function yearArb(): fc.Arbitrary<number> {
  return fc.integer({ min: -800, max: 2400 });
}

/**
 * A calendar-valid TimePoint of arbitrary granularity (year / yearMonth /
 * yearMonthDay). Month/day are chosen within range for the resolved year, so
 * leap days only appear in leap years. Built via the construction helpers.
 */
export function timePointArb(calendar: Calendar): fc.Arbitrary<TimePoint> {
  const months = monthsPerYear(calendar);
  return yearArb().chain((year) =>
    fc.oneof(
      fc.constant(timePointYear(year)),
      fc
        .integer({ min: 1, max: months })
        .map((month) => timePointYearMonth(year, month)),
      fc.integer({ min: 1, max: months }).chain((month) =>
        fc
          .integer({ min: 1, max: daysInMonth(calendar, year, month) })
          .map((day) => timePointYearMonthDay(year, month, day)),
      ),
    ),
  );
}

/** A pair of calendar-valid TimePoints sharing one calendar. */
export function timePointPairArb(
  calendar: Calendar,
): fc.Arbitrary<readonly [TimePoint, TimePoint]> {
  return fc.tuple(timePointArb(calendar), timePointArb(calendar));
}

/**
 * Three calendar-valid TimePoints for transitivity-style properties.
 */
export function timePointTripleArb(
  calendar: Calendar,
): fc.Arbitrary<readonly [TimePoint, TimePoint, TimePoint]> {
  return fc.tuple(
    timePointArb(calendar),
    timePointArb(calendar),
    timePointArb(calendar),
  );
}
