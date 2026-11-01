// 決定 (2)「集約地物を終わらせても子は道連れにせず、その年から最上位になる」を、
// **自分の系列を持つ子**（別の親から移された・連邦化で束ねられた子）でも固定する。
//
// 2026-10-03 に探針で見つけた: 確定（`createAnchorIntervalCommandForRoot`）が居候しか
// 数えていなかったので、自分の系列を持つ子は親が終わったあとも消えた親を指し続け、
// 開き直すと `tree-topology / dangling-parent` で修復を聞かれた。保存前の検査は年を
// 見ない（全年の和で親の存否を見る）ので、保存は止まらなかった。

import { describe, expect, it } from 'vitest';

import { materializeOwnSeries } from '../domain/affiliation/materialize';
import { aggregate, anchorOf, fid, leafTile } from '../domain/deletion/fixtures';
import { checkConsistency } from '../domain/persistence/consistency';
import { DEFAULT_BASEMAP, DEFAULT_SETTINGS } from '../domain/persistence/fixtures';
import type { FeatureHistory } from '../domain/persistence/serialize';
import { asAnchorId } from '../domain/ids';
import { getCalendar } from '../domain/time/calendar';
import { timePointYear } from '../domain/time/time-point';

import { createAnchorIntervalCommandForRoot, type DomainRoot } from './consistency-binding';
import { featuresAt } from './live-lookup';
import { buildSetEndIntent } from './property/index';

const calendar = getCalendar('gregorian');

/** 集約地物 agg に a（自分の系列を持つ子）と b（居候）が居る形。 */
function project(): DomainRoot {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const agg = aggregate('agg', ['a', 'b']);
  const histories: readonly FeatureHistory[] = [
    {
      featureId: fid('agg'),
      series: {
        entries: [
          {
            anchor: anchorOf('anchor-agg-1000', [agg, a.feature, b.feature], [...a.vertices, ...b.vertices]),
            start: timePointYear(1000),
            end: null,
          },
        ],
      },
    },
  ];
  return {
    histories: materializeOwnSeries(histories, [fid('a')], calendar).histories,
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  } as DomainRoot;
}

describe('集約地物を終わらせる — 自分の系列を持つ子も最上位になる（決定 (2)）', () => {
  it('終わったあとの年に、どの子も消えた親を指さず、整合検査が空', () => {
    const root = project();
    expect(checkConsistency(root, calendar).inconsistencies).toEqual([]);
    const built = createAnchorIntervalCommandForRoot(
      root,
      buildSetEndIntent(fid('agg'), asAnchorId('anchor-agg-1000'), timePointYear(1500)),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const after = built.command.execute(root).state;
    const at1600 = featuresAt(after, timePointYear(1600));
    expect(at1600.map((f) => String(f.id)).sort()).toEqual(['a', 'b']);
    for (const f of at1600) expect(f.parentId).toBeUndefined();
    // 終わる前の年は子のまま（記録は書き換えない）。
    const at1200 = featuresAt(after, timePointYear(1200));
    expect(at1200.find((f) => f.id === fid('a'))?.parentId).toBe(fid('agg'));
    expect(checkConsistency(after, calendar).inconsistencies).toEqual([]);
    // 取り消しは構築時の根へ戻す。
    expect(built.command.undo(after).state).toBe(root);
  });
});
