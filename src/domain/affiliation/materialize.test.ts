// 記録の置き場（司令塔の決定 (1)(2)）の検査。
//
// 固定するのは 4 つ。
//   1. 居候（自分の系列を持たないまとめ役の子）の記録が、全部の年ぶん自分の系列へ移る。
//   2. 親の錨からは外れ、頂点は「その地物が参照する分」だけ写る（共有は両方に残る）。
//   3. 既に自分の系列を持つ地物は触らない（二重に起こさない）。
//   4. 終わる年から先で最上位になる（前の年の「子だった」記録は残る）。

import { describe, expect, it } from 'vitest';

import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { aggregate, anchorOf, fid, leafTile } from '../deletion/fixtures';
import type { FeatureHistory } from '../persistence/serialize';

import {
  hasOwnSeries,
  materializeOwnSeries,
  promoteToTopLevelFrom,
  residentFeatureIds,
} from './materialize';

const calendar = getCalendar('gregorian');

/** まとめ役 `agg` の 1 本の歴史に、子 a・b が居候している形（実データと同じ形）。 */
function nestedProject(years: readonly number[] = [1000]): readonly FeatureHistory[] {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const agg = aggregate('agg', ['a', 'b']);
  const entries = years.map((year) => ({
    anchor: anchorOf(
      `anchor-agg-${year}`,
      [agg, a.feature, b.feature],
      [...a.vertices, ...b.vertices],
    ),
    start: timePointYear(year),
    end: null,
  }));
  return [{ featureId: fid('agg'), series: { entries } }];
}

describe('residentFeatureIds — まとめ役の錨に居候している地物', () => {
  it('自分の系列を持たない子を数え上げる（持ち主自身は含まない）', () => {
    expect(residentFeatureIds(nestedProject(), fid('agg'))).toEqual([fid('a'), fid('b')]);
  });

  it('既に自分の系列を持つ子は居候ではない', () => {
    const base = nestedProject();
    const moved = materializeOwnSeries(base, [fid('a')], calendar).histories;
    expect(residentFeatureIds(moved, fid('agg'))).toEqual([fid('b')]);
  });

  it('居ないまとめ役なら空', () => {
    expect(residentFeatureIds(nestedProject(), fid('nope'))).toEqual([]);
  });
});

