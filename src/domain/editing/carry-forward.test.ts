// 保存した属性を「次にその属性が本当に変わる錨」まで前へ引き継ぐ規則の単体テスト
// （増分 2 の手直し A1 / 反証 F1）。
//
// ここが守るのは 2 つで、どちらも欠けると意味が無い。
//   1. **意図しない巻き戻しが消える**（後ろの錨が持つ旧値の写しが新値になる）。
//   2. **本当の変更は 1 つも壊れない**（違う値を持つ錨で必ず止まる）。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, type AnchorEntry, type AnchorSeries } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createLeafFeature,
  withColor,
  withDetailDocument,
  withKindLabel,
  type Feature,
} from '../feature';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';

import {
  applyCarryForward,
  carriedAttributesOf,
  carryForwardTargets,
  changedCarriedAttributes,
  nextDivergingEntry,
} from './carry-forward';

const cal = getCalendar('gregorian');
const fid = asFeatureId('f-1');
const siblingId = asFeatureId('f-2');

const vertices = createVertexStore([
  createVertex(asVertexId('v1'), { lon: 0, lat: 0 }),
  createVertex(asVertexId('v2'), { lon: 1, lat: 0 }),
  createVertex(asVertexId('v3'), { lon: 1, lat: 1 }),
]);

function leaf(id: ReturnType<typeof asFeatureId>, name: string): Feature {
  return createLeafFeature(
    id,
    createBasicAttributes(name, 0, 0),
    createColorInfo(false, '#111111', '#222222', '#333333', 'default', 1, 1),
    createShape([
      createTerritoryRing(asRingId(`r-${String(id)}`), [
        asVertexId('v1'),
        asVertexId('v2'),
        asVertexId('v3'),
      ]),
    ]),
  );
}

function at(year: number, features: readonly Feature[]): AnchorEntry {
  return createAnchorEntry(
    createAnchor(asAnchorId(`a-${String(year)}`), createAnchorSnapshot(features, vertices)),
    timePointYear(year),
    null,
  );
}

function seriesOf(...entries: AnchorEntry[]): AnchorSeries {
  return { entries };
}

function nameAt(series: AnchorSeries, year: number): string | undefined {
  return series.entries
    .find((e) => e.start.year === year)
    ?.anchor.snapshot.features.find((f) => f.id === fid)?.attributes.name;
}

const carry = (before: Feature, after: Feature) => ({
  before: carriedAttributesOf(before),
  after: carriedAttributesOf(after),
});

describe('changedCarriedAttributes — 引き継ぐのは保存の対象 4 つだけ', () => {
  it('名前・種別ラベル・詳細文書・見た目の変化を拾う', () => {
    const base = leaf(fid, 'A');
    expect(
      changedCarriedAttributes(carriedAttributesOf(base), carriedAttributesOf(leaf(fid, 'B'))),
    ).toEqual(['name']);

    const withKind = withKindLabel(base, '州');
    expect(changedCarriedAttributes(carriedAttributesOf(base), carriedAttributesOf(withKind)))
      .toEqual(['kindLabel']);

    const withDoc = withDetailDocument(base, '本文');
    expect(changedCarriedAttributes(carriedAttributesOf(base), carriedAttributesOf(withDoc)))
      .toEqual(['detailDocument']);

    const recolored = withColor(
      base,
      createColorInfo(false, '#ff0000', '#222222', '#333333', 'default', 1, 1),
    );
    expect(changedCarriedAttributes(carriedAttributesOf(base), carriedAttributesOf(recolored)))
      .toEqual(['fillColor']);
  });

  it('何も変わっていなければ空（形だけの編集は引き継ぎを起こさない）', () => {
    const base = leaf(fid, 'A');
    expect(changedCarriedAttributes(carriedAttributesOf(base), carriedAttributesOf(base)))
      .toEqual([]);
  });
});

describe('反証 F1 — 過去の年の編集が後ろの錨で巻き戻らない', () => {
  // 集約地物の下の再現: 2000 年に「兄弟」を直したので親の系列に 2000 年の錨が立ち、
  // その写しには f-1 の **旧名** が入っている。そのあと 1000 年で f-1 を改名すると、
  // 引き継ぎが無ければ 2000 年から旧名に戻る。
  const before = leaf(fid, '旧名');
  const after = leaf(fid, '新名');
  const base = seriesOf(
    at(0, [before, leaf(siblingId, '兄弟')]),
    at(2000, [before, leaf(siblingId, '兄弟（改）')]),
    at(3000, [before, leaf(siblingId, '兄弟（改）')]),
  );

  it('1000 年で改名すると 2000 年・3000 年の写しも新名になる', () => {
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    expect(nameAt(next, 2000)).toBe('新名');
    expect(nameAt(next, 3000)).toBe('新名');
  });

  it('兄弟の値には触らない（他人の歴史を書き換えない）', () => {
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    const sibling2000 = next.entries
      .find((e) => e.start.year === 2000)
      ?.anchor.snapshot.features.find((f) => f.id === siblingId);
    expect(sibling2000?.attributes.name).toBe('兄弟（改）');
  });

  it('錨の開始・終了・錨 ID は動かさない', () => {
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    expect(next.entries.map((e) => e.start.year)).toEqual([0, 2000, 3000]);
    expect(next.entries.map((e) => e.anchor.id)).toEqual(base.entries.map((e) => e.anchor.id));
  });

  it('T より前・T ちょうどの錨は触らない', () => {
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    expect(nameAt(next, 0)).toBe('旧名');
  });
});

