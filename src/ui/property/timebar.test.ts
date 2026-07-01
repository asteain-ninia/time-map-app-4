// U32: 時間バー mapping tests (FR-60, 受け入れ基準 7, 教訓 5.29).
//
// All time↔pixel math routes through U02 normalize/denormalize; these tests
// confirm the mapping, the wheel-zoom centering, the dynamic edge times, and the
// SINGLE label-occupancy judgment.

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { timePointYearMonthDay } from '../../domain/time/time-point';

import { MAX_YEAR } from '../../domain/time/validate';

import {
  LABEL_MIN_OCCUPANCY,
  MAX_VIEW_DAYS,
  MIN_VIEW_DAYS,
  NORM_LIMIT,
  barSegment,
  pixelToTime,
  shouldShowLabel,
  timeToPixel,
  viewFromTimePoints,
  viewMaxTime,
  viewMinTime,
  viewSpanDays,
  zoomView,
} from './timebar';

const cal = getCalendar('gregorian');

function view(minYear: number, maxYear: number, px: number) {
  return viewFromTimePoints(
    timePointYearMonthDay(minYear, 1, 1),
    timePointYearMonthDay(maxYear, 1, 1),
    px,
    cal,
  );
}

describe('timebar mapping (FR-60, U02-backed)', () => {
  it('maps min/max edges to 0 / pixelLength', () => {
    const v = view(2000, 2010, 1000);
    expect(timeToPixel(timePointYearMonthDay(2000, 1, 1), v, cal)).toBe(0);
    expect(timeToPixel(timePointYearMonthDay(2010, 1, 1), v, cal)).toBe(1000);
  });

  it('maps the midpoint year near the axis center', () => {
    const v = view(2000, 2010, 1000);
    const px = timeToPixel(timePointYearMonthDay(2005, 1, 1), v, cal);
    expect(px).toBeGreaterThan(450);
    expect(px).toBeLessThan(550);
  });

  it('clamps a time outside the window to an edge', () => {
    const v = view(2000, 2010, 1000);
    expect(timeToPixel(timePointYearMonthDay(1990, 1, 1), v, cal)).toBe(0);
    expect(timeToPixel(timePointYearMonthDay(2050, 1, 1), v, cal)).toBe(1000);
  });

  it('pixelToTime returns a complete y/m/d point (round-trips a known year)', () => {
    const v = view(2000, 2010, 1000);
    const t = pixelToTime(0, v, cal);
    expect(t.granularity).toBe('yearMonthDay');
    expect(t.year).toBe(2000);
  });

  it('exposes the dynamic edge times', () => {
    const v = view(-100, 100, 800);
    expect(viewMinTime(v, cal).year).toBe(-100);
    expect(viewMaxTime(v, cal).year).toBe(100);
  });
});

describe('barSegment (FR-60: 非存在期間は空白)', () => {
  it('a closed interval produces a finite segment shorter than the axis', () => {
    const v = view(2000, 2020, 1000);
    const seg = barSegment(
      timePointYearMonthDay(2005, 1, 1),
      timePointYearMonthDay(2010, 1, 1),
      v,
      cal,
    );
    expect(seg.startPx).toBeGreaterThan(0);
    expect(seg.endPx).toBeLessThan(1000);
    expect(seg.endPx).toBeGreaterThan(seg.startPx);
  });

  it('an open-ended interval extends to the max edge', () => {
    const v = view(2000, 2020, 1000);
    const seg = barSegment(timePointYearMonthDay(2010, 1, 1), null, v, cal);
    expect(seg.endPx).toBe(1000);
  });

  it('two non-adjacent bars leave a blank gap (non-existence period)', () => {
    const v = view(2000, 2020, 1000);
    const a = barSegment(
      timePointYearMonthDay(2000, 1, 1),
      timePointYearMonthDay(2005, 1, 1),
      v,
      cal,
    );
    const b = barSegment(
      timePointYearMonthDay(2010, 1, 1),
      timePointYearMonthDay(2015, 1, 1),
      v,
      cal,
    );
    // The gap between a.endPx and b.startPx is the unfilled non-existence period.
    expect(b.startPx).toBeGreaterThan(a.endPx);
  });
});

