// 「直前の結果」ストアの単体テスト（設計書 §H.5 / 教訓 5.12 / K-7）。
//
// いちばん大事なのは **勝手に消えないこと** である。§7.4 が禁じているのは「数秒で自動消滅
// するトースト」で、消えない状態表示は禁じていない。消える契機は 3 つだけ:
// ①次の結果で置き換わる ②利用者が明示的に閉じる ③プロジェクトを開き直す。

import { describe, expect, it, vi } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';

import { STATUS_TONE, StatusMessageStore, moveTrailerKey } from './status-message';

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

// 増分 8C の手直し（反証 #2）: 結果の文に添えるボタン（「測量の線を消しました［戻す］」）。
describe('StatusMessageStore — 結果に添えるボタン（増分 8C の手直し）', () => {
  const action = { label: '戻す', run: () => undefined };

  it('ボタンつきで出せる。同じ文・同じ色味・同じボタンなら差し替えない（同一性を保つ）', () => {
    const store = new StatusMessageStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    const first = store.get();
    expect(first?.action).toBe(action);
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    expect(store.get()).toBe(first);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('同じ文でもボタンの無い結果が来たら、ボタンの無い結果に置き換わる', () => {
    const store = new StatusMessageStore();
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    store.success('測量の線を消しました');
    expect(store.get()?.action).toBeUndefined();
  });

  it('dropAction はそのボタンを持つ結果のボタンだけを外し、文と色味は残す', () => {
    const store = new StatusMessageStore();
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    store.dropAction(action);
    expect(store.get()).toEqual({ text: '測量の線を消しました', tone: STATUS_TONE.Success });
  });

  it('dropAction は別の結果に置き換わっていれば何もしない（新しい結果を消さない）', () => {
    const store = new StatusMessageStore();
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    store.failure('保存できませんでした。');
    const current = store.get();
    store.dropAction(action);
    expect(store.get()).toBe(current);
  });
});

describe('StatusMessageStore — 止めた打鍵の理由はボタンを残す（統合 8A〜8D の継ぎ目の検証 1-1）', () => {
  const action = { label: '戻す', run: () => undefined };

  it('refusalKeepingAction は文と色味を断りに置き換え、直前の結果のボタンは残す', () => {
    const store = new StatusMessageStore();
    store.set('測量の線を消しました', STATUS_TONE.Success, action);
    store.refusalKeepingAction('「元に戻す」はいま使えません。');
    expect(store.get()).toEqual({
      text: '「元に戻す」はいま使えません。',
      tone: STATUS_TONE.Failure,
      action,
    });
    // ボタンは同じオブジェクトなので、押し込んだ側が意味を失ったときに外せる。
    store.dropAction(action);
    expect(store.get()).toEqual({ text: '「元に戻す」はいま使えません。', tone: STATUS_TONE.Failure });
  });

  it('ボタンの無い結果のあとでは、ただの断りになる', () => {
    const store = new StatusMessageStore();
    store.success('保存しました');
    store.refusalKeepingAction('「削除」はいま使えません。');
    expect(store.get()).toEqual({ text: '「削除」はいま使えません。', tone: STATUS_TONE.Failure });
  });
});

describe('時刻の移動の知らせに続ける文（増分 7 の手直し 2 回目 / 設計適合 指摘 3）', () => {
  it('その時刻への知らせのときだけ取り出せて、取り出したら残らない', () => {
    const store = new StatusMessageStore();
    store.stageMoveTrailer(moveTrailerKey(timePointYear(1500)), 'この年に居ない 3 件の印を外しました。');
    expect(store.takeMoveTrailers(moveTrailerKey(timePointYear(1600)))).toBe('');
    // 別の時刻への取り出しでも控えは捨てる（古い控えを後の移動へ持ち越さない）。
    expect(store.takeMoveTrailers(moveTrailerKey(timePointYear(1500)))).toBe('');
    store.stageMoveTrailer(moveTrailerKey(timePointYear(1500)), 'この年に居ない 3 件の印を外しました。');
    store.stageMoveTrailer(moveTrailerKey(timePointYear(1500)), '記録を作りました。');
    expect(store.takeMoveTrailers(moveTrailerKey(timePointYear(1500)))).toBe(
      'この年に居ない 3 件の印を外しました。記録を作りました。',
    );
    expect(store.takeMoveTrailers(moveTrailerKey(timePointYear(1500)))).toBe('');
  });

  it('続ける文の句点を連結の 1 か所で揃える（指摘 5）', () => {
    const store = new StatusMessageStore();
    const key = moveTrailerKey(timePointYear(1500));
    store.stageMoveTrailer(key, '記録を行いました');
    store.stageMoveTrailer(key, '頂点を捨てました。');
    expect(store.takeMoveTrailers(key)).toBe('記録を行いました。頂点を捨てました。');
  });

  it('時刻が動いたら控えを捨てられる', () => {
    const store = new StatusMessageStore();
    store.stageMoveTrailer(moveTrailerKey(timePointYear(1500)), 'x');
    store.clearMoveTrailers();
    expect(store.takeMoveTrailers(moveTrailerKey(timePointYear(1500)))).toBe('');
  });
});
