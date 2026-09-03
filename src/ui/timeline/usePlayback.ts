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
import { toYearPoint, type TimePoint } from '../../domain/time/time-point';
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
  // 再生中だけ持つ「日の精度の現在地」(増分 2 の中身 1c)。**ストアへ書くのは年だけ**
  // に丸めた値なので、丸めた値をそのまま次の tick の入力にすると 1 年ぶん進む前に
  // 毎回 1 月 1 日へ戻され、再生が **その場で止まる**（1 倍速の 1 tick は約 36.5 日）。
  // 進行の計算は今までどおり日で行い、公開する値だけを丸める。accumulator と同じく
  // **開始・停止・端・アンマウントの全経路で捨てる** 一時状態である（教訓 5.2）。
  const preciseTimeRef = useRef<TimePoint | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The running tick reads the speed through a REF, not the closure value, so a
  // speed change WHILE playing takes effect on the very next tick — without
  // tearing down and restarting the interval (which would reset the accumulator
  // and drop the in-progress fractional day). `speed` is therefore intentionally
  // NOT a dependency of `play` (it is mirrored here on every change).
  const speedRef = useRef<PlaybackSpeed>(speed);
  useEffect(() => {
    speedRef.current = speed;
  }, [speed]);

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
    preciseTimeRef.current = null;
  }, [clearTimer]);

  const play = useCallback(() => {
    if (timerRef.current !== null) return;
    accumulatorRef.current = INITIAL_PLAYBACK_ACCUMULATOR;
    preciseTimeRef.current = null;
    setIsPlaying(true);
    timerRef.current = setInterval(() => {
      const state = store.getState();
      // 再生中に外から時刻が動いた（スライダー・錨を選ぶ・直接ジャンプ）ときは、
      // 自分の持っている日精度の現在地を捨ててストアへ従う。年が一致していれば
      // 自分の値が正しい続きなので、そのまま使って日の精度を保つ（教訓 5.5）。
      const held = preciseTimeRef.current;
      const heldIsCurrent =
        held !== null &&
        state.currentTime.granularity === 'year' &&
        state.currentTime.year === held.year;
      const current: TimePoint = heldIsCurrent && held !== null ? held : state.currentTime;
      const result = advancePlayback(
        current,
        speedRef.current,
        direction,
        state.timelineMin,
        state.timelineMax,
        accumulatorRef.current,
        calendar,
      );
      accumulatorRef.current = result.accumulator;
      preciseTimeRef.current = result.time;
      // 公開するのは年だけ（中身 1c）。再生で月日つきの現在時刻を作らない。
      state.setCurrentTime(toYearPoint(result.time), TIME_CHANGE_SOURCE.Playback);
      if (result.reachedEnd) {
        // 端で自動停止: clear the timer + flag here (教訓 5.8 必ず解除).
        clearTimer();
        setIsPlaying(false);
        accumulatorRef.current = INITIAL_PLAYBACK_ACCUMULATOR;
        preciseTimeRef.current = null;
      }
    }, PLAYBACK_TICK_MS);
  }, [store, direction, calendar, clearTimer]);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  // Clean up the timer on unmount (教訓 5.2: アンマウントで破棄).
  useEffect(() => clearTimer, [clearTimer]);

  return { isPlaying, speed, setSpeed, play, pause, toggle };
}
