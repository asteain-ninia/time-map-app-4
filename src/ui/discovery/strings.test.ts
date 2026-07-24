import { describe, expect, it } from 'vitest';

import { MENU_ITEM_KIND, MENU_ITEM_LABEL } from '../../domain/context-menu/index';

import {
  DIAGNOSTICS_STRINGS,
  ERROR_HANDLING_STRINGS,
  FILTER_STRINGS,
  SEARCH_STRINGS,
  VALIDATION_STRINGS,
} from './strings';

// FR-115: 文言は日本語で定数モジュールへ集約。FR-118: ヘルプ/例示/ツールチップを付与。
// 教訓 5.30: 先行ユニット (U20) と重複する文言モジュールを二重に作らない。

const JP = /[ぁ-んァ-ヶ一-龠]/;

describe('discovery strings are Japanese (FR-115)', () => {
  it('filter labels/help/example are Japanese and non-empty (FR-118)', () => {
    expect(FILTER_STRINGS.sectionTitle).toMatch(JP);
    expect(FILTER_STRINGS.sectionHelp.length).toBeGreaterThan(0);
    expect(FILTER_STRINGS.depthExample).toContain('例:');
    expect(FILTER_STRINGS.opacityHint).toMatch(JP);
    expect(FILTER_STRINGS.emphasizeHint).toMatch(JP);
  });

  it('FR-113 表示制御の右クリック文言は U41 文言集約と一字一句一致する (drift 防止)', () => {
    // The domain menu (items.ts) cannot import a ui module (layer direction), so the two
    // 表示制御 labels exist in both places. This test is the drift guard that keeps the
    // duplicate in lock-step — a rewording in one module without the other turns it red.
    expect(MENU_ITEM_LABEL[MENU_ITEM_KIND.HideFeature]).toBe(FILTER_STRINGS.individualHideLabel);
    expect(MENU_ITEM_LABEL[MENU_ITEM_KIND.EmphasizeFeature]).toBe(
      FILTER_STRINGS.emphasizeFeatureLabel,
    );
    expect(MENU_ITEM_LABEL[MENU_ITEM_KIND.UnemphasizeFeature]).toBe(
      FILTER_STRINGS.emphasizeClearLabel,
    );
    // Phase 2 のパネル文言も日本語で非空.
    expect(FILTER_STRINGS.emphasizeKindGroupLabel).toMatch(JP);
    expect(FILTER_STRINGS.emphasizeKindGroupHint).toMatch(JP);
    expect(FILTER_STRINGS.emphasizeClearAllLabel).toMatch(JP);
  });

  it('search help + query-format example are present (FR-118)', () => {
    expect(SEARCH_STRINGS.help).toMatch(JP);
    expect(SEARCH_STRINGS.example).toContain('例:');
    expect(SEARCH_STRINGS.jumpNotPresent).toMatch(JP);
  });

  it('validation messages are Japanese (FR-115 / 教訓 5.26)', () => {
    for (const msg of Object.values(VALIDATION_STRINGS)) {
      expect(msg).toMatch(JP);
    }
  });

  it('error messages describe 何が起きたか + どう対処するか (FR-118 / FR-115)', () => {
    // 報告案内 (回復不能時)
    expect(ERROR_HANDLING_STRINGS.reportHint).toContain('開発者へ報告');
    // フォールバックは原因と対処を含む
    expect(ERROR_HANDLING_STRINGS.fallbackBody).toMatch(JP);
  });

  it('diagnostics view states offline/privacy policy (FR-117 / FR-02)', () => {
    expect(DIAGNOSTICS_STRINGS.privacyNote).toContain('外部送信');
    expect(DIAGNOSTICS_STRINGS.help).toMatch(JP);
  });
});
