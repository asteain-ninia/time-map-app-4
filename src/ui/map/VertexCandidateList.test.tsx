// 増分 8A — 頂点の候補一覧（設計書 §B.5 の台帳 #12）の閉じ方と、鍵盤の持ち主への名乗り。
//
// 固定すること: 出たら `onOpenChange(true)`、閉じたら・部品ごと外れたら `false`
// （名乗りっぱなしで鍵盤が戻らない、を作らない）／Escape と一覧の外の押下で必ず消える／
// 一覧の中の押下では消えない／行を押すと選んで閉じる／行の本文は中身の書式どおり。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { asFeatureId, asVertexId } from '../../domain/ids';

import { VertexCandidateList } from './VertexCandidateList';
import { VertexCandidateStore, type VertexCandidateState } from './vertex-candidates';

const STATE: VertexCandidateState = {
  x: 10,
  y: 20,
  more: 3,
  rows: [
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v412'),
      featureName: 'A国',
      label: '頂点 #412（34.10°N 12.51°E・B国と共有）',
      distancePx: 0.4,
    },
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v413'),
      featureName: 'A国',
      label: '頂点 #413（34.11°N 12.52°E）',
      distancePx: 1.2,
    },
  ],
};

function setup() {
  const store = new VertexCandidateStore();
  const onPick = vi.fn();
  const onOpenChange = vi.fn();
  const view = render(
    <div>
      <button type="button" data-testid="outside">外</button>
      <VertexCandidateList store={store} onPick={onPick} onOpenChange={onOpenChange} />
    </div>,
  );
  return { store, onPick, onOpenChange, view };
}

describe('頂点の候補一覧', () => {
  it('出たら名乗り、閉じたら取り消す（鍵盤の持ち主は popover）', () => {
    const { store, onOpenChange } = setup();
    act(() => store.set(STATE));
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    // K-2 の走査が 1 枚として数えられるよう、非モーダルの dialog として出る。
    const box = screen.getByTestId('vertex-candidates');
    expect(box.getAttribute('role')).toBe('dialog');
    expect(box.getAttribute('aria-modal')).toBe('false');
    act(() => store.clear());
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('部品ごと外れたときも取り消す', () => {
    const { store, onOpenChange, view } = setup();
    act(() => store.set(STATE));
    view.unmount();
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('Escape で消え、Escape は下へ渡さない', () => {
    const { store } = setup();
    act(() => store.set(STATE));
    const below = vi.fn();
    document.addEventListener('keydown', below);
    fireEvent.keyDown(document, { key: 'Escape' });
    document.removeEventListener('keydown', below);
    expect(store.get()).toBeNull();
    expect(below).not.toHaveBeenCalled();
  });

  it('一覧の外の押下で消え、中の押下では消えない', () => {
    const { store } = setup();
    act(() => store.set(STATE));
    fireEvent.pointerDown(screen.getByTestId('vertex-candidates'));
    expect(store.get()).not.toBeNull();
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(store.get()).toBeNull();
  });

  it('行は中身の書式で出て、押すと選んで閉じる。畳んだ残りの件数も出る', () => {
    const { store, onPick } = setup();
    act(() => store.set(STATE));
    const row = screen.getByTestId('vertex-candidate-v412');
    expect(row.textContent).toContain('頂点 #412（34.10°N 12.51°E・B国と共有）');
    expect(screen.getByTestId('vertex-candidates-more').textContent).toContain('ほか 3 件');
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith('A', 'v412');
    expect(store.get()).toBeNull();
  });
});
