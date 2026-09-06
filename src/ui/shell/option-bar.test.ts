// オプションバーの内容ストア（設計書 §C.4）の単体テスト。
//
// 守る性質は 4 つ。
//  1. **4 本の API が押し込んだものがそのまま読める**（道具の実装が使う契約）。
//  2. **変化しなかった呼び出しでは通知もスナップショットの差し替えもしない**。ここが崩れると
//     `useSyncExternalStore` が毎レンダー新しいスナップショットを見て無限ループになる。
//     道具は頂点を打つたびに同じ文字列を押し込むので、実際に起きる。
//  3. **設定欄の取り外しは自分が入れた登録にしか効かない**（教訓 5.2 の「一時的 UI 状態は
//     全経路で破棄する」を、破棄が行きすぎないほうから固定する）。所有権は登録ごとの印で
//     見るので、**同じ id に同じ node インスタンスを入れ直した**あとに古い後片付けが遅れて
//     走っても、生きている登録は消えない。
//  4. **設定欄の並び順は、その id を最初に入れた場所のまま**。中身が更新されるたびに部品が
//     左右へ飛ばないこと。ここを見るテストは **必ず取り外しを挟んでから登録し直す**。
//     挟まないと、並び順キーが無くても（配列の中でその場で差し替えるだけでも）緑になり、
//     実際に起きる順序（後片付け → 再実行）での不具合を見逃す。

import { describe, expect, it, vi } from 'vitest';

import { OptionBarStore } from './option-bar';

describe('OptionBarStore — 4 本の API（設計書 §C.4）', () => {
  it('既定は「何も押し込まれていない」状態', () => {
    const store = new OptionBarStore();
    expect(store.get()).toEqual({
      toolName: null,
      target: { stage: null, name: null },
      nextStep: null,
      // 増分 4 の手直し E1: 次の一手の枠に載せるボタン（既定は 0 個）。
      nextStepActions: [],
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

  // ここから下が **実際に起きる順序**。上の 2 本は「外さずに登録し直す」しか見ていないので、
  // 並び順キーが無くても（配列の中でその場で差し替えるだけでも）緑になってしまう。
  // 本物の経路では、同じ effect の依存が変わると React は「後片付け → 再実行」の順に走らせる。
  // つまり登録し直す瞬間には古い後片付けが**先に**スロットを外し終えていて、新しい登録から
  // 見ると配列にその id は載っていない。だから「その場で差し替える」分岐は一度も通らない。

  it('外してから登録し直しても、元の場所へ戻る（後片付けを挟む本物の順序）', () => {
    const store = new OptionBarStore();
    const offSnap = store.registerOptionSlot('snap', 'A');
    store.registerOptionSlot('undo', 'B');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'undo']);

    offSnap(); // 古い登録の後片付け（React はこちらを先に走らせる）
    expect(store.get().slots.map((s) => s.id)).toEqual(['undo']);

    store.registerOptionSlot('snap', 'A2'); // 新しい登録
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'undo']);
    expect(store.get().slots[0]?.node).toBe('A2');
  });

  it('中身の更新（外す→入れ直す）を繰り返しても、「吸着 ▾」は先頭のまま', () => {
    // 吸着の許容値を 1px ずつ変えるように、同じ部品が何度も入れ替わる場面。
    // 1 回でも末尾へ回ると、以後ずっと左右が入れ替わったままになる。
    const store = new OptionBarStore();
    let offSnap = store.registerOptionSlot('snap', '許容 8px');
    store.registerOptionSlot('add-undo', '1 つ戻す');

    for (const tolerance of ['許容 9px', '許容 10px', '許容 11px']) {
      offSnap();
      offSnap = store.registerOptionSlot('snap', tolerance);
      expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'add-undo']);
    }
    expect(store.get().slots[0]?.node).toBe('許容 11px');
  });

  it('あとから入った部品は、外して入れ直しても後ろのまま', () => {
    // ［1 つ戻す］は「描いている最中だけ」出るので、作図の途中で外れて戻る。
    // 戻ってきたときに「吸着 ▾」より前へ出てはいけない。
    const store = new OptionBarStore();
    store.registerOptionSlot('snap', 'A');
    const offUndo = store.registerOptionSlot('add-undo', 'B');

    offUndo();
    store.registerOptionSlot('add-undo', 'B2');

    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'add-undo']);
  });

  it('reset で並び順キーも捨てる（次の道具は、その道具が入れた順に並ぶ）', () => {
    // 道具を降りたら設定欄の顔ぶれも替わる。前の道具での順番を引きずると、次の道具が
    // 「1 つ戻す → 吸着 ▾」の順に入れたのに前の道具の並びで出てしまう。
    const store = new OptionBarStore();
    store.registerOptionSlot('snap', 'A');
    store.registerOptionSlot('add-undo', 'B');
    store.reset();

    store.registerOptionSlot('add-undo', 'B2');
    store.registerOptionSlot('snap', 'A2');
    expect(store.get().slots.map((s) => s.id)).toEqual(['add-undo', 'snap']);
  });
});

