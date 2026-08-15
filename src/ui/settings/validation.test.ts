// U38 pure-logic tests: settings validation + defaults factory + draft diff.
// Single-run under Vitest, no DOM (NFR 5.8 / 受け入れ基準 8). Boundary cases
// (min=max year, FPS 0/1/60/61, equator 0/negative, opacity bounds) are covered
// (開発ガイド 1.9 境界網羅).

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_PROJECT_SETTINGS,
  type AppSettings,
  type ProjectSettings,
} from '../state/settings';

import {
  changedAppKeys,
  changedProjectKeys,
  isAppNoOp,
  isProjectNoOp,
} from './diff';
import {
  REJECTION,
  defaultAppSettings,
  defaultProjectSettings,
  validateAppSettings,
  validateProjectSettings,
} from './validation';

const projectOf = (over: Partial<ProjectSettings>): ProjectSettings => ({
  ...DEFAULT_PROJECT_SETTINGS,
  ...over,
});
const appOf = (over: Partial<AppSettings>): AppSettings => ({
  ...DEFAULT_APP_SETTINGS,
  ...over,
});

function errorFields(
  r: ReturnType<typeof validateProjectSettings> | ReturnType<typeof validateAppSettings>,
): readonly string[] {
  return r.ok ? [] : r.errors.map((e) => e.field);
}

