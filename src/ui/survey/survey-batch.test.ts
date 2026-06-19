import { describe, expect, it } from 'vitest';

import { createGeoParams } from '../../domain/geo/geo-params';
import { greatCircleDistanceKm } from '../../domain/geo/geodesy';
import {
  formatLatDecimal,
  formatLatDms,
  formatLonDecimal,
  formatLonDms,
} from '../../domain/survey/coords-format';
import {
  clickPoint,
  enableSurveyMode,
  initialSurveyState,
  updateHover,
} from '../../domain/survey/survey-state';
import {
  DEFAULT_SURVEY_STYLE,
  buildSurveyPrimitives,
  confirmedLinePrimitives,
  currentMeasurement,
  draftPrimitives,
} from './survey-batch';

const GEO = createGeoParams(40075, 0);
const P = (lon: number, lat: number) => ({ lon, lat });

function withTwoConfirmed() {
  let s = enableSurveyMode(initialSurveyState());
  s = clickPoint(s, P(0, 0));
  s = clickPoint(s, P(20, 10));
  s = clickPoint(s, P(-30, -5));
  s = clickPoint(s, P(40, 15));
  return s;
}

describe('buildSurveyPrimitives (FR-15 描画記述)', () => {
  it('empty state yields an empty list (教訓 5.18)', () => {
    expect(buildSurveyPrimitives(initialSurveyState())).toEqual([]);
  });

  it('each confirmed line contributes an equirectangular line, a great-circle line and two markers', () => {
    const prims = confirmedLinePrimitives(
      { id: 1, start: P(0, 0), end: P(20, 10) },
      DEFAULT_SURVEY_STYLE,
    );
    const lines = prims.filter((p) => p.kind === 'line');
    const points = prims.filter((p) => p.kind === 'point');
    expect(lines).toHaveLength(2);
    expect(points).toHaveLength(2);
    // The great-circle line (FR-15 mandatory) is multi-point (a curve), the
    // equirectangular line is the 2-point straight.
    const widths = lines.map((l) => (l.kind === 'line' ? l.points.length : 0));
    expect(Math.max(...widths)).toBeGreaterThan(2);
    expect(widths).toContain(2);
  });

  it('two confirmed lines + a draft all appear', () => {
    let s = withTwoConfirmed();
    s = clickPoint(s, P(5, 5)); // start a 3rd draft
    s = updateHover(s, P(9, 9));
    const prims = buildSurveyPrimitives(s);
    const points = prims.filter((p) => p.kind === 'point');
    // 2 lines * 2 markers = 4, + draft start + draft hover = 6.
    expect(points.length).toBe(6);
  });

  it('confirmed lines render even when survey mode is OFF (FR-15 残存)', () => {
    let s = withTwoConfirmed();
    s = { ...s, active: false };
    const prims = buildSurveyPrimitives(s);
    expect(prims.length).toBeGreaterThan(0);
  });

  it('FR-17: all marker/line sizes are screen-fixed px from the style', () => {
    const prims = buildSurveyPrimitives(withTwoConfirmed());
    for (const p of prims) {
      if (p.kind === 'point') expect(p.radiusPx).toBe(DEFAULT_SURVEY_STYLE.markerRadiusPx);
      if (p.kind === 'line') expect(p.widthPx).toBeGreaterThan(0);
    }
  });
});

describe('draftPrimitives (一時表示 / 教訓 5.18)', () => {
  it('start placed, no hover yet -> only the start marker', () => {
    const prims = draftPrimitives({ start: P(0, 0), hover: null }, DEFAULT_SURVEY_STYLE);
    expect(prims.filter((p) => p.kind === 'point')).toHaveLength(1);
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(0);
  });

  it('with hover -> preview line + preview marker + start marker', () => {
    const prims = draftPrimitives({ start: P(0, 0), hover: P(5, 5) }, DEFAULT_SURVEY_STYLE);
    expect(prims.filter((p) => p.kind === 'line')).toHaveLength(1);
    expect(prims.filter((p) => p.kind === 'point')).toHaveLength(2);
  });
});

