// オプションバーの内容ストア（設計書 §C.4）の単体テスト。
//
// 守る性質は 3 つ。
//  1. **4 本の API が押し込んだものがそのまま読める**（道具の実装が使う契約）。
//  2. **変化しなかった呼び出しでは通知もスナップショットの差し替えもしない**。ここが崩れると
//     `useSyncExternalStore` が毎レンダー新しいスナップショットを見て無限ループになる。
//     道具は頂点を打つたびに同じ文字列を押し込むので、実際に起きる。
//  3. **設定欄の取り外しは自分が入れた登録にしか効かない**（教訓 5.2 の「一時的 UI 状態は
//     全経路で破棄する」を、破棄が行きすぎないほうから固定する）。所有権は登録ごとの印で
//     見るので、**同じ id に同じ node インスタンスを入れ直した**あとに古い後片付けが遅れて
//     走っても、生きている登録は消えない。

import { describe, expect, it, vi } from 'vitest';

import { OptionBarStore } from './option-bar';

describe('OptionBarStore — 4 本の API（設計書 §C.4）', () => {
  it('既定は「何も押し込まれていない」状態', () => {
    const store = new OptionBarStore();
    expect(store.get()).toEqual({
      toolName: null,
      target: { stage: null, name: null },
      nextStep: null,
      commit: [],
      slots: [],
    });
  });

  it('setToolName / setTarget / setNextStep / setCommit が読み戻せる', () => {
    const store = new OptionBarStore();
    const onClick = vi.fn();

    store.setToolName('▱ 面を描く');
    store.setTarget('手順 1/2', '頂点 4 個（未確定）');
    store.setNextStep('もう 1 点打つか、Enter で閉じます');
    store.setCommit([{ id: 'commit', label: '閉じて確定', onClick }]);

    const state = store.get();
    expect(state.toolName).toBe('▱ 面を描く');
    expect(state.target).toEqual({ stage: '手順 1/2', name: '頂点 4 個（未確定）' });
    expect(state.nextStep).toBe('もう 1 点打つか、Enter で閉じます');
    expect(state.commit).toHaveLength(1);
    expect(state.commit[0]?.label).toBe('閉じて確定');
  });

  it('対象を 0 件へ戻せる（枠は残るので UI 側で「（選んでいません）」になる）', () => {
    const store = new OptionBarStore();
    store.setTarget(null, 'アアウェン州');
    store.setTarget(null, null);
    expect(store.get().target).toEqual({ stage: null, name: null });
  });
});

