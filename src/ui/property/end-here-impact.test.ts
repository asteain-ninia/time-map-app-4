// 決定 (2)「まとめ役を終わらせる前に、下位領域が最上位になることを見せる」の文を固定する。

import { describe, expect, it } from 'vitest';

import { buildEndHereImpactView } from './end-here-impact';

describe('buildEndHereImpactView — まとめ役を終わらせる前の影響（決定 (2)）', () => {
  it('件数と名前を「この年から最上位になります」で言い、題に名前と年が入る', () => {
    const view = buildEndHereImpactView({
      targetName: '正統ノル王国',
      yearLabel: '1500年',
      promotedCount: 14,
      promotedNames: ['北ノル州', '南ノル州', '東ノル州'],
    });
    expect(view.title).toBe('「正統ノル王国」を1500年で終わらせます');
    const promoted = view.groups.find((g) => g.testId === 'promoted');
    expect(promoted?.lines).toEqual([
      '下位領域 14 件（北ノル州・南ノル州 ほか 1 件）は、この年から最上位になります',
    ]);
    // 実行ボタンは素性欄のボタンと同じ文。
    expect(view.confirmLabel).toBe('1500年に終わったことにする');
    expect(view.note).toContain('Ctrl+Z');
  });

  it('名前が 1 件も引けなくても件数は言う', () => {
    const view = buildEndHereImpactView({
      targetName: 'A',
      yearLabel: '1200年',
      promotedCount: 2,
      promotedNames: [],
    });
    expect(view.groups.find((g) => g.testId === 'promoted')?.lines).toEqual([
      '下位領域 2 件は、この年から最上位になります',
    ]);
  });

  it('子が 0 件なら「最上位になるもの」の群は空（器が群ごと出さない）', () => {
    const view = buildEndHereImpactView({
      targetName: 'A',
      yearLabel: '1200年',
      promotedCount: 0,
      promotedNames: [],
    });
    expect(view.groups.find((g) => g.testId === 'promoted')?.lines).toEqual([]);
    expect(view.groups.find((g) => g.testId === 'ends')?.lines[0]).toContain('削除ではありません');
  });
});