describe('shouldShowLabel (教訓 5.29: single judgment)', () => {
  it('shows the label when occupancy meets the threshold', () => {
    const v = view(2000, 2020, 1000);
    // A bar of 50% occupancy is well above the threshold.
    const seg = { startPx: 0, endPx: 500 };
    expect(shouldShowLabel(seg, v)).toBe(true);
  });

  it('hides the label when occupancy is below the threshold', () => {
    const v = view(2000, 2020, 1000);
    const seg = { startPx: 0, endPx: LABEL_MIN_OCCUPANCY * 1000 - 1 };
    expect(shouldShowLabel(seg, v)).toBe(false);
  });
});

describe('zoomView (FR-60: ホイールでズーム)', () => {
  it('zooming in shrinks the span; zooming out grows it', () => {
    const v = view(2000, 2010, 1000);
    const span0 = viewSpanDays(v);
    const inView = zoomView(v, -1, 500, cal);
    const outView = zoomView(v, 1, 500, cal);
    expect(viewSpanDays(inView)).toBeLessThan(span0);
    expect(viewSpanDays(outView)).toBeGreaterThan(span0);
  });

  it('never zooms the span below MIN_VIEW_DAYS', () => {
    let v = view(2000, 2000, 1000); // 0-span seed is rejected; use a small span
    v = view(2000, 2001, 1000);
    for (let i = 0; i < 100; i++) v = zoomView(v, -1, 500, cal);
    expect(viewSpanDays(v)).toBeGreaterThanOrEqual(MIN_VIEW_DAYS);
  });

  it('keeps the focus time anchored under the focus pixel', () => {
    const v = view(2000, 2010, 1000);
    const focusPx = 250;
    const before = pixelToTime(focusPx, v, cal);
    const zoomed = zoomView(v, -1, focusPx, cal);
    const after = pixelToTime(focusPx, zoomed, cal);
    // Same year stays under the focus pixel (within rounding).
    expect(Math.abs(after.year - before.year)).toBeLessThanOrEqual(1);
  });

  it('derives NORM_LIMIT / MAX_VIEW_DAYS from MAX_YEAR (single source)', () => {
    expect(NORM_LIMIT).toBe(366 * MAX_YEAR);
    expect(MAX_VIEW_DAYS).toBe(2 * NORM_LIMIT);
  });

  it('clamps the span at MAX_VIEW_DAYS however many notches zoom out', () => {
    // Many zoom-out notches (≫100) would grow the span without limit and turn the
    // O(|years|) denormalize walk into a multi-minute hang — bound it (第8波 LOW).
    let v = view(2000, 2001, 1000);
    for (let i = 0; i < 200; i++) v = zoomView(v, 1, 500, cal);
    expect(viewSpanDays(v)).toBeLessThanOrEqual(MAX_VIEW_DAYS);
    // Both edges stay within the normalized range denormalize can walk bounded.
    expect(v.min as number).toBeGreaterThanOrEqual(-NORM_LIMIT);
    expect(v.max as number).toBeLessThanOrEqual(NORM_LIMIT);
  });

  it('clamps the edges to ±NORM_LIMIT when zooming out near the range end', () => {
    // Focus at the far right edge so an unclamped newMin would push max past the
    // normalized limit; the clamp must keep both edges in range.
    let v = view(2000, 2001, 1000);
    for (let i = 0; i < 200; i++) v = zoomView(v, 1, 1000, cal);
    expect(v.min as number).toBeGreaterThanOrEqual(-NORM_LIMIT);
    expect(v.max as number).toBeLessThanOrEqual(NORM_LIMIT);
    expect(v.max as number).toBeGreaterThan(v.min as number);
  });

  it('leaves an in-range zoom-out unchanged by the clamp (normal operation)', () => {
    const v = view(2000, 2010, 1000);
    const outView = zoomView(v, 1, 500, cal);
    // A single notch stays far inside the range: the clamp is a no-op here.
    const span = viewSpanDays(v);
    expect(viewSpanDays(outView)).toBe(Math.round(span * 1.2));
  });
});
