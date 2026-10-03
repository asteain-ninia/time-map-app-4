// 保存の直前の整合検査（司令塔の決定 (3)）の検査。
//
// 固定するのは 3 つ。
//   1. 素直な企画は止めない（空配列は真値）。
//   2. 「持ち主の居ない系列」「消えた親を指す parentId」を見つける。
//   3. 文言に地物の名前が載り、取り消しで戻れることを伝える。

import { describe, expect, it } from 'vitest';

import { aggregate, anchorOf, fid, leafTile } from '../deletion/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';

import {
  PRE_SAVE_PROBLEM,
  checkBeforeSave,
  isBlockingPreSaveProblem,
  preSaveBlockMessage,
  preSaveConfirmLines,
} from './pre-save';
import type { DomainProject, FeatureHistory } from './serialize';

const calendar = getCalendar('gregorian');

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
    expect(checkBeforeSave(project, calendar)).toEqual([]);
    expect(preSaveBlockMessage(checkBeforeSave(project, calendar), () => undefined)).toBeNull();
  });

  it('持ち主が自分の錨に居ない歴史を見つける', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const project = projectOf([historyOf('gone', [a.feature], a.vertices)]);
    expect(checkBeforeSave(project, calendar)).toEqual([
      { kind: PRE_SAVE_PROBLEM.OrphanHistory, featureId: fid('gone') },
    ]);
  });

  it('どこにも居ない親を指している parentId を見つける', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const project = projectOf([historyOf('a', [a.feature], a.vertices)]);
    expect(checkBeforeSave(project, calendar)).toEqual([
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
    expect(checkBeforeSave(projectOf([history]), calendar)).toHaveLength(1);
  });

  it('同じ年に親が居れば何も言わない', () => {
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
    expect(checkBeforeSave(project, calendar)).toEqual([]);
  });

  it('親が **別の年にだけ** 居るなら止めずに聞く（年をまたぐ食い違い。B67 / GPT #4）', () => {
    // 親 agg は 1200 年から。子 a は 1000 年から agg を指している（1000〜1200 年は居ない親）。
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a']);
    const project = projectOf([
      {
        featureId: fid('agg'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-agg-1200', [agg], []), start: timePointYear(1200), end: null },
          ],
        },
      },
      historyOf('a', [a.feature], a.vertices),
    ]);
    const problems = checkBeforeSave(project, calendar);
    expect(problems).toEqual([
      {
        kind: PRE_SAVE_PROBLEM.ParentAbsentThatYear,
        featureId: fid('a'),
        parentId: fid('agg'),
        atTime: timePointYear(1000),
      },
    ]);
    expect(problems.some(isBlockingPreSaveProblem)).toBe(false);
    // 止める文は出ない（行き止まりにしない）。聞く板の文は名前と年で言う。
    expect(preSaveBlockMessage(problems, () => undefined)).toBeNull();
    const lines = preSaveConfirmLines(
      problems,
      (id) => (id === fid('a') ? '南ケナ州' : id === fid('agg') ? 'デーレ共和国' : undefined),
      (at) => `${String(at.year)}年`,
    );
    // 次に開いたときに既定の修復が何をするかまで言う（手直し 3 回目 1-3）。
    expect(lines).toEqual([
      '「南ケナ州」は1000年に、その年には居ない上位領域「デーレ共和国」を指しています → 次に開くと、上位領域が居ない年の間だけ最上位にします',
    ]);
  });

  it('まとめ役の下位領域の一覧がその年の所属と食い違うなら聞く（子が先に終わった形。バグ狩り §3）', () => {
    // a は [1000, 1200) だけ居るのに、agg の子の並びは 1000 年からずっと a を載せている。
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a', 'b']);
    const project = projectOf([
      {
        featureId: fid('agg'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-agg-1000', [agg], []), start: timePointYear(1000), end: null },
          ],
        },
      },
      {
        featureId: fid('a'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: timePointYear(1000), end: timePointYear(1200) },
          ],
        },
      },
      historyOf('b', [b.feature], b.vertices),
    ]);
    const problems = checkBeforeSave(project, calendar);
    expect(problems.map((p) => [p.kind, p.featureId, p.atTime?.year])).toEqual([
      [PRE_SAVE_PROBLEM.ChildListMismatch, fid('agg'), 1200],
    ]);
    expect(problems.some(isBlockingPreSaveProblem)).toBe(false);
  });

  it('どの年にも居ない親は、年をまたぐ食い違いとしては重ねて出さない（止める側だけ）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const problems = checkBeforeSave(projectOf([historyOf('a', [a.feature], a.vertices)]), calendar);
    expect(problems.map((p) => p.kind)).toEqual([PRE_SAVE_PROBLEM.DanglingParent]);
    expect(problems.every(isBlockingPreSaveProblem)).toBe(true);
  });
});

describe('preSaveBlockMessage — 保存を止める理由', () => {
  it('地物の名前と、取り消しで戻せることを載せる', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'gone-parent');
    const problems = checkBeforeSave(projectOf([historyOf('a', [a.feature], a.vertices)]), calendar);
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
    const message = preSaveBlockMessage(checkBeforeSave(project, calendar), () => undefined);
    expect(message).toContain('2 件');
    expect(message).toContain('ほか');
  });
});

describe('preSaveConfirmLines — 次に開いたときの直し方を、実際に起きることと合わせる（手直し 4 回目 #1 (ii)）', () => {
  it('どの年にも下位領域が無いまとめ役には「無くします」と約束せず、聞かれることを言う', () => {
    const lonely = projectOf([
      {
        featureId: fid('L'),
        series: { entries: [{ anchor: anchorOf('anchor-L', [aggregate('L', [])], []), start: timePointYear(1000), end: null }] },
      },
    ]);
    const problems = checkBeforeSave(lonely, calendar);
    expect(problems.map((p) => [p.kind, p.intervalRepairable])).toEqual([[PRE_SAVE_PROBLEM.EmptyAggregate, false]]);
    const [line] = preSaveConfirmLines(problems, () => '孤立した連邦', (at) => `${String(at.year)}年`);
    expect(line).toContain('どうするかを聞かれます');
    expect(line).not.toContain('無くします');
  });

  it('子の居る年があるまとめ役には、子の居ない年の間だけ無くすと言う', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const project = projectOf([
      {
        featureId: fid('F'),
        series: {
          entries: [
            { anchor: anchorOf('anchor-F-1000', [aggregate('F', ['a'])], []), start: timePointYear(1000), end: null },
            { anchor: anchorOf('anchor-F-1300', [aggregate('F', [])], []), start: timePointYear(1300), end: null },
          ],
        },
      },
      {
        featureId: fid('a'),
        series: { entries: [{ anchor: anchorOf('anchor-a', [a.feature], a.vertices), start: timePointYear(1000), end: timePointYear(1300) }] },
      },
    ]);
    const problems = checkBeforeSave(project, calendar).filter((p) => p.kind === PRE_SAVE_PROBLEM.EmptyAggregate);
    expect(problems.map((p) => p.intervalRepairable)).toEqual([true]);
    const [line] = preSaveConfirmLines(problems, () => '連邦', (at) => `${String(at.year)}年`);
    expect(line).toContain('下位領域の居ない年の間だけ');
  });
});
