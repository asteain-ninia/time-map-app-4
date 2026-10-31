// U21: 時刻レール（設計書 §C.7）の組み立てを固定する。
//
// 増分 6 で帯は 4 段（読み取り／錨レーン／目盛り／操作列）になった。ここで守るのは
//   ① 年の欄が現在時刻に追従すること（他の経路で時刻が動いても置き去りにならない）
//   ② **打ちかけがあるあいだは追従しない**（中身 6。旧実装は現在時刻を `key` にして
//      入力欄を作り直していたので、打っている途中の数字が消えた）
//   ③ 範囲外の年は **丸めずに断る**（中身 7）
//   ④ 錨レーンは選択が無くても高さを保ち、淡い 1 行を出す（§B.4 / §H.4）
// の 4 つである。
//
// jsdom はレイアウトを持たないので **寸法はここで測らない**（教訓 5.49）。112px の
// 内訳は CSS の契約テスト（`shell/shell-layout.test.ts`）が、実寸は E2E が見る。

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { COMMAND_ID, CommandRegistry } from '../shell/commands';
import { moveTrailerKey, StatusMessageStore } from '../shell/status-message';
import { createSessionStore, TIME_CHANGE_SOURCE } from '../state/store';

import { Timeline } from './Timeline';
import { RAIL_STRINGS } from './rail-strings';

// **窓幅で畳む段は 1280px（既定の起動サイズ）に固定して測る**。jsdom の既定は 1024px で、
// そこでは「ステップ単位」が「≫」の中へ畳まれる（＝ `hidden` なので role では引けない）。
// 段そのものの正しさは `time/rail-fold.test.ts` が窓幅の関数として固定しているので、
// ここは「既定の窓で何が出ているか」だけを見る。
beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: 1280, configurable: true });
});

function store() {
  return createSessionStore<null>({
    initialDomain: null,
    initial: { currentTime: timePointYear(1000) },
  });
}

function yearInput(): HTMLInputElement {
  return screen.getByLabelText('直接ジャンプ 年') as HTMLInputElement;
}

function jump(year: string): void {
  fireEvent.change(yearInput(), { target: { value: year } });
  fireEvent.click(screen.getByRole('button', { name: 'ジャンプ' }));
}

describe('年の欄は現在時刻に追従する（打ちかけが無いあいだ）', () => {
  it('初期値は現在の年', () => {
    render(<Timeline store={store()} />);
    expect(yearInput().value).toBe('1000');
  });

  it('他の経路（つまみ・再生・錨の選択）で時刻が動くと追従する', () => {
    const s = store();
    render(<Timeline store={s} />);
    act(() => {
      s.getState().setCurrentTime(timePointYear(2500), TIME_CHANGE_SOURCE.Slider);
    });
    expect(yearInput().value).toBe('2500');
    act(() => {
      s.getState().setCurrentTime(timePointYear(7777), TIME_CHANGE_SOURCE.Playback);
    });
    expect(yearInput().value).toBe('7777');
  });
});

describe('中身 6 — 打ちかけの年入力が他経路の時刻変更で消えない', () => {
  // 旧実装は現在時刻を `key` にして入力欄を **作り直して**いたので、再生・つまみ・
  // 錨の選択で時刻が動くたびに打っている途中の数字が消えた。
  it('打ちかけがあるあいだは追従しない', () => {
    const s = store();
    render(<Timeline store={s} />);
    fireEvent.change(yearInput(), { target: { value: '15' } });
    act(() => {
      s.getState().setCurrentTime(timePointYear(2500), TIME_CHANGE_SOURCE.Playback);
    });
    expect(yearInput().value).toBe('15');
  });

  it('打ちかけの有無を欄が自分で名乗る（大域の打鍵の関門が読む）', () => {
    render(<Timeline store={store()} />);
    expect(yearInput().getAttribute('data-pristine')).toBe('true');
    fireEvent.change(yearInput(), { target: { value: '15' } });
    expect(yearInput().getAttribute('data-pristine')).toBe('false');
  });

  it('確定したら打ちかけは無くなり、また追従する', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('2000');
    expect(s.getState().currentTime.year).toBe(2000);
    act(() => {
      s.getState().setCurrentTime(timePointYear(3000), TIME_CHANGE_SOURCE.Playback);
    });
    expect(yearInput().value).toBe('3000');
  });

  it('Enter でも確定する（§I.2）', () => {
    const s = store();
    render(<Timeline store={s} />);
    fireEvent.change(yearInput(), { target: { value: '4321' } });
    fireEvent.keyDown(yearInput(), { key: 'Enter' });
    expect(s.getState().currentTime.year).toBe(4321);
  });
});

