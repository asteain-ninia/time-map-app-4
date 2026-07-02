// UI layer (U32 / property panel): the 時間バー表示 (FR-60).
//
// Draws each anchor's existence interval [start, end) as a bar on a horizontal
// time axis; the GAPS between bars are the非存在期間 left blank (FR-60). The axis
// edge times (min/max) are shown dynamically and update on wheel zoom; the wheel
// zooms the view (timebar.zoomView). A bar's name label is shown only when the
// single占有率 judgment (timebar.shouldShowLabel) allows it (教訓 5.29). Clicking a
// bar routes through the SAME `onSelectAnchor` path the list uses (受け入れ基準 7).
//
// All time↔pixel math is in timebar.ts (U02-backed); this component is the thin
// rendering shell. The transient zoom view is local state, reset when the series
// changes (教訓 5.2) via the keyed initial view.

import { useEffect, useState, type WheelEvent } from 'react';

import type { AnchorEntry, AnchorSeries } from '../../domain/anchor-series';
import type { AnchorId } from '../../domain/ids';
import type { Calendar } from '../../domain/time/calendar';
import { denormalize, normalize, type Normalized } from '../../domain/time/normalized';
import { timePointYearMonthDay, type TimePoint } from '../../domain/time/time-point';

import { formatTimePoint } from '../timeline/time-display';

import { PROPERTY_STRINGS } from './messages';
import {
  type TimeBarView,
  barSegment,
  shouldShowLabel,
  viewFromTimePoints,
  viewMaxTime,
  viewMinTime,
  viewSpanDays,
  zoomView,
} from './timebar';

/** The default axis pixel length used until layout measures (and in tests). */
export const DEFAULT_TIMEBAR_PIXELS = 480;

/**
 * Headroom (in WHOLE DAYS) appended past the last anchor's START when the series
 * is open-ended (継続中 — no end). At least one full year so the axis never
 * collapses to a sliver when the last anchor starts late in its year (e.g. a
 * late month/day): `last.start.year + 1` (Jan 1) would otherwise leave only the
 * remaining days of the year between start and that edge, pinning the view at the
 * zoom floor. Computed via U02 normalize/denormalize — never via UI day math.
 */
export const OPEN_ENDED_HEADROOM_DAYS = 365;

/** Floor for the WHOLE initial span (days) so the axis never collapses (≥1 year). */
export const MIN_INITIAL_SPAN_DAYS = 365;

export interface AnchorTimeBarProps {
  readonly series: AnchorSeries;
  readonly calendar: Calendar;
  readonly selectedAnchorId: AnchorId | null;
  readonly onSelectAnchor: (entry: AnchorEntry) => void;
  /** Axis pixel length (defaults to {@link DEFAULT_TIMEBAR_PIXELS}). */
  readonly pixelLength?: number;
}

/** Build the initial view spanning the whole series (first start .. last end). */
function initialView(
  series: AnchorSeries,
  pixelLength: number,
  calendar: Calendar,
): TimeBarView {
  const entries = series.entries;
  const first = entries[0];
  const last = entries[entries.length - 1];
  if (first === undefined || last === undefined) {
    // Empty series: a degenerate 1-day window (caller renders the empty notice).
    return viewFromTimePoints(
      { granularity: 'year', year: 0 },
      { granularity: 'year', year: 1 },
      pixelLength,
      calendar,
    );
  }
  // The max edge. For a CLOSED last interval it is the end. For an OPEN-ENDED
  // (継続中) series we add ≥1 year of headroom past the last START in WHOLE DAYS
  // via U02 (normalize → +headroom → denormalize) — NOT `start.year + 1`, which
  // collapses to a sliver when the start is late in its year (BUG: late month/day
  // → near-zero span → pinned at the zoom floor, unusable bar).
  let max: TimePoint;
  if (last.end !== null && last.end !== undefined) {
    max = last.end;
  } else {
    const lastStartDays = normalize(last.start, calendar) as number;
    const c = denormalize((lastStartDays + OPEN_ENDED_HEADROOM_DAYS) as Normalized, calendar);
    max = timePointYearMonthDay(c.year, c.month, c.day);
  }

  const view = viewFromTimePoints(first.start, max, pixelLength, calendar);
  // Floor the WHOLE span to ≥1 year regardless of granularity, so a very-short
  // closed final interval (or first==last) can never pin the axis at the zoom
  // floor either. Push the max edge out by the deficit in whole days via U02.
  const span = viewSpanDays(view);
  if (span >= MIN_INITIAL_SPAN_DAYS) return view;
  const flooredMaxDays = (view.min as number) + MIN_INITIAL_SPAN_DAYS;
  const fc = denormalize(flooredMaxDays as Normalized, calendar);
  return viewFromTimePoints(
    first.start,
    timePointYearMonthDay(fc.year, fc.month, fc.day),
    pixelLength,
    calendar,
  );
}

