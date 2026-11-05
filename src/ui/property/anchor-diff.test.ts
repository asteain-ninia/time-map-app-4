// 隣り合う錨の差分（実装計画 増分 2 の中身 4・5 / 設計書 §C.6・§N-15）。
//
// 2 つの受け入れ条件がここに乗っている。
//   - 錨表の行に「その年に何が変わったか」が出る（現状分析 N-45）。
//   - 集約地物の下位領域を選んだとき、親の系列から **その子に関わる錨だけ** が出る
//     （実データの 86 件 = 3 つの集約の子ぜんぶ）。
// どちらも同じ計算なので、ここが唯一の実装である（教訓 5.29）。

import { describe, expect, it } from 'vitest';

import { createAnchor, createAnchorSnapshot } from '../../domain/anchor';
import { createAnchorEntry, type AnchorEntry } from '../../domain/anchor-series';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createLeafFeature,
  createPointFeature,
  withAttributes,
  withColor,
  withDetailDocument,
  withKindLabel,
  withParentId,
  withReferenceName,
  type Feature,
} from '../../domain/feature';
import { getCalendar } from '../../domain/time/calendar';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';

import {
  ANCHOR_CHANGE,
  ANCHOR_DIFF_STRINGS,
  anchorRowsOf,
  changeSentence,
  changesBetween,
  diffSentence,
  existenceRunsOf,
  isRelevantAnchor,
  shapeChanged,
} from './anchor-diff';

const color = createColorInfo(true, '#111111', '#222222', '#333333');
const child = asFeatureId('child');
const sibling = asFeatureId('sibling');
const parent = asFeatureId('parent');
const v1 = asVertexId('v1');
const v2 = asVertexId('v2');
const v3 = asVertexId('v3');

function pointNamed(name: string): Feature {
  return createPointFeature(child, createBasicAttributes(name, 0, 9999), color, v1);
}

function siblingFeature(): Feature {
  return createPointFeature(sibling, createBasicAttributes('隣の州', 0, 9999), color, v2);
}

function parentFeature(): Feature {
  return createPointFeature(parent, createBasicAttributes('デーレ共和国', 0, 9999), color, v3);
}

function entryAt(year: number, features: readonly Feature[], coords?: Record<string, number>) {
  const vertices = createVertexStore([
    createVertex(v1, { lon: coords?.['v1'] ?? 0, lat: 0 }),
    createVertex(v2, { lon: 10, lat: 0 }),
    createVertex(v3, { lon: 20, lat: 0 }),
  ]);
  return createAnchorEntry(
    createAnchor(asAnchorId(`a${String(year)}`), createAnchorSnapshot(features, vertices)),
    timePointYear(year),
    null,
  );
}

/**
 * 親の名前を引く口。**前と後で別**（B4 / GPT#11）。ここでは同じ表を両方に渡すが、
 * 別々に渡せることを型で固定しておく。
 */
const nameOfIn = (id: ReturnType<typeof asFeatureId>): string =>
  id === parent ? 'デーレ共和国' : '別の地物';
const nameOf = { before: nameOfIn, after: nameOfIn };