describe('中身 7 — 範囲外の年は丸めずに断る', () => {
  // 既定の時間軸は 0 年〜10000 年（FR-66）。
  it('範囲の中の年はそのまま飛ぶ', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('2000');
    expect(s.getState().currentTime.year).toBe(2000);
  });

  it('範囲の外の年は飛ばず、理由が読み上げに出る', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('20000');
    expect(s.getState().currentTime.year).toBe(1000);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(RAIL_STRINGS.outOfRange('20000年', '0年', '10000年'));
    expect(alert.textContent).toContain('20000年');
    // **帯は伸びない**ので、断りは見える形では状態行が出す（ここは読み上げだけ）。
    expect(yearInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('紀元前側の範囲外も同じ', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('-1');
    expect(s.getState().currentTime.year).toBe(1000);
    expect(screen.getByRole('alert').textContent).toContain(
      RAIL_STRINGS.outOfRange('紀元前1年', '0年', '10000年'),
    );
  });

  it('断りは状態行の「直前の結果」枠にも出る', () => {
    const s = store();
    const messages: string[] = [];
    const messageStore = {
      failure: (text: string) => messages.push(text),
    } as unknown as StatusMessageStore;
    render(<Timeline store={s} statusMessages={messageStore} />);
    jump('20000');
    expect(messages.length).toBe(1);
    expect(messages[0]).toBe(RAIL_STRINGS.outOfRange('20000年', '0年', '10000年'));
  });
});

