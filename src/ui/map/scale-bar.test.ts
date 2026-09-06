// 縮尺バーの目盛り（設計書 §B.5 の台帳 #11）を固定する。
//
// 状態行の「1:12,000,000」と **同じ値から出す**が役目が違う（桁を読む／距離を目で測る）。
// ここで守るのは「バーの長さが目安の幅に入ること」と「読めない入力では出さないこと」。

import { describe, expect, it } from 'vitest';

import {
  SCALE_BAR_MAX_PX,
  SCALE_BAR_MIN_PX,
  chooseScaleBar,
  formatDistance,
} from './scale-bar';

const EQUATOR_KM = 40_075;

describe('chooseScaleBar', () => {
  it('どの倍率でも目安の幅（60〜160px）に入るきりのよい距離を選ぶ', () => {
    for (const zoom of [0.5, 1, 2, 4, 16, 64, 256, 1024, 8192]) {
      const bar = chooseScaleBar(zoom, EQUATOR_KM);
      expect(bar, `zoom=${String(zoom)}`).not.toBeNull();
      expect(bar!.pixels).toBeGreaterThanOrEqual(SCALE_BAR_MIN_PX);
      expect(bar!.pixels).toBeLessThanOrEqual(SCALE_BAR_MAX_PX);
    }
  });

  it('距離は 1/2/5 × 10^n のきりのよい値になる', () => {
    const bar = chooseScaleBar(4, EQUATOR_KM);
    expect(bar).not.toBeNull();
    const mantissa = bar!.metres / Math.pow(10, Math.floor(Math.log10(bar!.metres)));
    expect([1, 2, 5]).toContain(Math.round(mantissa));
  });

  it('読めない入力では **出さない**（「—」を描くと物差しとして嘘になる）', () => {
    expect(chooseScaleBar(0, EQUATOR_KM)).toBeNull();
    expect(chooseScaleBar(-1, EQUATOR_KM)).toBeNull();
    expect(chooseScaleBar(Number.NaN, EQUATOR_KM)).toBeNull();
    expect(chooseScaleBar(4, 0)).toBeNull();
  });
});

describe('formatDistance', () => {
  it('1km 以上は km、それ未満は m。3 桁区切りはロケールに依らせない', () => {
    expect(formatDistance(500)).toBe('500 m');
    expect(formatDistance(1000)).toBe('1 km');
    expect(formatDistance(2_000_000)).toBe('2,000 km');
  });
});
