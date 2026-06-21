// U18 grid model tests (FR-13, 受け入れ基準 7 / 8 / 9 / 13 / 15). Emphasis判定
// (single function shared by line+label), spacing options, graticule enumeration,
// label normalization across the seam.

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_GRID_SPACING_DEG,
  GRID_EMPHASIS,
  GRID_SPACINGS_DEG,
  coerceGridSpacing,
  formatLatitudeLabel,
  formatLongitudeLabel,
  graticuleLatitudes,
  graticuleLongitudes,
  MAX_GRATICULE_MERIDIANS,
  isGridSpacing,
  latitudeEmphasis,
  longitudeEmphasis,
} from './grid';

describe('grid spacings (FR-13: 5/10/15/30, default 10)', () => {
  it('lists exactly 5/10/15/30', () => {
    expect(GRID_SPACINGS_DEG).toEqual([5, 10, 15, 30]);
  });

  it('default is 10', () => {
    expect(DEFAULT_GRID_SPACING_DEG).toBe(10);
  });

  it('isGridSpacing accepts allowed, rejects others', () => {
    expect(isGridSpacing(10)).toBe(true);
    expect(isGridSpacing(7)).toBe(false);
  });

  it('coerceGridSpacing keeps allowed, defaults others to 10', () => {
    expect(coerceGridSpacing(30)).toBe(30);
    expect(coerceGridSpacing(7)).toBe(10);
  });
});

describe('emphasis判定 (single function, 受け入れ基準 8)', () => {
  it('equator (lat 0) is emphasized', () => {
    expect(latitudeEmphasis(0)).toBe(GRID_EMPHASIS.Equator);
    expect(latitudeEmphasis(10)).toBe(GRID_EMPHASIS.None);
  });

  it('prime meridian (lon 0) is emphasized', () => {
    expect(longitudeEmphasis(0)).toBe(GRID_EMPHASIS.PrimeMeridian);
  });

  it('antimeridian (lon ±180) is emphasized via U05 fold', () => {
    expect(longitudeEmphasis(180)).toBe(GRID_EMPHASIS.Antimeridian);
    expect(longitudeEmphasis(-180)).toBe(GRID_EMPHASIS.Antimeridian);
  });

  it('a continuous-scalar replica of the prime meridian is still emphasized (R3)', () => {
    // 360 folds to 0 (prime meridian); 540 folds to 180 (antimeridian).
    expect(longitudeEmphasis(360)).toBe(GRID_EMPHASIS.PrimeMeridian);
    expect(longitudeEmphasis(540)).toBe(GRID_EMPHASIS.Antimeridian);
  });

  it('a normal meridian is not emphasized', () => {
    expect(longitudeEmphasis(30)).toBe(GRID_EMPHASIS.None);
  });
});

describe('graticule enumeration', () => {
  it('parallels at 10° include the equator and span ±90', () => {
    const lats = graticuleLatitudes(10);
    expect(lats[0]).toBe(-90);
    expect(lats[lats.length - 1]).toBe(90);
    expect(lats).toContain(0);
  });

  it('meridians cover a continuous span across the seam (FR-07)', () => {
    // Span 170..190 continuous: meridians at 170, 180, 190 (190 = -170 after fold).
    const lons = graticuleLongitudes(170, 190, 10);
    expect(lons).toEqual([170, 180, 190]);
  });

  it('degenerate span yields no meridians', () => {
    expect(graticuleLongitudes(10, 5, 10)).toEqual([]);
  });

  // --- H1 safety: meridian enumeration must never hang / OOM (病的入力) ---------

  it('terminates and caps the count for a finite-but-huge span (no unbounded array)', () => {
    // A tiny zoom over a wide pan: span 0..1e9 would be 1e8 meridians at 10°.
    // Must return [] (cap exceeded), not an enormous array, and must return fast.
    const t0 = Date.now();
    const lons = graticuleLongitudes(0, 1e9, 10);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(lons).toEqual([]);
  });

  it('terminates for a finite-but-huge edge magnitude where `lon += spacing` is a float no-op (frame hang)', () => {
    // |lon| beyond 2^53: `lon += 10` no longer advances, so the naive while-loop
    // never terminated. The closed-form count guard must bail (cap or non-finite)
    // and RETURN — the assertion is simply that the call completes quickly.
    const t0 = Date.now();
    const huge = 1e15;
    const lons = graticuleLongitudes(huge, huge + 100, 10);
    expect(Date.now() - t0).toBeLessThan(1000);
    // A 100°-wide span at 10° is ≤ 11 meridians, well under the cap, so it returns
    // a bounded array (values may be float-collapsed, but the loop terminated).
    expect(lons.length).toBeLessThanOrEqual(MAX_GRATICULE_MERIDIANS);
  });

  it('terminates at the safe-integer boundary (2^53+1) without hanging', () => {
    const t0 = Date.now();
    const lons = graticuleLongitudes(2 ** 53 + 1, 2 ** 53 + 1, 10);
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(Array.isArray(lons)).toBe(true);
  });

  it('keeps a realistic deep-zoom-near-the-seam span (well under the cap)', () => {
    // 14 turns of world span at the densest spacing is still bounded; this is the
    // largest legitimate frame and must NOT be truncated.
    const lons = graticuleLongitudes(-180, -180 + 360 * 2, 5);
    expect(lons.length).toBeGreaterThan(0);
    expect(lons.length).toBeLessThanOrEqual(MAX_GRATICULE_MERIDIANS);
    expect(lons[0]).toBe(-180);
  });
});

describe('label normalization (受け入れ基準 13)', () => {
  it('latitude labels (N/S/equator)', () => {
    expect(formatLatitudeLabel(0)).toBe('0°');
    expect(formatLatitudeLabel(30)).toBe('30°N');
    expect(formatLatitudeLabel(-30)).toBe('30°S');
  });

  it('longitude labels fold continuous scalars (E/W/seam)', () => {
    expect(formatLongitudeLabel(0)).toBe('0°');
    expect(formatLongitudeLabel(30)).toBe('30°E');
    expect(formatLongitudeLabel(-30)).toBe('30°W');
    expect(formatLongitudeLabel(180)).toBe('180°');
    expect(formatLongitudeLabel(-180)).toBe('180°');
  });

  it('a +1-turn replica reads its true longitude, not a winding value', () => {
    // continuous 190° is the -170°W meridian one turn east.
    expect(formatLongitudeLabel(190)).toBe('170°W');
    // continuous 200° → -160°W.
    expect(formatLongitudeLabel(200)).toBe('160°W');
  });
});
