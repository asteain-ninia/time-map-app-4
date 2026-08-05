// U18 longitude shift tests (FR-12, 受け入れ基準 11 / 12 / 15). Zoom-dependent
// conversion (no double-apply), presets, center display normalization across the
// seam.

import { describe, expect, it } from 'vitest';

import {
  CENTER_LON_PRESET,
  SHIFT_PX_PER_UNIT,
  applyLongitudeShift,
  centerLonForPreset,
  formatCenterLonDisplay,
  parseAbsoluteCenterLon,
  representativeCenterLon,
  shiftToLonDelta,
} from './longitude-shift';

describe('shiftToLonDelta (zoom-dependent, 教訓 5.16)', () => {
  it('converts a shift unit to degrees via px/zoom', () => {
    // shift 1 unit = SHIFT_PX_PER_UNIT px; at zoom 10 px/deg → that many / 10 deg.
    expect(shiftToLonDelta(1, 10)).toBeCloseTo(SHIFT_PX_PER_UNIT / 10, 10);
  });

  it('higher zoom yields a SMALLER degree delta for the same shift (受け入れ基準 12)', () => {
    const lowZoom = shiftToLonDelta(1, 5);
    const highZoom = shiftToLonDelta(1, 50);
    expect(Math.abs(highZoom)).toBeLessThan(Math.abs(lowZoom));
    // Exactly 10x zoom → exactly 1/10 the delta (no double-apply).
    expect(highZoom).toBeCloseTo(lowZoom / 10, 10);
  });

  it('non-positive / non-finite zoom yields 0 (病的入力)', () => {
    expect(shiftToLonDelta(1, 0)).toBe(0);
    expect(shiftToLonDelta(1, -5)).toBe(0);
    expect(shiftToLonDelta(1, Number.NaN)).toBe(0);
  });
});

describe('applyLongitudeShift (continuous scalar, FR-07)', () => {
  it('adds the zoom-scaled delta to the continuous center (no fold)', () => {
    const next = applyLongitudeShift(170, 1, 1);
    expect(next).toBeCloseTo(170 + SHIFT_PX_PER_UNIT, 10);
    // Stays continuous (not folded back into [-180,180)).
    expect(next).toBeGreaterThan(180);
  });
});

describe('center presets (FR-12)', () => {
  it('prime meridian = 0, pacific = 180', () => {
    expect(centerLonForPreset(CENTER_LON_PRESET.PrimeMeridian)).toBe(0);
    expect(centerLonForPreset(CENTER_LON_PRESET.Pacific)).toBe(180);
  });
});

describe('parseAbsoluteCenterLon (HB3-1 絶対経度指定, 裁定 2026-08-06)', () => {
  it('parses a plain degree value (東経正)', () => {
    expect(parseAbsoluteCenterLon('90')).toBe(90);
    expect(parseAbsoluteCenterLon('-135.5')).toBeCloseTo(-135.5, 10);
    expect(parseAbsoluteCenterLon(' 0 ')).toBe(0);
  });

  it('folds out-of-range values through U05 wrapLonDeg (single source)', () => {
    expect(parseAbsoluteCenterLon('190')).toBeCloseTo(-170, 10);
    expect(parseAbsoluteCenterLon('360')).toBeCloseTo(0, 10);
    // wrapLonDeg's range is [-180, 180): a perfect ±180 folds to -180 (the readout
    // still displays it as "180°" via formatCenterLonDisplay).
    expect(parseAbsoluteCenterLon('-540')).toBeCloseTo(-180, 10);
    expect(parseAbsoluteCenterLon('180')).toBeCloseTo(-180, 10);
  });

  it('rejects empty / whitespace / non-numeric / non-finite input as null', () => {
    expect(parseAbsoluteCenterLon('')).toBeNull();
    expect(parseAbsoluteCenterLon('   ')).toBeNull();
    expect(parseAbsoluteCenterLon('abc')).toBeNull();
    expect(parseAbsoluteCenterLon('12,3')).toBeNull();
    expect(parseAbsoluteCenterLon('Infinity')).toBeNull();
    expect(parseAbsoluteCenterLon('NaN')).toBeNull();
  });
});

describe('center display (受け入れ基準 11, R3)', () => {
  it('representativeCenterLon folds a continuous scalar', () => {
    expect(representativeCenterLon(190)).toBeCloseTo(-170, 10);
    expect(representativeCenterLon(360)).toBeCloseTo(0, 10);
  });

  it('formats the readout with E/W/seam', () => {
    expect(formatCenterLonDisplay(0)).toBe('0°');
    expect(formatCenterLonDisplay(170)).toBe('170°E');
    expect(formatCenterLonDisplay(-170)).toBe('170°W');
    expect(formatCenterLonDisplay(180)).toBe('180°');
    // continuous 190 → -170 → 170°W.
    expect(formatCenterLonDisplay(190)).toBe('170°W');
  });
});
