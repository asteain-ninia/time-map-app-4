import { describe, expect, it } from 'vitest';

import { SURVEY_STRINGS, formatDistanceKm } from './strings';

describe('SURVEY_STRINGS (FR-115 日本語)', () => {
  it('provides Japanese labels for mode, clear and distances', () => {
    // 増分 5 の手直し C3 / E1: 画面から「モード」の語を外し、道具の 1 段の語に揃えた。
    expect(SURVEY_STRINGS.modeLabel).toBe('📏 測る');
    expect(SURVEY_STRINGS.toolName).toBe(SURVEY_STRINGS.modeLabel);
    expect(SURVEY_STRINGS.clearLabel).toContain('クリア');
    expect(SURVEY_STRINGS.equirectangularLabel).toBe('正距円筒距離');
    expect(SURVEY_STRINGS.greatCircleLabel).toBe('大円距離');
  });
});

describe('増分 8C の文言（設計書 §C.4 の測るの行 / §E.1 V15）', () => {
  it('次の一手に「測っている間は地物を選べません」が入る（N-54）', () => {
    expect(SURVEY_STRINGS.nextStepIdle).toContain('2 点を押すと距離が出ます');
    expect(SURVEY_STRINGS.nextStepIdle).toContain('測っている間は地物を選べません');
  });

  it('右クリックの項目は「この線を消す」/「1,234km の線を消す」', () => {
    expect(SURVEY_STRINGS.removeThisLine).toBe('この線を消す');
    expect(SURVEY_STRINGS.removeLineOfKm('1,234km')).toBe('1,234km の線を消す');
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
