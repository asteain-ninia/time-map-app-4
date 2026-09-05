// U21: Timeline composition tests (FR-64〜FR-69).
//
// Locks the bughunt3 finding: the direct-jump YearMonthDayInput MIRRORS the
// current time. After the time changes by any OTHER path (here a programmatic
// setCurrentTime, as a slider scrub / play / step / anchor jump would), the
// direct-jump field must RE-SEED to the new value (via key/remount) instead of
// showing its stale mount-time value forever.

/// <reference types="@testing-library/jest-dom" />

import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { timePointYear } from '../../domain/time/time-point';
import { createSessionStore } from '../state/store';
import { TIME_CHANGE_SOURCE } from '../state/store';

import { Timeline } from './Timeline';

function store() {
  return createSessionStore<null>({
    initialDomain: null,
    initial: { currentTime: timePointYear(1000) },
  });
}

function directJumpYearInput(): HTMLInputElement {
  return screen.getByLabelText('直接ジャンプ 年') as HTMLInputElement;
}

describe('Timeline — direct-jump field re-seeds from currentTime (bughunt3)', () => {
  it('seeds the direct-jump 年 input from the initial current time', () => {
    render(<Timeline store={store()} />);
    expect(directJumpYearInput().value).toBe('1000');
  });

  it('re-seeds the direct-jump 年 input when currentTime changes elsewhere', () => {
    const s = store();
    render(<Timeline store={s} />);
    expect(directJumpYearInput().value).toBe('1000');

    // The time changes by another path (slider/play/step/anchor-jump all funnel
    // through setCurrentTime). The direct-jump field must follow.
    act(() => {
      s.getState().setCurrentTime(timePointYear(2500), TIME_CHANGE_SOURCE.Slider);
    });

    expect(directJumpYearInput().value).toBe('2500');
  });

  it('re-seeds again on a subsequent change (not just the first)', () => {
    const s = store();
    render(<Timeline store={s} />);
    act(() => {
      s.getState().setCurrentTime(timePointYear(2500), TIME_CHANGE_SOURCE.Slider);
    });
    act(() => {
      s.getState().setCurrentTime(timePointYear(7777), TIME_CHANGE_SOURCE.Playback);
    });
    expect(directJumpYearInput().value).toBe('7777');
  });
});

describe('直接ジャンプは時間軸の範囲外を丸めずに断る（2026-09-06、2 回目の手直し）', () => {
  // 旧版は範囲外の年を打つと `jumpToTime` → `setCurrentTime` が **黙って端へ寄せて**
  // いたので、打った年と行き先が違うのに画面には何も出なかった。
  // 既定の時間軸は 0 年〜10000 年（FR-66）。
  function jump(year: string): void {
    fireEvent.change(directJumpYearInput(), { target: { value: year } });
    fireEvent.click(screen.getByRole('button', { name: 'ジャンプ' }));
  }

  it('範囲の中の年はそのまま飛ぶ', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('2000');
    expect(s.getState().currentTime.year).toBe(2000);
  });

  it('範囲の外の年は飛ばず、理由がその場に出る', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('20000');
    // 現在時刻は動かない（端へ丸めない）。
    expect(s.getState().currentTime.year).toBe(1000);
    const error = screen.getByRole('alert');
    expect(error.textContent).toContain('時間軸の範囲');
    expect(error.textContent).toContain('20000年');
  });

  it('紀元前側の範囲外も同じ', () => {
    const s = store();
    render(<Timeline store={s} />);
    jump('-1');
    expect(s.getState().currentTime.year).toBe(1000);
    expect(screen.getByRole('alert').textContent).toContain('時間軸の範囲');
  });
});