describe('materializeOwnSeries — 記録を自分の系列へ起こす', () => {
  it('居候の記録が自分の系列になり、親の錨からは外れる', () => {
    const before = nestedProject();
    expect(hasOwnSeries(before, fid('a'))).toBe(false);

    const { histories, materializedIds } = materializeOwnSeries(before, [fid('a')], calendar);
    expect(materializedIds).toEqual([fid('a')]);
    expect(hasOwnSeries(histories, fid('a'))).toBe(true);

    const own = histories.find((h) => h.featureId === fid('a'));
    expect(own?.series.entries).toHaveLength(1);
    expect(own?.series.entries[0]?.anchor.snapshot.features.map((f) => f.id)).toEqual([fid('a')]);

    const parent = histories.find((h) => h.featureId === fid('agg'));
    expect(parent?.series.entries[0]?.anchor.snapshot.features.map((f) => f.id)).toEqual([
      fid('agg'),
      fid('b'),
    ]);
  });

  it('全部の年の記録を写す（carry-forward の意味が保たれる）', () => {
    const before = nestedProject([1000, 1200, 1400]);
    const { histories } = materializeOwnSeries(before, [fid('a')], calendar);
    const own = histories.find((h) => h.featureId === fid('a'));
    expect(own?.series.entries.map((e) => e.start.year)).toEqual([1000, 1200, 1400]);
    for (const history of histories) {
      for (const entry of history.series.entries) {
        expect(entry.anchor.snapshot.features.some((f) => f.id === fid('a'))).toBe(
          history.featureId === fid('a'),
        );
      }
    }
  });

  it('頂点はその地物が参照する分だけ写る（親には残りが残る）', () => {
    const before = nestedProject();
    const { histories } = materializeOwnSeries(before, [fid('a')], calendar);
    const own = histories.find((h) => h.featureId === fid('a'));
    const parent = histories.find((h) => h.featureId === fid('agg'));
    expect(
      [...(own?.series.entries[0]?.anchor.snapshot.vertices.byId.keys() ?? [])].sort(),
    ).toEqual(['v-a-0', 'v-a-1', 'v-a-2', 'v-a-3']);
    expect(
      [...(parent?.series.entries[0]?.anchor.snapshot.vertices.byId.keys() ?? [])].sort(),
    ).toEqual(['v-b-0', 'v-b-1', 'v-b-2', 'v-b-3']);
  });

  it('親の錨の id は変えない（錨表の行が入れ替わらない）', () => {
    const before = nestedProject();
    const { histories } = materializeOwnSeries(before, [fid('a')], calendar);
    const parent = histories.find((h) => h.featureId === fid('agg'));
    expect(parent?.series.entries[0]?.anchor.id).toBe(before[0]?.series.entries[0]?.anchor.id);
  });

  it('既に自分の系列を持つ地物は素通り（同一参照を返す）', () => {
    const before = nestedProject();
    const once = materializeOwnSeries(before, [fid('a')], calendar);
    const twice = materializeOwnSeries(once.histories, [fid('a')], calendar);
    expect(twice.materializedIds).toEqual([]);
    expect(twice.histories).toBe(once.histories);
  });

  it('どこにも記録が無い id は黙って飛ばす（空の系列を作らない）', () => {
    const before = nestedProject();
    const { histories, materializedIds } = materializeOwnSeries(before, [fid('ghost')], calendar);
    expect(materializedIds).toEqual([]);
    expect(histories).toBe(before);
  });

  it('親の錨が空になったらその歴史ごと落とす（持ち主の居ない系列を残さない）', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const orphan: readonly FeatureHistory[] = [
      {
        featureId: fid('gone'),
        series: {
          entries: [
            {
              anchor: anchorOf('anchor-gone', [a.feature], a.vertices),
              start: timePointYear(1000),
              end: null,
            },
          ],
        },
      },
    ];
    const { histories } = materializeOwnSeries(orphan, [fid('a')], calendar);
    expect(histories.map((h) => h.featureId)).toEqual([fid('a')]);
  });

  it('入力を変更しない（純関数）', () => {
    const before = nestedProject();
    const snapshotBefore: readonly string[] =
      before[0]?.series.entries[0]?.anchor.snapshot.features.map((f) => String(f.id)) ?? [];
    materializeOwnSeries(before, [fid('a'), fid('b')], calendar);
    expect(before[0]?.series.entries[0]?.anchor.snapshot.features.map((f) => String(f.id))).toEqual(
      snapshotBefore,
    );
  });
});

describe('promoteToTopLevelFrom — 終わる年から最上位にする（決定 (2)）', () => {
  it('その年から親を外し、前の年の「子だった」記録は残す', () => {
    const base = materializeOwnSeries(nestedProject([1000]), [fid('a')], calendar).histories;
    const after = promoteToTopLevelFrom(base, [fid('a')], timePointYear(1500), calendar);
    const own = after.find((h) => h.featureId === fid('a'));
    expect(own?.series.entries.map((e) => e.start.year)).toEqual([1000, 1500]);
    expect(own?.series.entries[0]?.anchor.snapshot.features[0]?.parentId).toBe(fid('agg'));
    expect(own?.series.entries[1]?.anchor.snapshot.features[0]?.parentId).toBeUndefined();
  });

  it('終わる年より後の錨からも親を外す（carry-forward が親を連れ戻さない）', () => {
    const base = materializeOwnSeries(nestedProject([1000, 1600]), [fid('a')], calendar).histories;
    const after = promoteToTopLevelFrom(base, [fid('a')], timePointYear(1500), calendar);
    const own = after.find((h) => h.featureId === fid('a'));
    expect(own?.series.entries.map((e) => e.start.year)).toEqual([1000, 1500, 1600]);
    expect(own?.series.entries[2]?.anchor.snapshot.features[0]?.parentId).toBeUndefined();
  });

  it('その年に錨があるならその錨を書き替える（本数は増えない）', () => {
    const base = materializeOwnSeries(nestedProject([1000, 1500]), [fid('a')], calendar).histories;
    const after = promoteToTopLevelFrom(base, [fid('a')], timePointYear(1500), calendar);
    const own = after.find((h) => h.featureId === fid('a'));
    expect(own?.series.entries).toHaveLength(2);
    expect(own?.series.entries[1]?.anchor.snapshot.features[0]?.parentId).toBeUndefined();
  });

  it('自分の系列を持たない地物には何もしない（先に起こすのが前提）', () => {
    const base = nestedProject();
    expect(promoteToTopLevelFrom(base, [fid('a')], timePointYear(1500), calendar)).toBe(base);
  });
});
