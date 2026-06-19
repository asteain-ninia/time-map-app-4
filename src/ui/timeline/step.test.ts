// U21 pure-logic tests: step arithmetic (FR-68) — boundaries via U02.

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
} from '../../domain/time/time-point';
import { STEP_UNIT, stepTimePoint } from './step';

const cal = getCalendar('gregorian');

describe('stepTimePoint', () => {
  it('always returns a complete y/m/d value (完全値, 教訓 5.16)', () => {
    const r = stepTimePoint(timePointYear(100), STEP_UNIT.Year, 1, cal);
    expect(r.granularity).toBe('yearMonthDay');
  });

  it('completes 未指定 month/day to 1月1日 before stepping (教訓 5.18, not month||1)', () => {
    // year-only +1 day -> Jan 1 + 1 day = Jan 2
    expect(stepTimePoint(timePointYear(2000), STEP_UNIT.Day, 1, cal)).toEqual(
      timePointYearMonthDay(2000, 1, 2),
    );
  });

  it('day step crosses month-end via U02', () => {
    expect(
      stepTimePoint(timePointYearMonthDay(2001, 1, 31), STEP_UNIT.Day, 1, cal),
    ).toEqual(timePointYearMonthDay(2001, 2, 1));
  });

  it('day step crosses the year boundary', () => {
    expect(
      stepTimePoint(timePointYearMonthDay(2000, 12, 31), STEP_UNIT.Day, 1, cal),
    ).toEqual(timePointYearMonthDay(2001, 1, 1));
    expect(
      stepTimePoint(timePointYearMonthDay(2001, 1, 1), STEP_UNIT.Day, -1, cal),
    ).toEqual(timePointYearMonthDay(2000, 12, 31));
  });

  it('month step carries into the year and clamps the day to the new month', () => {
    // Jan 31 +1 month -> Feb: clamp to Feb 28 (2001 common year)
    expect(
      stepTimePoint(timePointYearMonthDay(2001, 1, 31), STEP_UNIT.Month, 1, cal),
    ).toEqual(timePointYearMonthDay(2001, 2, 28));
    // Dec +1 month -> next Jan
    expect(
      stepTimePoint(timePointYearMonth(2000, 12), STEP_UNIT.Month, 1, cal),
    ).toEqual(timePointYearMonthDay(2001, 1, 1));
  });

  it('year step on a leap day clamps Feb 29 -> Feb 28 in a common year', () => {
    expect(
      stepTimePoint(timePointYearMonthDay(2000, 2, 29), STEP_UNIT.Year, 1, cal),
    ).toEqual(timePointYearMonthDay(2001, 2, 28));
  });

  it('day step crosses the BC boundary (astronomical year 0)', () => {
    expect(
      stepTimePoint(timePointYearMonthDay(0, 1, 1), STEP_UNIT.Day, -1, cal),
    ).toEqual(timePointYearMonthDay(-1, 12, 31));
  });
});
