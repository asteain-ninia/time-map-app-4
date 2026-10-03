// 増分 8A — 頂点の候補一覧（設計書 §B.5 の台帳 #12）の閉じ方と、鍵盤の持ち主への名乗り。
//
// 固定すること: 出たら `onOpenChange(true)`、閉じたら・部品ごと外れたら `false`
// （名乗りっぱなしで鍵盤が戻らない、を作らない）／Escape と一覧の外の押下で必ず消える／
// 一覧の中の押下では消えない／行を押すと選んで閉じる／行の本文は中身の書式どおり。
// 増分 8A の手直し: 21 件目より先は「もっと見る」で出せる（GPT #1）／行に乗っている間、
// その頂点の座標が置き場の「乗っている頂点」に入る（地図の輪。設計適合 2-3）。

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { createCoordinate } from '../../domain/coordinate';
import { asFeatureId, asVertexId } from '../../domain/ids';

import { VertexCandidateList } from './VertexCandidateList';
import {
  VERTEX_CANDIDATE_MAX_ROWS,
  VertexCandidateStore,
  createVertexCandidateGesture,
  type DescribedVertexCandidate,
  type VertexCandidateRow,
  type VertexCandidateState,
} from './vertex-candidates';

const STATE: VertexCandidateState = {
  x: 10,
  y: 20,
  rows: [
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v412'),
      featureName: 'A国',
      label: '頂点 #412（34.10°N 12.51°E・B国と共有）',
      distancePx: 0.4,
      coordinate: createCoordinate(12.51, 34.1),
    },
    {
      featureId: asFeatureId('A'),
      vertexId: asVertexId('v413'),
      featureName: 'A国',
      label: '頂点 #413（34.11°N 12.52°E）',
      distancePx: 1.2,
      coordinate: createCoordinate(12.52, 34.11),
    },
  ],
};

/** 同じ座標に `n` 個並んだ候補（拡大しても絞れない形）。 */
function coincident(n: number): VertexCandidateState {
  const rows: VertexCandidateRow[] = Array.from({ length: n }, (_, i) => ({
    featureId: asFeatureId('A'),
    vertexId: asVertexId(`c${String(i)}`),
    featureName: 'A国',
    label: `頂点 #c${String(i)}（0.00°N 0.00°E）`,
    distancePx: 0,
    coordinate: createCoordinate(0, 0),
  }));
  return { x: 0, y: 0, rows };
}

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

  it('行は中身の書式で出て、押すと選んで閉じる', () => {
    const { store, onPick } = setup();
    act(() => store.set(STATE));
    const row = screen.getByTestId('vertex-candidate-v412');
    expect(row.textContent).toContain('頂点 #412（34.10°N 12.51°E・B国と共有）');
    // 全部出ているときは「ほか N 件」も「もっと見る」も出さない。
    expect(screen.queryByTestId('vertex-candidates-more')).toBeNull();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledWith('A', 'v412');
    expect(store.get()).toBeNull();
  });

  it('21 件以上なら最初は 20 行と残りの件数。「もっと見る」で残りが出て、最後の 1 つも選べる', () => {
    const { store, onPick } = setup();
    const n = VERTEX_CANDIDATE_MAX_ROWS * 2 + 3; // 43 個が同じ座標に重なっている
    act(() => store.set(coincident(n)));
    expect(screen.getAllByTestId(/^vertex-candidate-c\d+$/)).toHaveLength(VERTEX_CANDIDATE_MAX_ROWS);
    expect(screen.getByTestId('vertex-candidates-more').textContent).toContain(
      `ほか ${String(n - VERTEX_CANDIDATE_MAX_ROWS)} 件`,
    );
    fireEvent.click(screen.getByTestId('vertex-candidates-show-more'));
    expect(screen.getAllByTestId(/^vertex-candidate-c\d+$/)).toHaveLength(VERTEX_CANDIDATE_MAX_ROWS * 2);
    fireEvent.click(screen.getByTestId('vertex-candidates-show-more'));
    expect(screen.getAllByTestId(/^vertex-candidate-c\d+$/)).toHaveLength(n);
    expect(screen.queryByTestId('vertex-candidates-more')).toBeNull();
    fireEvent.click(screen.getByTestId(`vertex-candidate-c${String(n - 1)}`));
    expect(onPick).toHaveBeenCalledWith('A', `c${String(n - 1)}`);
  });

  it('出し直した一覧は最初の 20 行に戻る', () => {
    const { store } = setup();
    act(() => store.set(coincident(30)));
    fireEvent.click(screen.getByTestId('vertex-candidates-show-more'));
    expect(screen.getAllByTestId(/^vertex-candidate-c\d+$/)).toHaveLength(30);
    act(() => store.set(coincident(30)));
    expect(screen.getAllByTestId(/^vertex-candidate-c\d+$/)).toHaveLength(VERTEX_CANDIDATE_MAX_ROWS);
  });

  it('行に乗っている・焦点がある間だけ、その頂点の座標が「乗っている頂点」に入り、畳むと消える', () => {
    const { store } = setup();
    act(() => store.set(STATE));
    const row = screen.getByTestId('vertex-candidate-v413');
    fireEvent.pointerEnter(row);
    expect(store.getHover()).toEqual(createCoordinate(12.52, 34.11));
    fireEvent.pointerLeave(row);
    expect(store.getHover()).toBeNull();
    fireEvent.focus(row);
    expect(store.getHover()).toEqual(createCoordinate(12.52, 34.11));
    act(() => store.clear());
    expect(store.getHover()).toBeNull();
  });
});

