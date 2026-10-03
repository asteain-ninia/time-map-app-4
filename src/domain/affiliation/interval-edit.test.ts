// 存続期間の編集が所属の記録を一緒に動かすことの検査（増分 7 の手直し 2 回目）。
//
// 固定するのは次のとおり。
//   1. まとめ役を終わらせると、直接の子はその年から最上位になる（前の年の「子だった」記録は残る）。
//   2. 子が後の年に別の親へ移っていたら、その所属は外さない（反証 #1 / GPT #2）。
//   3. まとめ役が後の年の錨で再び現れるなら、子はその年から元の所属に戻る（殻を作らない）。
//   4. 孫は最上位にしない（反証 #5）。居候の孫も起こして、道連れに消さない。
//   5. 自分の系列を持つ子を終わらせると、親の子の並びからその年以後は外れる（バグ狩り §3 / D1）。
//   6. 開始年を後ろへ動かしたまとめ役の、居なくなった年の子も親を外す（GPT #4 の例）。
//   7. 終わりのある錨を割っても、後ろの片が終わりを越えて続かない。
//   8. 押す前の板の数え上げ（`planEnding`）と確定は同じ結果になる。

import { describe, expect, it } from 'vitest';

import { resolveAt, changeStart, setEnd, type AnchorSeries } from '../anchor-series';
import { aggregate, anchorOf, fid, leafTile } from '../deletion/fixtures';
import { withParentId, type Feature } from '../feature';
import type { FeatureId } from '../ids';
import type { FeatureHistory } from '../persistence/serialize';
import { checkConsistency } from '../persistence/consistency';
import type { DomainProject } from '../persistence/serialize';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';

import { materializeOwnSeries } from './materialize';
import {
  childrenPromotedByEnding,
  editFeatureInterval,
  emptyAggregateIntervals,
  endRunAt,
  hasGapAfter,
  planEnding,
  tailEmptyCuts,
  presenceOf,
  subtractIntervals,
  syncAggregateChildIds,
} from './interval-edit';

const calendar = getCalendar('gregorian');
const y = timePointYear;

function entryOf(id: string, year: number, features: readonly Feature[], vertices: Parameters<typeof anchorOf>[2], end: number | null = null) {
  return { anchor: anchorOf(`anchor-${id}-${year}`, features, vertices), start: y(year), end: end === null ? null : y(end) };
}

/** その年に `id` が居れば、その親（最上位なら null）。居なければ undefined。 */
function parentAt(histories: readonly FeatureHistory[], id: string, year: number): string | null | undefined {
  for (const h of histories) {
    const r = resolveAt(h.series, y(year), calendar);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === fid(id));
    if (f !== undefined) return f.parentId === undefined ? null : String(f.parentId);
  }
  return undefined;
}

function childIdsAt(histories: readonly FeatureHistory[], aggId: string, year: number): string[] | undefined {
  for (const h of histories) {
    const r = resolveAt(h.series, y(year), calendar);
    if (r.kind !== 'present') continue;
    const f = r.entry.anchor.snapshot.features.find((x) => x.id === fid(aggId));
    if (f !== undefined && f.kind === 'aggregate') return f.childIds.map(String).sort();
  }
  return undefined;
}

/** 「この年に終わったことにする」と同じ: その年から先の途切れずに続く記録をまとめて終わらせる。 */
function endHereAt(histories: readonly FeatureHistory[], id: string, year: number) {
  const own = histories.find((h) => h.featureId === fid(id))!;
  const r = resolveAt(own.series, y(year), calendar);
  if (r.kind !== 'present') throw new Error('absent');
  const anchorId = r.entry.anchor.id;
  return editFeatureInterval(histories, fid(id), (s: AnchorSeries) => endRunAt(s, fid(id), anchorId, y(year), calendar), calendar);
}

function endAt(histories: readonly FeatureHistory[], id: string, year: number) {
  const own = histories.find((h) => h.featureId === fid(id))!;
  const r = resolveAt(own.series, y(year), calendar);
  if (r.kind !== 'present') throw new Error('absent');
  const anchorId = r.entry.anchor.id;
  return editFeatureInterval(histories, fid(id), (s: AnchorSeries) => setEnd(s, anchorId, y(year), calendar), calendar);
}

