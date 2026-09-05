// U16 — 地物一覧（台帳）のセッション状態のスライス（増分 4 / 設計書 §C.5）。
//
// ここで固定するのは 4 つ:
//   1. **`ledger` だけを書く**（ドメイン・選択・projectDirty には触れない＝表示状態の軸）
//   2. **変化が無ければ参照を保つ**（一覧の memo と再描画の購読が同一性で判定するため）
//   3. **読み込み・新規で丸ごと捨てる**（古いプロジェクトのものだから＝教訓 5.2）
//   4. **展開集合は生きている地物だけに掃除する**（教訓 5.5 / 5.11。id で鍵を持つため）

import { describe, expect, it } from 'vitest';

import { createCommandResult } from '../../domain/command/result';
import { asFeatureId, type FeatureId } from '../../domain/ids';
import { BUNDLE_KIND, DEFAULT_LEDGER_STATE, LEDGER_MODE } from '../discovery/index';

import { createSessionStore } from './store';

interface TestDomain {
  readonly tag: string;
}
const f = (s: string): FeatureId => asFeatureId(s);

function bundleOf(ids: readonly string[]) {
  return {
    presetId: 'kana-area',
    label: '仮名',
    kind: BUNDLE_KIND.Expression,
    expression: '付近の領域[0-9]+$',
    members: ids.map((s) => ({
      featureId: f(s),
      baselineName: s,
      baselineKindLabel: '',
    })),
    cursor: 0,
  };
}

describe('store.ledger — 一覧のセッション状態', () => {
  it('既定は「現在時刻・木・絞り込みなし・まとまりなし」', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    expect(store.getState().ledger).toBe(DEFAULT_LEDGER_STATE);
    expect(store.getState().ledger.mode).toBe(LEDGER_MODE.Current);
    expect(store.getState().ledger.tree).toBe(true);
  });

  it('母集団・並べ方・絞り込みを書き換えても、プロジェクトは汚れない（表示状態の軸）', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setLedgerMode(LEDGER_MODE.History);
    store.getState().setLedgerTree(false);
    store.getState().setLedgerQuery('アアウェン');
    expect(store.getState().ledger.mode).toBe(LEDGER_MODE.History);
    expect(store.getState().ledger.tree).toBe(false);
    expect(store.getState().ledger.query).toBe('アアウェン');
    expect(store.getState().projectDirty).toBe(false);
  });

  it('変化が無い書き込みは参照を保つ（描画の世代を無駄に進めない）', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    const before = store.getState().ledger;
    store.getState().setLedgerMode(LEDGER_MODE.Current);
    store.getState().setLedgerTree(true);
    store.getState().setLedgerQuery('');
    store.getState().setBundle(null);
    store.getState().setBundleOnlyUnfinished(false);
    expect(store.getState().ledger).toBe(before);
  });

  it('展開はトグルできる', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().toggleLedgerExpanded(f('a'));
    expect(store.getState().ledger.expanded.has(f('a'))).toBe(true);
    store.getState().toggleLedgerExpanded(f('a'));
    expect(store.getState().ledger.expanded.has(f('a'))).toBe(false);
  });

  it('カーソルは束が無ければ動かず、あれば端で止まる', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setBundleCursor(3);
    expect(store.getState().ledger.bundle).toBeNull();

    store.getState().setBundle(bundleOf(['a', 'b', 'c']));
    store.getState().setBundleCursor(99);
    expect(store.getState().ledger.bundle?.cursor).toBe(2);
    store.getState().setBundleCursor(-1);
    expect(store.getState().ledger.bundle?.cursor).toBe(0);
  });

  it('読み込み・新規で一覧のセッション状態を丸ごと捨てる（教訓 5.2）', () => {
    const store = createSessionStore<TestDomain>({ initialDomain: { tag: 'd0' } });
    store.getState().setLedgerQuery('アアウェン');
    store.getState().setBundle(bundleOf(['a']));
    store.getState().resetToDomain({ tag: 'd1' });
    expect(store.getState().ledger).toBe(DEFAULT_LEDGER_STATE);
  });

  it('構造が変わったら、展開集合を生きている地物だけに掃除する（教訓 5.5 / 5.11）', () => {
    // id で鍵を持つ集合なので、消えた id を残すと、取り消しで同じ id が戻ったときに
    // 古い展開状態が **別の地物へ** 付く（filter の強調 id とまったく同じ罠）。
    let live = new Set<FeatureId>([f('a'), f('b')]);
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      liveFeatureIds: () => live,
    });
    store.getState().toggleLedgerExpanded(f('a'));
    store.getState().toggleLedgerExpanded(f('b'));
    live = new Set<FeatureId>([f('b')]);
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ deleted: [f('a')] }));
    expect(store.getState().ledger.expanded.has(f('a'))).toBe(false);
    expect(store.getState().ledger.expanded.has(f('b'))).toBe(true);
  });

  it('**束のメンバーは掃除しない**（並びと通し番号を固定する器だから）', () => {
    let live = new Set<FeatureId>([f('a'), f('b')]);
    const store = createSessionStore<TestDomain>({
      initialDomain: { tag: 'd0' },
      liveFeatureIds: () => live,
    });
    store.getState().setBundle(bundleOf(['a', 'b']));
    live = new Set<FeatureId>([f('b')]);
    store.getState().applyCommandResult({ tag: 'd1' }, createCommandResult({ deleted: [f('a')] }));
    // 消えた地物が抜けると通し番号が動き、重複名の 3 段目（#3 ／ 座標）が意味を失う。
    // 消えた地物の行は組み立ての時点で母集団に居ないので、一覧には出ない。
    expect(store.getState().ledger.bundle?.members).toHaveLength(2);
  });
});
