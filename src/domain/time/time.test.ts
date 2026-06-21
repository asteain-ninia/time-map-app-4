import { describe, expect, it } from 'vitest';

import {
  MAX_YEAR,
  compare,
  complete,
  completeEquals,
  daysInMonth,
  daysInYear,
  denormalize,
  duration,
  getCalendar,
  isWithin,
  monthsPerYear,
  normalize,
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  validate,
  type CompleteTimePoint,
} from './index';

const cal = getCalendar('gregorian');

describe('calendar (gregorian)', () => {
  it('has 12 months and standard lengths', () => {
    expect(monthsPerYear(cal)).toBe(12);
    expect(daysInMonth(cal, 2001, 1)).toBe(31);
    expect(daysInMonth(cal, 2001, 4)).toBe(30);
  });

  it('applies the leap-year rule (4 / 100 / 400)', () => {
    expect(daysInMonth(cal, 2000, 2)).toBe(29); // divisible by 400
    expect(daysInMonth(cal, 1900, 2)).toBe(28); // century, not by 400
    expect(daysInMonth(cal, 2004, 2)).toBe(29); // divisible by 4
    expect(daysInMonth(cal, 2003, 2)).toBe(28); // common year
    expect(daysInYear(cal, 2000)).toBe(366);
    expect(daysInYear(cal, 1900)).toBe(365);
  });

  it('applies the leap-year rule for negative (BC) years', () => {
    // Year 0 is divisible by 400 -> leap; year -4 divisible by 4 -> leap.
    expect(daysInYear(cal, 0)).toBe(366);
    expect(daysInMonth(cal, -4, 2)).toBe(29);
    expect(daysInMonth(cal, -1, 2)).toBe(28);
  });

  it('throws for an out-of-range month index', () => {
    expect(() => daysInMonth(cal, 2000, 13)).toThrow(RangeError);
  });
});

describe('round-trip (normalize -> denormalize === completed point)', () => {
  function roundTrips(point: ReturnType<typeof timePointYear>): CompleteTimePoint {
    return denormalize(normalize(point, cal), cal);
  }

  it('round-trips an AD year/month/day', () => {
    const p = timePointYearMonthDay(2023, 7, 15);
    expect(completeEquals(roundTrips(p), complete(p))).toBe(true);
  });

  it('round-trips a BC (negative) year', () => {
    const p = timePointYearMonthDay(-44, 3, 15);
    expect(completeEquals(roundTrips(p), complete(p))).toBe(true);
  });

  it('round-trips year 0 (astronomical convention)', () => {
    const p = timePointYearMonthDay(0, 12, 31);
    expect(completeEquals(roundTrips(p), complete(p))).toBe(true);
  });

  it('round-trips a leap day (Feb 29) in a leap year', () => {
    const p = timePointYearMonthDay(2000, 2, 29);
    const back = roundTrips(p);
    expect(back).toEqual({ year: 2000, month: 2, day: 29 });
  });

  it('completes unspecified month/day to Jan 1 and round-trips the completed value', () => {
    const yearOnly = timePointYear(1995);
    expect(complete(yearOnly)).toEqual({ year: 1995, month: 1, day: 1 });
    expect(denormalize(normalize(yearOnly, cal), cal)).toEqual({
      year: 1995,
      month: 1,
      day: 1,
    });

    const ym = timePointYearMonth(1995, 6);
    expect(complete(ym)).toEqual({ year: 1995, month: 6, day: 1 });
    expect(denormalize(normalize(ym, cal), cal)).toEqual({ year: 1995, month: 6, day: 1 });
  });
});

