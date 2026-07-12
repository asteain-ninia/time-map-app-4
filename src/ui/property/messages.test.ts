// UI layer (U32): 種別の日本語表示ラベル (表示層の単一写像, 要件定義書 §4).
//
// 実機報告「種別: aggregate って何? 日本語で」の回帰ロック。ドメインの kind 生値
// (point/line/leaf/aggregate) を詳細パネル等に出さず、要件定義書 §4 の日本語用語へ
// 表示層で写像することを固定する。ドメインの kind 値は不変・本写像は表示専用。

import { describe, expect, it } from 'vitest';

import { FEATURE_KIND } from '../../domain/feature';

import { featureKindJaLabel } from './messages';

describe('featureKindJaLabel (種別の日本語表示, 表示層)', () => {
  it('maps every domain kind to its 要件定義書 §4 Japanese term', () => {
    expect(featureKindJaLabel(FEATURE_KIND.Point)).toBe('点情報');
    expect(featureKindJaLabel(FEATURE_KIND.Line)).toBe('線情報');
    expect(featureKindJaLabel(FEATURE_KIND.Leaf)).toBe('末端地物');
    expect(featureKindJaLabel(FEATURE_KIND.Aggregate)).toBe('集約地物');
  });

  it('never leaks the raw English enum 生値 for any kind', () => {
    for (const kind of Object.values(FEATURE_KIND)) {
      const label = featureKindJaLabel(kind);
      // The label must be Japanese, never the discriminant string itself.
      expect(label).not.toBe(kind);
      expect(/^[a-z]+$/.test(label)).toBe(false);
    }
  });
});
