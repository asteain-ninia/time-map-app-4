// U21 pure-logic tests: BC display, range<->slider mapping, ticks, clamp.
//
// These run in the node Vitest environment (no DOM); they exercise the
// framework-free helpers the timeline components rely on (spec テスト: 純粋に切
// り出したロジックの Vitest 単体テスト). 暦計算は U02 経由であることも確認する。

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { normalize } from '../../domain/time/normalized';
import {
  timePointYear,
  timePointYearMonthDay,
} from '../../domain/time/time-point';
import {
  chooseYearTickInterval,
  clampToRange,
  formatTimePoint,
  formatYear,
  fractionToTime,
  fromYearLabel,
  generateTicks,
  timeToFraction,
  toNormalizedRange,
  toYearLabel,
} from './time-display';

const cal = getCalendar('gregorian');

describe('紀元前 (BC) display', () => {
  it('formats negative years as 紀元前 and round-trips through the label', () => {
    expect(formatYear(-100)).toBe('紀元前100年');
    expect(formatYear(100)).toBe('100年');
    expect(formatYear(0)).toBe('0年');
    for (const y of [-2024, -1, 0, 1, 2024]) {
      expect(fromYearLabel(toYearLabel(y))).toBe(y);
    }
  });

  it('formats a TimePoint honoring granularity (未指定 omitted)', () => {
    expect(formatTimePoint(timePointYear(-44))).toBe('紀元前44年');
    expect(formatTimePoint(timePointYearMonthDay(2026, 6, 20))).toBe('2026年6月20日');
  });
});

describe('range <-> slider fraction mapping', () => {
  const range = toNormalizedRange(timePointYear(0), timePointYear(10000), cal);

  it('maps the bounds to 0 and 1 and the midpoint near 0.5', () => {
    expect(timeToFraction(timePointYear(0), range, cal)).toBe(0);
    expect(timeToFraction(timePointYear(10000), range, cal)).toBe(1);
    expect(timeToFraction(timePointYear(5000), range, cal)).toBeCloseTo(0.5, 2);
  });

  it('clamps out-of-range current time to [0, 1]', () => {
    expect(timeToFraction(timePointYear(-100), range, cal)).toBe(0);
    expect(timeToFraction(timePointYear(20000), range, cal)).toBe(1);
  });

  it('fractionToTime returns a COMPLETE y/m/d point (no fractional year, FR-70)', () => {
    const point = fractionToTime(0.5, range, cal);
    expect(point.granularity).toBe('yearMonthDay');
    expect(Number.isInteger(point.year)).toBe(true);
  });

  it('fraction round-trips to a value within the range', () => {
    const point = fractionToTime(0.25, range, cal);
    const n = normalize(point, cal);
    expect(n).toBeGreaterThanOrEqual(normalize(timePointYear(0), cal));
    expect(n).toBeLessThanOrEqual(normalize(timePointYear(10000), cal));
  });
});

describe('tick interval selection', () => {
  it('chooses a nice 1/2/5 ladder interval and never below 1 year', () => {
    expect(chooseYearTickInterval(10000, 10)).toBeGreaterThanOrEqual(1);
    expect(chooseYearTickInterval(100, 10)).toBe(10);
    expect(chooseYearTickInterval(5, 10)).toBe(1);
  });

  it('generates aligned ticks within the range', () => {
    const ticks = generateTicks(0, 1000, cal, 10);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.fraction).toBeGreaterThanOrEqual(0);
      expect(t.fraction).toBeLessThanOrEqual(1);
    }
    // aligned to a round interval
    expect(ticks[0]!.year % (ticks[1]!.year - ticks[0]!.year)).toBe(0);
  });
});

describe('clampToRange (U02 比較のみ)', () => {
  it('clamps below min and above max, passes through in-range values', () => {
    const min = timePointYear(0);
    const max = timePointYear(100);
    expect(clampToRange(timePointYear(-50), min, max, cal)).toEqual(
      timePointYearMonthDay(0, 1, 1),
    );
    expect(clampToRange(timePointYear(200), min, max, cal)).toEqual(
      timePointYearMonthDay(100, 1, 1),
    );
    const inside = timePointYearMonthDay(50, 6, 15);
    expect(clampToRange(inside, min, max, cal)).toEqual(inside);
  });
});
