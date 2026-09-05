// 「選択したものは必ず地図に見える」の規則（増分 4 の中身 9 / 設計書 §D.6）。
//
// ここで固定するのは 3 つ:
//   1. 必ず描く集合 ＝ 選択中の地物と **根までの道筋**（親を落とすと、どの国の中に
//      あるのか分からない）
//   3. **重ね順を保ったまま描画列の最後へ**（道筋の中どうしの前後関係は導出どおり）
//   - 何も移すものが無ければ **同じ配列を返す**（描画の memo を無駄に外さない）

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature } from '../../domain/feature';
import { buildForest } from '../../domain/hierarchy/forest';
import { asFeatureId, type FeatureId } from '../../domain/ids';
import { createShape } from '../../domain/ring';

import { alwaysDrawnIds, describeForcedDraw, raiseAlwaysDrawn } from './always-drawn';

const attrs = createBasicAttributes('X', 0, 100);
const color = createColorInfo(true, '#111111', '#222222', '#333333');
const f = (s: string): FeatureId => asFeatureId(s);

function forestOf(pairs: readonly [string, string | null][]) {
  return buildForest(
    pairs.map(([id, parent]) =>
      parent === null
        ? createLeafFeature(f(id), attrs, color, createShape())
        : createLeafFeature(f(id), attrs, color, createShape(), { parentId: f(parent) }),
    ),
  );
}

describe('必ず描く集合（設計書 §D.6 の規則 1）', () => {
  it('選んでいなければ空', () => {
    expect(alwaysDrawnIds(forestOf([['a', null]]), null).size).toBe(0);
  });

  it('選択中の地物と、根までの道筋が入る', () => {
    const forest = forestOf([
      ['root', null],
      ['mid', 'root'],
      ['leaf', 'mid'],
      ['other', null],
    ]);
    const ids = alwaysDrawnIds(forest, f('leaf'));
    expect([...ids].sort()).toEqual([f('leaf'), f('mid'), f('root')].sort());
    expect(ids.has(f('other'))).toBe(false);
  });

  it('森に居ない地物（点情報・線情報）は自分 1 件だけ', () => {
    const ids = alwaysDrawnIds(forestOf([['a', null]]), f('point-1'));
    expect([...ids]).toEqual([f('point-1')]);
  });

  it('親子が循環していても止まる（教訓 5.28）', () => {
    const ids = alwaysDrawnIds(
      forestOf([
        ['a', 'b'],
        ['b', 'a'],
      ]),
      f('a'),
    );
    expect(ids.size).toBeLessThanOrEqual(2);
  });
});

describe('重ね順（設計書 §D.6 の規則 3）', () => {
  const drawn = [{ id: 'p' }, { id: 'x' }, { id: 'c' }, { id: 'y' }];
  const idOf = (i: { id: string }): FeatureId => f(i.id);

  it('必ず描くものを、順序を保ったまま末尾へまとめて重ねる', () => {
    const out = raiseAlwaysDrawn(drawn, new Set([f('p'), f('c')]), idOf);
    expect(out.map((i) => i.id)).toEqual(['x', 'y', 'p', 'c']);
  });

  it('**道筋の中どうしの前後関係は導出どおり**（p が c より先のまま）', () => {
    const out = raiseAlwaysDrawn(drawn, new Set([f('c'), f('p')]), idOf);
    // 集合の並びではなく、**元の描画列の並び**が残る（FR-113 の導出規則を変えない）。
    expect(out.map((i) => i.id).slice(2)).toEqual(['p', 'c']);
  });

  it('必ず描くものが無ければ同じ配列をそのまま返す（memo を外さない）', () => {
    expect(raiseAlwaysDrawn(drawn, new Set(), idOf)).toBe(drawn);
    expect(raiseAlwaysDrawn(drawn, new Set([f('zzz')]), idOf)).toBe(drawn);
  });
});

describe('状態行の知らせ（設計書 §D.6 の規則 2）', () => {
  it('普通に描かれているときは何も言わない', () => {
    expect(
      describeForcedDraw(new Set([f('a')]), f('a'), 1, () => '出た'),
    ).toBeNull();
  });

  it('描かれていないときだけ、深さを添えて言う', () => {
    expect(
      describeForcedDraw(new Set([f('b')]), f('a'), 1, (d) => `深さ ${String(d)}`),
    ).toBe('深さ 1');
  });

  it('深さが引けないときも黙らない', () => {
    expect(
      describeForcedDraw(new Set(), f('a'), null, (d) => (d === null ? '深さ不明' : 'x')),
    ).toBe('深さ不明');
  });
});
