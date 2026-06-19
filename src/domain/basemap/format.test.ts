// U18 base-map format/correction/fallback decision tests (FR-04, 受け入れ基準
// 3 / 4 / 5 / 15). Boundary cases: aspect exactly 2:1, slightly off, correctable,
// uncorrectable, invalid input.

import { describe, expect, it } from 'vitest';

import {
  BASEMAP_FALLBACK_REASON,
  BASEMAP_OUTCOME,
  IMAGE_VALIDATION_ERROR,
  MAX_IMAGE_DIMENSION_PX,
  aspectRatio,
  correctedDimensions,
  decideBasemapReplacement,
  isCorrectable,
  isFormatAdequate,
  validateImageDescriptor,
} from './format';

const desc = (widthPx: number, heightPx: number, source = 'maps/user.png') => ({
  widthPx,
  heightPx,
  source,
});

describe('validateImageDescriptor (boundary, FR-116 / R8)', () => {
  it('accepts a valid integer in-range descriptor', () => {
    const v = validateImageDescriptor(desc(3600, 1800));
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.descriptor.widthPx).toBe(3600);
      expect(v.descriptor.source).toBe('maps/user.png');
    }
  });

  it('rejects non-finite dimensions', () => {
    const v = validateImageDescriptor(desc(Number.NaN, 1800));
    expect(v).toEqual({ ok: false, error: IMAGE_VALIDATION_ERROR.NotFinite });
  });

  it('rejects fractional dimensions', () => {
    const v = validateImageDescriptor(desc(3600.5, 1800));
    expect(v).toEqual({ ok: false, error: IMAGE_VALIDATION_ERROR.NotInteger });
  });

  it('rejects a degenerate tiny image', () => {
    const v = validateImageDescriptor(desc(1, 1));
    expect(v).toEqual({ ok: false, error: IMAGE_VALIDATION_ERROR.TooSmall });
  });

  it('rejects an absurdly large image', () => {
    const v = validateImageDescriptor(desc(MAX_IMAGE_DIMENSION_PX + 1, 1800));
    expect(v).toEqual({ ok: false, error: IMAGE_VALIDATION_ERROR.TooLarge });
  });
});

describe('format adequacy (aspect 2:1)', () => {
  it('aspectRatio = width/height', () => {
    expect(aspectRatio({ widthPx: 3600, heightPx: 1800, source: '' })).toBe(2);
  });

  it('exactly 2:1 is adequate', () => {
    expect(isFormatAdequate({ widthPx: 3600, heightPx: 1800, source: '' })).toBe(true);
  });

  it('within tolerance (3601x1800) is adequate', () => {
    expect(isFormatAdequate({ widthPx: 3601, heightPx: 1800, source: '' })).toBe(true);
  });

  it('clearly off 2:1 is inadequate', () => {
    expect(isFormatAdequate({ widthPx: 4000, heightPx: 1800, source: '' })).toBe(false);
  });
});

describe('correctability + corrected dimensions', () => {
  it('a moderately-off aspect is correctable', () => {
    expect(isCorrectable({ widthPx: 3000, heightPx: 1800, source: '' })).toBe(true);
  });

  it('an extreme banner (10:1) is not correctable', () => {
    expect(isCorrectable({ widthPx: 10000, heightPx: 1000, source: '' })).toBe(false);
  });

  it('an extreme portrait (1:5) is not correctable', () => {
    expect(isCorrectable({ widthPx: 1000, heightPx: 5000, source: '' })).toBe(false);
  });

  it('too-wide corrects by growing height to halve aspect', () => {
    expect(correctedDimensions({ widthPx: 3000, heightPx: 1000, source: '' })).toEqual({
      widthPx: 3000,
      heightPx: 1500,
    });
  });

  it('too-tall corrects by growing width to double aspect', () => {
    expect(correctedDimensions({ widthPx: 1000, heightPx: 1000, source: '' })).toEqual({
      widthPx: 2000,
      heightPx: 1000,
    });
  });
});

describe('decideBasemapReplacement (fixed-order flow, 教訓 5.26)', () => {
  it('adequate → Adopted, registers copy', () => {
    const d = decideBasemapReplacement(validateImageDescriptor(desc(3600, 1800)));
    expect(d.outcome).toBe(BASEMAP_OUTCOME.Adopted);
    if (d.outcome === BASEMAP_OUTCOME.Adopted) {
      expect(d.registerCopy).toBe(true);
      expect(d.source).toBe('maps/user.png');
      expect(d.dimensions).toEqual({ widthPx: 3600, heightPx: 1800 });
    }
  });

  it('inadequate-but-correctable → CorrectedAndAdopted, registers copy', () => {
    const d = decideBasemapReplacement(validateImageDescriptor(desc(3000, 1000)));
    expect(d.outcome).toBe(BASEMAP_OUTCOME.CorrectedAndAdopted);
    if (d.outcome === BASEMAP_OUTCOME.CorrectedAndAdopted) {
      expect(d.registerCopy).toBe(true);
      expect(d.dimensions).toEqual({ widthPx: 3000, heightPx: 1500 });
    }
  });

  it('uncorrectable → FallbackToPreset, no copy (教訓 5.22)', () => {
    const d = decideBasemapReplacement(validateImageDescriptor(desc(10000, 1000)));
    expect(d.outcome).toBe(BASEMAP_OUTCOME.FallbackToPreset);
    if (d.outcome === BASEMAP_OUTCOME.FallbackToPreset) {
      expect(d.reason).toBe(BASEMAP_FALLBACK_REASON.Uncorrectable);
      expect(d.registerCopy).toBe(false);
    }
  });

  it('invalid input → FallbackToPreset (InvalidImage), no copy', () => {
    const d = decideBasemapReplacement(validateImageDescriptor(desc(Number.NaN, 1800)));
    expect(d.outcome).toBe(BASEMAP_OUTCOME.FallbackToPreset);
    if (d.outcome === BASEMAP_OUTCOME.FallbackToPreset) {
      expect(d.reason).toBe(BASEMAP_FALLBACK_REASON.InvalidImage);
      expect(d.registerCopy).toBe(false);
    }
  });
});