describe('validate', () => {
  it('accepts a valid full date', () => {
    expect(validate(timePointYearMonthDay(2020, 2, 29), cal)).toEqual({ ok: true });
  });

  it('rejects Feb 29 in a common year', () => {
    expect(validate(timePointYearMonthDay(2019, 2, 29), cal)).toEqual({
      ok: false,
      error: 'day-out-of-range',
    });
  });

  it('rejects an out-of-range month', () => {
    expect(validate(timePointYearMonth(2020, 13), cal)).toEqual({
      ok: false,
      error: 'month-out-of-range',
    });
    expect(validate(timePointYearMonth(2020, 0), cal)).toEqual({
      ok: false,
      error: 'month-out-of-range',
    });
  });

  it('rejects day 0 and an over-long day', () => {
    expect(validate(timePointYearMonthDay(2020, 4, 0), cal)).toEqual({
      ok: false,
      error: 'day-out-of-range',
    });
    expect(validate(timePointYearMonthDay(2020, 4, 31), cal)).toEqual({
      ok: false,
      error: 'day-out-of-range',
    });
  });

  it('rejects non-integer components', () => {
    expect(validate(timePointYear(2020.5), cal)).toEqual({
      ok: false,
      error: 'year-not-integer',
    });
    expect(validate(timePointYearMonth(2020, 1.5), cal)).toEqual({
      ok: false,
      error: 'month-not-integer',
    });
    expect(validate(timePointYearMonthDay(2020, 1, 1.5), cal)).toEqual({
      ok: false,
      error: 'day-not-integer',
    });
  });

  // Regression (bug-hunt): an unbounded year was accepted by validate (it only
  // checked Number.isInteger). A huge year then made the normalized day-count
  // overflow Number.MAX_SAFE_INTEGER — distinct days collapsed to one value
  // (breaking compare/duration exactness, FR-70/72) and turned the year-by-year
  // denormalize walk into an effectively-infinite hang. validate is the single
  // truth source the persistence schema routes through, so the bound lives here.
  describe('rejects an out-of-range (unbounded) year', () => {
    it('rejects a year beyond ±MAX_YEAR for every granularity', () => {
      const tooBig = MAX_YEAR + 1;
      const tooSmall = -(MAX_YEAR + 1);
      expect(validate(timePointYear(tooBig), cal)).toEqual({
        ok: false,
        error: 'year-out-of-range',
      });
      expect(validate(timePointYear(tooSmall), cal)).toEqual({
        ok: false,
        error: 'year-out-of-range',
      });
      // The huge year that triggered the original precision collapse.
      expect(validate(timePointYearMonthDay(1e20, 1, 1), cal)).toEqual({
        ok: false,
        error: 'year-out-of-range',
      });
      expect(validate(timePointYearMonth(tooBig, 6), cal)).toEqual({
        ok: false,
        error: 'year-out-of-range',
      });
    });

    it('accepts the year exactly at the ±MAX_YEAR boundary', () => {
      expect(validate(timePointYear(MAX_YEAR), cal)).toEqual({ ok: true });
      expect(validate(timePointYear(-MAX_YEAR), cal)).toEqual({ ok: true });
    });

    it('keeps the normalized day-count exact and below MAX_SAFE_INTEGER at the bound', () => {
      // At the bound, normalize must still be an exact safe integer, so two
      // distinct days in the same boundary year map to DISTINCT values and the
      // denormalize round-trip is exact (no precision collapse, no hang).
      const dayA = timePointYearMonthDay(MAX_YEAR, 1, 1);
      const dayB = timePointYearMonthDay(MAX_YEAR, 1, 2);
      const nA = normalize(dayA, cal);
      const nB = normalize(dayB, cal);
      expect(Number.isSafeInteger(nA as number)).toBe(true);
      expect(Number.isSafeInteger(nB as number)).toBe(true);
      expect(nA).not.toBe(nB);
      expect(duration(dayA, dayB, cal)).toBe(1);
      expect(compare(dayA, dayB, cal)).toBe(-1);
      expect(denormalize(nA, cal)).toEqual({ year: MAX_YEAR, month: 1, day: 1 });
      expect(denormalize(nB, cal)).toEqual({ year: MAX_YEAR, month: 1, day: 2 });
    });
  });

  it('accepts year 0 / month 0-as-unspecified without false default firing (教訓 5.18)', () => {
    // year 0 is a valid year, not a falsy default.
    expect(validate(timePointYear(0), cal)).toEqual({ ok: true });
    // A year-only point never checks month/day, so "0-like" never sneaks in.
    expect(complete(timePointYear(0))).toEqual({ year: 0, month: 1, day: 1 });
  });
});

describe('compare', () => {
  it('returns three-valued ordering', () => {
    expect(compare(timePointYear(1000), timePointYear(2000), cal)).toBe(-1);
    expect(compare(timePointYear(2000), timePointYear(1000), cal)).toBe(1);
    expect(compare(timePointYear(2000), timePointYear(2000), cal)).toBe(0);
  });

  it('treats equal completed points as simultaneous (0)', () => {
    // year-only and explicit Jan 1 complete to the same instant.
    expect(compare(timePointYear(2000), timePointYearMonthDay(2000, 1, 1), cal)).toBe(0);
  });

  it('orders BC before AD', () => {
    expect(compare(timePointYear(-100), timePointYear(100), cal)).toBe(-1);
    expect(compare(timePointYear(-1), timePointYear(0), cal)).toBe(-1);
  });
});

describe('duration (days, single base unit)', () => {
  it('is one day across a month boundary', () => {
    expect(
      duration(timePointYearMonthDay(2021, 1, 31), timePointYearMonthDay(2021, 2, 1), cal),
    ).toBe(1);
  });

  it('counts a full common year and leap year correctly', () => {
    expect(duration(timePointYear(2001), timePointYear(2002), cal)).toBe(365);
    expect(duration(timePointYear(2000), timePointYear(2001), cal)).toBe(366);
  });

  it('spans the BC -> AD boundary', () => {
    // From 1 BC (year 0) Jan 1 to AD 1 (year 1) Jan 1 is the length of year 0.
    expect(duration(timePointYear(0), timePointYear(1), cal)).toBe(daysInYear(cal, 0));
  });

  it('is negative when the target precedes the source and 0 when equal', () => {
    expect(duration(timePointYear(2002), timePointYear(2001), cal)).toBe(-365);
    expect(duration(timePointYear(2000), timePointYear(2000), cal)).toBe(0);
  });

  it('agrees with compare (single source of truth)', () => {
    const a = timePointYearMonthDay(-50, 6, 1);
    const b = timePointYearMonthDay(50, 6, 1);
    expect(duration(a, b, cal)).toBeGreaterThan(0);
    expect(compare(a, b, cal)).toBe(-1);
  });
});

describe('isWithin (half-open interval [start, end))', () => {
  const start = timePointYearMonthDay(2000, 1, 1);
  const end = timePointYearMonthDay(2010, 1, 1);

  it('includes the start boundary', () => {
    expect(isWithin(start, start, end, cal)).toBe(true);
  });

  it('excludes the end boundary', () => {
    expect(isWithin(end, start, end, cal)).toBe(false);
  });

  it('includes an interior point and excludes points before start / after end', () => {
    expect(isWithin(timePointYear(2005), start, end, cal)).toBe(true);
    expect(isWithin(timePointYear(1999), start, end, cal)).toBe(false);
    expect(isWithin(timePointYear(2011), start, end, cal)).toBe(false);
  });

  it('treats a null end as an open-ended (indefinite) interval', () => {
    expect(isWithin(timePointYear(9999), start, null, cal)).toBe(true);
    expect(isWithin(start, start, null, cal)).toBe(true);
    expect(isWithin(timePointYear(1999), start, null, cal)).toBe(false);
  });
});
