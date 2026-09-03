// 「直前の結果」ストアの単体テスト（設計書 §H.5 / 教訓 5.12 / K-7）。
//
// いちばん大事なのは **勝手に消えないこと** である。§7.4 が禁じているのは「数秒で自動消滅
// するトースト」で、消えない状態表示は禁じていない。消える契機は 3 つだけ:
// ①次の結果で置き換わる ②利用者が明示的に閉じる ③プロジェクトを開き直す。

import { describe, expect, it, vi } from 'vitest';

import { STATUS_TONE, StatusMessageStore } from './status-message';

describe('StatusMessageStore（設計書 §H.5）', () => {
  it('最初は何も無い', () => {
    expect(new StatusMessageStore().get()).toBeNull();
  });

  it('成功・失敗・進行中をそれぞれの色味で持つ', () => {
    const store = new StatusMessageStore();
    store.success('保存しました（a.gimoza）');
    expect(store.get()).toEqual({ text: '保存しました（a.gimoza）', tone: STATUS_TONE.Success });

    store.failure('保存できませんでした。');
    expect(store.get()?.tone).toBe(STATUS_TONE.Failure);

    store.progress('処理しています…');
    expect(store.get()?.tone).toBe(STATUS_TONE.Progress);
  });

  it('次の結果で置き換わる（消える契機①）', () => {
    const store = new StatusMessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.success('1 件目');
    store.success('2 件目');
    expect(store.get()?.text).toBe('2 件目');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('明示的に閉じると消える（消える契機②③）', () => {
    const store = new StatusMessageStore();
    store.failure('この州は深さ 1 にあります。');
    store.clear();
    expect(store.get()).toBeNull();
  });

  it('同じ文言・同じ色味を押し込み直しても通知せず、スナップショットも差し替えない', () => {
    // useSyncExternalStore は同一性で再レンダーを決めるので、ここが崩れると無限ループになる。
    const store = new StatusMessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.success('保存しました（a.gimoza）');
    const first = store.get();
    store.success('保存しました（a.gimoza）');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(first);
  });

  it('すでに空なら clear は通知しない', () => {
    const store = new StatusMessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.clear();
    expect(listener).not.toHaveBeenCalled();
  });

  it('購読を解除するとそれ以上通知が来ない', () => {
    const store = new StatusMessageStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.success('あとから来た結果');
    expect(listener).not.toHaveBeenCalled();
  });
});