export function AnchorTimeBar(props: AnchorTimeBarProps): JSX.Element {
  const { series, calendar, selectedAnchorId, onSelectAnchor } = props;
  const pixelLength = props.pixelLength ?? DEFAULT_TIMEBAR_PIXELS;

  const [view, setView] = useState<TimeBarView>(() =>
    initialView(series, pixelLength, calendar),
  );

  // 教訓 5.2: a series change (selection change) discards the transient zoom view
  // and resets to the new series' full span.
  useEffect(() => {
    setView(initialView(series, pixelLength, calendar));
  }, [series, pixelLength, calendar]);

  function handleWheel(e: WheelEvent<HTMLDivElement>): void {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const focusPx = e.clientX - rect.left;
    const notches = e.deltaY > 0 ? 1 : -1; // down = zoom out, up = zoom in
    setView((prev) => zoomView(prev, notches, focusPx, calendar));
  }

  if (series.entries.length === 0) {
    return (
      <p className="anchor-timebar__empty" data-testid="anchor-timebar-empty">
        {PROPERTY_STRINGS.anchorListEmpty}
      </p>
    );
  }

  return (
    <div className="anchor-timebar" data-testid="anchor-timebar">
      <div className="anchor-timebar__edges">
        <span data-testid="timebar-edge-min">{formatTimePoint(viewMinTime(view, calendar))}</span>
        <span data-testid="timebar-edge-max">{formatTimePoint(viewMaxTime(view, calendar))}</span>
      </div>
      <div
        className="anchor-timebar__axis"
        data-testid="timebar-axis"
        style={{ position: 'relative', width: view.pixelLength }}
        onWheel={handleWheel}
      >
        {series.entries.map((entry) => {
          const segment = barSegment(entry.start, entry.end, view, calendar);
          const showLabel = shouldShowLabel(segment, view);
          const selected = entry.anchor.id === selectedAnchorId;
          // Unconditional accessible name (WCAG 4.1.2): a thin bar (<占有率閾値)
          // hides its visible <span> label, which would otherwise leave the button
          // nameless to screen readers. Name it from the SAME start→end source the
          // list row renders (formatTimePoint + PROPERTY_STRINGS.openEndLabel,
          // AnchorList.tsx) so the two views stay one truth source.
          const barName = `${formatTimePoint(entry.start)} → ${
            entry.end === null ? PROPERTY_STRINGS.openEndLabel : formatTimePoint(entry.end)
          }`;
          return (
            <button
              type="button"
              key={entry.anchor.id}
              data-testid={`timebar-bar-${entry.anchor.id}`}
              data-show-label={showLabel ? 'true' : 'false'}
              aria-selected={selected}
              aria-label={barName}
              className={
                selected
                  ? 'anchor-timebar__bar anchor-timebar__bar--selected'
                  : 'anchor-timebar__bar'
              }
              style={{
                position: 'absolute',
                left: segment.startPx,
                width: Math.max(1, segment.endPx - segment.startPx),
              }}
              onClick={() => onSelectAnchor(entry)}
            >
              {showLabel && (
                <span className="anchor-timebar__label">{formatTimePoint(entry.start)}</span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