describe('本当の変更では止まる', () => {
  const before = leaf(fid, '旧名');
  const after = leaf(fid, '新名');

  it('その属性が本当に変わる錨より先へは進まない', () => {
    const base = seriesOf(
      at(0, [before]),
      at(2000, [before]),
      at(2500, [leaf(fid, '別の名前')]),
      at(3000, [leaf(fid, '別の名前')]),
    );
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    expect(nameAt(next, 2000)).toBe('新名');
    expect(nameAt(next, 2500)).toBe('別の名前');
    expect(nameAt(next, 3000)).toBe('別の名前');
  });

  it('止まる位置は属性ごとに独立に決まる', () => {
    // 2500 年で名前だけ変わっている。見た目は 0 年のまま続く。
    const recolored = withColor(
      after,
      createColorInfo(false, '#ff0000', '#222222', '#333333', 'default', 1, 1),
    );
    const base = seriesOf(
      at(0, [before]),
      at(2500, [leaf(fid, '別の名前')]),
      at(3000, [leaf(fid, '別の名前')]),
    );
    const { before: b, after: a } = carry(before, recolored);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    // 名前は 2500 年で止まる。
    expect(nameAt(next, 2500)).toBe('別の名前');
    // 見た目は 3000 年まで引き継がれる。
    const color3000 = next.entries
      .find((e) => e.start.year === 3000)
      ?.anchor.snapshot.features.find((f) => f.id === fid)?.color.fillColor;
    expect(color3000).toBe('#ff0000');
  });

  it('その地物が居なくなった錨で止まる', () => {
    const base = seriesOf(at(0, [before]), at(2000, [leaf(siblingId, '兄弟')]), at(3000, [before]));
    const { before: b, after: a } = carry(before, after);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    expect(nameAt(next, 3000)).toBe('旧名');
  });

  it('変化が無ければ系列をそのまま返す（同一性を保つ）', () => {
    const base = seriesOf(at(0, [before]), at(2000, [before]));
    const { before: b } = carry(before, before);
    expect(applyCarryForward(base, timePointYear(1000), fid, b, b, cal)).toBe(base);
  });
});

describe('押す前に見せるための予告（carryForwardTargets / nextDivergingEntry）', () => {
  const before = leaf(fid, '旧名');
  const after = leaf(fid, '新名');
  const base = seriesOf(
    at(0, [before]),
    at(2000, [before]),
    at(3000, [before]),
    at(4000, [leaf(fid, '別の名前')]),
  );

  it('書き換える先の錨を古い順に返す', () => {
    const { before: b, after: a } = carry(before, after);
    const targets = carryForwardTargets(base.entries, timePointYear(1000), fid, b, a, cal);
    expect(targets.map((e) => e.start.year)).toEqual([2000, 3000]);
  });

  it('予告と実際に書き換わる錨が一致する（同じ歩き方を使っている）', () => {
    const { before: b, after: a } = carry(before, after);
    const targets = carryForwardTargets(base.entries, timePointYear(1000), fid, b, a, cal);
    const next = applyCarryForward(base, timePointYear(1000), fid, b, a, cal);
    const rewritten = next.entries
      .filter((e, i) => e !== base.entries[i])
      .map((e) => e.start.year);
    expect(rewritten).toEqual(targets.map((e) => e.start.year));
  });

  it('「この姿は ○○年まで」の相手は、引き継ぎが済んだあとに姿が変わる最初の錨', () => {
    const { before: b, after: a } = carry(before, after);
    const diverging = nextDivergingEntry(base.entries, timePointYear(1000), fid, b, a, cal);
    expect(diverging?.start.year).toBe(4000);
  });

  it('この先ずっと同じ姿なら null（引き継ぎで新値になる錨は数えない）', () => {
    const s = seriesOf(at(0, [before]), at(2000, [before]));
    const { before: b, after: a } = carry(before, after);
    expect(nextDivergingEntry(s.entries, timePointYear(1000), fid, b, a, cal)).toBeNull();
  });
});
