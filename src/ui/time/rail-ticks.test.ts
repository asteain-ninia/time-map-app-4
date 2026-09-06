// レールの目盛り（設計書 §C.7 の (c)）を固定する。
//
// **目盛りと錨の印は同じ写像で置く**（`dayToPixel`）。既存の `generateTicks` は
// 「範囲の年から年まで」を割り付ける形なので、レールを拡大して端が年の途中になると
// ずれる ―― 同じ軸の上に 2 つの写像が並ぶのを防ぐのがこの module の役目である。

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { normalize } from '../../domain/time/normalized';
import { timePointYear } from '../../domain/time/time-point';

import { dayToPixel } from './anchor-lane';
import { DAYS_PER_YEAR, railTicks, viewSpanYears } from './rail-ticks';
import { viewFromTimePoints } from './timebar';

const calendar = getCalendar('gregorian');

function view(minYear: number, maxYear: number, px: number) {
  return viewFromTimePoints(timePointYear(minYear), timePointYear(maxYear), px, calendar);
}

describe('railTicks', () => {
  it('目盛りは軸の中に収まり、年は刻みの倍数になる', () => {
    const v = view(0, 10000, 1000);
    const ticks = railTicks(v, calendar, 10);
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.px).toBeGreaterThanOrEqual(-1);
      expect(t.px).toBeLessThanOrEqual(1001);
    }
    const interval = (ticks[1]?.year ?? 0) - (ticks[0]?.year ?? 0);
    expect(interval).toBeGreaterThan(0);
    for (const t of ticks) expect(t.year % interval).toBe(0);
  });

  it('**位置は錨の印とまったく同じ写像で出す**（拡大してもずれない）', () => {
    const v = view(1234, 1240, 600);
    for (const t of railTicks(v, calendar, 6)) {
      const expected = dayToPixel(normalize(timePointYear(t.year), calendar) as number, v);
      expect(t.px).toBeCloseTo(expected, 6);
    }
  });

  it('幅の無い表示範囲では目盛りを打たない', () => {
    expect(railTicks(view(0, 10000, 0), calendar, 10)).toEqual([]);
    expect(railTicks(view(500, 500, 100), calendar, 10)).toEqual([]);
  });
});

describe('viewSpanYears', () => {
  it('表示範囲の年の幅を返す（読み取り行の「◯年ぶん」の元）', () => {
    expect(viewSpanYears(view(0, 10000, 1000))).toBeCloseTo(10000, 0);
    expect(DAYS_PER_YEAR).toBeCloseTo(365.2425, 4);
  });
});
