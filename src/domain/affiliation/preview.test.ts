// U28 — 所属変更を確定する前の説明器の検査（増分 7 の中身 2b / 4）。
//
// ここで固定するのは 3 つ。
//   1. 洗い直し（{@link planAffiliationTargets}）が **確定と同じ展開規則**で動くこと
//      ―― 集約地物は下位領域へ広げ、居ないものは理由つきで外す。
//   2. 「子を得る既存の地物」（{@link gainingParentId}）を決定から先読みできること。
//   3. 分け残し（直轄領）が生まれる見込みと既定名称（{@link previewDirectDomain}）。

import { describe, expect, it } from 'vitest';

import { aggregate, fid, leafTile } from '../deletion/fixtures';
import { asFeatureId } from '../ids';

import { CREATE_TERMINAL, parentCreateWithTerminal, parentExisting, parentNone } from './decision';
import {
  AFFILIATION_TARGET_DROP,
  gainingParentId,
  planAffiliationTargets,
  previewDirectDomain,
} from './preview';

function world(): ReturnType<typeof leafTile>['feature'][] {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const lone = leafTile('lone', 40, 0, 10, 10);
  return [aggregate('agg', ['a', 'b']), a.feature, b.feature, lone.feature];
}

describe('planAffiliationTargets — 対象の洗い直し（FR-48 / 増分 7 の中身 2b）', () => {
  it('末端はそのまま対象になる', () => {
    const plan = planAffiliationTargets(world(), [fid('lone')]);
    expect(plan.leafIds).toEqual([fid('lone')]);
    expect(plan.expansions).toEqual([]);
    expect(plan.dropped).toEqual([]);
  });

  it('集約地物は全下位領域へ広げ、広げたことを記録する（FR-48 後半）', () => {
    const plan = planAffiliationTargets(world(), [fid('agg')]);
    expect([...plan.leafIds].sort()).toEqual([fid('a'), fid('b')].sort());
    expect(plan.expansions).toHaveLength(1);
    expect(plan.expansions[0]?.aggregateId).toBe(fid('agg'));
    expect(plan.expansions[0]?.leafIds).toHaveLength(2);
  });

  it('重複は 1 件に畳む（集約地物とその子を両方マークしても増えない）', () => {
    const plan = planAffiliationTargets(world(), [fid('agg'), fid('a')]);
    expect([...plan.leafIds].sort()).toEqual([fid('a'), fid('b')].sort());
  });

  it('その年に居ない ID は理由つきで外す（黙って落とさない）', () => {
    const plan = planAffiliationTargets(world(), [fid('lone'), asFeatureId('ghost')]);
    expect(plan.leafIds).toEqual([fid('lone')]);
    expect(plan.dropped).toEqual([
      { featureId: asFeatureId('ghost'), reason: AFFILIATION_TARGET_DROP.Missing },
    ]);
  });

  it('下位領域を 1 つも持たない集約地物も理由つきで外す', () => {
    const features = [...world(), aggregate('empty', [])];
    const plan = planAffiliationTargets(features, [fid('empty')]);
    expect(plan.leafIds).toEqual([]);
    expect(plan.dropped).toEqual([
      { featureId: fid('empty'), reason: AFFILIATION_TARGET_DROP.EmptyAggregate },
    ]);
  });

  it('入力の並びを保つ（画面の予告文が押した順で読める）', () => {
    const plan = planAffiliationTargets(world(), [fid('lone'), fid('a')]);
    expect(plan.leafIds).toEqual([fid('lone'), fid('a')]);
  });
});

describe('gainingParentId — 外から子を得る既存の地物', () => {
  it('既存を選んだらその地物', () => {
    expect(gainingParentId(parentExisting(fid('agg')))).toBe(fid('agg'));
  });

  it('最上位へ（独立）なら誰も子を得ない', () => {
    expect(gainingParentId(parentNone)).toBeUndefined();
  });

  it('新しく作って最上位に置くなら、既存の誰も子を得ない（連邦化）', () => {
    const decision = parentCreateWithTerminal(
      { name: 'エテ連邦' },
      { kind: CREATE_TERMINAL.NewTop },
    );
    expect(gainingParentId(decision)).toBeUndefined();
  });

  it('新しく作って既存の下に置くなら、その既存が子を得る（自治化・帰属）', () => {
    const decision = parentCreateWithTerminal(
      { name: '中間層' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('lone') },
    );
    expect(gainingParentId(decision)).toBe(fid('lone'));
  });
});

describe('previewDirectDomain — 分け残し（直轄領）の見込みと既定名称（G-4 / FR-37）', () => {
  it('形を持つ末端が子を得るときだけ出る', () => {
    const preview = previewDirectDomain(world(), parentExisting(fid('lone')));
    expect(preview).not.toBeNull();
    expect(preview?.ownerId).toBe(fid('lone'));
    expect(preview?.ownerName).toBe('leaf-lone');
    // 既定名称の規則はドメインの 1 か所（`defaultDirectDomainName`）が決める。
    expect(preview?.defaultName).toBe('leaf-lone 直轄領');
  });

  it('集約地物が親のときは出ない（形を持たないので分け残しが無い）', () => {
    expect(previewDirectDomain(world(), parentExisting(fid('agg')))).toBeNull();
  });

  it('最上位へ（独立）のときは出ない', () => {
    expect(previewDirectDomain(world(), parentNone)).toBeNull();
  });

  it('新しく作って既存の面の下に置くときも出る（再帰の先まで見る）', () => {
    const decision = parentCreateWithTerminal(
      { name: '中間層' },
      { kind: CREATE_TERMINAL.ExistingTop, topId: fid('lone') },
    );
    expect(previewDirectDomain(world(), decision)?.ownerId).toBe(fid('lone'));
  });

  it('居ない地物を指していたら出ない（捏造しない）', () => {
    expect(previewDirectDomain(world(), parentExisting(asFeatureId('ghost')))).toBeNull();
  });
});
