// 年への丸め（増分 2 の中身 1c / 設計書 §O の B-4）。
//
// 実データの錨は 689 本すべてが「年だけ」で始まる。編集時刻を現在時刻へ一本化すると
// （設計書 §D.3）、現在時刻に月日が付いた瞬間にその月日が `.gimoza` へ書き込まれる。
// U-14「月日を勝手に補わない」に反するデータを増やさないための、時刻側の 1 段。

import { describe, expect, it } from 'vitest';

import {
  isYearGranularity,
  timePointYear,
  timePointYearMonth,
  timePointYearMonthDay,
  toYearPoint,
} from './time-point';

describe('toYearPoint（月日を捨てて年だけにする）', () => {
  it('年月日・年月を年だけにする', () => {
    expect(toYearPoint(timePointYearMonthDay(5080, 12, 31))).toEqual(timePointYear(5080));
    expect(toYearPoint(timePointYearMonth(1200, 7))).toEqual(timePointYear(1200));
  });

  it('負の年（紀元前）でも年の値は変えない', () => {
    expect(toYearPoint(timePointYearMonthDay(-450, 6, 15))).toEqual(timePointYear(-450));
  });

  it('切り捨てであって四捨五入ではない（12月31日でも翌年にしない）', () => {
    expect(toYearPoint(timePointYearMonthDay(1999, 12, 31)).year).toBe(1999);
  });

  it('すでに年だけなら同じオブジェクトを返す（無駄な作り直しをしない）', () => {
    const y = timePointYear(0);
    expect(toYearPoint(y)).toBe(y);
  });

  it('冪等である', () => {
    const once = toYearPoint(timePointYearMonthDay(1200, 3, 4));
    expect(toYearPoint(once)).toEqual(once);
  });
});

describe('isYearGranularity', () => {
  it('年だけのときだけ真', () => {
    expect(isYearGranularity(timePointYear(1200))).toBe(true);
    expect(isYearGranularity(timePointYearMonth(1200, 1))).toBe(false);
    expect(isYearGranularity(timePointYearMonthDay(1200, 1, 1))).toBe(false);
  });
});