// --- 増分 4: 道具に属さない常設の部品（表示 ▾）--------------------------------
//
// 表示の設定は道具の状態ではない。読むだけのときも、道具を持っていないときも、面を
// 描いている最中も同じように使える必要がある。道具の枠（`registerOptionSlot`）へ入れると
// **道具が帯を持ち直した瞬間に落ちて画面から消える**（`claim` は持った瞬間に中身を空へ戻す）。
describe('OptionBarStore — 常設スロット（増分 4）', () => {
  it('道具が帯を持ち直しても落ちない', () => {
    const store = new OptionBarStore();
    store.registerPersistentSlot('display', 'D');
    store.registerOptionSlot('snap', 'S');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'display']);

    // 別の道具が帯を持つ → 道具の部品は落ち、常設は残る。
    store.claim({});
    expect(store.get().slots.map((s) => s.id)).toEqual(['display']);
  });

  it('道具を降りても（reset）落ちない', () => {
    const store = new OptionBarStore();
    store.registerPersistentSlot('display', 'D');
    store.registerOptionSlot('snap', 'S');
    store.reset();
    expect(store.get().slots.map((s) => s.id)).toEqual(['display']);
  });

  it('道具の部品より **うしろ** に並ぶ（道具ごとに変わるものが左）', () => {
    const store = new OptionBarStore();
    store.registerPersistentSlot('display', 'D');
    store.registerOptionSlot('snap', 'S');
    store.registerOptionSlot('add-undo', 'U');
    expect(store.get().slots.map((s) => s.id)).toEqual(['snap', 'add-undo', 'display']);
  });

  it('取り外しは自分の登録が載っているときだけ効く（遅れて走った後片付けは空振り）', () => {
    const store = new OptionBarStore();
    const off1 = store.registerPersistentSlot('display', 'D1');
    store.registerPersistentSlot('display', 'D2');
    off1();
    expect(store.get().slots.map((s) => s.id)).toEqual(['display']);
    expect(store.get().slots[0]?.node).toBe('D2');
  });

  it('同じ id に同じ node なら何もしない（描画中に呼んでも無限ループにならない）', () => {
    const store = new OptionBarStore();
    store.registerPersistentSlot('display', 'D');
    const before = store.get();
    store.registerPersistentSlot('display', 'D');
    expect(store.get()).toBe(before);
  });
});

