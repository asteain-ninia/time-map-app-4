// 地物一覧（台帳）の行の組み立て（増分 4 / 設計書 §C.5 / C4 / FR-111 = R9）。
//
// ここで固定するのは 4 つ:
//   1. **階層のたたみ込み**（木・平・展開・絞り込みで先祖を残す）
//   2. **重複名の見分けが 3 段で足りるまで上がる**（〈親名〉→ 階層のみち → 通し番号と座標）
//   3. **仮想スクロールの窓**（5,000 行でも描くのは窓に入るぶん＋前後 2 行だけ）
//   4. **行の高さが 1 種類**（28px。揃っていないと窓の計算が成り立たない）

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createAggregateFeature, createLeafFeature } from '../../domain/feature';
import { buildForest } from '../../domain/hierarchy/forest';
import { asFeatureId, type FeatureId } from '../../domain/ids';
import { createShape } from '../../domain/ring';

import {
  LEDGER_OVERSCAN,
  LEDGER_ROW_HEIGHT,
  QUALIFIER_STAGE,
  buildLedgerRows,
  compactCoordinate,
  ledgerWindow,
  qualifierStageOf,
  scrollTopForRow,
  type LedgerFeature,
} from './ledger';

const attrs = createBasicAttributes('X', 0, 100);
const color = createColorInfo(true, '#111111', '#222222', '#333333');

function id(s: string): FeatureId {
  return asFeatureId(s);
}

/** 台帳の材料 1 件（点は既定 null）。 */
function lf(
  key: string,
  name: string,
  parent: string | null,
  extra: Partial<LedgerFeature> = {},
): LedgerFeature {
  return {
    id: id(key),
    name,
    kind: 'leaf',
    kindLabel: '',
    parentId: parent === null ? null : id(parent),
    color: '#123456',
    anchorCount: 1,
    hiddenReason: null,
    hidden: false,
    point: null,
    ...extra,
  };
}

/** 同じ材料からドメインの親子関係（`buildForest`）を作る。 */
function forestOf(features: readonly LedgerFeature[]) {
  return buildForest(
    features.map((f) =>
      f.parentId === null
        ? createLeafFeature(f.id, attrs, color, createShape())
        : createLeafFeature(f.id, attrs, color, createShape(), { parentId: f.parentId }),
    ),
  );
}

function build(
  features: readonly LedgerFeature[],
  overrides: Partial<Parameters<typeof buildLedgerRows>[0]> = {},
) {
  return buildLedgerRows({
    features,
    forest: forestOf(features),
    expanded: new Set<FeatureId>(),
    query: '',
    tree: true,
    ...overrides,
  });
}

describe('台帳の行 — 階層のたたみ込み', () => {
  it('木では根だけが出て、展開すると子が 1 段下がって出る', () => {
    const features = [lf('p', '親国', null), lf('c', '子州', 'p')];
    const closed = build(features);
    expect(closed.rows.map((r) => r.name)).toEqual(['親国']);
    expect(closed.rows[0]?.hasChildren).toBe(true);
    expect(closed.rows[0]?.expanded).toBe(false);

    const open = build(features, { expanded: new Set([id('p')]) });
    expect(open.rows.map((r) => r.name)).toEqual(['親国', '子州']);
    expect(open.rows.map((r) => r.indent)).toEqual([0, 1]);
  });

  it('平では階層を無視して全部が同じ段で並ぶ', () => {
    const features = [lf('p', '親国', null), lf('c', '子州', 'p')];
    const flat = build(features, { tree: false });
    expect(flat.rows.map((r) => r.name)).toEqual(['親国', '子州']);
    expect(flat.rows.map((r) => r.indent)).toEqual([0, 0]);
  });

  it('絞り込むと、一致した子だけでなく **その先祖も残り、自動で開く**', () => {
    // 先祖を落とすと、一致した子へ辿り着く道が画面から消えて木として意味を成さない。
    const features = [lf('p', '親国', null), lf('c', '子州', 'p'), lf('x', '別国', null)];
    const result = build(features, { query: '子州' });
    expect(result.rows.map((r) => r.name)).toEqual(['親国', '子州']);
    // 母集団の件数は絞る前の全件、一致は 1 件。
    expect(result.totalCount).toBe(3);
    expect(result.matchCount).toBe(1);
    expect(result.autoExpanded.has(id('p'))).toBe(true);
  });

  it('**自分で開いた親は、絞り込みに当たらない子も出す**（押しても何も起きない三角を作らない）', () => {
    // 絞り込み中に親の三角を押しても何も起きない、では「押しても何も起きないボタン」に
    // なる（C9 の②）。自動で開いた親（探した結果を見せるための開き）とは分ける。
    const features = [lf('p', '親国', null), lf('c', '子州', 'p'), lf('x', '別国', null)];
    const auto = build(features, { query: '親国' });
    // 自動で開いた親: 当たった行（親）だけが出る。
    expect(auto.rows.map((r) => r.name)).toEqual(['親国']);

    const manual = build(features, { query: '親国', expanded: new Set([id('p')]) });
    // 自分で開いた親: 当たらない子も出る。
    expect(manual.rows.map((r) => r.name)).toEqual(['親国', '子州']);
  });

  it('種別でも絞り込める（V5: 種別で絞れること）', () => {
    const features = [
      lf('a', 'アアウェン州', null, { kindLabel: '州' }),
      lf('b', 'アルラーク国', null, { kindLabel: '島国' }),
    ];
    const result = build(features, { query: '島国' });
    expect(result.rows.map((r) => r.name)).toEqual(['アルラーク国']);
  });

  it('親子が循環していても止まる（教訓 5.28）', () => {
    const features = [lf('a', 'A', 'b'), lf('b', 'B', 'a')];
    const result = build(features, { expanded: new Set([id('a'), id('b')]) });
    // どちらも根には見えないが、走査は必ず終わる（行が有限）。
    expect(result.rows.length).toBeLessThanOrEqual(2);
  });
});