function treeIssues(histories: readonly FeatureHistory[]): string[] {
  const report = checkConsistency({ histories } as unknown as DomainProject, calendar);
  return report.inconsistencies
    .filter((i) => i.kind === 'tree-topology')
    .map((i) => `${i.detail ?? ''}@${i.atTime?.year ?? '?'}:${i.featureIds.map(String).join(',')}`);
}

/** まとめ役 agg（1000 年〜、錨は `aggYears`）に居候 a・b。 */
function nested(aggYears: readonly number[] = [1000]): readonly FeatureHistory[] {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const agg = aggregate('agg', ['a', 'b']);
  return [
    {
      featureId: fid('agg'),
      series: { entries: aggYears.map((year) => entryOf('agg', year, [agg, a.feature, b.feature], [...a.vertices, ...b.vertices])) },
    },
  ];
}

describe('presenceOf / subtractIntervals', () => {
  it('終わりを打った区間が「居なくなる区間」になる', () => {
    const before = nested([1000, 1600])[0]!.series;
    const anchorId = before.entries[0]!.anchor.id;
    const ended = setEnd(before, anchorId, y(1500), calendar);
    if (!ended.ok) throw new Error('rejected');
    const lost = subtractIntervals(presenceOf(before, calendar), presenceOf(ended.series, calendar), calendar);
    expect(lost.map((iv) => [iv.start.year, iv.end?.year ?? null])).toEqual([[1500, 1600]]);
  });
});