describe('OptionBarStore.epoch — 遅れて走った後片付けが次の持ち主を踏み消さない', () => {
  // 増分 5 の手直し 2 回目。手順のある 5 道具は `activeTool` が外れたあと **effect の
  // 中で** 自分の状態を畳むので、後片付けが 1 コミット遅れて走る。そのあいだに次の
  // 持ち主が帯を持ち直して押し込みを済ませているため、遅れた後片付けが押し込みを
  // 踏み消した（実測: 5 道具 → 選ぶ／頂点／動かす／測る の 20 通り）。
  it('claim / 手放しのたびに代が進む', () => {
    const store = new OptionBarStore();
    const start = store.epoch();
    const release = store.claim({});
    expect(store.epoch()).toBeGreaterThan(start);
    const mid = store.epoch();
    release();
    expect(store.epoch()).toBeGreaterThan(mid);
  });

  it('代が変わっていなければ、押し込んだ側の後片付けはそのまま効く', () => {
    const store = new OptionBarStore();
    store.claim({});
    const epoch = store.epoch();
    store.setTarget('手順 2/4', 'アアウェン州');
    expect(store.epoch()).toBe(epoch); // 押し込みでは代は進まない
    if (store.epoch() === epoch) store.setTarget(null, null);
    expect(store.get().target).toEqual({ stage: null, name: null });
  });

  it('あいだに帯が持ち直されていたら、遅れて走った後片付けは空振りする', () => {
    const store = new OptionBarStore();
    // ① 手順のある道具が帯を持ち、対象を押し込む。
    store.claim({});
    const stale = store.epoch();
    store.setTarget('手順 2/4', 'アアウェン州');
    // ② 同じ持ち替えで次の持ち主が帯を持ち直し、自分の対象を押し込む。
    store.claim({});
    store.setTarget(null, 'ハルナ君主国（末端地物）');
    // ③ 1 コミット遅れて、前の道具の後片付けが走る。**代が違うので何もしない。**
    if (store.epoch() === stale) store.setTarget(null, null);
    expect(store.get().target.name).toBe('ハルナ君主国（末端地物）');
  });
});

describe('OptionBarStore — 書いた人の印（手直し 3 回目）', () => {
  // **代だけでは足りなかった。** 押し込む側が代の変化で押し直すようになった結果、
  // 押し直した側は新しい代を覚えるので、そのあと降りたときの後片付けが **もう古くなく**、
  // 次の持ち主が入れた中身をまた踏み消した（実測: 分ける → 選ぶ で対象欄が空になった）。
  it('対象欄: あいだに別の人が書いていたら、後片付けは空振りする', () => {
    const store = new OptionBarStore();
    const tool = {};
    store.setTarget('手順 2/4', 'アアウェン州', tool);
    // 別の人（`ToolOptionBar`）が印なしで書く。
    store.setTarget(null, 'ハルナ君主国（末端地物）');
    store.clearTargetIfMine(tool);
    expect(store.get().target.name).toBe('ハルナ君主国（末端地物）');
  });

  it('対象欄: 自分が最後に書いたままなら、後片付けは効く', () => {
    const store = new OptionBarStore();
    const tool = {};
    store.setTarget('手順 2/4', 'アアウェン州', tool);
    store.clearTargetIfMine(tool);
    expect(store.get().target).toEqual({ stage: null, name: null });
  });

  it('次の一手と確定欄も同じ印で守る', () => {
    const store = new OptionBarStore();
    const tool = {};
    store.setNextStep('分断線を引いてください', [], tool);
    store.setCommit([{ id: 'c', label: '確定', onClick: () => undefined }], tool);
    // 別の人が書いたら、前の人の後片付けは空振りする。
    store.setNextStep('地図か地物一覧から選ぶ');
    store.clearChromeIfMine(tool);
    expect(store.get().nextStep).toBe('地図か地物一覧から選ぶ');
  });

  it('reset は印も捨てる（遅れて走った後片付けが「自分のもの」と誤判定しない）', () => {
    const store = new OptionBarStore();
    const tool = {};
    store.setTarget('手順 2/4', 'アアウェン州', tool);
    store.reset();
    store.setTarget(null, '別の持ち主が入れた名前');
    store.clearTargetIfMine(tool);
    expect(store.get().target.name).toBe('別の持ち主が入れた名前');
  });
});
