// UI layer (U32 / property panel): the 時間バー表示 pure mapping (FR-60).
//
// All time↔screen math routes through U02 (domain/time): a view is a normalized
// [min, max) window in WHOLE DAYS, mapped to screen pixels. Calendar constants /
// normalization are NEVER re-implemented here — `normalize`/`denormalize` are the
// single source (受け入れ基準 7). The label-visibility decision is a SINGLE
// function (教訓 5.29) so every bar uses the same占有率閾値. Pure + framework-free
// (NFR 5.8): inputs are TimePoints + a Calendar + the pixel length; outputs are
// screen positions / decisions.

import type { Calendar } from '../../domain/time/calendar';
import {
  denormalize,
  normalize,
  type Normalized,
} from '../../domain/time/normalized';
import {
  timePointYearMonthDay,
  type TimePoint,
} from '../../domain/time/time-point';

/**
 * The time-bar view window: the normalized [min, max) range currently shown and
 * the pixel length of the axis. Zoom/scroll change `min`/`max`; the pixel length
 * comes from layout. Half-open like U09's intervals (start inclusive, end
 * exclusive).
 */
export interface TimeBarView {
  /** The earliest time shown (top/left edge), in U02 normalized days. */
  readonly min: Normalized;
  /** The latest time shown (bottom/right edge), in U02 normalized days. */
  readonly max: Normalized;
  /** The axis length in screen pixels. */
  readonly pixelLength: number;
}

/** Minimum span (days) a view may zoom IN to, so it never collapses to 0. */
export const MIN_VIEW_DAYS = 1;
/** Wheel zoom factor per notch (>1 zooms out, <1 zooms in). */
export const ZOOM_STEP = 1.2;
/**
 * The screen-occupancy threshold (fraction of the axis) a bar must reach before
 * its name label is drawn (教訓 5.29: 単一の判定関数). Below it the label is
 * omitted (would be unreadable). One constant → one rule for every bar.
 */
export const LABEL_MIN_OCCUPANCY = 0.08;

/** Build a view from min/max TimePoints + a pixel length (single U02 normalize). */
export function viewFromTimePoints(
  min: TimePoint,
  max: TimePoint,
  pixelLength: number,
  calendar: Calendar,
): TimeBarView {
  return {
    min: normalize(min, calendar),
    max: normalize(max, calendar),
    pixelLength,
  };
}

/** The view's span in whole days (>= 0). */
export function viewSpanDays(view: TimeBarView): number {
  const span = (view.max as number) - (view.min as number);
  return span > 0 ? span : 0;
}

/**
 * Map a TimePoint to a screen position (px from the min edge). Clamped to
 * [0, pixelLength] so a time outside the window still yields a valid edge
 * position. Uses U02 normalize only (no UI day math).
 */
export function timeToPixel(
  time: TimePoint,
  view: TimeBarView,
  calendar: Calendar,
): number {
  return normalizedToPixel(normalize(time, calendar), view);
}

/** Map a normalized value to a clamped screen position (px from the min edge). */
export function normalizedToPixel(value: Normalized, view: TimeBarView): number {
  const span = viewSpanDays(view);
  if (span <= 0) return 0;
  const pos = ((value as number) - (view.min as number)) / span;
  const px = pos * view.pixelLength;
  if (px < 0) return 0;
  if (px > view.pixelLength) return view.pixelLength;
  return px;
}

/**
 * Map a screen position (px from the min edge) back to a COMPLETE TimePoint via
 * U02 denormalize (FR-70: スカラー位置→完全値). The result is always a concrete
 * y/m/d point, never a fractional year.
 */
export function pixelToTime(
  px: number,
  view: TimeBarView,
  calendar: Calendar,
): TimePoint {
  const span = viewSpanDays(view);
  const clampedPx = px < 0 ? 0 : px > view.pixelLength ? view.pixelLength : px;
  const fraction = view.pixelLength > 0 ? clampedPx / view.pixelLength : 0;
  const day = Math.round((view.min as number) + fraction * span);
  const c = denormalize(day as Normalized, calendar);
  return timePointYearMonthDay(c.year, c.month, c.day);
}

/** The TimePoint at the min edge (動的端時刻表示, FR-60). */
export function viewMinTime(view: TimeBarView, calendar: Calendar): TimePoint {
  const c = denormalize(view.min, calendar);
  return timePointYearMonthDay(c.year, c.month, c.day);
}

/** The TimePoint at the max edge (動的端時刻表示, FR-60). */
export function viewMaxTime(view: TimeBarView, calendar: Calendar): TimePoint {
  const c = denormalize(view.max, calendar);
  return timePointYearMonthDay(c.year, c.month, c.day);
}

/**
 * A bar segment on the axis (px). `start`/`end` are clamped screen positions;
 * `end` is null for an open-ended (継続中) interval, drawn to the max edge.
 */
export interface BarSegment {
  readonly startPx: number;
  readonly endPx: number;
}

/**
 * Compute a bar's clamped screen segment from its [start, end) interval. An
 * open-ended interval (`end === null`) extends to the view's max edge. The
 * non-existence period between bars is simply the GAP left unfilled (FR-60: 非存在
 * 期間は空白) — this function only returns the FILLED segment.
 */
export function barSegment(
  start: TimePoint,
  end: TimePoint | null,
  view: TimeBarView,
  calendar: Calendar,
): BarSegment {
  const startPx = timeToPixel(start, view, calendar);
  const endPx =
    end === null ? view.pixelLength : timeToPixel(end, view, calendar);
  return { startPx, endPx };
}

/**
 * The SINGLE label-visibility judgment (教訓 5.29). A bar's label is shown only
 * when its on-screen length is at least {@link LABEL_MIN_OCCUPANCY} of the axis.
 * Both the list-vs-bar rendering and any future hit-test share this one rule.
 */
export function shouldShowLabel(segment: BarSegment, view: TimeBarView): boolean {
  if (view.pixelLength <= 0) return false;
  const lengthPx = Math.max(0, segment.endPx - segment.startPx);
  return lengthPx / view.pixelLength >= LABEL_MIN_OCCUPANCY;
}

/**
 * Apply a wheel zoom to the view, centered on a focus pixel (FR-60: ホイールで
 * ズーム). `notches` > 0 zooms OUT (span grows), < 0 zooms IN (span shrinks). The
 * focus time stays anchored at the focus pixel so zoom is centered consistently.
 * The span is floored at {@link MIN_VIEW_DAYS}. Pure: returns a new view.
 */
export function zoomView(
  view: TimeBarView,
  notches: number,
  focusPx: number,
  calendar: Calendar,
): TimeBarView {
  const span = viewSpanDays(view);
  if (span <= 0) return view;
  const factor = Math.pow(ZOOM_STEP, notches);
  const newSpan = Math.max(MIN_VIEW_DAYS, Math.round(span * factor));

  // The normalized value under the focus pixel must stay under it after zoom.
  const focusTime = pixelToTime(focusPx, view, calendar);
  const focusValue = normalize(focusTime, calendar) as number;
  const focusFraction =
    view.pixelLength > 0
      ? Math.min(1, Math.max(0, focusPx / view.pixelLength))
      : 0;

  const newMin = Math.round(focusValue - focusFraction * newSpan);
  const newMax = newMin + newSpan;
  return {
    min: newMin as Normalized,
    max: newMax as Normalized,
    pixelLength: view.pixelLength,
  };
}
