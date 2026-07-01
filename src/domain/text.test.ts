import { describe, expect, it } from 'vitest';

import {
  hasVisibleText,
  stripInvisible,
  stripInvisibleThenTrim,
} from './text';

describe('stripInvisible (不可視ゼロ幅コードポイント除去, 教訓 5.30 単一真実源)', () => {
  it('removes each zero-width / invisible code point but keeps visible text', () => {
    expect(stripInvisible('a​b‌‍‎‏⁠﻿c')).toBe(
      'abc',
    );
  });

  it('leaves ordinary text (incl. surrogate-pair emoji) untouched', () => {
    expect(stripInvisible('ローマ帝国 😀')).toBe('ローマ帝国 😀');
  });
});

describe('stripInvisibleThenTrim', () => {
  it('is empty for an invisible-only string (so a fallback can fire)', () => {
    expect(stripInvisibleThenTrim('​﻿⁠')).toBe('');
    expect(stripInvisibleThenTrim('  ​  ')).toBe('');
  });

  it('trims surrounding whitespace around the visible core', () => {
    expect(stripInvisibleThenTrim('  ​ローマ​  ')).toBe('ローマ');
  });
});

describe('hasVisibleText', () => {
  it('is false when only invisible / whitespace remains', () => {
    expect(hasVisibleText('​﻿')).toBe(false);
    expect(hasVisibleText('   ')).toBe(false);
    expect(hasVisibleText('')).toBe(false);
  });

  it('is true when a visible glyph survives', () => {
    expect(hasVisibleText(' ​a ')).toBe(true);
  });
});
