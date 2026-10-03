// 増分 8A — 掴める距離は画面倍率に連動し、8px を下回らない（設計書 §M-11 ①）。

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport } from '../../render';

import {
  GRAB_RADIUS_GROW_FROM_RATIO,
  GRAB_RADIUS_MAX_PX,
  GRAB_RADIUS_MIN_PX,
  grabRadiusPx,
  worldFitZoom,
} from './grab-radius';
import { DEFAULT_HIT_RADIUS_PX } from './live-hit-test';

const VIEW: Viewport = { widthCss: 900, heightCss: 600, devicePixelRatio: 1 };
const FIT = 900 / 360; // 横で決まる（600/180 = 3.33 より小さい）

const at = (ratio: number): Camera => ({ centerLon: 0, centerLat: 0, zoom: FIT * ratio });

describe('掴める距離', () => {
  it('世界全体表示の倍率は 360°×180° がちょうど収まる値', () => {
    expect(worldFitZoom(VIEW)).toBeCloseTo(FIT);
    expect(worldFitZoom({ widthCss: 0, heightCss: 600, devicePixelRatio: 1 })).toBe(0);
  });

  it('下限は旧来の 8px と同じ値で、全体表示から 16 倍までは下限のまま', () => {
    expect(GRAB_RADIUS_MIN_PX).toBe(DEFAULT_HIT_RADIUS_PX);
    expect(grabRadiusPx(at(1), VIEW)).toBe(8);
    expect(grabRadiusPx(at(4), VIEW)).toBe(8);
    expect(grabRadiusPx(at(GRAB_RADIUS_GROW_FROM_RATIO), VIEW)).toBe(8);
  });

  it('16 倍を超えると倍率に比例して広がり、32 倍で上限 16px に止まる', () => {
    expect(grabRadiusPx(at(24), VIEW)).toBeCloseTo(12);
    expect(grabRadiusPx(at(32), VIEW)).toBe(GRAB_RADIUS_MAX_PX);
    expect(grabRadiusPx(at(1000), VIEW)).toBe(GRAB_RADIUS_MAX_PX);
  });

  it('倍率が大きいほど小さくはならない（単調）', () => {
    let prev = 0;
    for (let r = 0.25; r <= 64; r *= 1.5) {
      const now = grabRadiusPx(at(r), VIEW);
      expect(now).toBeGreaterThanOrEqual(prev);
      expect(now).toBeGreaterThanOrEqual(GRAB_RADIUS_MIN_PX);
      prev = now;
    }
  });

  it('測れていないカメラ・ビューポートでは下限', () => {
    expect(grabRadiusPx({ centerLon: 0, centerLat: 0, zoom: 0 }, VIEW)).toBe(8);
    expect(grabRadiusPx({ centerLon: 0, centerLat: 0, zoom: Number.NaN }, VIEW)).toBe(8);
    expect(
      grabRadiusPx(at(100), { widthCss: 0, heightCss: 0, devicePixelRatio: 1 }),
    ).toBe(8);
  });
});
