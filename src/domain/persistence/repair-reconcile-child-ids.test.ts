// 「子の並びを揃える」修復（ReconcileChildIds）を時刻ごとに当てる検査（増分 7 の手直し 2 回目 /
// バグ狩り §3 の開き直し）。
//
// 子が自分の系列を持つ集約地物（連邦化で束ねた・外から移した子）の子は、集約地物の錨の中には
// 居ない。錨 1 枚だけで子を数え直すと子の並びが空になり、時刻ごとの検査では食い違いが
// 残ったまま（修復しても「解消できなかった」）になっていた。アプリが以前の版で書いた
// ファイル（子を先に終わらせてから親を終わらせた形）を開くと、ここで止まっていた。

import { describe, expect, it } from 'vitest';

import { aggregate, anchorOf, fid, leafTile } from '../deletion/fixtures';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';

import { checkConsistency, INCONSISTENCY } from './consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from './fixtures';
import { applyRepairChecked, REPAIR_OPTION } from './repair';
import type { DomainProject } from './serialize';

const CAL = getCalendar('gregorian');

/** 連邦 agg（自分の系列）と、自分の系列を持つ子 a・b。a は 1200 年に終わったのに、agg の子の並びには a が残っている。 */
function staleChildList(): DomainProject {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  return {
    histories: [
      {
        featureId: fid('agg'),
        series: { entries: [{ anchor: anchorOf('agg-1000', [aggregate('agg', ['a', 'b'])], []), start: timePointYear(1000), end: null }] },
      },
      {
        featureId: fid('a'),
        series: { entries: [{ anchor: anchorOf('a-1000', [a.feature], a.vertices), start: timePointYear(1000), end: timePointYear(1200) }] },
      },
      {
        featureId: fid('b'),
        series: { entries: [{ anchor: anchorOf('b-1000', [b.feature], b.vertices), start: timePointYear(1000), end: null }] },
      },
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

describe('ReconcileChildIds — 子が自分の系列を持つ集約地物も、時刻ごとの所属で揃える', () => {
  it('子が先に終わった年から、子の並びを外して解消する（子の並びを空にしない）', () => {
    const project = staleChildList();
    const inc = checkConsistency(project, CAL).inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.TreeTopology && i.detail === 'child-parent-mismatch',
    );
    expect(inc).toBeDefined();
    const applied = applyRepairChecked(project, inc!, REPAIR_OPTION.ReconcileChildIds, CAL);
    expect(applied.resolved).toBe(true);
    expect(applied.remaining.inconsistencies).toEqual([]);
    const agg = applied.project.histories.find((h) => h.featureId === fid('agg'))!;
    const childIdsAt = agg.series.entries.map((e) => {
      const f = e.anchor.snapshot.features.find((x) => x.id === fid('agg'));
      return [e.start.year, f?.kind === 'aggregate' ? f.childIds.map(String) : []];
    });
    expect(childIdsAt).toEqual([
      [1000, ['a', 'b']],
      [1200, ['b']],
    ]);
  });
});
