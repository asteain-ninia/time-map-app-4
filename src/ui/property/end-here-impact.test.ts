// 決定 (2)「集約地物を終わらせる前に、下位領域が最上位になることを見せる」の文を固定する。

import { describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';

import { anchorDeleteImpactView } from './AnchorList';
import { buildEndHereImpactView, cascadedImpactLines, intervalCascadeStatus } from './end-here-impact';

describe('一緒に終わる集約地物の文（B78: 終わらせる板と錨を消す板が同じ 1 本を使う）', () => {
  it('記録ごと無くなるものと、その年から終わるものを言い分け、同じ行を繰り返さない', () => {
    expect(
      cascadedImpactLines([
        { name: '連邦 G', yearLabel: '1200年', whole: true },
        { name: '連邦 G', yearLabel: '1400年', whole: true },
        { name: '王国 H', yearLabel: '1500年', whole: false },
      ]),
    ).toEqual([
      '集約地物「連邦 G」はどの年にも下位領域が居なくなるので、記録ごと無くなります（所属を変えて下位領域を全て失ったときと同じ）',
      '集約地物「王国 H」は下位領域を全て失うので、1500年から終わります',
    ]);
  });

  it('錨を消す板: 一緒に無くなるものを「一緒に終わるもの」の群で言う。無ければ群は空', () => {
    const start = timePointYear(1200);
    const gone = anchorDeleteImpactView(start, [{ name: '連邦 G', yearLabel: '1200年', whole: true }]);
    const group = gone.groups.find((g) => g.testId === 'cascaded');
    expect(group?.heading).toBe('一緒に終わるもの');
    expect(group?.lines[0]).toContain('記録ごと無くなります');
    expect(anchorDeleteImpactView(start).groups.find((g) => g.testId === 'cascaded')?.lines).toEqual([]);
  });
});

describe('存続期間の編集のあとの状態行の文（B78）', () => {
  it('記録ごと無くなるものだけ', () => {
    expect(intervalCascadeStatus([], ['連邦 G'])).toBe(
      '存続期間を変えました。どの年にも下位領域が居なくなった「連邦 G」は、記録ごと無くなりました。',
    );
  });
  it('その年から終わるものと両方', () => {
    expect(intervalCascadeStatus(['王国 H'], ['連邦 G'])).toBe(
      '存続期間を変えました。下位領域を全て失った「王国 H」は、その年から終わりました。どの年にも下位領域が居なくなった「連邦 G」は、記録ごと無くなりました。',
    );
  });
  it('名前が 1 つも無ければ何も言わない', () => {
    expect(intervalCascadeStatus([], [])).toBeNull();
  });
});

describe('buildEndHereImpactView — 集約地物を終わらせる前の影響（決定 (2)）', () => {
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

  it('後ろの続いていた記録が一緒に終わる・集約地物が一緒に終わるときは、その行を出す（手直し 3 回目 / 締め D）', () => {
    const view = buildEndHereImpactView({
      targetName: '合成州 02',
      yearLabel: '1400年',
      promotedCount: 0,
      promotedNames: [],
      trimmedCount: 2,
      cascaded: [{ name: '第一連邦', yearLabel: '1400年' }],
    });
    expect(view.groups.find((g) => g.testId === 'ends')?.lines[1]).toBe(
      '1400年より後の、途切れずに続いていた記録（中身の変わる記録 2 件）も一緒に終わります',
    );
    expect(view.groups.find((g) => g.testId === 'cascaded')?.lines).toEqual([
      '集約地物「第一連邦」は下位領域を全て失うので、1400年から終わります',
    ]);
  });

  it('別の上位領域への後の所属が一緒に終わる・集約地物が記録ごと無くなるときは、その行を出す（4 回目 #1・#2）', () => {
    const view = buildEndHereImpactView({
      targetName: '州 a',
      yearLabel: '1400年',
      promotedCount: 0,
      promotedNames: [],
      laterAffiliations: [{ name: '連邦 G', yearLabel: '1700年' }],
      cascaded: [{ name: '連邦 G', yearLabel: '1700年', whole: true }],
    });
    expect(view.groups.find((g) => g.testId === 'ends')?.lines).toContain(
      '1700年からの「連邦 G」への所属も一緒に終わります（「連邦 G」の下位領域から外れます）',
    );
    expect(view.groups.find((g) => g.testId === 'cascaded')?.lines).toEqual([
      '集約地物「連邦 G」はどの年にも下位領域が居なくなるので、記録ごと無くなります（所属を変えて下位領域を全て失ったときと同じ）',
    ]);
  });
});
