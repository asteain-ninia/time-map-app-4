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