// B86（2026-10-03 の観察）の確かめ: 一覧が出たまま地図の別の点 B を押すと、一覧を畳む押下は
// そのまま地図の押下として届き、B の候補で一覧が出直す ―― **素の状態から B を押したのと同じ**。
// 観察された「前の一覧の持ち主が選ばれる」は、B が一覧の矩形の上にあって行を押していた
// （正しい動き: 行を押せばその頂点を選ぶ）。ここでは「一覧の外の押下」の順序を、文書の捕捉段で
// 畳む（`use-dismissable`）→ 地図の押下 → 解放、の実物と同じ並びで固定する。
describe('B86: 一覧が出たまま別の点を押すと、素の状態から押したのと同じ結果になる', () => {
  const at = (owner: string, id: string, lon: number): DescribedVertexCandidate => ({
    featureId: asFeatureId(owner),
    vertexId: asVertexId(id),
    distancePx: 1,
    coordinate: createCoordinate(lon, 0),
    citers: [asFeatureId(owner)],
  });
  // 点 A の近くには A国の頂点が 2 つ、点 B の近くには B国の頂点が 2 つ。
  const near = (x: number): readonly DescribedVertexCandidate[] =>
    x < 100 ? [at('A', 'a1', 1), at('A', 'a2', 1.01)] : [at('B', 'b1', 50), at('B', 'b2', 50.01)];

  function mount() {
    const store = new VertexCandidateStore();
    const gesture = createVertexCandidateGesture({
      store,
      probe: (p) => near(p.x),
      activeFeature: () => null,
      nameOf: (id) => `${String(id)}国`,
    });
    render(
      <div>
        <div data-testid="map">地図</div>
        <VertexCandidateList store={store} onPick={vi.fn()} />
      </div>,
    );
    // 地図の入力層（`mount/input.ts`）と同じく、押下と解放を地図の要素の上で受ける。
    const map = screen.getByTestId('map');
    let point = { x: 0, y: 0 };
    map.addEventListener('pointerdown', () => gesture.press(point, true, 1));
    map.addEventListener('pointerup', () => gesture.release(point, 1));
    const click = (x: number): void => {
      point = { x, y: 10 };
      act(() => {
        fireEvent.pointerDown(map);
        fireEvent.pointerUp(map);
      });
    };
    return { store, click };
  }

  it('素の状態から B を押すと B の一覧が出る', () => {
    const { store, click } = mount();
    click(200);
    expect(store.get()?.rows.map((r) => r.vertexId)).toEqual(['b1', 'b2']);
  });

  it('A の一覧が出たまま B を押しても、B の一覧が出る（A の持ち主に寄らない）', () => {
    const { store, click } = mount();
    click(10);
    expect(store.get()?.rows.map((r) => r.vertexId)).toEqual(['a1', 'a2']);
    expect(screen.getByTestId('vertex-candidates')).toBeTruthy();
    click(200);
    expect(store.get()?.rows.map((r) => r.vertexId)).toEqual(['b1', 'b2']);
    expect(store.get()?.rows.every((r) => r.featureId === asFeatureId('B'))).toBe(true);
  });
});