describe('currentMeasurement (FR-14 readout)', () => {
  it('returns null when there is nothing to measure (教訓 5.18)', () => {
    expect(currentMeasurement(initialSurveyState(), GEO)).toBeNull();
    const drafting = clickPoint(enableSurveyMode(initialSurveyState()), P(0, 0));
    // start placed but hover === start initially -> still measurable (0 distance)
    expect(currentMeasurement(drafting, GEO)).not.toBeNull();
  });

  it('measures the draft (start<->hover) while drafting', () => {
    let s = enableSurveyMode(initialSurveyState());
    s = clickPoint(s, P(0, 0));
    s = updateHover(s, P(10, 0));
    const m = currentMeasurement(s, GEO);
    expect(m).not.toBeNull();
    expect(m?.greatCircleKm).toBeCloseTo(greatCircleDistanceKm(P(0, 0), P(10, 0), GEO), 6);
  });

  it('measures the last confirmed line when idle', () => {
    const s = withTwoConfirmed();
    const m = currentMeasurement(s, GEO);
    expect(m?.start).toEqual(P(-30, -5));
    expect(m?.end).toEqual(P(40, 15));
  });

  it('re-derives distance from the supplied geoParams (教訓 5.3, no stale cache)', () => {
    const s = withTwoConfirmed();
    const small = currentMeasurement(s, createGeoParams(40075, 0));
    const big = currentMeasurement(s, createGeoParams(80150, 0));
    expect(big?.greatCircleKm).toBeCloseTo((small?.greatCircleKm ?? 0) * 2, 3);
  });
});

describe('currentMeasurement lat/lon dual-format display (AC-4 / FR-16 表示経路)', () => {
  it('exposes BOTH 度分秒 and 十進 forms for start AND end (formatCoordinate consumed)', () => {
    let s = enableSurveyMode(initialSurveyState());
    s = clickPoint(s, P(139.7671, 35.6812)); // Tokyo-ish
    s = updateHover(s, P(-0.1276, 51.5072)); // London-ish
    const m = currentMeasurement(s, GEO);
    expect(m).not.toBeNull();
    if (m === null) return;
    // The display contract carries all four strings per endpoint (both forms).
    expect(m.startDisplay.latDms).toBe(formatLatDms(35.6812));
    expect(m.startDisplay.lonDms).toBe(formatLonDms(139.7671));
    expect(m.startDisplay.latDecimal).toBe(formatLatDecimal(35.6812));
    expect(m.startDisplay.lonDecimal).toBe(formatLonDecimal(139.7671));
    expect(m.endDisplay.latDms).toBe(formatLatDms(51.5072));
    expect(m.endDisplay.lonDms).toBe(formatLonDms(-0.1276));
    expect(m.endDisplay.latDecimal).toBe(formatLatDecimal(51.5072));
    expect(m.endDisplay.lonDecimal).toBe(formatLonDecimal(-0.1276));
  });

  it('度分秒 and 十進 are distinct non-empty strings (both forms truly shown)', () => {
    let s = enableSurveyMode(initialSurveyState());
    s = clickPoint(s, P(20, 10));
    s = updateHover(s, P(40, 15));
    const m = currentMeasurement(s, GEO);
    expect(m).not.toBeNull();
    if (m === null) return;
    expect(m.startDisplay.latDms).not.toBe(m.startDisplay.latDecimal);
    expect(m.startDisplay.latDms).toMatch(/[°′″]/);
    expect(m.startDisplay.latDecimal).toMatch(/°$/);
    expect(m.startDisplay.lonDms.length).toBeGreaterThan(0);
    expect(m.startDisplay.lonDecimal.length).toBeGreaterThan(0);
  });

  it('folds an infinite-scroll (>180) longitude to its representative form for display', () => {
    let s = enableSurveyMode(initialSurveyState());
    s = clickPoint(s, P(370, 0)); // 370° == 10° after the ±360 fold
    s = updateHover(s, P(10, 0));
    const m = currentMeasurement(s, GEO);
    expect(m).not.toBeNull();
    if (m === null) return;
    // The raw scalar is preserved on the coordinate, but the DISPLAY folds it.
    expect(m.start.lon).toBe(370);
    expect(m.startDisplay.lonDecimal).toBe(formatLonDecimal(370));
    expect(m.startDisplay.lonDecimal).toBe(formatLonDecimal(10));
  });
});