describe('台帳の行 — 重複名の見分け（3 段。設計書 §C.5）', () => {
  it('重複していなければ見分けは付かない', () => {
    const rows = build([lf('a', 'アアウェン州', null)]).rows;
    expect(rows[0]?.qualifier).toBeNull();
    expect(qualifierStageOf(rows[0]?.qualifier ?? null)).toBe(QUALIFIER_STAGE.None);
  });

  it('1 段目: 親が違えば〈親名〉で区別できる', () => {
    const features = [
      lf('p1', 'デーレ共和国', null),
      lf('p2', '正統ノル王国', null),
      lf('a', '???州', 'p1'),
      lf('b', '???州', 'p2'),
    ];
    const rows = build(features, {
      expanded: new Set([id('p1'), id('p2')]),
    }).rows;
    const a = rows.find((r) => r.featureId === id('a'));
    const b = rows.find((r) => r.featureId === id('b'));
    expect(a?.qualifier).toBe('〈デーレ共和国〉');
    expect(b?.qualifier).toBe('〈正統ノル王国〉');
    expect(qualifierStageOf(a?.qualifier ?? null)).toBe(QUALIFIER_STAGE.Parent);
  });

  it('3 段目: 親も階層のみちも同じ「???州」10 件は、通し番号と座標まで出して区別する', () => {
    // 実データの「???州」10 件は **すべてデーレ共和国の子**なので、〈親名〉でも
    // 階層のみちでも 10 行が同じ表示になる（設計書 §O の GPT V4）。
    const parent = lf('deere', 'デーレ共和国', null);
    const children = Array.from({ length: 10 }, (_, i) =>
      lf(`s${String(i)}`, '???州', 'deere', {
        point: { lon: 88 + i, lat: 12 + i },
      }),
    );
    const features = [parent, ...children];
    const bundleIndex = new Map<FeatureId, number>(
      children.map((c, i) => [c.id, i + 1]),
    );
    const rows = build(features, {
      expanded: new Set([id('deere')]),
      bundleIndex,
    }).rows;
    const shown = rows.filter((r) => r.name === '???州');
    expect(shown).toHaveLength(10);
    // **10 行が全部ちがう見分けを持つ**（これが「画面上で区別できる」の中身）。
    const qualifiers = shown.map((r) => r.qualifier);
    expect(new Set(qualifiers).size).toBe(10);
    expect(qualifiers[0]).toBe('#1 ／ 北12.0° 東88.0°');
    expect(qualifierStageOf(qualifiers[0] ?? null)).toBe(QUALIFIER_STAGE.Position);
  });

  it('段は かたまりごとに 独立に上がる（親で区別できるものは〈親名〉のまま）', () => {
    const features = [
      lf('p1', 'デーレ共和国', null),
      lf('p2', '正統ノル王国', null),
      // 親で区別できるかたまり
      lf('x1', '南ケナ州', 'p1'),
      lf('x2', '南ケナ州', 'p2'),
      // 親では区別できないかたまり
      lf('y1', '???州', 'p1', { point: { lon: 10, lat: 20 } }),
      lf('y2', '???州', 'p1', { point: { lon: 30, lat: 40 } }),
    ];
    const rows = build(features, { expanded: new Set([id('p1'), id('p2')]) }).rows;
    expect(rows.find((r) => r.featureId === id('x1'))?.qualifier).toBe('〈デーレ共和国〉');
    expect(qualifierStageOf(rows.find((r) => r.featureId === id('y1'))?.qualifier ?? null)).toBe(
      QUALIFIER_STAGE.Position,
    );
  });

  it('座標は 1 桁の短い形（28px の行に 6 桁は入らない）', () => {
    expect(compactCoordinate({ lon: 88.14, lat: 12.44 })).toBe('北12.4° 東88.1°');
    expect(compactCoordinate({ lon: -12.35, lat: -35.21 })).toBe('南35.2° 西12.4°');
    // 周回を持つ経度は代表値へ畳んでから出す。
    expect(compactCoordinate({ lon: 200, lat: 0 })).toBe('北0.0° 西160.0°');
  });
});

