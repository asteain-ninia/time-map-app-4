// キーボードズーム (view.zoomIn / view.zoomOut) の算出契約.
//
// menu.ts は Ctrl+= / Ctrl+- を宣言済みだがハンドラが未登録で、実機では Electron 既定
// アプリケーションメニューの zoomIn/zoomOut ロール（= **ページ**ズーム）に食われていた。
// ページズームは FR-16 の座標対応（CSS px ↔ 経緯度）を壊すので、アプリは自分の **地図**
// ズームへ結線する。その算出はホイールズームと同じ U17 `zoomStepAtCursor` の一本道で、
// 唯一の違いはアンカーがカーソルではなくビューポート中心であること。

import { describe, expect, it } from 'vitest';

import { screenToWorld, type Camera, type Viewport } from '../../render';
import { keyboardZoomCamera, keyboardZoomFactor, viewportCentre } from './keyboard-zoom';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAMERA: Camera = { zoom: 4, centerLon: 10, centerLat: 20 };

describe('keyboardZoomFactor', () => {
  it('zooms IN with a factor > 1 and OUT with its reciprocal', () => {
    const inFactor = keyboardZoomFactor('in');
    const outFactor = keyboardZoomFactor('out');
    expect(inFactor).toBeGreaterThan(1);
    expect(outFactor).toBeLessThan(1);
    // 1回の押下で in→out（順序どちらでも）が元の倍率へ戻る = 対称ステップ.
    expect(inFactor * outFactor).toBeCloseTo(1, 12);
  });

  it('is a whole number of wheel notches (the SAME multiplicative step the wheel uses)', () => {
    // ホイール1ノッチ = 1.1 倍（PointerDispatcher の既定）。キーボード1押下はその整数乗
    // であって、独自の倍率定数ではない（単一真実源）。
    const notches = Math.log(keyboardZoomFactor('in')) / Math.log(1.1);
    expect(notches).toBeCloseTo(Math.round(notches), 12);
    expect(Math.round(notches)).toBeGreaterThanOrEqual(1);
  });
});

describe('viewportCentre', () => {
  it('is the CSS-pixel centre of the surface', () => {
    expect(viewportCentre(VIEWPORT)).toEqual({ x: 400, y: 300 });
  });

  it('is finite for a degenerate (unmeasured) viewport', () => {
    const centre = viewportCentre({ widthCss: 0, heightCss: 0, devicePixelRatio: 1 });
    expect(Number.isFinite(centre.x)).toBe(true);
    expect(Number.isFinite(centre.y)).toBe(true);
  });
});

describe('keyboardZoomCamera', () => {
  it('changes the MAP zoom (in raises, out lowers)', () => {
    expect(keyboardZoomCamera(CAMERA, VIEWPORT, 'in').zoom).toBeGreaterThan(CAMERA.zoom);
    expect(keyboardZoomCamera(CAMERA, VIEWPORT, 'out').zoom).toBeLessThan(CAMERA.zoom);
  });

  it('holds the world point under the viewport CENTRE invariant', () => {
    const centre = viewportCentre(VIEWPORT);
    const before = screenToWorld(centre, CAMERA, VIEWPORT);
    for (const direction of ['in', 'out'] as const) {
      const next = keyboardZoomCamera(CAMERA, VIEWPORT, direction);
      const after = screenToWorld(centre, next, VIEWPORT);
      expect(after.lon).toBeCloseTo(before.lon, 9);
      expect(after.lat).toBeCloseTo(before.lat, 9);
    }
  });

  it('round-trips: one step in then one step out returns the same camera', () => {
    const round = keyboardZoomCamera(keyboardZoomCamera(CAMERA, VIEWPORT, 'in'), VIEWPORT, 'out');
    expect(round.zoom).toBeCloseTo(CAMERA.zoom, 9);
    expect(round.centerLon).toBeCloseTo(CAMERA.centerLon, 9);
    expect(round.centerLat).toBeCloseTo(CAMERA.centerLat, 9);
  });

  it('obeys the FR-10 clamp range it is given (never past min/max)', () => {
    const range = { minZoom: 3, maxZoom: 5 };
    expect(keyboardZoomCamera({ ...CAMERA, zoom: 5 }, VIEWPORT, 'in', range).zoom).toBe(5);
    expect(keyboardZoomCamera({ ...CAMERA, zoom: 3 }, VIEWPORT, 'out', range).zoom).toBe(3);
    // 中間からのステップも範囲内に収まる.
    const stepped = keyboardZoomCamera({ ...CAMERA, zoom: 4.9 }, VIEWPORT, 'in', range);
    expect(stepped.zoom).toBeLessThanOrEqual(5);
    expect(stepped.zoom).toBeGreaterThanOrEqual(3);
  });
});
