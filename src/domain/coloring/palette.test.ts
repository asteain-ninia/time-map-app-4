import { describe, expect, it } from 'vitest';

import { parseHex } from './color-math';
import {
  DEFAULT_PALETTE,
  DEFAULT_BASE_COLORS,
  createPalette,
  baseColorCount,
  colorAtIndex,
  isBaseColorIndex,
} from './palette';

describe('palette: base colors', () => {
  it('default palette exposes its base colors verbatim', () => {
    DEFAULT_BASE_COLORS.forEach((c, i) => {
      expect(colorAtIndex(DEFAULT_PALETTE, i)).toBe(c);
    });
    expect(baseColorCount(DEFAULT_PALETTE)).toBe(DEFAULT_BASE_COLORS.length);
  });

  it('createPalette falls back to default base colors when empty', () => {
    const p = createPalette('custom', []);
    expect(p.baseColors).toEqual(DEFAULT_BASE_COLORS);
  });

  it('createPalette keeps a non-empty custom set', () => {
    const p = createPalette('custom', ['#111111', '#222222']);
    expect(p.baseColors).toEqual(['#111111', '#222222']);
    expect(isBaseColorIndex(p, 0)).toBe(true);
    expect(isBaseColorIndex(p, 1)).toBe(true);
    expect(isBaseColorIndex(p, 2)).toBe(false);
  });
});

describe('palette: deterministic expansion beyond base colors (FR-101)', () => {
  it('indices >= baseCount produce derived colors', () => {
    const n = baseColorCount(DEFAULT_PALETTE);
    const derived = colorAtIndex(DEFAULT_PALETTE, n);
    expect(parseHex(derived)).not.toBeNull();
    expect(isBaseColorIndex(DEFAULT_PALETTE, n)).toBe(false);
  });

  it('expansion is deterministic (same palette + index -> same color)', () => {
    const n = baseColorCount(DEFAULT_PALETTE) + 2;
    expect(colorAtIndex(DEFAULT_PALETTE, n)).toBe(colorAtIndex(DEFAULT_PALETTE, n));
  });

  it('the first derived index does not equal its source base color', () => {
    const n = baseColorCount(DEFAULT_PALETTE);
    expect(colorAtIndex(DEFAULT_PALETTE, n)).not.toBe(colorAtIndex(DEFAULT_PALETTE, 0));
  });
});
