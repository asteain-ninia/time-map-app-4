// U21: Timeline composition tests (FR-64〜FR-69).
//
// Locks the bughunt3 finding: the direct-jump YearMonthDayInput MIRRORS the
// current time. After the time changes by any OTHER path (here a programmatic
// setCurrentTime, as a slider scrub / play / step / anchor jump would), the
// direct-jump field must RE-SEED to the new value (via key/remount) instead of
// showing its stale mount-time value forever.

/// <reference types="@testing-library/jest-dom" />

import { act, render, screen } from '@testing-library/react';
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
