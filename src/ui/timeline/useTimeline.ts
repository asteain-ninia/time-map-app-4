// UI layer (U21 / timeline): the store-binding hook.
//
// Binds the timeline React components to the single-truth-source session store
// (技術方針 2.5). EVERY time-change path (slider / numeric jump / step /
// playback / event marker) funnels through `store.setCurrentTime`, which
// re-validates time-dependent selection and notifies subscribers — the map
// (U16) tracks the new current time via subscription, NOT via this hook
// (spec: 本ユニットは現在時刻を更新し通知するのみ). This hook never reaches into
// render/Canvas.

import { useCallback, useMemo } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import { getCalendar, type Calendar } from '../../domain/time/calendar';
import type { TimePoint } from '../../domain/time/time-point';
import {
  TIME_CHANGE_SOURCE,
  type SessionStore,
  type TimeChangeSource,
} from '../state/store';

import { RAIL_STRINGS } from './rail-strings';
import {
  clampToRange,
  formatYear,
  fractionToTime,
  isWithinRange,
  timeToFraction,
  toNormalizedRange,
} from './time-display';
import { stepTimePoint, type StepDirection, type StepUnit } from './step';

/** The slice of timeline state + actions the components consume. */
export interface TimelineBinding {
  readonly currentTime: TimePoint;
  readonly timelineMin: TimePoint;
  readonly timelineMax: TimePoint;
  readonly calendar: Calendar;
  /** Current time as a slider fraction in [0, 1] (双方向同期). */
  readonly fraction: number;
  /** Commit a slider fraction: converts to a complete value via U02. */
  readonly jumpToFraction: (fraction: number) => void;
  /** Commit a complete TimePoint from the direct-jump field. */
  readonly jumpToTime: (point: TimePoint, source?: TimeChangeSource) => void;
  /** Advance by one step unit in a direction, clamped to the range. */
  readonly step: (unit: StepUnit, direction: StepDirection) => void;
  /**
   * 時間軸の範囲の外なら断りの文、内なら null（2026-09-06、2 回目の手直し）。
   *
   * 直接ジャンプ欄は範囲外の年を受け取ると **黙って端へ丸めて**いた ―― 打った年と
   * 行き先が違うのに、画面には何も出ない（`setCurrentTime` も `jumpToTime` も端へ
   * 寄せる）。押す前に断る道を作るために、欄がこの述語を通す。
   */
  readonly outOfRangeMessage: (point: TimePoint) => string | null;
}

/**
 * Binds to the session store. The calendar id is read from project settings is
 * out of scope here; the timeline uses the gregorian calendar (initial 暦設定,
 * FR-67) via U02's factory — never hardcoding calendar constants.
 */
export function useTimeline<S>(store: StoreApi<SessionStore<S>>): TimelineBinding {
  const currentTime = useStore(store, (s) => s.currentTime);
  const timelineMin = useStore(store, (s) => s.timelineMin);
  const timelineMax = useStore(store, (s) => s.timelineMax);

  const calendar = useMemo(() => getCalendar('gregorian'), []);

  const range = useMemo(
    () => toNormalizedRange(timelineMin, timelineMax, calendar),
    [timelineMin, timelineMax, calendar],
  );

  const fraction = useMemo(
    () => timeToFraction(currentTime, range, calendar),
    [currentTime, range, calendar],
  );

  const jumpToTime = useCallback(
    (point: TimePoint, source: TimeChangeSource = TIME_CHANGE_SOURCE.NumericJump) => {
      const clamped = clampToRange(point, timelineMin, timelineMax, calendar);
      store.getState().setCurrentTime(clamped, source);
    },
    [store, timelineMin, timelineMax, calendar],
  );

  const jumpToFraction = useCallback(
    (f: number) => {
      const point = fractionToTime(f, range, calendar);
      store.getState().setCurrentTime(point, TIME_CHANGE_SOURCE.Slider);
    },
    [store, range, calendar],
  );

  const step = useCallback(
    (unit: StepUnit, direction: StepDirection) => {
      const next = stepTimePoint(currentTime, unit, direction, calendar);
      const clamped = clampToRange(next, timelineMin, timelineMax, calendar);
      store.getState().setCurrentTime(clamped, TIME_CHANGE_SOURCE.NumericJump);
    },
    [store, currentTime, timelineMin, timelineMax, calendar],
  );

  /**
   * 範囲外の断り。**文言は `rail-strings.ts` の 1 か所から引く**（2026-09-07 の最終
   * 手直し）―― 旧版はここが「◯年は時間軸の範囲（…）の外です」という **もう 1 系統の
   * 文**を持っていて、年入力（`RAIL_STRINGS.outOfRange`）とスライダー・錨ジャンプで
   * 断りの語が違っていた（用語集の第一表記は「時刻レール」）。
   */
  const outOfRangeMessage = useCallback(
    (point: TimePoint): string | null =>
      isWithinRange(point, timelineMin, timelineMax, calendar)
        ? null
        : RAIL_STRINGS.outOfRange(
            formatYear(point.year),
            formatYear(timelineMin.year),
            formatYear(timelineMax.year),
          ),
    [timelineMin, timelineMax, calendar],
  );

  return {
    currentTime,
    timelineMin,
    timelineMax,
    calendar,
    fraction,
    outOfRangeMessage,
    jumpToFraction,
    jumpToTime,
    step,
  };
}
