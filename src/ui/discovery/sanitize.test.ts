import { describe, expect, it } from 'vitest';

import { toSearchableText } from './sanitize';

describe('toSearchableText (検索前の整え, FR-116)', () => {
  it('作業メモはプレーンテキストなので、記法や HTML の形をした文字もそのまま探せる', () => {
    expect(toSearchableText('**ローマ** <b>帝国</b> [図](img.png)')).toBe(
      '**ローマ** <b>帝国</b> [図](img.png)',
    );
  });

  it('collapses whitespace and trims', () => {
    expect(toSearchableText('  多くの\n\n空白  ')).toBe('多くの 空白');
  });

  it('drops invisible zero-width code points (not matched by \\s)', () => {
    // U+200B between words and a U+FEFF (BOM) at the edge must not leak into the
    // searchable text nor split a word into two search tokens.
    expect(toSearchableText('﻿ローマ​帝国')).toBe('ローマ帝国');
  });
});
