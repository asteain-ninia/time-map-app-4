// UI layer (U21 / 時刻レール): レールの表示範囲（ズーム・横スクロール）を持つ hook。
//
// **表示範囲はプロジェクトのデータではないが、利用者の作業文脈である**（設計書 §D.7 の
// 「捨てない」側にレールの表示範囲が明記されている）。道具を持ち替えても・時刻を動かしても
// 捨てない。捨てるのは **プロジェクトの時間軸そのものが変わったとき**（新規・読み込み・
// 設定変更）だけで、そのときは全体表示へ戻す。
//
// **現在時刻を追いかけない**（設計書 §F.2 の規則 4）。表示範囲が変わると錨レーンは
// 再集計するので、再生のたびに範囲を寄せると「再生中に 5 万錨を数え直す」ことになる。
// 既定の表示範囲は時間軸の全体なので、拡大していないかぎり再生ヘッドは常に見えている。
// 拡大しているあいだに現在時刻が外へ出たら、**端に寄せて「外に居る」と印を出す**
// （値を偽らない ―― 教訓 5.18 の趣旨）。

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from 'zustand';
import type { StoreApi } from 'zustand/vanilla';

import type { Calendar } from '../../domain/time/calendar';
import { denormalize, normalize, type Normalized } from '../../domain/time/normalized';
import { timePointYear, type TimePoint } from '../../domain/time/time-point';
import type { SessionStore } from '../state/store';
import { dayToPixel, pixelToDay } from '../time/anchor-lane';
import { viewSpanDays, zoomView, type TimeBarView } from '../time/timebar';

/** 表示範囲の窓（日数）。null なら「時間軸の全体」。 */
interface RailWindow {
  readonly min: number;
  readonly max: number;
}

export interface RailViewBinding {
  /** いまの表示範囲。 */
  readonly view: TimeBarView;
  /** 軸の画素数を報せる（レイアウトの測定から）。 */
  readonly setPixelLength: (px: number) => void;
  /** ホイールのズーム（正で縮小・負で拡大）。 */
  readonly zoomAt: (notches: number, focusPx: number) => void;
  /** 表示範囲をそのまま差し替える（1 段拡大などの計算済みの結果）。 */
  readonly setView: (next: TimeBarView) => void;
  /** 横スクロール（px。正で右へ）。 */
  readonly scrollByPixels: (px: number) => void;
  /** 全体表示（時間軸いっぱい）へ戻す。 */
  readonly fitAll: () => void;
  /** 拡大されているか（＝全体表示ではないか）。 */
  readonly zoomed: boolean;
  /** その時刻が表示範囲の外なら、見えるところまで寄せる。 */
  readonly revealTime: (time: TimePoint) => void;
  /** 現在時刻の画素位置（表示範囲の外なら端に寄せた値）。 */
  readonly playheadPx: number;
  /** 現在時刻が表示範囲の外か。 */
  readonly playheadOutside: boolean;
  /** 表示範囲の中の割合（0〜1）。つまみの値。 */
  readonly fraction: number;
  /** 割合から時刻を復元する（つまみの確定）。 */
  readonly timeAtFraction: (fraction: number) => TimePoint;
}

