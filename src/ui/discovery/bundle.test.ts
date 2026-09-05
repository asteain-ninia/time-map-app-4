// 作業のまとまり（束。設計書 §C.5 の「束の定義」/ V4）。
//
// ここで固定するのは 5 つ:
//   1. **並びは母集団の並びのまま**（改名しても行が動かない ＝ 報告 E §2.10 の解）
//   2. **「済」は保存せず導出する**（作った時点の名前・種別と、いまの姿が違うか）
//   3. **開き直しても同じ 220 件が同じ並びで出る**（式は通史で当てはめる）
//   4. **送り**（次の未処理へ。末尾まで無ければ先頭へ回り込む）
//   5. **読めない式は理由を返す**（例外を画面へ出さない）

import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../../domain/ids';

import {
  BUNDLE_KIND,
  BUNDLE_PRESETS,
  buildBundle,
  bundleIndexOf,
  doneIdsOf,
  firstUnfinishedIndex,
  indexOfMember,
  isMemberDone,
  nextUnfinishedIndex,
  stepIndex,
  fromSavedBundle,
  toSavedBundle,
  unavailableMemberCount,
  withCursor,
  type BundleSource,
} from './bundle';
import { BUNDLE_STRINGS } from './strings';

/** 作成日時は判定に使わないので、テストでは固定値を 1 つ使う。 */
const FIXED_AT = '2026-09-05T00:00:00.000Z';

function id(s: string): FeatureId {
  return asFeatureId(s);
}

function source(
  features: readonly { id: string; name: string; kindLabel?: string }[],
  overrides: Partial<BundleSource> = {},
): BundleSource {
  return {
    features: features.map((f) => ({
      id: id(f.id),
      name: f.name,
      kindLabel: f.kindLabel ?? '',
    })),
    historyOf: () => [],
    changedThisYear: () => false,
    family: new Set(),
    marked: new Set(),
    ...overrides,
  };
}

