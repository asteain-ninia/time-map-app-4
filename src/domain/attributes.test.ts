import { describe, expect, it } from 'vitest';
import {
  basicAttributesEqual,
  colorInfoEqual,
  createBasicAttributes,
  createColorInfo,
  withAutoColorEnabled,
  withBorderColor,
  withEndYear,
  withFillColor,
  withName,
  withSelectedColor,
  withStartYear,
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
    expect(withSelectedColor(c, '#abcdef').selectedColor).toBe('#abcdef');
    expect(withBorderColor(c, '#abcdef').borderColor).toBe('#abcdef');
    expect(c.fillColor).toBe('#111111');
  });
});
