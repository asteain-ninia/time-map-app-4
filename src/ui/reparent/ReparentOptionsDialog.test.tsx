// U28 — 3 択の作業ダイアログの検査（増分 7 の中身 1・2・4・9・11）。
//
// ここで固定するのは 5 つ。
//   1. **3 択がある**（既存から選ぶ／新しく作る／最上位へ）。
//   2. **新しい親は台帳と同じツリーから選ぶ**（773 件の素のプルダウンをやめた）。
//      選べない候補は理由つきで灰色になる。
//   3. **分け残し（直轄領）の名前を確定前に上書きできる**（G-4 / FR-37 must）。
//   4. **予告文**が件数と行き先を言う（V6・V7・V8）。
//   5. **用語集の 7 操作名**が説明文に出る（N-31 / 設計書 §H.1）。

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PARENT_DECISION, type ParentDecision } from '../../domain/affiliation/index';
import { aggregate, leafTile } from '../../domain/deletion/fixtures';
import type { Feature } from '../../domain/feature';
import { asFeatureId, type FeatureId } from '../../domain/ids';

import { REPARENT_CHOICE, ReparentOptionsDialog } from './ReparentOptionsDialog';
import { REPARENT_STRINGS } from './strings';

/** まとめ役 1 件（子 2 件）＋独立した面 1 件。親候補の木が 2 段になる。 */
function world(): readonly Feature[] {
  const a = leafTile('a', 0, 0, 10, 10, 'agg');
  const b = leafTile('b', 10, 0, 10, 10, 'agg');
  const lone = leafTile('lone', 40, 0, 10, 10);
  return [aggregate('agg', ['a', 'b']), a.feature, b.feature, lone.feature];
}

function mount(
  over: Partial<React.ComponentProps<typeof ReparentOptionsDialog>> = {},
): { onConfirm: ReturnType<typeof vi.fn>; unmount: () => void } {
  const onConfirm = vi.fn();
  const utils = render(
    <ReparentOptionsDialog
      features={world()}
      plan={{ leafIds: [asFeatureId('lone')], expansions: [], dropped: [] }}
      initialChoice={REPARENT_CHOICE.Existing}
      initialParentId={null}
      eligibility={() => null}
      yearLabel="1200年"
      message={null}
      committing={false}
      onConfirm={onConfirm}
      onCancel={() => {}}
      {...over}
    />,
  );
  return { onConfirm, unmount: utils.unmount };
}

describe('ReparentOptionsDialog — 3 択（増分 7 の中身 1）', () => {
  it('3 つの枝が並ぶ（FR-46 must の入口がここに揃う）', () => {
    mount();
    expect(screen.getByTestId('reparent-parent-existing')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-parent-create')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-parent-none')).toBeInTheDocument();
  });

  it('用語集の 7 操作名が説明文に出る（N-31 / 設計書 §H.1。ラベルにはしない）', () => {
    mount();
    const text = screen.getByTestId('reparent-options-parent').textContent ?? '';
    for (const word of ['割譲', '帰属', '直轄化', '連邦化', '自治化', '独立']) {
      expect(text).toContain(word);
    }
    // 7 つ目（解体）は 3 択に入らない操作なので、行き先だけを書く。
    expect(screen.getByTestId('reparent-dismantle-note').textContent).toContain('解体');
  });

  it('開く枝は呼び出し側が決める（押した部品と枝が 1 本の線でつながる）', () => {
    mount({ initialChoice: REPARENT_CHOICE.Create });
    expect(screen.getByTestId('reparent-parent-create')).toBeChecked();
    expect(screen.getByTestId('reparent-parent-create-name')).toBeInTheDocument();
  });
});

