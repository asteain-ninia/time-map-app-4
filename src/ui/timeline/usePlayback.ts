// UI layer (U21 / timeline): playback timer hook.
//
// Drives 再生 with a FIXED-interval timer (PLAYBACK_TICK_MS); the speed
// multiplier is applied ONLY inside advancePlayback's day increment (教訓 5.16,
// no double scaling). On every tick the new current time is written to the
// store (single truth source) so the map (U16) follows via subscription. The
// timer and playing flag are cleared on stop, end-of-range, and unmount
// (教訓 5.2 / 5.8: 開始で立てた状態は全経路で解除).

import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import type { Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import { TIME_CHANGE_SOURCE, type SessionStore } from '../state/store';

import {
  advancePlayback,
  INITIAL_PLAYBACK_ACCUMULATOR,
  PLAYBACK_TICK_MS,
  type PlaybackAccumulator,
  type PlaybackSpeed,
} from './playback';

export interface PlaybackController {
  readonly isPlaying: boolean;
  readonly speed: PlaybackSpeed;
  readonly setSpeed: (speed: PlaybackSpeed) => void;
  readonly play: () => void;
  readonly pause: () => void;
  readonly toggle: () => void;
}

export function usePlayback<S>(
  store: StoreApi<SessionStore<S>>,
  calendar: Calendar,
  direction: 1 | -1 = 1,
): PlaybackController {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);

  const accumulatorRef = useRef<PlaybackAccumulator>(INITIAL_PLAYBACK_ACCUMULATOR);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pause = useCallback(() => {
    clearTimer();
    setIsPlaying(false);
    // Discard the transient accumulator so the next play starts clean (教訓 5.2).
    accumulatorRef.current = INITIAL_PLAYBACK_ACCUMULATOR;
  }, [clearTimer]);

  const play = useCallback(() => {
    if (timerRef.current !== null) return;
    accumulatorRef.current = INITIAL_PLAYBACK_ACCUMULATOR;
    setIsPlaying(true);
    timerRef.current = setInterval(() => {
      const state = store.getState();
      const current: TimePoint = state.currentTime;
      const result = advancePlayback(
        current,
        speed,
        direction,
        state.timelineMin,
        state.timelineMax,
        accumulatorRef.current,
        calendar,
      );
      accumulatorRef.current = result.accumulator;
      state.setCurrentTime(result.time, TIME_CHANGE_SOURCE.Playback);
      if (result.reachedEnd) {
        // 端で自動停止: clear the timer + flag here (教訓 5.8 必ず解除).
        clearTimer();
        setIsPlaying(false);
        accumulatorRef.current = INITIAL_PLAYBACK_ACCUMULATOR;
      }
    }, PLAYBACK_TICK_MS);
  }, [store, speed, direction, calendar, clearTimer]);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  // Clean up the timer on unmount (教訓 5.2: アンマウントで破棄).
  useEffect(() => clearTimer, [clearTimer]);

  return { isPlaying, speed, setSpeed, play, pause, toggle };
}