export function useRailView<S>(
  store: StoreApi<SessionStore<S>>,
  calendar: Calendar,
  currentTime: TimePoint,
): RailViewBinding {
  const timelineMin = useStore(store, (s) => s.timelineMin);
  const timelineMax = useStore(store, (s) => s.timelineMax);

  const [pixelLength, setPixelLengthState] = useState(0);
  const [window_, setWindow] = useState<RailWindow | null>(null);

  const fullMin = useMemo(
    () => normalize(timelineMin, calendar) as number,
    [timelineMin, calendar],
  );
  const fullMax = useMemo(
    () => normalize(timelineMax, calendar) as number,
    [timelineMax, calendar],
  );

  // 時間軸そのものが変わったら全体表示へ戻す（前のプロジェクトの窓を持ち越さない）。
  useEffect(() => {
    setWindow(null);
  }, [fullMin, fullMax]);

  const view = useMemo<TimeBarView>(() => {
    const w = window_ ?? { min: fullMin, max: fullMax };
    return {
      min: w.min as Normalized,
      max: w.max as Normalized,
      pixelLength,
    };
  }, [window_, fullMin, fullMax, pixelLength]);

  const setPixelLength = useCallback((px: number) => {
    setPixelLengthState((prev) => (prev === px ? prev : px));
  }, []);

  /**
   * 窓を時間軸の中へ収める。**幅は変えない**（寄せるだけ）。時間軸より広い窓は
   * 端に合わせず全体表示に畳む ―― 何も無いところを見続けても意味がない。
   */
  const clampWindow = useCallback(
    (min: number, max: number): RailWindow | null => {
      const span = max - min;
      const full = fullMax - fullMin;
      if (span >= full) return null;
      let lo = min;
      if (lo < fullMin) lo = fullMin;
      if (lo + span > fullMax) lo = fullMax - span;
      return { min: lo, max: lo + span };
    },
    [fullMin, fullMax],
  );

  const setView = useCallback(
    (next: TimeBarView) => {
      setWindow(clampWindow(next.min as number, next.max as number));
    },
    [clampWindow],
  );

  const zoomAt = useCallback(
    (notches: number, focusPx: number) => {
      setWindow((prev) => {
        const base: TimeBarView = {
          min: (prev?.min ?? fullMin) as Normalized,
          max: (prev?.max ?? fullMax) as Normalized,
          pixelLength,
        };
        const next = zoomView(base, notches, focusPx, calendar);
        return clampWindow(next.min as number, next.max as number);
      });
    },
    [fullMin, fullMax, pixelLength, calendar, clampWindow],
  );

  const scrollByPixels = useCallback(
    (px: number) => {
      setWindow((prev) => {
        const min = prev?.min ?? fullMin;
        const max = prev?.max ?? fullMax;
        if (pixelLength <= 0) return prev ?? null;
        const days = ((max - min) / pixelLength) * px;
        return clampWindow(min + days, max + days);
      });
    },
    [fullMin, fullMax, pixelLength, clampWindow],
  );

  const fitAll = useCallback(() => {
    setWindow(null);
  }, []);

  const revealTime = useCallback(
    (time: TimePoint) => {
      const day = normalize(time, calendar) as number;
      setWindow((prev) => {
        if (prev === null) return null;
        if (day >= prev.min && day <= prev.max) return prev;
        const span = prev.max - prev.min;
        return clampWindow(day - span / 2, day + span / 2);
      });
    },
    [calendar, clampWindow],
  );

  const currentDay = useMemo(
    () => normalize(currentTime, calendar) as number,
    [currentTime, calendar],
  );
  const span = viewSpanDays(view);
  const playheadOutside =
    span > 0 && (currentDay < (view.min as number) || currentDay > (view.max as number));
  const rawPx = dayToPixel(currentDay, view);
  const playheadPx = Math.max(0, Math.min(pixelLength, rawPx));
  const fraction = pixelLength > 0 ? playheadPx / pixelLength : 0;

  const timeAtFraction = useCallback(
    (f: number): TimePoint => {
      const clamped = f < 0 ? 0 : f > 1 ? 1 : f;
      const day = pixelToDay(clamped * view.pixelLength, view);
      return roundToYear(day, calendar);
    },
    [view, calendar],
  );

  return {
    view,
    setPixelLength,
    zoomAt,
    setView,
    scrollByPixels,
    fitAll,
    zoomed: window_ !== null,
    revealTime,
    playheadPx,
    playheadOutside,
    fraction,
    timeAtFraction,
  };
}

/**
 * 位置から復元した時刻は **年に丸める**（設計書 §O の B-4 / 増分 2 の中身 1c）。
 * 1px が数年に当たる軸では、位置から出した月日に意味が無い。編集時刻は現在時刻に
 * 一本化されているので、丸めずに置くと月日つきの錨が保存ファイルに増える。
 */
function roundToYear(day: number, calendar: Calendar): TimePoint {
  const complete = denormalize(Math.round(day) as Normalized, calendar);
  return timePointYear(complete.year);
}
