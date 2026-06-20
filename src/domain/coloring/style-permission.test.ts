import { describe, expect, it } from 'vitest';

import { createColorInfo } from '../attributes';
import {
  colorValuesEditable,
  paletteSelectable,
  autoColorToggleable,
  manualColorsOnDisable,
  applyAutoColors,
} from './style-permission';

describe('style-permission: single color-edit gate (FR-102 / 教訓 5.13)', () => {
  it('color values are editable iff auto-color is OFF', () => {
    expect(colorValuesEditable(false)).toBe(true);
    expect(colorValuesEditable(true)).toBe(false);
  });

  it('palette selector and auto-color toggle are operable in both states', () => {
    expect(paletteSelectable()).toBe(true);
    expect(autoColorToggleable()).toBe(true);
  });
});

describe('style-permission: ON->OFF preserves auto colors (FR-100 / 教訓 5.5)', () => {
  it('disabling auto-color keeps current colors, only flips the flag', () => {
    const auto = createColorInfo(true, '#4e79a7', '#7da3c9', '#222222');
    const manual = manualColorsOnDisable(auto);
    expect(manual.autoColorEnabled).toBe(false);
    expect(manual.fillColor).toBe('#4e79a7'); // preserved, not reset
    expect(manual.selectedColor).toBe('#7da3c9'); // preserved
    expect(manual.borderColor).toBe('#222222'); // untouched
  });
});

describe('style-permission: applyAutoColors writes system colors with ON', () => {
  it('sets fill + selected and marks auto-color enabled', () => {
    const before = createColorInfo(false, '#000000', '#000000', '#222222');
    const after = applyAutoColors(before, '#59a14f', '#7bbf72');
    expect(after.autoColorEnabled).toBe(true);
    expect(after.fillColor).toBe('#59a14f');
    expect(after.selectedColor).toBe('#7bbf72');
    expect(after.borderColor).toBe('#222222');
  });
});
