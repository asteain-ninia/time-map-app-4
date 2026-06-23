// U21: playback hook tests (FR-69).
//
// Locks the bughunt3 finding: changing the playback speed WHILE playing takes
// effect on the next tick WITHOUT a pause/play cycle (the running tick must read
// the live speed through a ref, not a stale closure value).

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getCalendar } from '../../domain/time/calendar';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import { createSessionStore } from '../state/store';

import { PLAYBACK_TICK_MS } from './playback';
import { usePlayback } from './usePlayback';

const cal = getCalendar('gregorian');

function store() {
  // A wide range so playback never auto-stops at a bound during the test window.
  return createSessionStore<null>({
    initialDomain: null,
    initial: {
      currentTime: timePointYear(0),
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Advance N playback ticks under fake timers. */
function tick(n: number): void {
  act(() => {
    vi.advanceTimersByTime(PLAYBACK_TICK_MS * n);
  });
}

describe('usePlayback — mid-play speed change (bughunt3)', () => {
  it('changing speed WHILE playing changes the advance rate without pause/play', () => {
    const s = store();
    const { result } = renderHook(() => usePlayback(s, cal));

    act(() => {
      result.current.play();
    });

    // Advance one whole second at 1倍 (= 1 年/秒). The current time should move
    // forward by ~1 year from year 0.
    tick(Math.round(1000 / PLAYBACK_TICK_MS));
    const afterOneSecAt1x = s.getState().currentTime;
    expect(afterOneSecAt1x.year).toBeGreaterThanOrEqual(1);

    // Now change the speed mid-play to 10倍 — WITHOUT pausing. The very next
    // second of ticks must advance ~10 years (the new rate), proving the running
    // tick picked up the new speed.
    const baseYear = s.getState().currentTime.year;
    act(() => {
      result.current.setSpeed(10);
    });
    tick(Math.round(1000 / PLAYBACK_TICK_MS));
    const afterOneSecAt10x = s.getState().currentTime;
    const advanced = afterOneSecAt10x.year - baseYear;

    // ~10 years advanced (allow a small leap/rounding margin), and crucially it is
    // much larger than the ~1-year/sec the stale 1倍 closure would have produced.
    expect(advanced).toBeGreaterThanOrEqual(8);
    expect(advanced).toBeGreaterThan(3);

    // The hook never paused: still playing.
    expect(result.current.isPlaying).toBe(true);

    act(() => {
      result.current.pause();
    });
  });

  it('the interval is NOT torn down on a speed change (still playing, no reset)', () => {
    const s = store();
    const { result } = renderHook(() => usePlayback(s, cal));
    act(() => {
      result.current.play();
    });
    tick(3);
    const before: TimePoint = s.getState().currentTime;
    act(() => {
      result.current.setSpeed(2);
    });
    // Still playing immediately after a speed change (no pause/play needed).
    expect(result.current.isPlaying).toBe(true);
    tick(5);
    // Time kept advancing across the speed change.
    expect(s.getState().currentTime.year).toBeGreaterThanOrEqual(before.year);
    act(() => {
      result.current.pause();
    });
  });
});
