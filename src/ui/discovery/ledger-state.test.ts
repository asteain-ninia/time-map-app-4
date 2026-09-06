// 一覧のセッション状態のうち、**対象の印**（`markedFeatures`。増分 7 / 設計書 §D.5）の
// 遷移を固定する。
//
// 印は **選択（0 か 1 件）とは別概念**で、2 件以上になりうる集合である。ここで守りたいのは
// 3 つ ―― ①つけ外しが 1 件ずつ効く ②生きていない地物は掃除される（取り消しで同じ id が
// 戻ったときに古い印が別の地物へ付かない）③変化が無ければ同じ参照を返す（描画の世代を
// 無駄に進めない）。

import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../../domain/ids';

import {
  DEFAULT_LEDGER_STATE,
  clearMarked,
  reconcileLedgerToLive,
  toggleMarked,
  withMarked,
} from './ledger-state';

const A = asFeatureId('f-a');
const B = asFeatureId('f-b');
const C = asFeatureId('f-c');

describe('対象の印（`markedFeatures`。増分 7 / 設計書 §D.5）', () => {
  it('既定は空（何も相手にしていない）', () => {
    expect(DEFAULT_LEDGER_STATE.marked.size).toBe(0);
  });

  it('toggleMarked は 1 件ずつ付け外しする', () => {
    const one = toggleMarked(DEFAULT_LEDGER_STATE, A);
    expect([...one.marked]).toEqual([A]);
    const two = toggleMarked(one, B);
    expect([...two.marked].sort()).toEqual([A, B].sort());
    const back = toggleMarked(two, A);
    expect([...back.marked]).toEqual([B]);
  });

  it('印は選択・展開・束に触らない（別概念であることを型でなく振る舞いで固定する）', () => {
    const next = toggleMarked(DEFAULT_LEDGER_STATE, A);
    expect(next.expanded).toBe(DEFAULT_LEDGER_STATE.expanded);
    expect(next.collapsed).toBe(DEFAULT_LEDGER_STATE.collapsed);
    expect(next.bundle).toBe(DEFAULT_LEDGER_STATE.bundle);
    expect(next.query).toBe(DEFAULT_LEDGER_STATE.query);
  });

  it('withMarked はまとめて置き換える（「その全下位領域を対象にする」の入口）', () => {
    const next = withMarked(DEFAULT_LEDGER_STATE, [A, B, C]);
    expect(next.marked.size).toBe(3);
  });

  it('withMarked は中身が同じなら同じ参照を返す（描画の世代を進めない）', () => {
    const first = withMarked(DEFAULT_LEDGER_STATE, [A, B]);
    expect(withMarked(first, [B, A])).toBe(first);
  });

  it('clearMarked は全部外す。既に空なら同じ参照を返す', () => {
    const marked = withMarked(DEFAULT_LEDGER_STATE, [A, B]);
    expect(clearMarked(marked).marked.size).toBe(0);
    expect(clearMarked(DEFAULT_LEDGER_STATE)).toBe(DEFAULT_LEDGER_STATE);
  });

  it('生きていない地物の印は掃除される（教訓 5.5 / 5.11）', () => {
    const marked = withMarked(DEFAULT_LEDGER_STATE, [A, B]);
    const live = new Set([A]);
    const next = reconcileLedgerToLive(marked, live);
    expect([...next.marked]).toEqual([A]);
  });

  it('全部生きていれば同じ参照を返す（掃除が世代を進めない）', () => {
    const marked = withMarked(DEFAULT_LEDGER_STATE, [A, B]);
    expect(reconcileLedgerToLive(marked, new Set([A, B]))).toBe(marked);
  });
});
