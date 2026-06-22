import { describe, expect, it } from 'vitest';
import {
  basicAttributesEqual,
  colorInfoEqual,
  createBasicAttributes,
  createColorInfo,
  DEFAULT_OPACITY,
  DEFAULT_PALETTE_THEME_ID,
  withAutoColorEnabled,
  withBorderColor,
  withEndYear,
  withFillColor,
  withFillOpacity,
  withName,
  withPaletteTheme,
  withSelectedColor,
  withSelectedOpacity,
  withStartYear,
  DEFAULT_NEW_FEATURE_FILL_OPACITY,
} from './attributes';

// Criterion 8 + criterion 5: attribute/color types exist with full withXxx
// coverage and value equality; updates are immutable.

describe('basic attributes (FR-97)', () => {
  const base = createBasicAttributes('Rome', -753, 476);

  it('value equality', () => {
    expect(basicAttributesEqual(base, createBasicAttributes('Rome', -753, 476))).toBe(true);
    expect(basicAttributesEqual(base, createBasicAttributes('Rome', -752, 476))).toBe(false);
  });

  it('withXxx covers every attribute immutably', () => {
    expect(withName(base, 'Roma')).toEqual({ name: 'Roma', startYear: -753, endYear: 476 });
    expect(withStartYear(base, -700)).toEqual({ name: 'Rome', startYear: -700, endYear: 476 });
    expect(withEndYear(base, 1453)).toEqual({ name: 'Rome', startYear: -753, endYear: 1453 });
    expect(base).toEqual({ name: 'Rome', startYear: -753, endYear: 476 });
  });
});

describe('color info (FR-97)', () => {
  const c = createColorInfo(true, '#111111', '#222222', '#333333');

  it('value equality', () => {
    expect(colorInfoEqual(c, createColorInfo(true, '#111111', '#222222', '#333333'))).toBe(true);
    expect(colorInfoEqual(c, createColorInfo(false, '#111111', '#222222', '#333333'))).toBe(false);
  });

  it('withXxx covers every attribute immutably', () => {
    expect(withAutoColorEnabled(c, false).autoColorEnabled).toBe(false);
    expect(withFillColor(c, '#abcdef').fillColor).toBe('#abcdef');
    expect(withFillOpacity(c, 0.4).fillOpacity).toBe(0.4);
    expect(withSelectedColor(c, '#abcdef').selectedColor).toBe('#abcdef');
    expect(withSelectedOpacity(c, 0.6).selectedOpacity).toBe(0.6);
    expect(withBorderColor(c, '#abcdef').borderColor).toBe('#abcdef');
    expect(withPaletteTheme(c, 'warm').paletteTheme).toBe('warm');
    expect(c.fillColor).toBe('#111111');
  });

  it('透過度（アルファ）is a persisted style attribute (U33 spec 行23-26 / AC1・AC5)', () => {
    // 既定は不透明（1）。明示指定はそのまま保持される。
    const def = createColorInfo(true, '#111', '#222', '#333');
    expect(def.fillOpacity).toBe(DEFAULT_OPACITY);
    expect(def.selectedOpacity).toBe(DEFAULT_OPACITY);
    const explicit = createColorInfo(true, '#111', '#222', '#333', 'default', 0.3, 0.7);
    expect(explicit.fillOpacity).toBe(0.3);
    expect(explicit.selectedOpacity).toBe(0.7);
    // equality は透過度の差にも反応する（透過のみの編集が no-op にならない）。
    expect(
      colorInfoEqual(
        createColorInfo(true, '#111', '#222', '#333', 'default', 0.3, 1),
        createColorInfo(true, '#111', '#222', '#333', 'default', 1, 1),
      ),
    ).toBe(false);
    expect(
      colorInfoEqual(
        createColorInfo(true, '#111', '#222', '#333', 'default', 1, 0.3),
        createColorInfo(true, '#111', '#222', '#333', 'default', 1, 1),
      ),
    ).toBe(false);
  });

  it('HB3-13: the new-feature default fill opacity is translucent (0.7) and distinct from the deserialize default (1)', () => {
    expect(DEFAULT_NEW_FEATURE_FILL_OPACITY).toBe(0.7);
    // It is genuinely translucent so new 面 do not hide what is under them…
    expect(DEFAULT_NEW_FEATURE_FILL_OPACITY).toBeLessThan(1);
    // …and it is a SEPARATE concept from the "absent in manifest ⇒ opaque" default.
    expect(DEFAULT_NEW_FEATURE_FILL_OPACITY).not.toBe(DEFAULT_OPACITY);
    // Stamping it onto a default color yields a translucent fill, opaque elsewhere.
    const newFeatureColor = withFillOpacity(
      createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
      DEFAULT_NEW_FEATURE_FILL_OPACITY,
    );
    expect(newFeatureColor.fillOpacity).toBe(0.7);
    expect(newFeatureColor.selectedOpacity).toBe(DEFAULT_OPACITY);
  });

  it('paletteTheme is a persisted style attribute (U33 AC1)', () => {
    // 使用パレット（テーマ名）defaults to既定 when not supplied; explicit value sticks.
    expect(createColorInfo(true, '#111', '#222', '#333').paletteTheme).toBe(
      DEFAULT_PALETTE_THEME_ID,
    );
    expect(createColorInfo(true, '#111', '#222', '#333', 'warm').paletteTheme).toBe('warm');
    // equality is sensitive to the palette theme (so a palette-only edit is not no-op).
    expect(
      colorInfoEqual(
        createColorInfo(true, '#111', '#222', '#333', 'warm'),
        createColorInfo(true, '#111', '#222', '#333', 'cool'),
      ),
    ).toBe(false);
  });

  it('every withXxx PRESERVES the palette theme AND both opacities (no withXxx silently drops a style attribute)', () => {
    const themed = createColorInfo(true, '#111111', '#222222', '#333333', 'warm', 0.3, 0.7);
    expect(withAutoColorEnabled(themed, false).paletteTheme).toBe('warm');
    expect(withFillColor(themed, '#abcdef').paletteTheme).toBe('warm');
    expect(withSelectedColor(themed, '#abcdef').paletteTheme).toBe('warm');
    expect(withBorderColor(themed, '#abcdef').paletteTheme).toBe('warm');
    // 透過度（アルファ）も同様に全 withXxx で保持される（教訓 5.17 全網羅）。
    expect(withAutoColorEnabled(themed, false).fillOpacity).toBe(0.3);
    expect(withFillColor(themed, '#abcdef').selectedOpacity).toBe(0.7);
    expect(withPaletteTheme(themed, 'cool').fillOpacity).toBe(0.3);
    expect(withBorderColor(themed, '#abcdef').selectedOpacity).toBe(0.7);
    // and the opacity-setters preserve everything else, including the palette.
    expect(withFillOpacity(themed, 0.9).paletteTheme).toBe('warm');
    expect(withFillOpacity(themed, 0.9).selectedOpacity).toBe(0.7);
    expect(withSelectedOpacity(themed, 0.1).fillOpacity).toBe(0.3);
  });
});
