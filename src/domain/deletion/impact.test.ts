// U31 deletion — 「消す前に何が起きるかを見せる」説明器の検査（設計書 §A.3 / §N-3、
// 増分 7 の中身 6）。
//
// 所有者の裁定は「削除＝その地物の錨をすべて消し、子は最上位へ昇格。**消す前に影響を
// 見せる**」なので、ここで固定するのは **数え上げが実際の結果と一致すること**である
// （文言は UI 側の `delete-impact.test.ts` が見る）。

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../ids';

import { DELETE_VERDICT } from './eligibility';
import { aggregate, anchorOf, fid, leafTile, stateOf } from './fixtures';
import { describeDeletionImpact, directChildCountAt } from './impact';
import { createDeleteFeatureCommand } from './command';

describe('describeDeletionImpact — 削除の影響を数える（設計書 §A.3）', () => {
  it('集約地物を消すと、下位領域が「最上位へ移るもの」として全部挙がる', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a', 'b']);
    const state = stateOf(
      anchorOf('an-0', [agg, a.feature, b.feature], [...a.vertices, ...b.vertices]),
    );

    const impact = describeDeletionImpact(state, fid('agg'), [0]);

    expect([...impact.promotedChildIds].sort()).toEqual([fid('a'), fid('b')].sort());
    // 集約地物は自分の形を持たない（FR-35）ので、消える頂点は 0 個である。
    expect(impact.ownsShape).toBe(false);
    expect(impact.vertexCount).toBe(0);
    expect(impact.ownAnchorYears).toEqual([0]);
    expect(impact.verdict.kind).toBe(DELETE_VERDICT.Allowed);
  });

  it('末端を消すと、その地物が持っている頂点の数が出る', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const state = stateOf(anchorOf('an-0', [a.feature], a.vertices));

    const impact = describeDeletionImpact(state, fid('a'), [0]);

    expect(impact.ownsShape).toBe(true);
    expect(impact.vertexCount).toBe(4);
    expect(impact.promotedChildIds).toEqual([]);
    expect(impact.autoRemovedIds).toEqual([]);
  });

  it('最後の下位領域を消すと、空になる集約地物が「自動で消える地物」に挙がる', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    const state = stateOf(anchorOf('an-0', [agg, a.feature], a.vertices));

    const impact = describeDeletionImpact(state, fid('a'), [0]);

    expect(impact.autoRemovedIds).toEqual([fid('agg')]);
  });

  it('数え上げは、実際に消したあとの状態と一致する（説明が嘘をつかない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    const state = stateOf(anchorOf('an-0', [agg, a.feature], a.vertices));

    const impact = describeDeletionImpact(state, fid('a'), [0]);
    const after = createDeleteFeatureCommand(state, fid('a')).execute(state).state;
    const survivorIds = new Set(
      after.anchors.flatMap((an) => an.snapshot.features.map((f) => f.id)),
    );

    // 「自動で消える」と言ったものは、本当に消えている。
    for (const id of impact.autoRemovedIds) expect(survivorIds.has(id)).toBe(false);
  });

  it('全部の年を横断して数える（ある年にだけ子が居る場合も落とさない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const aggOnlyA = aggregate('agg', ['a']);
    const aggBoth = aggregate('agg', ['a', 'b']);
    const state = stateOf(
      anchorOf('an-0', [aggOnlyA, a.feature], a.vertices),
      anchorOf('an-1', [aggBoth, a.feature, b.feature], [...a.vertices, ...b.vertices]),
    );

    const impact = describeDeletionImpact(state, fid('agg'), [0, 1200]);

    expect([...impact.promotedChildIds].sort()).toEqual([fid('a'), fid('b')].sort());
    expect(impact.ownAnchorYears).toEqual([0, 1200]);
  });

  it('居ない地物は「見つからない」判定になる（no-op ガードが判定として出る）', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const state = stateOf(anchorOf('an-0', [a.feature], a.vertices));

    const impact = describeDeletionImpact(state, asFeatureId('nope'));

    expect(impact.verdict.kind).toBe(DELETE_VERDICT.Rejected);
    expect(impact.ownAnchorYears).toEqual([]);
  });

  it('錨の開始年は昇順に並べ直す（呼び出し側の並びに依らない）', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const state = stateOf(anchorOf('an-0', [a.feature], a.vertices));

    expect(describeDeletionImpact(state, fid('a'), [1200, 0, 800]).ownAnchorYears).toEqual([
      0, 800, 1200,
    ]);
  });
});

describe('directChildCountAt — その年の直接の下位領域の数', () => {
  it('集約地物の直接の子だけを数える（孫は数えない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a', 'b']);

    expect(directChildCountAt([agg, a.feature, b.feature], fid('agg'))).toBe(2);
    expect(directChildCountAt([agg, a.feature, b.feature], fid('a'))).toBe(0);
  });
});
