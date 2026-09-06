// UI layer (U21 / 時刻レール): 目盛りの位置（設計書 §C.7 の (c)）。
//
// **表示範囲そのものに対して打つ**。既存の `generateTicks` は「範囲の年から年まで」を
// 割り付ける形なので、レールが拡大されて端が年の途中になると、目盛りと錨の印が
// わずかにずれる（同じ軸の上で 2 つの写像が並ぶ）。刻み幅を選ぶ規則
// （`chooseYearTickInterval`）は共有し、位置だけをレールの写像で出す（教訓 5.29）。

import type { Calendar } from '../../domain/time/calendar';
import { denormalize, normalize } from '../../domain/time/normalized';
import { timePointYear } from '../../domain/time/time-point';

import {
  chooseYearTickInterval,
  formatCompleteTimePoint,
  formatYear,
} from '../timeline/time-display';

import { dayToPixel } from './anchor-lane';
import { viewSpanDays, type TimeBarView } from './timebar';

/** 目盛り 1 本（年と、軸の左端からの px）。 */
export interface RailTick {
  readonly year: number;
  readonly px: number;
  /** 画面に出す文字（年の途中まで拡大したら日付になる）。 */
  readonly label: string;
  /** React の key（両端の目盛りは同じ年になりうるので年では足りない）。 */
  readonly key: string;
}

/** 1 年の日数のならし（刻み幅を選ぶためだけに使う概算）。 */
export const DAYS_PER_YEAR = 365.2425;

/** 表示範囲の年の幅（概算。読み取り行の「◯年ぶん」に使う）。 */
export function viewSpanYears(view: TimeBarView): number {
  return viewSpanDays(view) / DAYS_PER_YEAR;
}

/**
 * 表示範囲に目盛りを打つ。刻みは 1/2/5 × 10^n の梯子から `targetTicks` 本に近いものを
 * 選ぶ（既存の規則をそのまま使う）。位置は錨の印と **同じ写像**（`dayToPixel`）で出す。
 */
export function railTicks(
  view: TimeBarView,
  calendar: Calendar,
  targetTicks: number,
): readonly RailTick[] {
  const span = viewSpanDays(view);
  if (span <= 0 || view.pixelLength <= 0) return [];
  const minYear = denormalize(view.min, calendar).year;
  const maxYear = denormalize(view.max, calendar).year;
  const interval = chooseYearTickInterval(Math.max(1, maxYear - minYear), targetTicks);
  const first = Math.ceil(minYear / interval) * interval;
  const out: RailTick[] = [];
  for (let y = first; y <= maxYear; y += interval) {
    const px = dayToPixel(normalize(timePointYear(y), calendar) as number, view);
    if (px < -1 || px > view.pixelLength + 1) continue;
    out.push({ year: y, px, label: formatYear(y), key: `y${String(y)}` });
  }
  // **最低 2 本は残す**（2026-09-07 の手直し）。1 年より狭くまで拡大すると年の目盛りは
  // 0〜1 本しか立たず、**軸に数字が 1 つも無い**状態になっていた（実測）。そのときは
  // 表示範囲の両端に日付の目盛りを立てる ―― どこを見ているかが必ず読める。
  if (out.length >= 2) return out;
  const minPoint = denormalize(view.min, calendar);
  const maxPoint = denormalize(view.max, calendar);
  return [
    { year: minPoint.year, px: 0, label: formatCompleteTimePoint(minPoint), key: 'edge-min' },
    {
      year: maxPoint.year,
      px: view.pixelLength,
      label: formatCompleteTimePoint(maxPoint),
      key: 'edge-max',
    },
  ];
}

/**
 * 目盛りラベルのおおよその幅（px）。**「単位: 年」の余白をラベルの最大幅から取る**ために
 * 使う（2026-09-07 の手直し）―― 旧版は余白を 64px に固定していたので、いちばん右の
 * ラベルが余白へ 18.5px 食い込み、紀元前でラベルが伸びると「単位: 年」と重なった。
 * 文字幅は 10px の等幅数字を前提に、半角 ≒ 0.6em・全角 ≒ 1em で見積もる。
 */
export function tickLabelWidthPx(label: string, fontSizePx = 10): number {
  let em = 0;
  for (const ch of label) {
    em += ch.codePointAt(0)! <= 0x7f ? 0.6 : 1;
  }
  return Math.ceil(em * fontSizePx);
}
