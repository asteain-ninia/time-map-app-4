import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PROJECT_SETTINGS,
  DEFAULT_ZOOM_MAX,
  DEFAULT_ZOOM_MIN,
  ZOOM_LIMIT_CEIL,
  ZOOM_LIMIT_FLOOR,
} from '../state/settings';

import {
  ZOOM_LIMIT_REJECTION,
  isWithinZoomBoundary,
  validateZoomLimits,
  zoomRangeOf,
} from './zoom-limit';

describe('zoom-limit defaults (FR-10 単一の真実源)', () => {
  it('default project settings carry 1×..50× (受け入れ基準 5)', () => {
    expect(DEFAULT_ZOOM_MIN).toBe(1);
    expect(DEFAULT_ZOOM_MAX).toBe(50);
    expect(DEFAULT_PROJECT_SETTINGS.zoomMin).toBe(1);
    expect(DEFAULT_PROJECT_SETTINGS.zoomMax).toBe(50);
  });

  it('the user-settable boundary is 0.1×..10000× (受け入れ基準 5)', () => {
    expect(ZOOM_LIMIT_FLOOR).toBe(0.1);
    expect(ZOOM_LIMIT_CEIL).toBe(10000);
  });
});

describe('isWithinZoomBoundary', () => {
  it('accepts the inclusive boundary endpoints', () => {
    expect(isWithinZoomBoundary(ZOOM_LIMIT_FLOOR)).toBe(true);
    expect(isWithinZoomBoundary(ZOOM_LIMIT_CEIL)).toBe(true);
  });

  it('rejects below floor / above ceiling / non-finite', () => {
    expect(isWithinZoomBoundary(0.05)).toBe(false);
    expect(isWithinZoomBoundary(10001)).toBe(false);
    expect(isWithinZoomBoundary(Number.NaN)).toBe(false);
    expect(isWithinZoomBoundary(Number.POSITIVE_INFINITY)).toBe(false);
  });
});

describe('validateZoomLimits (FR-10 / 教訓 5.26)', () => {
  it('accepts a valid in-range pair', () => {
    const r = validateZoomLimits(0.5, 200);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.zoomMin).toBe(0.5);
      expect(r.zoomMax).toBe(200);
    }
  });

  it('accepts the default 1×..50×', () => {
    expect(validateZoomLimits(1, 50).ok).toBe(true);
  });

  it('rejects an out-of-range minimum with a Japanese reason', () => {
    const r = validateZoomLimits(0.05, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        { field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.outOfRange },
      ]);
    }
  });

  it('rejects an out-of-range maximum', () => {
    const r = validateZoomLimits(1, 20000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.field === 'zoomMax')).toBe(true);
    }
  });

  it('rejects min > max even when both are in range (受け入れ基準 5)', () => {
    const r = validateZoomLimits(100, 10);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        { field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.order },
      ]);
    }
  });

  it('rejects a non-numeric input as 数値を入力してください', () => {
    const r = validateZoomLimits(Number.NaN, 50);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors[0]?.message).toBe(ZOOM_LIMIT_REJECTION.notANumber);
    }
  });

  it('does not run the order check when a value is out of range', () => {
    // 0.05 is below the floor; the order rule must NOT also fire (only the range error).
    const r = validateZoomLimits(0.05, 0.2);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors).toEqual([
        { field: 'zoomMin', message: ZOOM_LIMIT_REJECTION.outOfRange },
      ]);
    }
  });
});

describe('zoomRangeOf (supply to U17)', () => {
  it('projects the stored limits into a ZoomRange value', () => {
    const range = zoomRangeOf({ ...DEFAULT_PROJECT_SETTINGS, zoomMin: 2, zoomMax: 80 });
    expect(range).toEqual({ minZoom: 2, maxZoom: 80 });
  });

  it('supplies the FR-10 default range from default settings', () => {
    expect(zoomRangeOf(DEFAULT_PROJECT_SETTINGS)).toEqual({ minZoom: 1, maxZoom: 50 });
  });
});
