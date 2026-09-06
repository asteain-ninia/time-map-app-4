// UI layer (U31 / 素性欄): 削除の影響を **文にする**ところの検査（設計書 §A.3 /
// 増分 7 の中身 6）。
//
// ドメイン側（`domain/deletion/impact.test.ts`）は「数え上げが実際の結果と一致するか」を
// 見る。こちらは「その数が **画面の文**になるか」を見る ―― 群の並び、名前の畳み方、
// 断りの理由の出方である。

import { describe, expect, it } from 'vitest';

import { DELETE_REJECT, DELETE_VERDICT, type DeletionImpact } from '../../domain/deletion/index';
import { asFeatureId, type FeatureId } from '../../domain/ids';

import { buildDeleteImpactView, summarizeNames } from './delete-impact';

const NAMES: Readonly<Record<string, string>> = {
  a: 'アアウェン州',
  b: '南ケナ州',
  c: '第三の州',
  agg: 'デーレ共和国',
};

function nameOf(id: FeatureId): string | null {
  return NAMES[id as unknown as string] ?? null;
}

function impactOf(over: Partial<DeletionImpact>): DeletionImpact {
  return {
    targetId: asFeatureId('agg'),
    ownAnchorYears: [0, 1200],
    vertexCount: 0,
    ownsShape: false,
    promotedChildIds: [],
    autoRemovedIds: [],
    verdict: { kind: DELETE_VERDICT.Allowed },
    ...over,
  };
}

describe('summarizeNames — 長い一覧を「A・B ほか n 件」に畳む', () => {
  it('0 件なら空文字', () => {
    expect(summarizeNames([])).toBe('');
  });

  it('2 件までは全部出す', () => {
    expect(summarizeNames(['A', 'B'])).toBe('A・B');
  });

  it('3 件以上は先頭 2 件＋残りの件数', () => {
    expect(summarizeNames(['A', 'B', 'C', 'D'])).toBe('A・B ほか 2 件');
  });
});

describe('buildDeleteImpactView — 影響の一覧の文（設計書 §A.3 の文面）', () => {
  it('見出しに対象の名前を入れる', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({}),
      targetName: 'デーレ共和国',
      nameOf,
    });
    expect(view.title).toContain('デーレ共和国');
    expect(view.title).toContain('全部の年から消します');
  });

  it('まとめ役では「頂点 0 個（自分の形を持ちません）」と言う', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ ownsShape: false, vertexCount: 0 }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    const gone = view.groups.find((g) => g.testId === 'gone');
    expect(gone?.lines.some((l) => l.includes('自分の形を持ちません'))).toBe(true);
  });

  it('形を持つ地物では頂点の数を出す', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ ownsShape: true, vertexCount: 601 }),
      targetName: 'バアカ',
      nameOf,
    });
    const gone = view.groups.find((g) => g.testId === 'gone');
    expect(gone?.lines.some((l) => l.includes('601'))).toBe(true);
  });

  it('錨の年を並べる（どの年の記録が消えるのかが読める）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ ownAnchorYears: [0, 1200] }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    const gone = view.groups.find((g) => g.testId === 'gone');
    expect(gone?.lines[0]).toContain('0年');
    expect(gone?.lines[0]).toContain('1200年');
  });

  it('自分の歴史を持たない地物では、親が持っていることを言う', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ ownAnchorYears: [] }),
      targetName: '南ケナ州',
      nameOf,
    });
    const gone = view.groups.find((g) => g.testId === 'gone');
    expect(gone?.lines[0]).toContain('上位領域の記録の中に居ます');
  });

  it('最上位へ移る下位領域を、件数と名前で出す（設計書 §A.3 の 60 州の文）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({
        promotedChildIds: [asFeatureId('a'), asFeatureId('b'), asFeatureId('c')],
      }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    const ref = view.groups.find((g) => g.testId === 'referenced');
    expect(ref?.lines[0]).toContain('3 件');
    expect(ref?.lines[0]).toContain('アアウェン州・南ケナ州 ほか 1 件');
    expect(ref?.lines[0]).toContain('すべての年で最上位へ移ります');
  });

  it('下位領域が居なければ、その群は行を持たない（器が空の見出しを出さない）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ promotedChildIds: [] }),
      targetName: 'バアカ',
      nameOf,
    });
    expect(view.groups.find((g) => g.testId === 'referenced')?.lines).toEqual([]);
  });

  it('自動で消える地物が無いときは「なし」と言い切る（沈黙しない）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ autoRemovedIds: [] }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    expect(view.groups.find((g) => g.testId === 'auto')?.lines[0]).toContain('なし');
  });

  it('自動で消える地物があれば件数と名前を出す（FR-41 の連鎖消滅）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ autoRemovedIds: [asFeatureId('agg')] }),
      targetName: 'アアウェン州',
      nameOf,
    });
    const auto = view.groups.find((g) => g.testId === 'auto');
    expect(auto?.lines[0]).toContain('1 件');
    expect(auto?.lines[0]).toContain('デーレ共和国');
  });

  it('再編できない見込みは「気をつけること」として出す。**実行は止めない**（裁定 (あ)）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({
        verdict: {
          kind: DELETE_VERDICT.Rejected,
          reason: DELETE_REJECT.ReorganizationImpossible,
          featureIds: [asFeatureId('agg')],
        },
      }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    // 裁定一覧 A の 2026-09-03 は「削除＝錨を全部消し、子は昇格」＝ **掃除して消す**。
    // 判定は警告として出すが、ボタンは押せる。
    expect(view.blockedReason).toBeNull();
    expect(view.groups.find((g) => g.testId === 'caution')?.lines[0]).toContain('削除できません');
  });

  it('消せるときは「気をつけること」の行が無い（空の見出しを出さない）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({}),
      targetName: 'デーレ共和国',
      nameOf,
    });
    expect(view.blockedReason).toBeNull();
    expect(view.groups.find((g) => g.testId === 'caution')?.lines).toEqual([]);
  });

  it('取り消せることを注記に出す（FR-73）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({}),
      targetName: 'デーレ共和国',
      nameOf,
    });
    expect(view.note).toContain('Ctrl+Z');
  });

  it('名前が引けない地物は件数にだけ数える（内部 id を画面に出さない＝U-1）', () => {
    const view = buildDeleteImpactView({
      impact: impactOf({ promotedChildIds: [asFeatureId('a'), asFeatureId('unknown-id')] }),
      targetName: 'デーレ共和国',
      nameOf,
    });
    const ref = view.groups.find((g) => g.testId === 'referenced');
    expect(ref?.lines[0]).toContain('2 件');
    expect(ref?.lines[0]).not.toContain('unknown-id');
  });
});
