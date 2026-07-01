import { describe, expect, it } from 'vitest';

import {
  MAX_QUERY_LENGTH,
  VALIDATION_REASON,
  validateDepthThreshold,
  validateOpacity,
  validateSearchQuery,
  validationMessage,
} from './validation';
import { VALIDATION_STRINGS } from './strings';

describe('validateSearchQuery (FR-116 自己適用, 教訓 5.26)', () => {
  it('accepts and trims a non-empty query', () => {
    const r = validateSearchQuery('  ローマ  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('ローマ');
  });

  it('rejects empty/whitespace with reason+message one-to-one', () => {
    const r = validateSearchQuery('   ');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(VALIDATION_REASON.EmptyQuery);
      expect(r.message).toBe(VALIDATION_STRINGS.emptyQuery);
    }
  });

  it('rejects an over-long query', () => {
    const r = validateSearchQuery('あ'.repeat(MAX_QUERY_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(VALIDATION_REASON.QueryTooLong);
  });

  it('counts length by code point, so MAX emoji (surrogate pairs) still fit', () => {
    // Each 😀 is 2 UTF-16 units but 1 code point: a .max() unit-count bound would
    // reject at half the limit; the code-point bound accepts exactly MAX.
    const r = validateSearchQuery('😀'.repeat(MAX_QUERY_LENGTH));
    expect(r.ok).toBe(true);
  });

  it('rejects an emoji query one code point over the limit', () => {
    const r = validateSearchQuery('😀'.repeat(MAX_QUERY_LENGTH + 1));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe(VALIDATION_REASON.QueryTooLong);
  });

  it('rejects an invisible-only query as empty (not too-long)', () => {
    const r = validateSearchQuery('​﻿⁠');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(VALIDATION_REASON.EmptyQuery);
      expect(r.message).toBe(VALIDATION_STRINGS.emptyQuery);
    }
  });

  it('strips invisible code points around a visible query', () => {
    const r = validateSearchQuery('​ローマ﻿');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('ローマ');
  });
});

describe('validateOpacity (FR-116 透明度の数値範囲)', () => {
  it('accepts values in [0, 1]', () => {
    expect(validateOpacity(0).ok).toBe(true);
    expect(validateOpacity(1).ok).toBe(true);
    expect(validateOpacity(0.5).ok).toBe(true);
  });

  it('rejects out-of-range / non-finite with the matching message', () => {
    for (const bad of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = validateOpacity(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe(VALIDATION_REASON.OpacityOutOfRange);
        expect(r.message).toBe(VALIDATION_STRINGS.opacityOutOfRange);
      }
    }
  });
});

describe('validateDepthThreshold (FR-116 フィルター設定値)', () => {
  it('accepts non-negative integers', () => {
    expect(validateDepthThreshold(0).ok).toBe(true);
    expect(validateDepthThreshold(3).ok).toBe(true);
  });

  it('rejects negatives and non-integers', () => {
    expect(validateDepthThreshold(-1).ok).toBe(false);
    expect(validateDepthThreshold(1.5).ok).toBe(false);
  });
});

describe('validationMessage maps every reason to a日本語 message', () => {
  it('covers every reason (一対一, 教訓 5.26)', () => {
    for (const reason of Object.values(VALIDATION_REASON)) {
      expect(validationMessage(reason).length).toBeGreaterThan(0);
    }
  });
});