describe('changesBetween — その地物に何が起きたか', () => {
  it('最初の錨は「ここから記録が始まる」', () => {
    const changes = changesBetween(null, entryAt(0, [pointNamed('アアウェン州')]), child, nameOf);
    expect(changes.map((c) => c.kind)).toEqual([ANCHOR_CHANGE.Appeared]);
  });

  it('名前が変わったことを、前後の値つきで出す', () => {
    const before = entryAt(0, [pointNamed('アアウェン州')]);
    const after = entryAt(1200, [pointNamed('北アアウェン州')]);
    const changes = changesBetween(before, after, child, nameOf);
    expect(changes).toEqual([
      { kind: ANCHOR_CHANGE.Name, before: 'アアウェン州', after: '北アアウェン州' },
    ]);
  });

  it('種別ラベルの付け外しも変化として拾う（空文字と未設定を同じ扱いにする）', () => {
    const before = entryAt(0, [pointNamed('アアウェン州')]);
    const after = entryAt(1200, [withKindLabel(pointNamed('アアウェン州'), '州')]);
    expect(changesBetween(before, after, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.KindLabel,
    ]);
    // 逆向き（外した）も拾う。
    expect(changesBetween(after, before, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.KindLabel,
    ]);
  });

  it('参照名の付け外しも、前後の値つきで拾う（FR-98）', () => {
    const before = entryAt(0, [pointNamed('アアウェン州')]);
    const after = entryAt(1200, [withReferenceName(pointNamed('アアウェン州'), '出界百科: 州')]);
    const changes = changesBetween(before, after, child, nameOf);
    expect(changes).toEqual([
      { kind: ANCHOR_CHANGE.ReferenceName, before: null, after: '出界百科: 州' },
    ]);
    expect(changeSentence(changes[0]!)).toBe(
      ANCHOR_DIFF_STRINGS.referenceName(null, '出界百科: 州'),
    );
    expect(changesBetween(after, before, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.ReferenceName,
    ]);
  });

  it('親が変わったことを、名前へ写して出す（内部 id を画面に出さない）', () => {
    const before = entryAt(0, [pointNamed('南ケナ州'), parentFeature()]);
    const after = entryAt(1200, [
      withParentId(pointNamed('南ケナ州'), parent),
      parentFeature(),
    ]);
    const changes = changesBetween(before, after, child, nameOf);
    expect(changes).toEqual([
      { kind: ANCHOR_CHANGE.Parent, before: null, after: 'デーレ共和国' },
    ]);
    expect(changes[0]?.after).not.toContain('parent');
  });

  it('形が変わったことを拾う（同じ頂点 id でも座標が動けば変化）', () => {
    const before = entryAt(0, [pointNamed('アアウェン州')], { v1: 0 });
    const after = entryAt(1200, [pointNamed('アアウェン州')], { v1: 5 });
    expect(changesBetween(before, after, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.Shape,
    ]);
  });

  it('居なくなったことを拾う', () => {
    const before = entryAt(0, [pointNamed('アアウェン州'), siblingFeature()]);
    const after = entryAt(1200, [siblingFeature()]);
    expect(changesBetween(before, after, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.Disappeared,
    ]);
  });

  it('何も変わっていなければ空（＝その錨はこの地物に関わらない）', () => {
    const before = entryAt(0, [pointNamed('アアウェン州')]);
    const after = entryAt(1200, [pointNamed('アアウェン州')]);
    expect(changesBetween(before, after, child, nameOf)).toEqual([]);
  });

  it('**兄弟だけが変わった錨は、この地物に関わらない**（他人の変化を混ぜない、裁定 §N-15）', () => {
    const before = entryAt(0, [pointNamed('アアウェン州'), siblingFeature()]);
    const after = entryAt(1200, [
      pointNamed('アアウェン州'),
      withAttributes(siblingFeature(), createBasicAttributes('改名した隣', 0, 9999)),
    ]);
    expect(changesBetween(before, after, child, nameOf)).toEqual([]);
    expect(isRelevantAnchor(before, after, child)).toBe(false);
  });
});

describe('shapeChanged', () => {
  it('頂点の本数が違えば変化', () => {
    const a = createLeafFeature(
      child,
      createBasicAttributes('面', 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId('r1'), [v1, v2, v3])]),
    );
    const b = createLeafFeature(
      child,
      createBasicAttributes('面', 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId('r1'), [v1, v2])]),
    );
    const snap = createAnchorSnapshot([], createVertexStore([]));
    expect(shapeChanged(a, snap, b, snap)).toBe(true);
  });

  it('同じ id・同じ座標なら変化なし', () => {
    const f = pointNamed('同じ');
    const snap = createAnchorSnapshot([], createVertexStore([createVertex(v1, { lon: 1, lat: 2 })]));
    expect(shapeChanged(f, snap, f, snap)).toBe(false);
  });
});

