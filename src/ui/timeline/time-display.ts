// UI layer (U21 / timeline): pure display + mapping helpers.
//
// These are the framework-free, side-effect-free calculations the timeline UI
// relies on. They are extracted as pure functions so they can be unit-tested in
// the node Vitest environment without a DOM (spec テスト: 純粋に切り出したロジ
// ックを Vitest 単体テスト). React components call these; the functions never
// touch React, Zustand, Canvas, or the system clock (教訓 5.15).
//
// 暦法定数 (各月の日数・うるう年規則・年間日数・既定補完・年 0 規約) は U02 の
// 単一の真実源にあり、ここでは UI 側で再実装しない (受け入れ基準 6)。年→日数
// や正規化が要る箇所はすべて U02 の関数を経由する。

import type { Calendar } from '../../domain/time/calendar';
import {
  compareNormalized,
  denormalize,
  normalize,
  type Normalized,
} from '../../domain/time/normalized';
import {
  complete,
  timePointYearMonthDay,
  type CompleteTimePoint,
  type TimePoint,
} from '../../domain/time/time-point';

// --- 紀元前 (BC) display convention -----------------------------------------
//
// U02 uses an astronomical continuous year count where year 0 exists and
// negative years are years before it (calendar.ts). The UI converts a negative
// year into a "紀元前" label here, in ONE place, so display and input
// interpretation share the same convention (注意点: 紀元前表示の規約を一箇所に
// 集約). Convention chosen: year y < 0 displays as 紀元前 (-y) 年, year y >= 0
// displays as y 年 (year 0 displayed as "0 年" under the astronomical count —
// kept explicit so the round-trip with parseYearLabel is total).

export interface YearLabel {
  /** True when the year is before the epoch (negative astronomical year). */
  readonly isBce: boolean;
  /** The magnitude shown to the user (always non-negative). */
  readonly magnitude: number;
}

/** Converts an astronomical year to its display decomposition (sign + magnitude). */
export function toYearLabel(year: number): YearLabel {
  if (year < 0) {
    return { isBce: true, magnitude: -year };
  }
  return { isBce: false, magnitude: year };
}

/** Renders an astronomical year as a Japanese label (紀元前 N 年 / N 年). */
export function formatYear(year: number): string {
  const label = toYearLabel(year);
  return label.isBce ? `紀元前${label.magnitude}年` : `${label.magnitude}年`;
}

/**
 * Inverse of {@link toYearLabel}: rebuilds the astronomical year from a display
 * decomposition. Lives next to toYearLabel so display and input interpretation
 * provably share one convention (round-trip tested).
 */
export function fromYearLabel(label: YearLabel): number {
  return label.isBce ? -label.magnitude : label.magnitude;
}

// --- Full label of a complete time point ------------------------------------

/** Renders a CompleteTimePoint as a full Japanese label (… 年 M 月 D 日). */
export function formatCompleteTimePoint(point: CompleteTimePoint): string {
  return `${formatYear(point.year)}${point.month}月${point.day}日`;
}

/**
 * Renders a TimePoint honoring its granularity — month/day that are NOT
 * specified are omitted (未指定は値が無い状態として握りつぶさない, 教訓 5.18).
 */
export function formatTimePoint(point: TimePoint): string {
  switch (point.granularity) {
    case 'year':
      return formatYear(point.year);
    case 'yearMonth':
      return `${formatYear(point.year)}${point.month}月`;
    case 'yearMonthDay':
      return `${formatYear(point.year)}${point.month}月${point.day}日`;
  }
}

// --- Range <-> slider position mapping --------------------------------------
//
// The slider's internal scalar position is a fraction in [0, 1]. It is a pure
// presentation device: the moment a position is committed to the store it is
// converted back to a complete year/month/day TimePoint via U02 (spec 時間値の
// 取り扱い: スカラー位置でも反映時は完全値へ落とす, FR-70). No floating year is
// ever stored or notified.

/** A timeline range expressed in U02 normalized (whole-day) units. */
export interface NormalizedRange {
  readonly min: Normalized;
  readonly max: Normalized;
}

/** Builds a normalized range from the min/max TimePoints via U02 (単一経路). */
export function toNormalizedRange(
  min: TimePoint,
  max: TimePoint,
  calendar: Calendar,
): NormalizedRange {
  return { min: normalize(min, calendar), max: normalize(max, calendar) };
}