describe('年の欄の断りと粒度（2026-09-07 の手直し）', () => {
  function withStatus() {
    const s = store();
    const messages: { kind: string; text: string }[] = [];
    const messageStore = {
      failure: (text: string) => messages.push({ kind: 'failure', text }),
      notice: (text: string) => messages.push({ kind: 'notice', text }),
      // 移動の知らせに続ける文（手直し 2 回目）。この検査では控えは無い。
      takeMoveTrailers: () => '',
    } as unknown as StatusMessageStore;
    render(<Timeline store={s} statusMessages={messageStore} />);
    return { s, messages };
  }

  it('空欄で確定すると、状態行に断りが出る（旧版は画面のどこにも何も起きなかった）', () => {
    const { s, messages } = withStatus();
    jump('');
    expect(s.getState().currentTime.year).toBe(1000);
    expect(messages.at(-1)?.text).toBe(RAIL_STRINGS.emptyYear);
  });

  it('数字でない文字を打って確定しても、断りが状態行に出る', () => {
    const { s, messages } = withStatus();
    jump('あああ');
    expect(s.getState().currentTime.year).toBe(1000);
    expect(messages.at(-1)?.kind).toBe('failure');
    expect(messages.at(-1)?.text.length).toBeGreaterThan(0);
  });

  it('断ったあとに移動できたら、状態行は成功の文へ置き換わる（断りが残らない）', () => {
    const { messages } = withStatus();
    jump('20000');
    expect(messages.at(-1)?.kind).toBe('failure');
    jump('2000');
    expect(messages.at(-1)?.kind).toBe('notice');
    expect(messages.at(-1)?.text).toBe(RAIL_STRINGS.movedTo('2000年'));
  });

  it('全角の数字も読む（`type=number` の欄は空になっていた）', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('１２３４');
    expect(s.getState().currentTime.year).toBe(1234);
  });

  it('IME で変換中の Enter は確定ではない（読みを打ち終える前に飛ばない）', () => {
    const s = store();
    render(<Timeline store={s} />);
    fireEvent.change(yearInput(), { target: { value: '2000' } });
    fireEvent.compositionStart(yearInput());
    fireEvent.keyDown(yearInput(), { key: 'Enter' });
    expect(s.getState().currentTime.year).toBe(1000);
    fireEvent.compositionEnd(yearInput());
    fireEvent.keyDown(yearInput(), { key: 'Enter' });
    expect(s.getState().currentTime.year).toBe(2000);
  });

  it('年だけ打ち直したら年の粒度に戻る（前の月日を引きずらない＝決定 (5)）', () => {
    const s = store();
    act(() => {
      s.getState().setCurrentTime(
        { granularity: 'yearMonthDay', year: 1500, month: 6, day: 15 },
        TIME_CHANGE_SOURCE.NumericJump,
      );
    });
    render(<Timeline store={s} />);
    jump('1600');
    expect(s.getState().currentTime).toEqual(timePointYear(1600));
  });

  it('すでに端に居るときは「移動しました」と言わない（2026-09-07 の最終手直し）', () => {
    const s = store();
    const messages: string[] = [];
    const messageStore = {
      failure: (text: string) => messages.push(text),
      notice: (text: string) => messages.push(text),
    } as unknown as StatusMessageStore;
    act(() => {
      s.getState().setCurrentTime(timePointYear(0), TIME_CHANGE_SOURCE.NumericJump);
    });
    render(<Timeline store={s} statusMessages={messageStore} />);
    const back = screen.getByRole('button', { name: '10年前へ戻る' });
    fireEvent.pointerDown(back);
    fireEvent.pointerUp(back);
    expect(s.getState().currentTime.year).toBe(0);
    // 1 年も動いていないので「移動しました」ではない。
    expect(messages.at(-1)).toBe(RAIL_STRINGS.alreadyAtEdge('0年'));
  });

  it('再生を始めた年へ Alt+← で戻れる（再生の 1 コマは積まない）', () => {
    // 旧版は「再生で動いた年は積まない」だけだったので、3000 年から再生して止めると
    // **3000 年を飛ばして**その前に居た年へ戻っていた（実測）。
    const s = store();
    // Alt+← は大域のコマンド（`time.back`）なので、登録簿を通して押す。
    const registry = new CommandRegistry();
    render(<Timeline store={s} registry={registry} />);
    act(() => {
      s.getState().setCurrentTime(timePointYear(2000), TIME_CHANGE_SOURCE.NumericJump);
    });
    act(() => {
      s.getState().setCurrentTime(timePointYear(3000), TIME_CHANGE_SOURCE.NumericJump);
    });
    // 再生を始める → 3000 年が 1 回だけ積まれる。
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '再生' }));
    });
    // 再生で年が進む（1 コマぶんを手で作る）。
    act(() => {
      s.getState().setCurrentTime(timePointYear(3015), TIME_CHANGE_SOURCE.Playback);
    });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: '一時停止' }));
    });
    act(() => {
      registry.dispatch(COMMAND_ID.TimeBack);
    });
    expect(s.getState().currentTime.year).toBe(3000);
  });

  it('送りが端を越えたら端で止まり、そう言う。同時に捨てた下書きの文も続ける（決定 (4) / 指摘 4）', () => {
    const s = store();
    const messageStore = new StatusMessageStore();
    act(() => {
      s.getState().setCurrentTime(timePointYear(9995), TIME_CHANGE_SOURCE.NumericJump);
    });
    render(<Timeline store={s} statusMessages={messageStore} />);
    // 1280px の窓では 100 年送りは「≫」の中なので、行に出ている 10 年送りで見る。
    const forward = screen.getByRole('button', { name: '10年次へ進む' });
    fireEvent.pointerDown(forward);
    fireEvent.pointerUp(forward);
    expect(s.getState().currentTime.year).toBe(10000);
    expect(messageStore.get()?.text).toBe(RAIL_STRINGS.stepClampedTo('10000年'));

    // 関門に止められた送りは、端へ動いたと言わない。
    act(() => {
      s.getState().setCurrentTime(timePointYear(9995), TIME_CHANGE_SOURCE.NumericJump);
    });
    messageStore.clear();
    const remove = s.getState().addTimeChangeGate(() => true);
    fireEvent.pointerDown(forward);
    fireEvent.pointerUp(forward);
    expect(s.getState().currentTime.year).toBe(9995);
    expect(messageStore.get()).toBeNull();
    remove();

    // 関門が通して動いたら、控えた文を同じ 1 文の後ろへ続ける。
    messageStore.stageMoveTrailer(moveTrailerKey(timePointYear(10000)), 'trailer');
    fireEvent.pointerDown(forward);
    fireEvent.pointerUp(forward);
    expect(s.getState().currentTime.year).toBe(10000);
    expect(messageStore.get()?.text).toBe(`${RAIL_STRINGS.stepClampedTo('10000年')}trailer。`);
  });
});