describe('ReparentOptionsDialog — 台帳と同じツリーから親を選ぶ（中身 2）', () => {
  it('候補は階層の木として出る（素のプルダウンではない）', () => {
    mount();
    // まとめ役も候補に出る（FR-48 は集約を親にすることを禁じていない）。
    expect(screen.getByTestId('reparent-parent-existing-pick-item-agg')).toBeInTheDocument();
    expect(screen.getByTestId('reparent-parent-existing-pick-item-lone')).toBeInTheDocument();
    // 木なので、子を持つ行には開閉の三角が付く。
    expect(screen.getByTestId('reparent-parent-existing-pick-expand-agg')).toBeInTheDocument();
  });

  it('絞り込みの欄がある（773 件から名前で探せる）', () => {
    mount();
    const filter = screen.getByTestId('reparent-parent-existing-pick-filter');
    fireEvent.change(filter, { target: { value: 'leaf-lone' } });
    expect(screen.queryByTestId('reparent-parent-existing-pick-item-lone')).toBeInTheDocument();
    expect(screen.queryByTestId('reparent-parent-existing-pick-item-b')).not.toBeInTheDocument();
  });

  it('選べない候補は理由つきで灰色になる（押せるのに断られる、をなくす）', () => {
    mount({ eligibility: (id: FeatureId) => (id === asFeatureId('agg') ? '循環します' : null) });
    const agg = screen.getByTestId('reparent-parent-existing-pick-item-agg');
    expect(agg).toBeDisabled();
    expect(agg).toHaveAttribute('title', '循環します');
    expect(screen.getByTestId('reparent-parent-existing-pick-item-lone')).not.toBeDisabled();
  });

  it('候補を選ぶと確定できる（決定は `parentExisting`）', () => {
    const h = mount();
    fireEvent.click(screen.getByTestId('reparent-parent-existing-pick-item-agg'));
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(h.onConfirm).toHaveBeenCalledTimes(1);
    const decision = h.onConfirm.mock.calls[0]?.[0] as ParentDecision;
    expect(decision.kind).toBe(PARENT_DECISION.Existing);
  });

  it('地図で拾った初期値が使えない相手なら、理由の行を出して確定させない（探索 explore-t2-r1）', () => {
    // ツリーの行は灰色で押せないが、地図で拾った上位領域は初期値として板へ入ってくる。
    // 以前は理由の行が出ているのに［確定］が押せ、押すと断られて板が閉じなかった。
    const h = mount({
      initialParentId: asFeatureId('agg'),
      eligibility: (id: FeatureId) => (id === asFeatureId('agg') ? '循環します' : null),
    });
    expect(screen.getByTestId('reparent-options-ineligible')).toBeInTheDocument();
    const confirm = screen.getByTestId('reparent-options-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    expect(h.onConfirm).not.toHaveBeenCalled();
  });

  it('候補を選ぶまでは確定できない（押しても断られるボタンを出さない）', () => {
    mount();
    expect(screen.getByTestId('reparent-options-confirm')).toBeDisabled();
  });
});

describe('ReparentOptionsDialog — 新しい上位領域を作る（G-3 / FR-47）', () => {
  it('名前が空のあいだは確定できない', () => {
    mount({ initialChoice: REPARENT_CHOICE.Create });
    expect(screen.getByTestId('reparent-options-confirm')).toBeDisabled();
  });

  it('名前と種別を入れると `parentCreate` の決定になる（連邦化のルート）', () => {
    const h = mount({ initialChoice: REPARENT_CHOICE.Create });
    fireEvent.change(screen.getByTestId('reparent-parent-create-name'), {
      target: { value: 'エテ連邦' },
    });
    fireEvent.change(screen.getByTestId('reparent-parent-create-kind'), {
      target: { value: '連邦' },
    });
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    const decision = h.onConfirm.mock.calls[0]?.[0] as ParentDecision;
    expect(decision.kind).toBe(PARENT_DECISION.Create);
    if (decision.kind === PARENT_DECISION.Create) {
      expect(decision.spec.name).toBe('エテ連邦');
      expect(decision.spec.kindLabel).toBe('連邦');
      // 最上位に置く（`above` が `none`）＝ 連邦化のルート。
      expect(decision.above.kind).toBe(PARENT_DECISION.None);
    }
  });

  it('「既存の下に置く」を選ぶと、置き場所の木が出る（自治化・帰属）', () => {
    mount({ initialChoice: REPARENT_CHOICE.Create });
    fireEvent.click(screen.getByTestId('reparent-create-terminal-under'));
    expect(screen.getByTestId('reparent-create-terminal-pick-tree')).toBeInTheDocument();
  });
});

describe('ReparentOptionsDialog — 分け残し（直轄領）の名前（G-4 / FR-37 must）', () => {
  it('形を持つ面を親にすると、名前の欄が出て既定名称が下敷きに出る', () => {
    mount({ initialParentId: asFeatureId('lone') });
    const input = screen.getByTestId('reparent-direct-domain-name');
    expect(input).toHaveAttribute('placeholder', 'leaf-lone 直轄領');
    expect(screen.getByTestId('reparent-direct-domain').textContent).toContain(
      '子に分けなかった残りの領域が 1 件増えます',
    );
  });

  it('まとめ役を親にすると、名前の欄そのものが出ない（分け残しが無いから）', () => {
    mount({ initialParentId: asFeatureId('agg') });
    expect(screen.queryByTestId('reparent-direct-domain')).not.toBeInTheDocument();
  });

  it('打った名前が確定へ渡る（空欄なら渡さない＝既定名称のまま）', () => {
    const h = mount({ initialParentId: asFeatureId('lone') });
    fireEvent.change(screen.getByTestId('reparent-direct-domain-name'), {
      target: { value: '本国' },
    });
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(h.onConfirm.mock.calls[0]?.[1]).toEqual({ directDomainNameOverride: '本国' });
    h.unmount();
  });

  it('空欄のままなら上書きを渡さない（既定名称「<元名> 直轄領」のまま）', () => {
    const h = mount({ initialParentId: asFeatureId('lone') });
    fireEvent.click(screen.getByTestId('reparent-options-confirm'));
    expect(h.onConfirm.mock.calls[0]?.[1]).toEqual({});
    h.unmount();
  });
});

describe('ReparentOptionsDialog — 予告文と洗い直し（中身 2b / V6・V7・V8）', () => {
  it('件数と行き先を言う（「3 件をまとめて『エテ連邦』の下に入れます」の形）', () => {
    mount({
      plan: {
        leafIds: [asFeatureId('a'), asFeatureId('b'), asFeatureId('lone')],
        expansions: [],
        dropped: [],
      },
      initialParentId: asFeatureId('agg'),
    });
    const preview = screen.getByTestId('reparent-preview').textContent ?? '';
    expect(preview).toContain('3 件');
    expect(preview).toContain('agg-agg');
  });

  it('どの年に記録が増えるかを言う（V6 の確認の文）', () => {
    mount({ initialParentId: asFeatureId('agg') });
    expect(screen.getByTestId('reparent-preview').textContent).toContain('1200年の記録');
    expect(screen.getByTestId('reparent-preview').textContent).toContain('Ctrl+Z');
  });

  it('まとめ役を広げたことを言う（FR-48 後半）', () => {
    mount({
      plan: {
        leafIds: [asFeatureId('a'), asFeatureId('b')],
        expansions: [{ aggregateId: asFeatureId('agg'), leafIds: [asFeatureId('a'), asFeatureId('b')] }],
        dropped: [],
      },
      initialParentId: asFeatureId('lone'),
    });
    expect(screen.getByTestId('reparent-preview').textContent).toContain('下位領域 2 件を対象にしました');
  });

  it('外した対象は件数と理由を言う（黙って落とさない）', () => {
    mount({
      plan: {
        leafIds: [asFeatureId('lone')],
        expansions: [],
        dropped: [{ featureId: asFeatureId('ghost'), reason: 'missing' }],
      },
      initialParentId: asFeatureId('agg'),
    });
    expect(screen.getByTestId('reparent-preview').textContent).toContain(
      '1 件は、いまの年に存在しないので対象から外しました',
    );
  });

  it('対象が 0 件なら確定できない', () => {
    mount({
      plan: { leafIds: [], expansions: [], dropped: [] },
      initialParentId: asFeatureId('agg'),
    });
    expect(screen.getByTestId('reparent-options-confirm')).toBeDisabled();
  });
});

describe('ReparentOptionsDialog — 進行表示と断り（中身 9 / 拒否理由）', () => {
  it('確定中は進行表示が出て、ボタンが押せない（二重に適用させない）', () => {
    mount({ initialParentId: asFeatureId('agg'), committing: true });
    expect(screen.getByTestId('reparent-commit-progress').textContent).toBe(
      REPARENT_STRINGS.committing,
    );
    expect(screen.getByTestId('reparent-options-confirm')).toBeDisabled();
  });

  it('断りの理由が板の中に出る（G-23 の出口）', () => {
    mount({ message: '循環参照になります。' });
    expect(screen.getByTestId('reparent-options-message').textContent).toBe(
      '循環参照になります。',
    );
  });
});
