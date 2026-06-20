import { describe, expect, it } from 'vitest';

import {
  parseHex,
  rgbToHex,
  rgbToHsl,
  hslToRgb,
  deriveSelectedColor,
  deriveColor,
} from './color-math';

describe('color-math: hex parsing', () => {
  it('parses #rrggbb', () => {
    expect(parseHex('#4e79a7')).toEqual({ r: 0x4e, g: 0x79, b: 0xa7 });
  });

  it('parses #rgb shorthand', () => {
    expect(parseHex('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc });
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(parseHex('  #4E79A7 ')).toEqual({ r: 0x4e, g: 0x79, b: 0xa7 });
  });

  it('returns null for malformed input (never throws — 教訓 5.26)', () => {
    expect(parseHex('not-a-color')).toBeNull();
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('#1234')).toBeNull();
  });
});

describe('color-math: hsl round-trip', () => {
  it('round-trips common colors within 1 channel step', () => {
    for (const hex of ['#4e79a7', '#f28e2b', '#59a14f', '#000000', '#ffffff', '#808080']) {
      const rgb = parseHex(hex);
      expect(rgb).not.toBeNull();
      if (rgb === null) continue;
      const hsl = rgbToHsl(rgb.r, rgb.g, rgb.b);
      const back = hslToRgb(hsl);
      const reHex = rgbToHex(back.r, back.g, back.b);
      const reRgb = parseHex(reHex);
      expect(reRgb).not.toBeNull();
      if (reRgb === null) continue;
      expect(Math.abs(reRgb.r - rgb.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(reRgb.g - rgb.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(reRgb.b - rgb.b)).toBeLessThanOrEqual(1);
    }
  });
});

describe('color-math: selection color (FR-101 brighter & more vivid)', () => {
  it('selected is lighter and at least as saturated as the fill', () => {
    const fill = '#4e79a7';
    const selected = deriveSelectedColor(fill);
    const fr = parseHex(fill);
    const sr = parseHex(selected);
    expect(fr).not.toBeNull();
    expect(sr).not.toBeNull();
    if (fr === null || sr === null) return;
    const fh = rgbToHsl(fr.r, fr.g, fr.b);
    const sh = rgbToHsl(sr.r, sr.g, sr.b);
    expect(sh.l).toBeGreaterThan(fh.l);
    expect(sh.s).toBeGreaterThanOrEqual(fh.s);
  });

  it('is deterministic (same fill -> same selected color)', () => {
    expect(deriveSelectedColor('#59a14f')).toBe(deriveSelectedColor('#59a14f'));
  });

  it('returns the input unchanged for an unparseable color (graceful)', () => {
    expect(deriveSelectedColor('garbage')).toBe('garbage');
  });
});

describe('color-math: derived color (FR-101 deterministic derivation)', () => {
  it('is deterministic for the same (base, step)', () => {
    expect(deriveColor('#4e79a7', 1)).toBe(deriveColor('#4e79a7', 1));
    expect(deriveColor('#4e79a7', 3)).toBe(deriveColor('#4e79a7', 3));
  });

  it('different steps from the same base differ', () => {
    expect(deriveColor('#4e79a7', 1)).not.toBe(deriveColor('#4e79a7', 2));
  });

  it('produces a valid hex token', () => {
    expect(parseHex(deriveColor('#4e79a7', 2))).not.toBeNull();
  });
});