/**
 * Maps a TimePoint to a slider fraction in [0, 1] within the range. Clamped so
 * a current time outside the configured range still yields a valid thumb
 * position (the thumb tracks current time bidirectionally — 受け入れ基準 1).
 */
export function timeToFraction(
  time: TimePoint,
  range: NormalizedRange,
  calendar: Calendar,
): number {
  const span = (range.max as number) - (range.min as number);
  if (span <= 0) return 0;
  const pos = (normalize(time, calendar) as number) - (range.min as number);
  const fraction = pos / span;
  if (fraction < 0) return 0;
  if (fraction > 1) return 1;
  return fraction;
}

/**
 * Maps a slider fraction in [0, 1] back to a COMPLETE year/month/day TimePoint
 * via U02 denormalize (FR-70: スカラーを完全値へ落とす). The fraction is
 * clamped; the result is always a concrete y/m/d point, never a fractional year.
 */
export function fractionToTime(
  fraction: number,
  range: NormalizedRange,
  calendar: Calendar,
): TimePoint {
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  const span = (range.max as number) - (range.min as number);
  const day = Math.round((range.min as number) + clamped * span);
  const c = denormalize(day as Normalized, calendar);
  return timePointYearMonthDay(c.year, c.month, c.day);
}

// --- Tick marks --------------------------------------------------------------
//
// Choose a readable tick spacing (in whole years) for a range so the slider's
// labels do not overcrowd. The spacing is selected from a 1/2/5 * 10^n ladder
// targeting roughly `targetTicks` labels. Pure and deterministic so it is
// unit-testable and stable across renders.

const TICK_LADDER = [1, 2, 5];

/**
 * Picks a "nice" tick interval in years for a span (in years) so the number of
 * ticks is close to (but not exceeding) targetTicks. Always >= 1 year.
 */
export function chooseYearTickInterval(spanYears: number, targetTicks: number): number {
  if (spanYears <= 0 || targetTicks <= 0) return 1;
  const rough = spanYears / targetTicks;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.max(rough, 1))));
  for (const step of TICK_LADDER) {
    const candidate = step * magnitude;
    if (candidate >= rough) return Math.max(1, Math.round(candidate));
  }
  return Math.max(1, Math.round(10 * magnitude));
}

/** A single tick: its astronomical year and its slider fraction. */
export interface Tick {
  readonly year: number;
  readonly fraction: number;
}

/**
 * Generates evenly spaced year ticks across the range, each with its slider
 * fraction. Years are aligned to multiples of the chosen interval so labels are
 * round numbers. Tick positions come from U02 normalization (no UI day math).
 */
export function generateTicks(
  minYear: number,
  maxYear: number,
  calendar: Calendar,
  targetTicks: number,
): readonly Tick[] {
  if (maxYear <= minYear) return [{ year: minYear, fraction: 0 }];
  const interval = chooseYearTickInterval(maxYear - minYear, targetTicks);
  const range = toNormalizedRange(
    timePointYearMonthDay(minYear, 1, 1),
    timePointYearMonthDay(maxYear, 1, 1),
    calendar,
  );
  const ticks: Tick[] = [];
  const first = Math.ceil(minYear / interval) * interval;
  for (let y = first; y <= maxYear; y += interval) {
    ticks.push({
      year: y,
      fraction: timeToFraction(timePointYearMonthDay(y, 1, 1), range, calendar),
    });
  }
  return ticks;
}

// --- Range端 clamping for the current time ----------------------------------

/**
 * Clamps a candidate TimePoint into [min, max] using U02 comparison only
 * (no UI day math). Returns the candidate, or the nearer bound if it falls
 * outside. Used so step/jump cannot leave the configured range.
 */
export function clampToRange(
  candidate: TimePoint,
  min: TimePoint,
  max: TimePoint,
  calendar: Calendar,
): TimePoint {
  const c = normalize(candidate, calendar);
  const lo = normalize(min, calendar);
  const hi = normalize(max, calendar);
  if (compareNormalized(c, lo) < 0) return completeOf(min);
  if (compareNormalized(c, hi) > 0) return completeOf(max);
  return candidate;
}

/** Resolves a TimePoint to a complete y/m/d point via U02 default completion. */
function completeOf(point: TimePoint): TimePoint {
  const c = complete(point);
  return timePointYearMonthDay(c.year, c.month, c.day);
}