describe('diffSentence — 行に添える日本語', () => {
  it('値を変えずに作った錨には、そのための文が出る（Ctrl+K / B1）', () => {
    // 比べる語彙が保存の対象と同じ広さになったので、ここに残るのは本当に
    // 「値を変えずに作った錨」だけである。「変化はありません」では何を記録したのか
    // 分からないので、記録したことそのものを言う。
    const before = entryAt(0, [pointNamed('A')]);
    const after = entryAt(1200, [pointNamed('A')]);
    expect(diffSentence(before, after, child, nameOf)).toBe(ANCHOR_DIFF_STRINGS.noChange);
    expect(ANCHOR_DIFF_STRINGS.noChange).toContain('同じ姿が続く');
  });

  it('複数の変化は 1 行に並べる', () => {
    const before = entryAt(0, [pointNamed('A'), parentFeature()]);
    const after = entryAt(1200, [
      withParentId(withKindLabel(pointNamed('B'), '州'), parent),
      parentFeature(),
    ]);
    const sentence = diffSentence(before, after, child, nameOf);
    expect(sentence).toContain('名前が変わった');
    expect(sentence).toContain('種別が変わった');
    expect(sentence).toContain('親が変わった');
    expect(sentence).toContain(ANCHOR_DIFF_STRINGS.separator);
  });

  it('内部の識別子が文に混ざらない（U-1）', () => {
    const before = entryAt(0, [pointNamed('A')]);
    const after = entryAt(1200, [pointNamed('B')]);
    expect(diffSentence(before, after, child, nameOf)).not.toMatch(/child|a1200/);
  });
});

describe('anchorRowsOf（onlyRelevant） — 集約地物の下位領域に関わる錨だけを選り分ける（裁定 §N-15）', () => {
  it('親の系列から、その子が変わった錨だけを残す', () => {
    const entries: readonly AnchorEntry[] = [
      entryAt(0, [pointNamed('アアウェン州'), siblingFeature()]),
      // 1200: 兄弟だけが変わった ⇒ この子には関わらない
      entryAt(1200, [
        pointNamed('アアウェン州'),
        withAttributes(siblingFeature(), createBasicAttributes('改名した隣', 0, 9999)),
      ]),
      // 2000: この子が改名した ⇒ 関わる
      entryAt(2000, [
        pointNamed('北アアウェン州'),
        withAttributes(siblingFeature(), createBasicAttributes('改名した隣', 0, 9999)),
      ]),
    ];
    const kept = anchorRowsOf(entries, child, { onlyRelevant: true }).map((r) => r.entry);
    expect(kept.map((e) => e.start.year)).toEqual([0, 2000]);
  });

  it('比較は元の並び順で行う（飛ばした錨があっても前後関係が崩れない）', () => {
    // 1200 を飛ばしても、2000 の比較相手は 1200（直前の錨）である。1200 で改名し
    // 2000 で元に戻したなら、2000 も「関わる」錨になる。
    const entries: readonly AnchorEntry[] = [
      entryAt(0, [pointNamed('A'), siblingFeature()]),
      entryAt(1200, [pointNamed('B'), siblingFeature()]),
      entryAt(2000, [pointNamed('A'), siblingFeature()]),
    ];
    expect(
      anchorRowsOf(entries, child, { onlyRelevant: true }).map((r) => r.entry.start.year),
    ).toEqual([0, 1200, 2000]);
  });

  it('その子が 1 度も出てこない系列では空になる', () => {
    const entries: readonly AnchorEntry[] = [
      entryAt(0, [siblingFeature()]),
      entryAt(1200, [siblingFeature()]),
    ];
    expect(anchorRowsOf(entries, child, { onlyRelevant: true })).toEqual([]);
  });
});