describe('OptionBarStore — スナップショットの同一性（useSyncExternalStore の前提）', () => {
  it('同じ値を押し込み直しても通知せず、スナップショットも差し替えない', () => {
    const store = new OptionBarStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setToolName('✂ 分ける');
    expect(listener).toHaveBeenCalledTimes(1);
    const first = store.get();

    store.setToolName('✂ 分ける');
    store.setTarget(null, null);
    store.setNextStep(null);
    store.setCommit([]);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(first);
  });

  it('確定ボタンは中身で比べる（同じ配列を作り直しても通知しない）', () => {
    const store = new OptionBarStore();
    const onClick = vi.fn();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setCommit([{ id: 'a', label: '分断線を確定', onClick }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setCommit([{ id: 'a', label: '分断線を確定', onClick }]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setCommit([{ id: 'a', label: '分断線を確定', onClick, disabled: true }]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('reset は 1 度だけ通知し、すでに空なら通知しない', () => {
    const store = new OptionBarStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.reset();
    expect(listener).not.toHaveBeenCalled();

    store.setNextStep('2 点をクリックすると距離が出ます');
    store.reset();
    expect(listener).toHaveBeenCalledTimes(2);
    expect(store.get().nextStep).toBeNull();
  });

  it('購読を解除するとそれ以上通知が来ない', () => {
    const store = new OptionBarStore();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off();
    store.setToolName('📏 測る');
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('OptionBarStore — registerOptionSlot（設定欄の差し込み口）', () => {
  it('差し込んだ部品が並び、同じ id で差し替えられる', () => {
    const store = new OptionBarStore();
    store.registerOptionSlot('snap', 'snap-v1');
    store.registerOptionSlot('depth', 'depth-v1');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'depth']);

    // 増分 3 で直した: 差し替えても **並び順は最初に入れた場所のまま**（末尾へ回さない）。
    // 回すと、中身が更新されるたびに設定欄の部品が左右へ飛ぶ。
    store.registerOptionSlot('snap', 'snap-v2');
    const slots = store.get().slots;
    expect(slots.map((s) => s.id)).toEqual(['snap', 'depth']);
    expect(slots.find((s) => s.id === 'snap')?.node).toBe('snap-v2');
  });

  it('戻り値で取り外せる', () => {
    const store = new OptionBarStore();
    const off = store.registerOptionSlot('snap', 'snap-v1');
    off();
    expect(store.get().slots).toEqual([]);
  });

  it('あとから同じ id を上書きされたら、古い取り外しは何もしない', () => {
    // 道具 A が「吸着 ▾」を入れる → 道具 B に持ち替えて同じ id で入れ直す → A の後片付けが
    // 遅れて走る、という順序でも、B の部品を巻き添えで消さないこと。
    const store = new OptionBarStore();
    const offA = store.registerOptionSlot('snap', 'A');
    store.registerOptionSlot('snap', 'B');

    offA();

    expect(store.get().slots).toEqual([{ id: 'snap', node: 'B' }]);
  });

  it('同じ node インスタンスで登録し直したら、古い取り外しは新しい登録を消さない', () => {
    // React の effect は「後片付け → 再実行」の順に走るとは限らない。同じ id で
    // **同じ node インスタンス**を入れ直したあとに前の後片付けが遅れて走る、という
    // 順序が起きる。所有権を node の同一性で見ていると `mine.node === node` が成立して
    // しまい、生きている登録を巻き添えで消す（設定欄から「吸着 ▾」が黙って消える）。
    const store = new OptionBarStore();
    const node = 'snap-node'; // 2 回とも同じインスタンスを渡す
    const offFirst = store.registerOptionSlot('snap', node);
    const offSecond = store.registerOptionSlot('snap', node);

    offFirst(); // 遅れて走った古い後片付け

    expect(store.get().slots).toEqual([{ id: 'snap', node }]);

    // 新しいほうの取り外しは効く（畳み忘れにはしない＝教訓 5.2）。
    offSecond();
    expect(store.get().slots).toEqual([]);
  });

  it('同じ id・同じ node の登録し直しでは通知が飛ばず、スナップショットも据え置かれる', () => {
    // 道具が毎レンダー同じ部品を押し込んでも、購読者（OptionBar）を動かさないこと。
    // ここで通知すると `useSyncExternalStore` が再レンダーし、描画中に登録する経路では
    // 無限ループになる。
    const store = new OptionBarStore();
    const node = 'snap-node';
    const listener = vi.fn();
    store.subscribe(listener);

    store.registerOptionSlot('snap', node);
    expect(listener).toHaveBeenCalledTimes(1);
    const first = store.get();

    store.registerOptionSlot('snap', node);
    store.registerOptionSlot('snap', node);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(first);
  });

  it('取り外しを 2 回呼んでも 2 度目は何もしない（通知もしない）', () => {
    const store = new OptionBarStore();
    const listener = vi.fn();
    const off = store.registerOptionSlot('snap', 'A');
    store.subscribe(listener);

    off();
    expect(listener).toHaveBeenCalledTimes(1);
    const after = store.get();

    off();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.get()).toBe(after);
  });

  it('reset で設定欄も空になる', () => {
    const store = new OptionBarStore();
    store.registerOptionSlot('snap', 'A');
    store.reset();
    expect(store.get().slots).toEqual([]);
  });
});

// --- 帯の持ち主（増分 3。増分 1 の申し送り「reset を誰がいつ呼ぶか」への答え）------

describe('OptionBarStore.claim — 帯は 1 つの道具だけが持つ', () => {
  it('持った瞬間に中身が空へ戻る（前の道具の残りが持ち越されない）', () => {
    const store = new OptionBarStore();
    store.setToolName('▱ 面を描く');
    store.setNextStep('もう 1 点打つか、Enter で閉じて確定します');

    const owner = Symbol('別の道具');
    store.claim(owner as unknown as object);

    expect(store.get().toolName).toBeNull();
    expect(store.get().nextStep).toBeNull();
  });

  it('手放しは自分が持っているときだけ効く', () => {
    const store = new OptionBarStore();
    const first = Symbol('道具A');
    const release = store.claim(first as unknown as object);

    // 別の道具が持ってから、遅れて A の後片付けが走る。
    const second = Symbol('道具B');
    store.claim(second as unknown as object);
    store.setToolName('✂ 分ける');
    release();

    // B の中身は消えない（空振りする）。
    expect(store.get().toolName).toBe('✂ 分ける');
    expect(store.hasOwner()).toBe(true);
  });

  it('自分が持っているまま手放すと空へ戻り、持ち主も居なくなる', () => {
    const store = new OptionBarStore();
    const owner = Symbol('道具');
    const release = store.claim(owner as unknown as object);
    store.setToolName('▱ 面を描く');
    release();
    expect(store.get().toolName).toBeNull();
    expect(store.hasOwner()).toBe(false);
  });
});

describe('OptionBarStore.registerOptionSlot — 並び順（増分 3 で見つけた粗）', () => {
  it('同じ id を差し替えても、並び順は最初に入れた場所のまま', () => {
    const store = new OptionBarStore();
    store.registerOptionSlot('snap', 'A');
    store.registerOptionSlot('undo', 'B');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'undo']);

    // 「吸着 ▾」の中身が更新される（許容値を変えた等）。末尾へ回ってはいけない。
    store.registerOptionSlot('snap', 'A2');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'undo']);
    expect(store.get().slots[0]?.node).toBe('A2');
  });
});
