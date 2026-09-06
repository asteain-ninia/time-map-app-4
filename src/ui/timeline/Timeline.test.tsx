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
import type { StatusMessageStore } from '../shell/status-message';
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
    expect(alert.textContent).toContain('時間軸の範囲');
    expect(alert.textContent).toContain('20000年');
    // **帯は伸びない**ので、断りは見える形では状態行が出す（ここは読み上げだけ）。
    expect(yearInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('紀元前側の範囲外も同じ', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('-1');
    expect(s.getState().currentTime.year).toBe(1000);
    expect(screen.getByRole('alert').textContent).toContain('時間軸の範囲');
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
    expect(messages[0]).toContain('時間軸の範囲');
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

  it('「単位: 年」は消さない（U-27）。目盛りの器の中にある', () => {
    render(<Timeline store={store()} />);
    const ticks = screen.getByTestId('timeline-ticks');
    expect(ticks.querySelector('[data-testid="timeline-ticks-unit"]')?.textContent).toContain(
      '年',
    );
  });
});