// 増分 2 の手直し B1 — 比べる語彙は「保存の対象」と同じ広さでなければならない
// （バグ狩り #1 / GPT#3 / 設計 B4）。旧版は見た目・詳細文書・リング構成を見ていなかった
// ので、それだけを直して作った錨が子の錨表から消え、行の文も嘘をついた。
describe('changesBetween — 保存の対象を全部見る（B1）', () => {
  it('見た目だけを直した錨も変化として拾う', () => {
    const recolored = withColor(
      pointNamed('アアウェン州'),
      createColorInfo(true, '#ff0000', '#222222', '#333333'),
    );
    const before = entryAt(0, [pointNamed('アアウェン州')]);
    const after = entryAt(1200, [recolored]);
    expect(changesBetween(before, after, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.Style,
    ]);
    expect(isRelevantAnchor(before, after, child)).toBe(true);
    expect(diffSentence(before, after, child, nameOf)).toBe(ANCHOR_DIFF_STRINGS.style);
  });

  it('不透明度・パレット・自動配色の違いも見た目の変化である', () => {
    const base = pointNamed('A');
    const cases = [
      createColorInfo(true, '#111111', '#222222', '#333333', 'default', 0.5, 1),
      createColorInfo(true, '#111111', '#222222', '#333333', 'default', 1, 0.5),
      createColorInfo(true, '#111111', '#222222', '#333333', 'muted'),
      createColorInfo(false, '#111111', '#222222', '#333333'),
    ];
    for (const c of cases) {
      const after = entryAt(1200, [withColor(base, c)]);
      expect(changesBetween(entryAt(0, [base]), after, child, nameOf).map((x) => x.kind)).toEqual([
        ANCHOR_CHANGE.Style,
      ]);
    }
  });

  it('詳細文書だけを直した錨も変化として拾う', () => {
    const before = entryAt(0, [pointNamed('A')]);
    const after = entryAt(1200, [withDetailDocument(pointNamed('A'), '本文')]);
    expect(changesBetween(before, after, child, nameOf).map((c) => c.kind)).toEqual([
      ANCHOR_CHANGE.DetailDocument,
    ]);
    expect(diffSentence(before, after, child, nameOf)).toBe(ANCHOR_DIFF_STRINGS.detailDocument);
  });

  it('リングの構成だけが変わった形も拾う（同じ頂点でも別の環に組み替えた）', () => {
    const snap = createAnchorSnapshot([], createVertexStore([]));
    const oneRing = createLeafFeature(
      child,
      createBasicAttributes('面', 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId('r1'), [v1, v2, v3])]),
    );
    // 同じ 3 頂点を、別の ID の環へ入れ替える（参照している頂点 id の平らな並びは同じ）。
    const renamedRing = createLeafFeature(
      child,
      createBasicAttributes('面', 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId('r2'), [v1, v2, v3])]),
    );
    expect(shapeChanged(oneRing, snap, renamedRing, snap)).toBe(true);
  });

  it('地物の種類が変わったら形の変化として拾う', () => {
    const snap = createAnchorSnapshot([], createVertexStore([]));
    const point = pointNamed('A');
    const leaf = createLeafFeature(
      child,
      createBasicAttributes('A', 0, 9999),
      color,
      createShape([createTerritoryRing(asRingId('r1'), [v1])]),
    );
    expect(shapeChanged(point, snap, leaf, snap)).toBe(true);
  });
});

// 増分 2 の手直し B4 — 親の名前は前後で別の口から引く（GPT#11）。
describe('changesBetween — 親の名前は前後で別の口から引く（B4）', () => {
  it('旧親の名前は前の錨から、新親の名前は後の錨から引く', () => {
    const oldParent = asFeatureId('oldParent');
    const before = entryAt(0, [withParentId(pointNamed('州'), oldParent)]);
    const after = entryAt(1200, [withParentId(pointNamed('州'), parent)]);
    const changes = changesBetween(before, after, child, {
      before: (id) => (id === oldParent ? '古い親' : '（前の錨には居ない）'),
      after: (id) => (id === parent ? '新しい親' : '（後の錨には居ない）'),
    });
    expect(changes).toEqual([
      { kind: ANCHOR_CHANGE.Parent, before: '古い親', after: '新しい親' },
    ]);
  });
});

