// U21 pure-logic tests: playback speed conversion (no double scaling) + advance
// auto-stop (FR-69 / 教訓 5.16 / 受け入れ基準 5).

import { describe, expect, it } from 'vitest';

import { getCalendar, daysInYear } from '../../domain/time/calendar';
import { normalize } from '../../domain/time/normalized';
import { timePointYear, timePointYearMonthDay } from '../../domain/time/time-point';
import {
  INITIAL_PLAYBACK_ACCUMULATOR,
  PLAYBACK_SPEEDS,
  TICKS_PER_SECOND,
  advancePlayback,
  daysPerSecond,
  daysPerTick,
} from './playback';

const cal = getCalendar('gregorian');

describe('speed -> days conversion (single multiplier application)', () => {
  it('1 倍 = 1 年/秒 (daysInYear days per real second)', () => {
    const year = 2001; // common year (365)
    expect(daysPerSecond(1, year, cal)).toBeCloseTo(daysInYear(cal, year), 9);
  });

  it('每个倍率: days/sec == speed * daysInYear (二重適用なし)', () => {
    const year = 2001;
    for (const speed of PLAYBACK_SPEEDS) {
      expect(daysPerSecond(speed, year, cal)).toBeCloseTo(
        speed * daysInYear(cal, year),
        9,
      );
    }
  });

  it('the multiplier is applied to the increment, not the interval', () => {
    // days/tick * ticks/sec must equal a single application of speed.
    const year = 2001;
    const speed = 5;
    expect(daysPerTick(speed, year, cal) * TICKS_PER_SECOND).toBeCloseTo(
      daysPerSecond(speed, year, cal),
      9,
    );
  });
});

describe('advancePlayback', () => {
  it('returns a complete y/m/d value and carries fractional days', () => {
    const r = advancePlayback(
      timePointYear(0),
      0.1, // slow: < 1 whole day per tick
      1,
      timePointYear(0),
      timePointYear(10000),
      INITIAL_PLAYBACK_ACCUMULATOR,
      cal,
    );
    expect(r.time.granularity).toBe('yearMonthDay');
    // 0.1 倍 over a single 100ms tick is well below 1 whole day, so it carries.
    expect(r.accumulator.fractionalDays).toBeGreaterThan(0);
    expect(r.reachedEnd).toBe(false);
  });

  it('accumulates fractional days into whole-day progress over many ticks', () => {
    let time = timePointYear(0);
    let acc = INITIAL_PLAYBACK_ACCUMULATOR;
    const start = normalize(time, cal);
    for (let i = 0; i < TICKS_PER_SECOND; i++) {
      const r = advancePlayback(time, 1, 1, timePointYear(0), timePointYear(10000), acc, cal);
      time = r.time;
      acc = r.accumulator;
    }
    // After ~1 second at 1 倍 we advanced about a year's worth of days.
    const advanced = (normalize(time, cal) as number) - (start as number);
    expect(advanced).toBeGreaterThanOrEqual(daysInYear(cal, 0) - 1);
  });

  it('auto-stops at the range end and clamps to it (端で自動停止)', () => {
    const r = advancePlayback(
      timePointYearMonthDay(10000, 1, 1),
      10,
      1,
      timePointYear(0),
      timePointYear(10000),
      INITIAL_PLAYBACK_ACCUMULATOR,
      cal,
    );
    expect(r.reachedEnd).toBe(true);
    expect(normalize(r.time, cal)).toBe(normalize(timePointYear(10000), cal));
    expect(r.accumulator.fractionalDays).toBe(0);
  });

  it('backward playback stops at the min bound', () => {
    const r = advancePlayback(
      timePointYearMonthDay(0, 1, 1),
      10,
      -1,
      timePointYear(0),
      timePointYear(10000),
      INITIAL_PLAYBACK_ACCUMULATOR,
      cal,
    );
    expect(r.reachedEnd).toBe(true);
    expect(normalize(r.time, cal)).toBe(normalize(timePointYear(0), cal));
  });
});