describe('editFeatureInterval — まとめ役を終わらせる（決定 (2) と手直し 2 回目）', () => {
  it('居候の子を起こし、その年から最上位にする（前の年の所属は残る）', () => {
    const result = endAt(nested(), 'agg', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(result.promoted.map(String).sort()).toEqual(['a', 'b']);
    expect(parentAt(result.histories, 'a', 1400)).toBe('agg');
    expect(parentAt(result.histories, 'a', 1500)).toBeNull();
    expect(parentAt(result.histories, 'b', 3000)).toBeNull();
    expect(parentAt(result.histories, 'agg', 1500)).toBeUndefined();
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('子が後の年に別の親へ移っていたら、その所属は外さない（反証 #1）', () => {
    // a は自分の系列を持つ: 1000 年は agg の子、1700 年から q の子。
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const q = leafTile('qq', 50, 0, 10, 10);
    const histories: readonly FeatureHistory[] = [
      { featureId: fid('agg'), series: { entries: [entryOf('agg', 1000, [aggregate('agg', ['a', 'b']), b.feature], b.vertices), entryOf('agg', 1700, [aggregate('agg', ['b']), b.feature], b.vertices)] } },
      { featureId: fid('q'), series: { entries: [entryOf('q', 1000, [aggregate('q', []), q.feature], q.vertices), entryOf('q', 1700, [aggregate('q', ['a']), q.feature], q.vertices)] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1000, [a.feature], a.vertices), entryOf('a', 1700, [withParentId(a.feature, fid('q'))], a.vertices)] } },
    ];
    const result = endAt(histories, 'agg', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'a', 1600)).toBeNull();
    expect(parentAt(result.histories, 'a', 1700)).toBe('q');
    expect(parentAt(result.histories, 'a', 1400)).toBe('agg');
  });

  it('途切れの後に再び現れるなら、子はその年から元の所属に戻る（殻を作らない。手直し 3 回目で「途切れの後」だけに狭めた）', () => {
    // agg は [1000, 1400) と [1600, ∞) の 2 つの続き（1400〜1600 年は居ない＝途切れ）。
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    const agg = aggregate('agg', ['a', 'b']);
    const histories: readonly FeatureHistory[] = [
      {
        featureId: fid('agg'),
        series: {
          entries: [
            entryOf('agg', 1000, [agg, a.feature, b.feature], [...a.vertices, ...b.vertices], 1400),
            entryOf('agg', 1600, [agg, a.feature, b.feature], [...a.vertices, ...b.vertices]),
          ],
        },
      },
    ];
    const result = endHereAt(histories, 'agg', 1300);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'a', 1350)).toBeNull();
    expect(parentAt(result.histories, 'a', 1600)).toBe('agg');
    expect(childIdsAt(result.histories, 'agg', 1600)).toEqual(['a', 'b']);
    expect(planEnding(histories, fid('agg'), y(1300), calendar)?.reappearsAt?.year).toBe(1600);
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('途切れずに続いている後ろの錨は一緒に終わり、再び現れない（再検証 #2 / 締め A）', () => {
    // 1000・1600 の 2 錨は途切れずに続いている（1000 の錨に終わりが無い）。
    const histories = nested([1000, 1600]);
    const plan = planEnding(histories, fid('agg'), y(1500), calendar);
    expect(plan?.reappearsAt).toBeNull();
    expect(plan?.trimmedLaterRecords).toBe(1);
    const result = endHereAt(histories, 'agg', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'agg', 1600)).toBeUndefined();
    expect(parentAt(result.histories, 'agg', 3000)).toBeUndefined();
    expect(parentAt(result.histories, 'a', 1600)).toBeNull();
    expect(parentAt(result.histories, 'b', 3000)).toBeNull();
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('孫は最上位にしない（中間のまとめ役は子を保ったまま最上位になる。反証 #5）', () => {
    const d = leafTile('d', 0, 0, 10, 10, 'c');
    const e = leafTile('e', 10, 0, 10, 10, 'c');
    const x = leafTile('x', 20, 0, 10, 10, 'p');
    const c = aggregate('c', ['d', 'e'], 'p');
    const p = aggregate('p', ['c', 'x']);
    const histories: readonly FeatureHistory[] = [
      { featureId: fid('p'), series: { entries: [entryOf('p', 1000, [p, c, d.feature, e.feature, x.feature], [...d.vertices, ...e.vertices, ...x.vertices])] } },
    ];
    const result = endAt(histories, 'p', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(result.promoted.map(String).sort()).toEqual(['c', 'x']);
    expect(parentAt(result.histories, 'c', 1600)).toBeNull();
    expect(parentAt(result.histories, 'd', 1600)).toBe('c');
    expect(parentAt(result.histories, 'e', 1600)).toBe('c');
    expect(childIdsAt(result.histories, 'c', 1600)).toEqual(['d', 'e']);
    expect(childrenPromotedByEnding(histories, fid('p'), y(1500), calendar).map(String).sort()).toEqual(['c', 'x']);
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('前の年の錨でだけ子だった地物は数えない', () => {
    const base = materializeOwnSeries(nested(), [fid('a')], calendar).histories;
    const own = base.find((h) => h.featureId === fid('a'))!;
    // a を 1200 年から最上位にしておく（それ以後は agg の子ではない）。
    const detached: readonly FeatureHistory[] = base.map((h) =>
      h === own
        ? { featureId: fid('a'), series: { entries: [...own.series.entries, { ...own.series.entries[0]!, anchor: anchorOf('anchor-a-1200', [withParentId(own.series.entries[0]!.anchor.snapshot.features[0]!, undefined)], [...own.series.entries[0]!.anchor.snapshot.vertices.byId.values()]), start: y(1200) }] } }
        : h,
    );
    expect(childrenPromotedByEnding(detached, fid('agg'), y(1500), calendar).map(String)).toEqual(['b']);
  });
});

describe('editFeatureInterval — 子を終わらせる・開始年を動かす', () => {
  /** agg（自分の系列）と、自分の系列を持つ子 a・b（どちらも 1000 年から agg の子）。 */
  function federation(): readonly FeatureHistory[] {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const b = leafTile('b', 10, 0, 10, 10, 'agg');
    return [
      { featureId: fid('agg'), series: { entries: [entryOf('agg', 1000, [aggregate('agg', ['a', 'b'])], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1000, [a.feature], a.vertices)] } },
      { featureId: fid('b'), series: { entries: [entryOf('b', 1000, [b.feature], b.vertices)] } },
    ];
  }

  it('自分の系列を持つ子を終わらせると、親の子の並びからその年以後は外れる（D1）', () => {
    const result = endAt(federation(), 'a', 1200);
    if (!result.ok) throw new Error('rejected');
    expect(childIdsAt(result.histories, 'agg', 1100)).toEqual(['a', 'b']);
    expect(childIdsAt(result.histories, 'agg', 1200)).toEqual(['b']);
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('まとめ役の開始年を後ろへ動かすと、居なくなった年の子は親を外す（GPT #4 の例）', () => {
    const base = federation();
    const anchorId = base[0]!.series.entries[0]!.anchor.id;
    const result = editFeatureInterval(base, fid('agg'), (s) => changeStart(s, anchorId, y(1200), calendar), calendar);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'a', 1100)).toBeNull();
    expect(parentAt(result.histories, 'a', 1200)).toBe('agg');
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('終わりのある錨を割っても、後ろの片が終わりを越えて続かない', () => {
    // a は [1000, 1600) だけ居る。agg を 1500 で終わらせると a は 1500 から最上位、1600 で居なくなる。
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const histories: readonly FeatureHistory[] = [
      { featureId: fid('agg'), series: { entries: [entryOf('agg', 1000, [aggregate('agg', ['a'])], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1000, [a.feature], a.vertices, 1600)] } },
    ];
    const result = endAt(histories, 'agg', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'a', 1550)).toBeNull();
    expect(parentAt(result.histories, 'a', 1600)).toBeUndefined();
    expect(parentAt(result.histories, 'a', 3000)).toBeUndefined();
  });

  it('入力を変えない（取り消しは構築時の根をそのまま戻す）', () => {
    const base = nested();
    const before = JSON.stringify(base.map((h) => h.series.entries.map((e) => e.anchor.snapshot.features.map((f) => [f.id, f.parentId ?? null]))));
    endAt(base, 'agg', 1500);
    expect(JSON.stringify(base.map((h) => h.series.entries.map((e) => e.anchor.snapshot.features.map((f) => [f.id, f.parentId ?? null]))))).toBe(before);
  });
});

describe('syncAggregateChildIds — 子の並びを時刻ごとの所属に揃える', () => {
  it('揃っていれば同一参照を返す', () => {
    const base = nested();
    expect(syncAggregateChildIds(base, [fid('agg')], calendar)).toBe(base);
  });

  it('区間の途中で子が抜けるなら、その年で錨を割る', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'agg');
    const histories: readonly FeatureHistory[] = [
      { featureId: fid('agg'), series: { entries: [entryOf('agg', 1000, [aggregate('agg', ['a', 'b'])], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1000, [a.feature], a.vertices)] } },
      { featureId: fid('b'), series: { entries: [entryOf('b', 1000, [leafTile('b', 10, 0, 10, 10, 'agg').feature], leafTile('b', 10, 0, 10, 10).vertices, 1300)] } },
    ];
    const synced = syncAggregateChildIds(histories, [fid('agg') as FeatureId], calendar);
    const agg = synced.find((h) => h.featureId === fid('agg'))!;
    expect(agg.series.entries.map((e) => e.start.year)).toEqual([1000, 1300]);
    expect(childIdsAt(synced, 'agg', 1200)).toEqual(['a', 'b']);
    expect(childIdsAt(synced, 'agg', 1300)).toEqual(['a']);
  });
});

describe('手直し 3 回目 — 途切れずに続く記録をまとめて終わらせる・後ろ側が空のまとめ役を終わらせる', () => {
  /** 連邦 F（自分の系列）と、自分の系列を持つ州 a・b（どちらも 1200 年から F の子）。 */
  function federation(): readonly FeatureHistory[] {
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const b = leafTile('b', 10, 0, 10, 10, 'F');
    return [
      { featureId: fid('F'), series: { entries: [entryOf('F', 1200, [aggregate('F', ['a', 'b'])], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1200, [a.feature], a.vertices)] } },
      { featureId: fid('b'), series: { entries: [entryOf('b', 1200, [b.feature], b.vertices)] } },
    ];
  }
  function presentAt(histories: readonly FeatureHistory[], id: string, year: number): boolean {
    return parentAt(histories, id, year) !== undefined;
  }

  it('途切れの定義: 明示の終わりの後に間をあけて始まるときだけ途切れ（終わりの無い錨のあとは続いている）', () => {
    const a = leafTile('a', 0, 0, 10, 10);
    const continuous = [entryOf('a', 1000, [a.feature], a.vertices), entryOf('a', 1500, [a.feature], a.vertices)];
    const touching = [entryOf('a', 1000, [a.feature], a.vertices, 1500), entryOf('a', 1500, [a.feature], a.vertices)];
    const gapped = [entryOf('a', 1000, [a.feature], a.vertices, 1400), entryOf('a', 1500, [a.feature], a.vertices)];
    expect(hasGapAfter(continuous, 0, calendar)).toBe(false);
    expect(hasGapAfter(touching, 0, calendar)).toBe(false);
    expect(hasGapAfter(gapped, 0, calendar)).toBe(true);
  });

  it('再検証 #2 の再現: 州 a を 1500 年で終わらせて F が割られても、F を 1300 年で終わらせれば 1500 年に戻らない', () => {
    const r1 = endHereAt(federation(), 'a', 1500);
    if (!r1.ok) throw new Error('rejected');
    // F は子の並びを揃えるために 1500 年で割られている（帳簿の錨）。
    expect(r1.histories.find((h) => h.featureId === fid('F'))!.series.entries.length).toBe(2);
    const r2 = endHereAt(r1.histories, 'F', 1300);
    if (!r2.ok) throw new Error('rejected');
    expect(presentAt(r2.histories, 'F', 1250)).toBe(true);
    expect(presentAt(r2.histories, 'F', 1500)).toBe(false);
    expect(presentAt(r2.histories, 'F', 3000)).toBe(false);
    expect(parentAt(r2.histories, 'b', 1500)).toBeNull();
    expect(parentAt(r2.histories, 'b', 1250)).toBe('F');
    expect(treeIssues(r2.histories)).toEqual([]);
  });

  it('締め B: 終わらせる範囲の後ろの錨にだけ居る州の記録を、切り詰める前に起こして残す', () => {
    // P の 1000 年の錨には a、1700 年の錨には a と「1600 年に加わった州」x が居る（x は 1700 年の錨にだけ居る）。
    const a = leafTile('a', 0, 0, 10, 10, 'P');
    const x = leafTile('x', 20, 0, 10, 10, 'P');
    const histories: readonly FeatureHistory[] = [
      {
        featureId: fid('P'),
        series: {
          entries: [
            entryOf('P', 1000, [aggregate('P', ['a']), a.feature], a.vertices),
            entryOf('P', 1700, [aggregate('P', ['a', 'x']), a.feature, x.feature], [...a.vertices, ...x.vertices]),
          ],
        },
      },
    ];
    const result = endHereAt(histories, 'P', 1500);
    if (!result.ok) throw new Error('rejected');
    // 1700 年の錨は P と一緒に終わるが、そこにだけ居た x の記録は x 自身の年表に残る（最上位）。
    expect(parentAt(result.histories, 'x', 1700)).toBeNull();
    expect(parentAt(result.histories, 'x', 3000)).toBeNull();
    expect(result.histories.some((h) => h.featureId === fid('x'))).toBe(true);
    expect(parentAt(result.histories, 'P', 1700)).toBeUndefined();
    expect(parentAt(result.histories, 'a', 1700)).toBeNull();
    expect(treeIssues(result.histories)).toEqual([]);
  });

  it('1-1: 州を全部同じ年で終わらせると、後ろ側が空になった連邦もその年から終わる（記録は前の年に残る）', () => {
    const r1 = endHereAt(federation(), 'a', 1400);
    if (!r1.ok) throw new Error('rejected');
    expect(r1.cascaded).toEqual([]);
    const plan = planEnding(r1.histories, fid('b'), y(1400), calendar);
    expect(plan?.cascaded.map((c) => [String(c.featureId), c.at.year])).toEqual([['F', 1400]]);
    const r2 = endHereAt(r1.histories, 'b', 1400);
    if (!r2.ok) throw new Error('rejected');
    expect(r2.cascaded.map((c) => String(c.featureId))).toEqual(['F']);
    expect(presentAt(r2.histories, 'F', 1300)).toBe(true);
    expect(childIdsAt(r2.histories, 'F', 1300)).toEqual(['a', 'b']);
    expect(presentAt(r2.histories, 'F', 1400)).toBe(false);
    const report = checkConsistency({ histories: r2.histories } as unknown as DomainProject, calendar);
    expect(report.inconsistencies).toEqual([]);
  });

  it('1-1 の連鎖: 帝国 G ＞ 連邦 F ＞ 州 a で、a を終わらせると F も G もその年から終わる', () => {
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const histories: readonly FeatureHistory[] = [
      { featureId: fid('G'), series: { entries: [entryOf('G', 1200, [aggregate('G', ['F'])], [])] } },
      { featureId: fid('F'), series: { entries: [entryOf('F', 1200, [aggregate('F', ['a'], 'G')], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1200, [a.feature], a.vertices)] } },
    ];
    const result = endHereAt(histories, 'a', 1500);
    if (!result.ok) throw new Error('rejected');
    expect(result.cascaded.map((c) => [String(c.featureId), c.at.year]).sort()).toEqual([
      ['F', 1500],
      ['G', 1500],
    ]);
    expect(presentAt(result.histories, 'G', 1400)).toBe(true);
    expect(presentAt(result.histories, 'G', 1500)).toBe(false);
    expect(checkConsistency({ histories: result.histories } as unknown as DomainProject, calendar).inconsistencies).toEqual([]);
  });

  it('締め C: 最初から子が居ないまとめ役・途中だけ空のまとめ役は終わらせない', () => {
    const lonely: readonly FeatureHistory[] = [
      { featureId: fid('L'), series: { entries: [entryOf('L', 1000, [aggregate('L', [])], [])] } },
    ];
    expect(tailEmptyCuts(lonely, fid('L'), calendar)).toEqual([]);
    expect(emptyAggregateIntervals(lonely, fid('L'), calendar)).toEqual([]);
    // 途中だけ空: a は [1200,1300)、b は 1400 から F の子。1300〜1400 年だけ子が居ない。
    const a = leafTile('a', 0, 0, 10, 10, 'F');
    const b = leafTile('b', 10, 0, 10, 10, 'F');
    const middle: readonly FeatureHistory[] = [
      { featureId: fid('F'), series: { entries: [entryOf('F', 1200, [aggregate('F', ['a', 'b'])], [])] } },
      { featureId: fid('a'), series: { entries: [entryOf('a', 1200, [a.feature], a.vertices, 1300)] } },
      { featureId: fid('b'), series: { entries: [entryOf('b', 1400, [b.feature], b.vertices)] } },
    ];
    expect(tailEmptyCuts(middle, fid('F'), calendar)).toEqual([]);
    expect(emptyAggregateIntervals(middle, fid('F'), calendar).map((iv) => [iv.start.year, iv.end?.year ?? null])).toEqual([
      [1300, 1400],
    ]);
  });

  it('1-1: 子の開始年を親より前へ動かすと、親が居ない区間だけ親を外す（再検証 #1 の 2）', () => {
    const base = federation();
    const aAnchor = base.find((h) => h.featureId === fid('a'))!.series.entries[0]!.anchor.id;
    const result = editFeatureInterval(base, fid('a'), (s) => changeStart(s, aAnchor, y(1100), calendar), calendar);
    if (!result.ok) throw new Error('rejected');
    expect(parentAt(result.histories, 'a', 1150)).toBeNull();
    expect(parentAt(result.histories, 'a', 1200)).toBe('F');
    expect(checkConsistency({ histories: result.histories } as unknown as DomainProject, calendar).inconsistencies).toEqual([]);
  });

  it('続きの始まりで終わらせる（何も残らない）のは断る', () => {
    const histories = federation();
    const own = histories.find((h) => h.featureId === fid('a'))!;
    const anchorId = own.series.entries[0]!.anchor.id;
    expect(endRunAt(own.series, fid('a'), anchorId, y(1200), calendar).ok).toBe(false);
  });
});
