// UI layer (U21 / timeline): pure playback (再生) conversion + advance.
//
// FR-69: 再生 advances 作中時間 (current time) on a fixed-interval timer. The
// speed selector (0.1/0.5/1/2/5/10 倍, 1 倍 = 1 年/秒) is converted to a
// per-tick day increment HERE — in ONE place — using U02's days-in-year. The
// timer interval is FIXED; the multiplier is applied ONLY to the day increment
// (教訓 5.16: 速度倍率を間隔と進行量の両方へ掛けない / 二重適用防止). Tests
// assert that the conversion equals a single multiplier application (受け入れ
// 基準 5).
//
// 作中時間のみを進める (教訓 5.15): the real-time timer drives ticks, but the
// progression is computed against the current time, never against Date.now().

import { daysInYear, type Calendar } from '../../domain/time/calendar';
import {
  compareNormalized,
  denormalize,
  normalize,
  type Normalized,
} from '../../domain/time/normalized';
import {
  complete,
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';

/** Selectable playback speeds (倍率). 1 倍 = 1 年/秒 (FR-69). */
export const PLAYBACK_SPEEDS = [0.1, 0.5, 1, 2, 5, 10] as const;

export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * The FIXED timer interval, in milliseconds. Speed is NOT applied here — only to
 * the per-tick day increment (教訓 5.16). 10 ticks/sec gives smooth motion
 * while keeping the per-tick increment integral for normal speeds.
 */
export const PLAYBACK_TICK_MS = 100;

/** Ticks per real-time second derived from the fixed interval. */
export const TICKS_PER_SECOND = 1000 / PLAYBACK_TICK_MS;

/**
 * Converts a speed multiplier to the number of days to advance PER TICK,
 * reckoned for the given year (days-in-year comes from U02, never hardcoded).
 *
 * Derivation (single multiplier application, no double scaling):
 *   1 倍 = 1 年/秒 = daysInYear days/sec.
 *   days/sec  = speed * daysInYear
 *   days/tick = (speed * daysInYear) / TICKS_PER_SECOND
 *
 * The interval is fixed (PLAYBACK_TICK_MS), so `speed` multiplies exactly one
 * quantity. The result is a real number; callers accumulate the fractional part
 * (see {@link advancePlayback}) so slow speeds (0.1) still progress and never
 * round to zero.
 */
export function daysPerTick(speed: number, year: number, calendar: Calendar): number {
  return (speed * daysInYear(calendar, year)) / TICKS_PER_SECOND;
}

/**
 * Days advanced over a whole real-time second at the given speed. Used by tests
 * to assert "1 秒あたり進行量 == speed * daysInYear" (定義どおり, 二重適用なし).
 */
export function daysPerSecond(speed: number, year: number, calendar: Calendar): number {
  return daysPerTick(speed, year, calendar) * TICKS_PER_SECOND;
}

/** The accumulator carried across ticks so fractional day increments are not lost. */
export interface PlaybackAccumulator {
  /** Sub-day remainder carried from the previous tick (always in [0, 1)). */
  readonly fractionalDays: number;
}

export const INITIAL_PLAYBACK_ACCUMULATOR: PlaybackAccumulator = { fractionalDays: 0 };

/** The outcome of advancing playback by one tick. */
export interface PlaybackAdvance {
  /** The new current time (a complete y/m/d value, 完全値). */
  readonly time: TimePoint;
  /** The carried accumulator for the next tick. */
  readonly accumulator: PlaybackAccumulator;
  /**
   * True when the advance reached or passed the range end and playback must
   * auto-stop (FR-69 端で自動停止). The returned `time` is clamped to the end.
   */
  readonly reachedEnd: boolean;
}

/**
 * Advances the current time by one playback tick. The day increment is computed
 * from the speed via {@link daysPerTick} for the current year. Fractional days
 * accumulate so slow speeds progress; whole days are applied through U02
 * normalize/denormalize (so month/year/leap/BC boundaries are exact). Stops at
 * the range end using U02 comparison (教訓 5.8: 開始で立てた状態は停止で必ず落
 * とす — the caller clears the playing flag on reachedEnd).
 *
 * `direction` is +1 forward / -1 backward; backward stops at `min` instead.
 */
export function advancePlayback(
  current: TimePoint,
  speed: number,
  direction: 1 | -1,
  min: TimePoint,
  max: TimePoint,
  accumulator: PlaybackAccumulator,
  calendar: Calendar,
): PlaybackAdvance {
  const c = complete(current);
  const total = accumulator.fractionalDays + daysPerTick(speed, c.year, calendar);
  const wholeDays = Math.floor(total);
  const carry = total - wholeDays;

  const currentN = normalize(timePointYearMonthDay(c.year, c.month, c.day), calendar);
  const candidateN = ((currentN as number) + direction * wholeDays) as Normalized;

  const bound = normalize(direction > 0 ? max : min, calendar);
  const cmp = compareNormalized(candidateN, bound);
  const passedEnd = direction > 0 ? cmp >= 0 : cmp <= 0;

  const resultN = passedEnd ? bound : candidateN;
  const d = denormalize(resultN, calendar);
  return {
    time: timePointYearMonthDay(d.year, d.month, d.day),
    accumulator: { fractionalDays: passedEnd ? 0 : carry },
    reachedEnd: passedEnd,
  };
}