// 増分 2 の手直し B2 — 「前の錨」の決め方は 1 か所しかない。
describe('anchorRowsOf — 前の錨を 1 か所で決める（B2）', () => {
  const entries: readonly AnchorEntry[] = [
    entryAt(0, [pointNamed('A'), siblingFeature()]),
    // 1200: 兄弟だけが変わった ⇒ この子には関わらない
    entryAt(1200, [
      pointNamed('A'),
      withAttributes(siblingFeature(), createBasicAttributes('改名した隣', 0, 9999)),
    ]),
    entryAt(2000, [
      pointNamed('B'),
      withAttributes(siblingFeature(), createBasicAttributes('改名した隣', 0, 9999)),
    ]),
  ];

  it('絞り込んでも「前の錨」は元の系列の隣のまま', () => {
    const rows = anchorRowsOf(entries, child, { onlyRelevant: true });
    expect(rows.map((r) => r.entry.start.year)).toEqual([0, 2000]);
    // 2000 の比較相手は **1200**（絞り込みで飛ばした錨）である。
    expect(rows[1]?.previous?.start.year).toBe(1200);
  });

  it('絞り込まないときは全件が並び、先頭の前は null', () => {
    const rows = anchorRowsOf(entries, child);
    expect(rows.map((r) => r.entry.start.year)).toEqual([0, 1200, 2000]);
    expect(rows[0]?.previous).toBeNull();
  });

  it('絞り込みは「行を作ってから残す」だけで、別の計算を持たない', () => {
    const all = anchorRowsOf(entries, child);
    const kept = anchorRowsOf(entries, child, { onlyRelevant: true });
    // 残った行は、絞り込まないときの行の部分集合（同じ組がそのまま残る）。
    for (const row of kept) expect(all).toContainEqual(row);
  });
});

// 増分 2 の手直し B3 — 「続く」行は親の系列そのものから出し、穴を隠さない
// （設計 C4 / 反証 F7 / バグ狩り #7）。
describe('existenceRunsOf — 穴のある存在期間（B3）', () => {
  const cal = getCalendar('gregorian');

  function bounded(year: number, end: number | null, features: readonly Feature[]) {
    return createAnchorEntry(
      createAnchor(
        asAnchorId(`b${String(year)}`),
        createAnchorSnapshot(features, createVertexStore([createVertex(v1, { lon: 0, lat: 0 })])),
      ),
      timePointYear(year),
      end === null ? null : timePointYear(end),
    );
  }

  it('繋がっている錨は 1 区間にまとめる', () => {
    const runs = existenceRunsOf(
      [bounded(0, 1200, [pointNamed('A')]), bounded(1200, null, [pointNamed('A')])],
      child,
      cal,
    );
    expect(runs).toHaveLength(1);
    expect(runs[0]?.start.year).toBe(0);
    expect(runs[0]?.end).toBeNull();
  });

  it('途中で終わって後から再開する並びは 2 区間になる（穴を隠さない）', () => {
    const runs = existenceRunsOf(
      [bounded(0, 2000, [pointNamed('A')]), bounded(3000, null, [pointNamed('A')])],
      child,
      cal,
    );
    expect(runs.map((r) => [r.start.year, r.end?.year ?? null])).toEqual([
      [0, 2000],
      [3000, null],
    ]);
  });

  it('その地物が居ない錨でも区間が切れる（集約地物の下位領域の存在期間は親のそれと違う）', () => {
    const runs = existenceRunsOf(
      [
        bounded(0, null, [pointNamed('A')]),
        bounded(1000, null, [siblingFeature()]),
        bounded(2000, null, [pointNamed('A')]),
      ],
      child,
      cal,
    );
    expect(runs.map((r) => r.start.year)).toEqual([0, 2000]);
  });

  it('1 度も居なければ空（値を捏造しない）', () => {
    expect(existenceRunsOf([bounded(0, null, [siblingFeature()])], child, cal)).toEqual([]);
  });
});
