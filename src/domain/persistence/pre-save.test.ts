// 保存の直前の整合検査（司令塔の決定 (3)）の検査。
//
// 固定するのは 3 つ。
//   1. 素直な企画は止めない（空配列は真値）。
//   2. 「持ち主の居ない系列」「消えた親を指す parentId」を見つける。
//   3. 文言に地物の名前が載り、取り消しで戻れることを伝える。

import { describe, expect, it } from 'vitest';

import { aggregate, anchorOf, fid, leafTile } from '../deletion/fixtures';
import { timePointYear } from '../time/time-point';

import { PRE_SAVE_PROBLEM, checkBeforeSave, preSaveBlockMessage } from './pre-save';
import type { DomainProject, FeatureHistory } from './serialize';

function projectOf(histories: readonly FeatureHistory[]): DomainProject {
  return { histories } as unknown as DomainProject;
}

function historyOf(owner: string, features: Parameters<typeof anchorOf>[1], vertices: Parameters<typeof anchorOf>[2]): FeatureHistory {
  return {
    featureId: fid(owner),
    series: {
      entries: [
        { anchor: anchorOf(`anchor-${owner}`, features, vertices), start: timePointYear(1000), end: null },
      ],
    },
  };
}

describe('checkBeforeSave — 開き直すと地物が失われる形を保存前に見つける', () => {
  it('素直な企画は止めない', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    const project = projectOf([historyOf('agg', [agg, a.feature], a.vertices)]);
    expect(checkBeforeSave(project)).toEqual([]);
    expect(preSaveBlockMessage(checkBeforeSave(project), () => undefined)).toBeNull();
  });

  it('持ち主が自分の錨に居ない歴史を見つける', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const project = projectOf([historyOf('gone', [a.feature], a.vertices)]);
    expect(checkBeforeSave(project)).toEqual([
      { kind: PRE_SAVE_PROBLEM.OrphanHistory, featureId: fid('gone') },
    ]);
  });

  it('どこにも居ない親を指している parentId を見つける', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const project = projectOf([historyOf('a', [a.feature], a.vertices)]);
    expect(checkBeforeSave(project)).toEqual([
      {
        kind: PRE_SAVE_PROBLEM.DanglingParent,
        featureId: fid('a'),
        parentId: fid('gone-parent'),
      },
    ]);
  });

  it('同じ組み合わせは 1 件に畳む（錨の数だけ並べない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const history: FeatureHistory = {
      featureId: fid('a'),
      series: {
        entries: [1000, 1200].map((year) => ({
          anchor: anchorOf(`anchor-a-${year}`, [a.feature], a.vertices),
          start: timePointYear(year),
          end: null,
        })),
      },
    };
    expect(checkBeforeSave(projectOf([history]))).toHaveLength(1);
  });

  it('親が別の年にだけ居るなら止めない（歴史の中に居れば消えていない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    const project = projectOf([
      {
        featureId: fid('agg'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-agg-1000', [agg], []), start: timePointYear(1000), end: null },
          ],
        },
      },
      historyOf('a', [a.feature], a.vertices),
    ]);
    expect(checkBeforeSave(project)).toEqual([]);
  });
});

describe('preSaveBlockMessage — 保存を止める理由', () => {
  it('地物の名前と、取り消しで戻せることを載せる', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const problems = checkBeforeSave(projectOf([historyOf('a', [a.feature], a.vertices)]));
    const message = preSaveBlockMessage(problems, (id) => (id === fid('a') ? '南ケナ州' : undefined));
    expect(message).toContain('保存を中止しました');
    expect(message).toContain('南ケナ州');
    expect(message).toContain('Ctrl+Z');
  });

  it('件数が 2 件以上なら「ほか」で畳む', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const b = leafTile('b', 10, 0, 10, 10, 'gone-parent');
    const project = projectOf([
      historyOf('a', [a.feature], a.vertices),
      historyOf('b', [b.feature], b.vertices),
    ]);
    const message = preSaveBlockMessage(checkBeforeSave(project), () => undefined);
    expect(message).toContain('2 件');
    expect(message).toContain('ほか');
  });
});