describe('台帳 — 仮想スクロールの窓', () => {
  it('行の高さは 28px の 1 種類（窓の計算の前提）', () => {
    expect(LEDGER_ROW_HEIGHT).toBe(28);
  });

  it('5,000 行でも描くのは「窓に入るぶん＋前後 2 行」だけ', () => {
    const viewport = 240; // 1280×800 の一覧の実測に近い高さ
    const win = ledgerWindow(5000, 0, viewport);
    const drawn = win.endIndex - win.startIndex;
    // 240 / 28 = 8.57 → 9 行 + 1 + 前後の余分 2 = 12 以下。受け入れ条件は「20 個以下」。
    expect(drawn).toBeLessThanOrEqual(20);
    expect(win.totalHeight).toBe(5000 * LEDGER_ROW_HEIGHT);
  });

  it('スクロールすると窓が動き、上に空ける高さが行の高さの倍数になる', () => {
    const win = ledgerWindow(5000, 28 * 100, 240);
    expect(win.startIndex).toBe(100 - LEDGER_OVERSCAN);
    expect(win.offsetY).toBe((100 - LEDGER_OVERSCAN) * LEDGER_ROW_HEIGHT);
  });

  it('高さが 0（レイアウトを持たない環境）でも先頭の数行を返す（教訓 5.49）', () => {
    // 0 行を返すと「一覧が空」と区別が付かず、jsdom の検査が中身を確かめられない。
    const win = ledgerWindow(100, 0, 0);
    expect(win.endIndex).toBeGreaterThan(0);
  });

  it('0 行のときは何も描かない', () => {
    expect(ledgerWindow(0, 0, 240)).toEqual({
      startIndex: 0,
      endIndex: 0,
      offsetY: 0,
      totalHeight: 0,
    });
  });

  it('窓の外の行を画面へ入れるスクロール位置を出す（束の送りで飛んだ先を見せる）', () => {
    // 下へ外れている: 行の下端が窓の下端に合う。
    expect(scrollTopForRow(20, 0, 240)).toBe(21 * 28 - 240);
    // 上へ外れている: 行の上端が窓の上端に合う。
    expect(scrollTopForRow(2, 500, 240)).toBe(2 * 28);
    // 既に入っている: 動かさない。
    expect(scrollTopForRow(3, 0, 240)).toBe(0);
  });
});

describe('台帳 — 束の「済」と未処理の絞り込み', () => {
  it('済の行に印が付き、「未処理だけ」で消える', () => {
    const features = [lf('a', 'A', null), lf('b', 'B', null)];
    const done = new Set([id('a')]);
    const withDone = build(features, {
      done,
      bundleIndex: new Map([
        [id('a'), 1],
        [id('b'), 2],
      ]),
    });
    expect(withDone.rows.find((r) => r.featureId === id('a'))?.done).toBe(true);
    expect(withDone.rows.find((r) => r.featureId === id('b'))?.done).toBe(false);

    const onlyOpen = build(features, {
      done,
      bundleIndex: new Map([
        [id('a'), 1],
        [id('b'), 2],
      ]),
      onlyUnfinished: true,
    });
    expect(onlyOpen.rows.map((r) => r.name)).toEqual(['B']);
  });

  it('「未処理だけ」のときの分母は **束の大きさ**（総数ではない）', () => {
    // 2026-09-06、2 回目の手直し。旧版は分母を常に母集団の総数にしていたので、
    // 220 件の作業に絞っても「775 件中 …」と出て、**まとまりの大きさが画面のどこにも
    // 出なかった**。
    const features = [lf('a', 'A', null), lf('b', 'B', null), lf('c', 'C', null)];
    const forest = forestOf(features);
    const bundleIndex = new Map([
      [id('a'), 1],
      [id('b'), 2],
    ]);
    const done = new Set([id('a')]);

    const all = buildLedgerRows({ features, forest, expanded: new Set(), query: '', tree: false });
    expect(all.totalCount).toBe(3);

    const onlyOpen = buildLedgerRows({
      features,
      forest,
      expanded: new Set(),
      query: '',
      tree: false,
      done,
      bundleIndex,
      onlyUnfinished: true,
    });
    // 分母は束の 2 件、分子は未処理の 1 件。
    expect(onlyOpen.totalCount).toBe(2);
    expect(onlyOpen.matchCount).toBe(1);
  });
});

describe('台帳 — まとめ役も行になる', () => {
  it('まとめ役（集約地物）は子を持つので展開の三角が出る', () => {
    const features = [
      { ...lf('agg', 'デーレ共和国', null), kind: 'aggregate' as const },
      lf('c', 'アアウェン州', 'agg'),
    ];
    const forest = buildForest([
      createAggregateFeature(id('agg'), attrs, color, [id('c')]),
      createLeafFeature(id('c'), attrs, color, createShape(), { parentId: id('agg') }),
    ]);
    const result = buildLedgerRows({
      features,
      forest,
      expanded: new Set(),
      query: '',
      tree: true,
    });
    expect(result.rows[0]?.hasChildren).toBe(true);
  });
});
