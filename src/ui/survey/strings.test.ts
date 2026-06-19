import { describe, expect, it } from 'vitest';

import { SURVEY_STRINGS, formatDistanceKm } from './strings';

describe('SURVEY_STRINGS (FR-115 日本語)', () => {
  it('provides Japanese labels for mode, clear and distances', () => {
    expect(SURVEY_STRINGS.modeLabel).toBe('測量モード');
    expect(SURVEY_STRINGS.clearLabel).toContain('クリア');
    expect(SURVEY_STRINGS.equirectangularLabel).toBe('正距円筒距離');
    expect(SURVEY_STRINGS.greatCircleLabel).toBe('大円距離');
  });
});

describe('formatDistanceKm (FR-14 / FR-117)', () => {
  it('formats with 2 decimals and the km unit', () => {
    expect(formatDistanceKm(1234.5)).toBe('1,234.50 km');
    expect(formatDistanceKm(0)).toBe('0.00 km');
  });

  it('shows the internal-error guidance for non-finite values (FR-117)', () => {
    expect(formatDistanceKm(NaN)).toBe(SURVEY_STRINGS.internalError);
  });
});
