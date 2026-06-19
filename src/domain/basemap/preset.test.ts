// U18 preset / displayed-base-map resolution tests (FR-03, 受け入れ基準 1 / 2).
// The three preset-display triggers funnel through one decision.

import { describe, expect, it } from 'vitest';

import { basemapNotice } from './messages';
import {
  BASEMAP_FALLBACK_REASON,
  BASEMAP_OUTCOME,
  type BasemapDecision,
} from './format';
import {
  DISPLAYED_BASEMAP,
  FULL_WORLD_META,
  PRESET_BASEMAP_ID,
  resolveDisplayedBasemap,
} from './preset';

describe('resolveDisplayedBasemap (受け入れ基準 1)', () => {
  it('初回起動 (empty ref) → preset', () => {
    const r = resolveDisplayedBasemap('');
    expect(r.kind).toBe(DISPLAYED_BASEMAP.Preset);
    expect(r.source).toBe(PRESET_BASEMAP_ID);
  });

  it('新規 (explicit preset id) → preset', () => {
    expect(resolveDisplayedBasemap(PRESET_BASEMAP_ID).kind).toBe(DISPLAYED_BASEMAP.Preset);
  });

  it('読込失敗 (user ref not loadable) → preset (FR-03)', () => {
    const r = resolveDisplayedBasemap('maps/user.png', false);
    expect(r.kind).toBe(DISPLAYED_BASEMAP.Preset);
    expect(r.source).toBe(PRESET_BASEMAP_ID);
  });

  it('loadable user ref → user map at full-world meta', () => {
    const r = resolveDisplayedBasemap('maps/user.png', true);
    expect(r.kind).toBe(DISPLAYED_BASEMAP.User);
    expect(r.source).toBe('maps/user.png');
    expect(r.meta).toEqual(FULL_WORLD_META);
  });

  it('preset spans the full 2:1 world (受け入れ基準 2)', () => {
    const m = resolveDisplayedBasemap('').meta;
    expect(m.lonEast - m.lonWest).toBe(360);
    expect(m.latNorth - m.latSouth).toBe(180);
  });
});

describe('basemapNotice (日本語, 教訓 5.26)', () => {
  const adopted: BasemapDecision = {
    outcome: BASEMAP_OUTCOME.Adopted,
    source: 's',
    dimensions: { widthPx: 2, heightPx: 1 },
    registerCopy: true,
  };
  const corrected: BasemapDecision = {
    outcome: BASEMAP_OUTCOME.CorrectedAndAdopted,
    source: 's',
    dimensions: { widthPx: 2, heightPx: 1 },
    registerCopy: true,
  };
  const fallbackUncorrectable: BasemapDecision = {
    outcome: BASEMAP_OUTCOME.FallbackToPreset,
    reason: BASEMAP_FALLBACK_REASON.Uncorrectable,
    registerCopy: false,
  };
  const fallbackInvalid: BasemapDecision = {
    outcome: BASEMAP_OUTCOME.FallbackToPreset,
    reason: BASEMAP_FALLBACK_REASON.InvalidImage,
    registerCopy: false,
  };

  it('each outcome yields a non-empty 日本語 notice', () => {
    for (const d of [adopted, corrected, fallbackUncorrectable, fallbackInvalid]) {
      expect(basemapNotice(d).length).toBeGreaterThan(0);
    }
  });

  it('fallback notices mention プリセット', () => {
    expect(basemapNotice(fallbackUncorrectable)).toContain('プリセット');
    expect(basemapNotice(fallbackInvalid)).toContain('プリセット');
  });
});