describe('錨レーンの空状態（§B.4 / §H.4）', () => {
  it('選んでいないときも高さを保ち、淡い 1 行を出す', () => {
    render(<Timeline store={store()} />);
    expect(screen.getByTestId('rail-lane')).toBeInTheDocument();
    expect(screen.getByTestId('anchor-lane-empty').textContent).toBe(
      RAIL_STRINGS.laneEmptyNoSelection,
    );
  });

  it('栞の 4 つの名前を使わない（撤去済みの栞の E2E が無改修で通る条件）', () => {
    const { container } = render(<Timeline store={store()} />);
    expect(screen.queryByTestId('timeline-markers')).toBeNull();
    expect(screen.queryByTestId('timeline-markers-hint')).toBeNull();
    expect(container.querySelector('.timeline-markers')).toBeNull();
    expect(screen.queryByRole('button', { name: 'この時刻をブックマーク' })).toBeNull();
  });
});

describe('U-8 / HB-13 — ±1 の送りと再生の文字と読み上げ名は据え置く', () => {
  it('可視テキスト「前へ」「次へ」「再生」と読み上げ名が残っている', () => {
    render(<Timeline store={store()} />);
    const forward = screen.getByRole('button', { name: '1年次へ進む' });
    expect(forward.textContent).toContain('次へ');
    expect(screen.getByRole('button', { name: '1年前へ戻る' }).textContent).toContain('前へ');
    expect(screen.getByRole('button', { name: '再生' }).textContent).toContain('再生');
    // 「ステップ単位」の select も残す。
    expect(screen.getByRole('combobox', { name: 'ステップ単位' })).toBeInTheDocument();
  });

  it('10・100 の送りの読み上げ名は、ステップ単位に追従する', () => {
    // 単位を「月」にしたのに読み上げ名が「10年次へ進む」のままだと、**画面が嘘をつく**。
    const s = store();
    render(<Timeline store={s} />);
    expect(screen.getByRole('button', { name: '10年次へ進む' })).toBeInTheDocument();
    fireEvent.change(screen.getByRole('combobox', { name: 'ステップ単位' }), {
      target: { value: 'month' },
    });
    expect(screen.getByRole('button', { name: '10月次へ進む' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '1月前へ戻る' })).toBeInTheDocument();
  });

  it('「単位: 年」は消さない（U-27）。目盛りの器の中にある', () => {
    render(<Timeline store={store()} />);
    const ticks = screen.getByTestId('timeline-ticks');
    expect(ticks.querySelector('[data-testid="timeline-ticks-unit"]')?.textContent).toContain(
      '年',
    );
  });
});
