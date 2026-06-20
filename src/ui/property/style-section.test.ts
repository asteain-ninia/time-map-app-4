import { describe, expect, it } from 'vitest';

import { resolveStylePermissions, clampOpacity } from './style-section';

describe('style-section: permission resolution (FR-102 / 教訓 5.13)', () => {
  it('auto-color ON => color values read-only, palette + toggle operable', () => {
    const p = resolveStylePermissions(true);
    expect(p.colorValuesEditable).toBe(false);
    expect(p.paletteSelectable).toBe(true);
    expect(p.autoColorToggleable).toBe(true);
  });

  it('auto-color OFF => color values editable', () => {
    const p = resolveStylePermissions(false);
    expect(p.colorValuesEditable).toBe(true);
    expect(p.paletteSelectable).toBe(true);
    expect(p.autoColorToggleable).toBe(true);
  });
});

describe('style-section: opacity clamping', () => {
  it('clamps into [0,1] and defaults NaN to 1', () => {
    expect(clampOpacity(-0.5)).toBe(0);
    expect(clampOpacity(1.5)).toBe(1);
    expect(clampOpacity(0.4)).toBe(0.4);
    expect(clampOpacity(Number.NaN)).toBe(1);
  });
});