describe('束 — 既定の式', () => {
  it('既定は 10 種で、実データの命名規約が式として画面に出る', () => {
    expect(BUNDLE_PRESETS).toHaveLength(10);
    const kana = BUNDLE_PRESETS.find((p) => p.id === 'kana-area');
    expect(kana?.expression).toBe('付近の領域[0-9]+$');
    expect(kana?.kind).toBe(BUNDLE_KIND.Expression);
  });

  it('式は画面から書き換えられる（既定を使わずに作れる）', () => {
    const built = buildBundle(
      { presetId: null, label: '自作', kind: BUNDLE_KIND.Expression, expression: '^テスト', createdAt: FIXED_AT },
      source([{ id: 'a', name: 'テスト国' }, { id: 'b', name: '別国' }]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a')]);
  });

  it('読めない式は理由を返す（例外を投げない・内部の英語をそのまま出さない）', () => {
    const built = buildBundle(
      { presetId: null, label: 'x', kind: BUNDLE_KIND.Expression, expression: '[', createdAt: FIXED_AT },
      source([{ id: 'a', name: 'A' }]),
    );
    expect(built.ok).toBe(false);
    if (built.ok) return;
    // **エンジン由来の英語を 1 文字も混ぜない**（手直し B11）。日本語で始まることだけ
    // 見ていた旧版は、`Invalid regular expression: ...` を丸ごと連結していても通った。
    expect(built.message).toBe(BUNDLE_STRINGS.invalidExpression);
    expect(/[A-Za-z]/.test(built.message)).toBe(false);
  });

  it('全角で打った式も、絞り込み欄と同じように当たる（NFKC で畳む）', () => {
    const built = buildBundle(
      { presetId: null, label: 'x', kind: BUNDLE_KIND.Expression, expression: '領域［０－９］＋$', createdAt: FIXED_AT },
      source([{ id: 'a', name: '付近の領域12' }, { id: 'b', name: '別国' }]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a')]);
  });

  it('「手で印を付けたもの」はまだ選べない（増分 7 まで）', () => {
    const marked = BUNDLE_PRESETS.find((p) => p.id === 'marked');
    expect(marked?.available).toBe(false);
    // ほかの既定は選べる（既定で `available` を書かないものは選べる扱い）。
    expect(BUNDLE_PRESETS.filter((p) => p.available === false)).toHaveLength(1);
  });
});

describe('束 — 並びと「済」', () => {
  it('並びは母集団の並びのまま（改名しても行が動かない）', () => {
    const built = buildBundle(
      {
        presetId: 'kana-area',
        label: '仮名',
        kind: BUNDLE_KIND.Expression,
        expression: '付近の領域[0-9]+$',
        createdAt: FIXED_AT,
      },
      source([
        { id: 'a', name: 'ヴィオニア大陸付近の領域01' },
        { id: 'x', name: '別国' },
        { id: 'b', name: 'ヴィオニア大陸付近の領域02' },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a'), id('b')]);
    expect(bundleIndexOf(built.bundle).get(id('b'))).toBe(2);
  });

  it('「済」は作った時点の名前・種別と、いまの姿の違いで決まる（保存しない）', () => {
    const member = { featureId: id('a'), baselineName: '仮名', baselineKindLabel: '' };
    expect(isMemberDone(member, { name: '仮名', kindLabel: '' })).toBe(false);
    expect(isMemberDone(member, { name: '本名', kindLabel: '' })).toBe(true);
    // 種別だけ直しても済（V5 の (a) がこれで数えられる）。
    expect(isMemberDone(member, { name: '仮名', kindLabel: '州' })).toBe(true);
    // その年に居ない地物は「済」ではない（消えたことを直したとは言わない）。
    expect(isMemberDone(member, undefined)).toBe(false);
  });

  it('**開き直しても続けられる**: 改名して式から外れた地物も束に残り、済として出る', () => {
    // 開き直すと束そのものは消えるが、同じ式を選び直すと通史で当てはめるので
    // **同じ件数が同じ並びで戻り、名前が変わっているものは済として出る**（設計書 §C.5）。
    const built = buildBundle(
      {
        presetId: 'kana-area',
        label: '仮名',
        kind: BUNDLE_KIND.Expression,
        expression: '付近の領域[0-9]+$',
        createdAt: FIXED_AT,
      },
      source(
        [
          // いまの名前は本名（＝式に当てはまらない）だが、昔の錨では仮名だった。
          { id: 'a', name: 'アアウェン州' },
          { id: 'b', name: 'ヴィオニア大陸付近の領域02' },
        ],
        {
          historyOf: (featureId) =>
            featureId === id('a')
              ? [
                  { name: 'ヴィオニア大陸付近の領域01', kindLabel: '' },
                  { name: 'アアウェン州', kindLabel: '' },
                ]
              : [{ name: 'ヴィオニア大陸付近の領域02', kindLabel: '' }],
        },
      ),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    // **2 件とも束に居る**（改名したほうも落ちない）。
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a'), id('b')]);
    // 基準は「当てはまったいちばん古い姿」。
    expect(built.bundle.members[0]?.baselineName).toBe('ヴィオニア大陸付近の領域01');

    const done = doneIdsOf(built.bundle, (featureId) =>
      featureId === id('a')
        ? { name: 'アアウェン州', kindLabel: '' }
        : { name: 'ヴィオニア大陸付近の領域02', kindLabel: '' },
    );
    expect([...done]).toEqual([id('a')]);
  });
});

describe('束 — 組み込みの判定', () => {
  it('名前が重複しているもの', () => {
    const built = buildBundle(
      { presetId: 'duplicate-name', label: 'x', kind: BUNDLE_KIND.DuplicateName, expression: '', createdAt: FIXED_AT },
      source([
        { id: 'a', name: '???州' },
        { id: 'b', name: '???州' },
        { id: 'c', name: '固有' },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a'), id('b')]);
  });

  it('種別が付いていないもの（空文字は「付いていない」）', () => {
    const built = buildBundle(
      { presetId: 'no-kind-label', label: 'x', kind: BUNDLE_KIND.NoKindLabel, expression: '', createdAt: FIXED_AT },
      source([
        { id: 'a', name: 'A', kindLabel: '' },
        { id: 'b', name: 'B', kindLabel: '州' },
      ]),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('a')]);
  });

  it('この年に変わったもの（母集団は現在時刻側の絞り込み＝§N-14 の (A)）', () => {
    const built = buildBundle(
      {
        presetId: 'changed-this-year',
        label: 'x',
        kind: BUNDLE_KIND.ChangedThisYear,
        expression: '',
        createdAt: FIXED_AT,
      },
      source([{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], {
        changedThisYear: (featureId) => featureId === id('b'),
      }),
    );
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.bundle.members.map((m) => m.featureId)).toEqual([id('b')]);
  });
});

describe('束 — 送り', () => {
  const bundle = {
    presetId: null,
    label: 'x',
    kind: BUNDLE_KIND.Expression,
    expression: '',
    members: [
      { featureId: id('a'), baselineName: 'A', baselineKindLabel: '' },
      { featureId: id('b'), baselineName: 'B', baselineKindLabel: '' },
      { featureId: id('c'), baselineName: 'C', baselineKindLabel: '' },
    ],
    cursor: 0,
    createdAt: FIXED_AT,
  } as const;

  it('先頭の未処理から始まる（束を作った瞬間に選ぶもの）', () => {
    expect(firstUnfinishedIndex(bundle, new Set())).toBe(0);
    expect(firstUnfinishedIndex(bundle, new Set([id('a')]))).toBe(1);
    expect(firstUnfinishedIndex(bundle, new Set([id('a'), id('b'), id('c')]))).toBeNull();
  });

  it('次の未処理へ送る。末尾まで無ければ先頭へ回り込む', () => {
    expect(nextUnfinishedIndex(bundle, new Set(), 0)).toBe(1);
    expect(nextUnfinishedIndex(bundle, new Set([id('b')]), 0)).toBe(2);
    // 末尾に居て、残る未処理が前にあるとき。
    expect(nextUnfinishedIndex(bundle, new Set([id('c')]), 2)).toBe(0);
    expect(nextUnfinishedIndex(bundle, new Set([id('a'), id('b'), id('c')]), 0)).toBeNull();
  });

  it('戻るときは済を飛ばさない（さっき直したものを見直すため）', () => {
    const at = withCursor(bundle, 2);
    expect(stepIndex(at, new Set([id('b')]), -1)).toBe(1);
  });

  it('全部済んでいても「次へ」で 1 つ進める（見直しのために詰まらせない）', () => {
    const all = new Set([id('a'), id('b'), id('c')]);
    expect(stepIndex(bundle, all, 1)).toBe(1);
  });

  it('カーソルは範囲の端で止まる', () => {
    expect(withCursor(bundle, -5).cursor).toBe(0);
    expect(withCursor(bundle, 99).cursor).toBe(2);
    // 変化が無ければ同じ参照（描画の世代を無駄に進めない）。
    expect(withCursor(bundle, 0)).toBe(bundle);
  });

  it('取り消しで戻った地物の位置を引ける（Ctrl+Z でカーソルが追いかける）', () => {
    expect(indexOfMember(bundle, id('c'))).toBe(2);
    expect(indexOfMember(bundle, id('zzz'))).toBeNull();
  });

  // 手直し G2: 消した地物・その年に居ない地物は **並びには残すが送りでは飛ばす**。
  // 飛ばさないと「次へ」で素性欄が空・カメラも動かない幽霊が選ばれ、しかも永久に
  // 済にならないので束が終わらない。
  // 手直し D / 司令塔の決定 (1): 束を保存ファイルの節へ書いて、開き直しても続けられる。
  it('保存の形と行き来しても、並び・基準・カーソル・作成日時が変わらない', () => {
    const at = withCursor(bundle, 2);
    const saved = toSavedBundle(at);
    expect(saved.members.map((m) => m.featureId)).toEqual(['a', 'b', 'c']);
    expect(saved.createdAt).toBe(FIXED_AT);
    const back = fromSavedBundle(saved);
    expect(back).toEqual(at);
  });

  it('知らない種類は式として読む（束を丸ごと失わない）', () => {
    const saved = { ...toSavedBundle(bundle), kind: 'まだ無い種類' };
    expect(fromSavedBundle(saved).kind).toBe(BUNDLE_KIND.Expression);
  });

  it('範囲の外のカーソルは並びの中へ収める', () => {
    const saved = { ...toSavedBundle(bundle), cursor: 99 };
    expect(fromSavedBundle(saved).cursor).toBe(2);
    expect(fromSavedBundle({ ...toSavedBundle(bundle), cursor: 0, members: [] }).cursor).toBe(0);
  });

  it('いま居ないメンバーは送りで飛ばす（並びと通し番号は動かさない）', () => {
    const available = (featureId: FeatureId): boolean => featureId !== id('b');
    expect(unavailableMemberCount(bundle, available)).toBe(1);
    // 0 → （b を飛ばして）2
    expect(stepIndex(bundle, new Set(), 1, available)).toBe(2);
    // 2 → （b を飛ばして）0 へ回り込む
    expect(stepIndex(withCursor(bundle, 2), new Set(), 1, available)).toBe(0);
    // 戻るときも飛ばす
    expect(stepIndex(withCursor(bundle, 2), new Set(), -1, available)).toBe(0);
    // 先頭の未処理も居るものから選ぶ
    expect(firstUnfinishedIndex(bundle, new Set([id('a')]), available)).toBe(2);
  });
});