describe('defaults factory (受け入れ基準 4 / 5: 単一の真実源)', () => {
  it('project defaults equal U16 defaults (same source)', () => {
    expect(defaultProjectSettings()).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it('project defaults supply the spec timeline range 0〜10000 年 (FR-66, 受け入れ基準 4 / 5)', () => {
    // Pin the spec-mandated default directly, not only equality to the U16
    // constant, so the new-project initialisation entry never drifts from the
    // spec value (U38.md 行37・68・114・166・194, FR-66).
    expect(defaultProjectSettings().timelineMinYear).toBe(0);
    expect(defaultProjectSettings().timelineMaxYear).toBe(10000);
  });

  it('app defaults equal U16 defaults (snap 50px, 60 FPS, FR-110)', () => {
    expect(defaultAppSettings()).toEqual(DEFAULT_APP_SETTINGS);
    expect(defaultAppSettings().snapDistancePx).toBe(50);
    expect(defaultAppSettings().renderFps).toBe(60);
  });

  it('default factory returns a fresh customPalette array (no shared mutation)', () => {
    const a = defaultProjectSettings();
    const b = defaultProjectSettings();
    expect(a.customPalette).not.toBe(b.customPalette);
  });
});

describe('validateProjectSettings (FR-109, 受け入れ基準 7 / 8)', () => {
  it('accepts the defaults', () => {
    expect(validateProjectSettings(DEFAULT_PROJECT_SETTINGS).ok).toBe(true);
  });

  it('rejects min >= max year (boundary: equal)', () => {
    const r = validateProjectSettings(projectOf({ timelineMinYear: 5, timelineMaxYear: 5 }));
    expect(errorFields(r)).toContain('timelineMinYear');
    if (!r.ok) expect(r.errors.some((e) => e.message === REJECTION.timelineOrder)).toBe(true);
  });

  it('rejects min > max year', () => {
    const r = validateProjectSettings(projectOf({ timelineMinYear: 10, timelineMaxYear: 0 }));
    expect(errorFields(r)).toContain('timelineMinYear');
  });

  it('accepts min < max year (including negative min)', () => {
    expect(validateProjectSettings(projectOf({ timelineMinYear: -3000, timelineMaxYear: 0 })).ok).toBe(true);
  });

  // 第6波バグハント HIGH/data-loss: 書込側(この検証)は yearSchema(読込側)と同じ境界
  // (整数・±MAX_YEAR=±1,000,000)で拒否しないと、フォームが受理した年が .gimoza に保存され
  // 次回ロードで manifest 全体が Invalid 拒否=自分の正当ファイルが二度と開けない(書込⊄読込)。
  it('rejects a timeline year beyond ±MAX_YEAR (書込⊆読込: 保存ファイルの再ロード不能を防ぐ)', () => {
    const overMax = validateProjectSettings(projectOf({ timelineMinYear: 0, timelineMaxYear: 1_000_001 }));
    expect(errorFields(overMax)).toContain('timelineMaxYear');
    if (!overMax.ok) {
      expect(overMax.errors.some((e) => e.message === REJECTION.timelineYearBound)).toBe(true);
    }
    expect(validateProjectSettings(projectOf({ timelineMinYear: -1_000_001, timelineMaxYear: 0 })).ok).toBe(
      false,
    );
    expect(validateProjectSettings(projectOf({ timelineMinYear: 0, timelineMaxYear: 2_000_000 })).ok).toBe(
      false,
    );
  });

  it('rejects a non-integer timeline year (yearSchema は整数のみ受理)', () => {
    expect(
      errorFields(validateProjectSettings(projectOf({ timelineMinYear: 0, timelineMaxYear: 100.5 }))),
    ).toContain('timelineMaxYear');
    expect(
      errorFields(validateProjectSettings(projectOf({ timelineMinYear: 0.5, timelineMaxYear: 10 }))),
    ).toContain('timelineMinYear');
  });

  it('accepts the ±MAX_YEAR boundary (過剰拒否しない)', () => {
    expect(
      validateProjectSettings(projectOf({ timelineMinYear: -1_000_000, timelineMaxYear: 1_000_000 })).ok,
    ).toBe(true);
  });

  it('rejects equator length 0 and negative', () => {
    expect(errorFields(validateProjectSettings(projectOf({ equatorLengthKm: 0 })))).toContain('equatorLengthKm');
    expect(errorFields(validateProjectSettings(projectOf({ equatorLengthKm: -1 })))).toContain('equatorLengthKm');
  });

  it('accepts a positive equator length', () => {
    expect(validateProjectSettings(projectOf({ equatorLengthKm: 1 })).ok).toBe(true);
  });

  it('rejects flattening < 0 and >= 1, accepts [0,1)', () => {
    expect(errorFields(validateProjectSettings(projectOf({ flattening: -0.01 })))).toContain('flattening');
    expect(errorFields(validateProjectSettings(projectOf({ flattening: 1 })))).toContain('flattening');
    expect(validateProjectSettings(projectOf({ flattening: 0 })).ok).toBe(true);
    expect(validateProjectSettings(projectOf({ flattening: 0.5 })).ok).toBe(true);
  });

  it('rejects an off-list grid spacing, accepts 5/10/15/30', () => {
    expect(errorFields(validateProjectSettings(projectOf({ gridSpacingDeg: 7 })))).toContain('gridSpacingDeg');
    for (const s of [5, 10, 15, 30]) {
      expect(validateProjectSettings(projectOf({ gridSpacingDeg: s })).ok).toBe(true);
    }
  });

  it('rejects grid opacity outside [0,1] (boundaries inclusive)', () => {
    expect(errorFields(validateProjectSettings(projectOf({ gridOpacity: -0.1 })))).toContain('gridOpacity');
    expect(errorFields(validateProjectSettings(projectOf({ gridOpacity: 1.1 })))).toContain('gridOpacity');
    expect(validateProjectSettings(projectOf({ gridOpacity: 0 })).ok).toBe(true);
    expect(validateProjectSettings(projectOf({ gridOpacity: 1 })).ok).toBe(true);
  });

  // FR-13 グリッド ON/OFF切替 (受け入れ基準 9): gridVisible is a boolean.
  it('accepts gridVisible true and false (FR-13 boolean 受理)', () => {
    expect(validateProjectSettings(projectOf({ gridVisible: true })).ok).toBe(true);
    expect(validateProjectSettings(projectOf({ gridVisible: false })).ok).toBe(true);
  });

  it('rejects a non-boolean gridVisible (defensive; schema z.boolean() と対応)', () => {
    const bad = projectOf({ gridVisible: 'yes' as unknown as boolean });
    expect(errorFields(validateProjectSettings(bad))).toContain('gridVisible');
    expect(validateProjectSettings(bad).ok).toBe(false);
  });

  it('rejects occupancy threshold outside [0,1]', () => {
    expect(errorFields(validateProjectSettings(projectOf({ areaLabelOccupancyThreshold: 2 })))).toContain('areaLabelOccupancyThreshold');
    expect(validateProjectSettings(projectOf({ areaLabelOccupancyThreshold: 0.5 })).ok).toBe(true);
  });

  it('rejects an out-of-range zoom limit (FR-10, U39 integration)', () => {
    // Below the 0.1× floor → rejected inline at the zoomMin field.
    expect(errorFields(validateProjectSettings(projectOf({ zoomMin: 0.05 })))).toContain('zoomMin');
    // Above the 10000× ceiling → rejected at zoomMax.
    expect(errorFields(validateProjectSettings(projectOf({ zoomMax: 20000 })))).toContain('zoomMax');
  });

  it('rejects zoom min > max (FR-10 reversed input)', () => {
    expect(errorFields(validateProjectSettings(projectOf({ zoomMin: 60, zoomMax: 10 })))).toContain('zoomMin');
  });

  it('accepts an in-range zoom limit pair', () => {
    expect(validateProjectSettings(projectOf({ zoomMin: 0.5, zoomMax: 500 })).ok).toBe(true);
  });

  it('collects multiple errors at once', () => {
    const r = validateProjectSettings(
      projectOf({ equatorLengthKm: -1, timelineMinYear: 9, timelineMaxYear: 1 }),
    );
    expect(r.ok).toBe(false);
    expect(errorFields(r)).toEqual(expect.arrayContaining(['equatorLengthKm', 'timelineMinYear']));
  });

  it('rejects NaN numeric inputs (FR-115 reason)', () => {
    const r = validateProjectSettings(projectOf({ equatorLengthKm: Number.NaN }));
    expect(errorFields(r)).toContain('equatorLengthKm');
  });
});

describe('validateAppSettings (FR-110, 受け入れ基準 2 / 7 / 8)', () => {
  it('accepts the defaults', () => {
    expect(validateAppSettings(DEFAULT_APP_SETTINGS).ok).toBe(true);
  });

  it('rejects FPS 0 and 61, accepts 1 and 60 (boundary network)', () => {
    expect(errorFields(validateAppSettings(appOf({ renderFps: 0 })))).toContain('renderFps');
    expect(errorFields(validateAppSettings(appOf({ renderFps: 61 })))).toContain('renderFps');
    expect(validateAppSettings(appOf({ renderFps: 1 })).ok).toBe(true);
    expect(validateAppSettings(appOf({ renderFps: 60 })).ok).toBe(true);
  });

  it('FPS rejection reason is the FR-110 Japanese message', () => {
    const r = validateAppSettings(appOf({ renderFps: 100 }));
    if (!r.ok) expect(r.errors.some((e) => e.message === REJECTION.fpsRange)).toBe(true);
  });

  it('rejects negative snap distance, accepts 0 and positive', () => {
    expect(errorFields(validateAppSettings(appOf({ snapDistancePx: -1 })))).toContain('snapDistancePx');
    expect(validateAppSettings(appOf({ snapDistancePx: 0 })).ok).toBe(true);
    expect(validateAppSettings(appOf({ snapDistancePx: 50 })).ok).toBe(true);
  });

  it('rejects non-integer / negative marker cap, accepts 0 and integers', () => {
    expect(errorFields(validateAppSettings(appOf({ vertexMarkerCap: -5 })))).toContain('vertexMarkerCap');
    expect(errorFields(validateAppSettings(appOf({ vertexMarkerCap: 1.5 })))).toContain('vertexMarkerCap');
    expect(validateAppSettings(appOf({ vertexMarkerCap: 0 })).ok).toBe(true);
    expect(validateAppSettings(appOf({ vertexMarkerCap: 3000 })).ok).toBe(true);
  });

  // FR-74 (undo履歴上限を設定可能化): a positive integer; 0 / negative / fractional
  // are rejected, accepts the default 100 and small positive values.
  it('rejects non-positive / non-integer undo stack size, accepts positive integers', () => {
    expect(errorFields(validateAppSettings(appOf({ undoStackSize: 0 })))).toContain('undoStackSize');
    expect(errorFields(validateAppSettings(appOf({ undoStackSize: -3 })))).toContain('undoStackSize');
    expect(errorFields(validateAppSettings(appOf({ undoStackSize: 2.5 })))).toContain('undoStackSize');
    expect(validateAppSettings(appOf({ undoStackSize: 1 })).ok).toBe(true);
    expect(validateAppSettings(appOf({ undoStackSize: 100 })).ok).toBe(true);
  });
});

describe('draft→commit diff / no-op guard (教訓 5.24, 受け入れ基準 6)', () => {
  it('reports no changed project keys when draft equals baseline', () => {
    expect(changedProjectKeys(DEFAULT_PROJECT_SETTINGS, DEFAULT_PROJECT_SETTINGS)).toEqual([]);
    expect(isProjectNoOp(DEFAULT_PROJECT_SETTINGS, DEFAULT_PROJECT_SETTINGS)).toBe(true);
  });

  it('reports only the changed project keys', () => {
    const draft = projectOf({ equatorLengthKm: 12345, projectName: 'X' });
    expect(changedProjectKeys(DEFAULT_PROJECT_SETTINGS, draft)).toEqual(
      expect.arrayContaining(['equatorLengthKm', 'projectName']),
    );
    expect(changedProjectKeys(DEFAULT_PROJECT_SETTINGS, draft)).toHaveLength(2);
    expect(isProjectNoOp(DEFAULT_PROJECT_SETTINGS, draft)).toBe(false);
  });

  it('treats an equal-content customPalette array as unchanged', () => {
    const draft = projectOf({ customPalette: [...DEFAULT_PROJECT_SETTINGS.customPalette] });
    expect(changedProjectKeys(DEFAULT_PROJECT_SETTINGS, draft)).toEqual([]);
  });

  it('detects a customPalette content change', () => {
    const draft = projectOf({ customPalette: ['#ffffff'] });
    expect(changedProjectKeys(DEFAULT_PROJECT_SETTINGS, draft)).toEqual(['customPalette']);
  });

  it('reports no changed app keys for an unchanged draft, only changed ones otherwise', () => {
    expect(isAppNoOp(DEFAULT_APP_SETTINGS, DEFAULT_APP_SETTINGS)).toBe(true);
    expect(changedAppKeys(DEFAULT_APP_SETTINGS, appOf({ renderFps: 30 }))).toEqual(['renderFps']);
  });
});
