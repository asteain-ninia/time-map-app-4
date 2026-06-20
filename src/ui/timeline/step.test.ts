// U21 pure-logic tests: step arithmetic (FR-68) — boundaries via U02.

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { normalize } from '../../domain/time/normalized';
import {
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';
import { STEP_UNIT, stepTimePoint } from './step';

const cal = getCalendar('gregorian');

describe('stepTimePoint', () => {
  it('keeps the result granularity at max(input, unit) — a 年 step on a year point stays year-granularity (op∘逆op=恒等 at display level)', () => {
    const r = stepTimePoint(timePointYear(100), STEP_UNIT.Year, 1, cal);
    expect(r).toEqual(timePointYear(101));
    expect(r.granularity).toBe('year');
  });

  it('a 月 step on a year+month point stays yearMonth-granularity (no fabricated day)', () => {
    const r = stepTimePoint(timePointYearMonth(2000, 1), STEP_UNIT.Month, 1, cal);
    expect(r).toEqual(timePointYearMonth(2000, 2));
    expect(r.granularity).toBe('yearMonth');
  });

  it('a 日 step always pins down a day (year point + 日 -> yearMonthDay)', () => {
    const r = stepTimePoint(timePointYear(100), STEP_UNIT.Day, 1, cal);
    expect(r.granularity).toBe('yearMonthDay');
  });

  it('a coarser step never drops finer fields the input already had (ymd + 年 stays ymd)', () => {
    const r = stepTimePoint(timePointYearMonthDay(100, 3, 15), STEP_UNIT.Year, 1, cal);
    expect(r).toEqual(timePointYearMonthDay(101, 3, 15));
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
    // Dec +1 month -> next Jan (day stays unspecified: yearMonth in, yearMonth out)
    expect(
      stepTimePoint(timePointYearMonth(2000, 12), STEP_UNIT.Month, 1, cal),
    ).toEqual(timePointYearMonth(2001, 1));
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

describe('stepTimePoint round-trip identity (BUGHUNT:time-roundtrip)', () => {
  // Regression for: "0年" rendering as "0年1月1日" after forward+back. The
  // metamorphic invariant step(unit,-1) ∘ step(unit,+1) = identity must hold at
  // the DISPLAY/granularity level (formatTimePoint), not only at the normalized
  // instant — i.e. the returned TimePoint must be structurally unchanged.
  //
  // Identity holds whenever the input is already at least as fine as the step
  // unit (so the step pins down no NEW field and cannot promote granularity).
  // The timeline's initial unit is 年 on a year-only currentTime, which is the
  // exact case the bughunt repro exercises. (A 月/日 step on a coarser point
  // legitimately introduces that field; identity there is the normalized
  // instant, covered separately below.)
  const granularityRank: Record<TimePoint['granularity'], number> = {
    year: 0,
    yearMonth: 1,
    yearMonthDay: 2,
  };
  const unitRank: Record<(typeof STEP_UNIT)[keyof typeof STEP_UNIT], number> = {
    year: 0,
    month: 1,
    day: 2,
  };
  const points: ReadonlyArray<readonly [string, TimePoint]> = [
    ['year 0 (initial currentTime)', timePointYear(0)],
    ['year-only', timePointYear(2024)],
    ['year-only BC', timePointYear(-44)],
    ['yearMonth', timePointYearMonth(2024, 6)],
    ['yearMonthDay', timePointYearMonthDay(2024, 6, 20)],
  ];

  for (const [label, point] of points) {
    for (const unit of [STEP_UNIT.Year, STEP_UNIT.Month, STEP_UNIT.Day] as const) {
      const noPromotion = granularityRank[point.granularity] >= unitRank[unit];
      const tag = noPromotion ? 'structural identity' : 'instant identity (granularity may rise)';
      it(`forward then back is ${tag} for ${label} stepping by ${unit}`, () => {
        const forward = stepTimePoint(point, unit, 1, cal);
        const back = stepTimePoint(forward, unit, -1, cal);
        if (noPromotion) {
          // Same granularity AND same fields -> identical display string/snapshot.
          // This is the regression case: a 年 step on a year point used to come
          // back as yearMonthDay ("0年1月1日"); it must stay year ("0年").
          expect(back).toEqual(point);
          expect(back.granularity).toBe(point.granularity);
        } else {
          // The step necessarily introduced a finer field; identity is preserved
          // at the normalized instant, and the granularity is exactly the unit's.
          expect(normalize(back, cal)).toBe(normalize(point, cal));
          expect(back.granularity).toBe(unit === STEP_UNIT.Month ? 'yearMonth' : 'yearMonthDay');
        }
      });
    }
  }
});
