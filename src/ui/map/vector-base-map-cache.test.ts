// ベクター背景の「焼き直し判定」(FR-03 ベクター背景 / ユーザー裁定 2026-08-09)。
//
// 契約:
//   - 余白の内側のパン・同一段階内のズームでは鍵が変わらない = 焼き直さない
//   - 段階をまたぐズーム、余白を出るパンでは鍵が変わる = その領域を 1 度だけ焼く
//   - 焼く矩形は画面より広く、世界の外へはみ出さない
//   - 退化した (未計測の) カメラ/ビューポートでも落ちず、世界全体を返す

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport } from '../../render';

import {
  MAX_VECTOR_BAKE_PX,
  planVectorBake,
  vectorBakeZoomFor,
  vectorBakeZoomLevel,
} from './vector-base-map-cache';

const VP: Viewport = { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 };
const cam = (centerLon: number, centerLat: number, zoom: number): Camera => ({
  centerLon,
  centerLat,
  zoom,
});

describe('planVectorBake — 焼く矩形は必ず画面を覆う (最重要の不変条件)', () => {
  // 実機報告「画面端部分の地図表示がかなり消える」= 焼いた矩形が画面を覆えていない状態。
  // 焼き付け範囲はズーム段階へ量子化し、さらにグリッドへスナップするので、余白が
  // 「量子化のずれ + スナップのずれ」を吸収しきれないと画面端に穴が空く。
  // あらゆるズーム・カメラ位置で覆えることを網羅的に確かめる。
  const zooms = [0.2, 0.7, 1, 1.3, 2, 2.9, 4, 5.7, 8, 11, 16, 23, 32, 45, 50];
  const centers = [0, 0.4, 1.7, 7.3, 33.3, 91.1, 179.9, -12.5, -88.8];
  const viewports: Viewport[] = [
    { widthCss: 1280, heightCss: 720, devicePixelRatio: 1 },
    { widthCss: 800, heightCss: 1200, devicePixelRatio: 2 },
    { widthCss: 2560, heightCss: 1440, devicePixelRatio: 1 },
  ];

  it('どのズーム・位置・画面サイズでも、画面が覆う経度範囲が焼く矩形に収まる', () => {
    const gaps: string[] = [];
    for (const vp of viewports) {
      for (const zoom of zooms) {
        for (const lon of centers) {
          const plan = planVectorBake(cam(lon, 0, zoom), vp);
          const halfVisible = vp.widthCss / zoom / 2;
          const westNeeded = lon - halfVisible;
          const eastNeeded = lon + halfVisible;
          // 世界一周ぶんを焼いている場合はシーム複製が全面を埋めるので対象外
          if (plan.rect.lonEast - plan.rect.lonWest >= 360 - 1e-9) continue;
          if (plan.rect.lonWest > westNeeded + 1e-9 || plan.rect.lonEast < eastNeeded - 1e-9) {
            gaps.push(
              `vp=${vp.widthCss} zoom=${zoom} lon=${lon}: 要 [${westNeeded.toFixed(2)}, ${eastNeeded.toFixed(2)}] / 焼 [${plan.rect.lonWest.toFixed(2)}, ${plan.rect.lonEast.toFixed(2)}]`,
            );
          }
        }
      }
    }
    expect(gaps).toEqual([]);
  });

  it('どのズーム・位置・画面サイズでも、画面が覆う緯度範囲が焼く矩形に収まる', () => {
    const gaps: string[] = [];
    for (const vp of viewports) {
      for (const zoom of zooms) {
        for (const lat of [0, 5.5, 30, 61.2, -44.4]) {
          const plan = planVectorBake(cam(0, lat, zoom), vp);
          const halfVisible = vp.heightCss / zoom / 2;
          // 世界の外は焼けないので、±90 で切り詰めた分は要求からも外す
          const northNeeded = Math.min(90, lat + halfVisible);
          const southNeeded = Math.max(-90, lat - halfVisible);
          if (
            plan.rect.latNorth < northNeeded - 1e-9 ||
            plan.rect.latSouth > southNeeded + 1e-9
          ) {
            gaps.push(
              `vp=${vp.heightCss} zoom=${zoom} lat=${lat}: 要 [${southNeeded.toFixed(2)}, ${northNeeded.toFixed(2)}] / 焼 [${plan.rect.latSouth.toFixed(2)}, ${plan.rect.latNorth.toFixed(2)}]`,
            );
          }
        }
      }
    }
    expect(gaps).toEqual([]);
  });
});

describe('planVectorBake — 焼き直しの判定', () => {
  it('わずかなパンでは鍵が変わらない (焼き直さない)', () => {
    const a = planVectorBake(cam(0, 0, 10), VP);
    const b = planVectorBake(cam(0.5, 0.3, 10), VP);
    expect(b.key).toBe(a.key);
  });

  it('余白を出るほど動かすと鍵が変わる (その領域を焼く)', () => {
    const a = planVectorBake(cam(0, 0, 10), VP);
    // 画面幅 = 1280/10 = 128°。余白込み 256°。半領域 (128°) 動かせばスナップ先が変わる。
    const b = planVectorBake(cam(140, 0, 10), VP);
    expect(b.key).not.toBe(a.key);
  });

  it('同じ段階の中のズーム変化では鍵が変わらない', () => {
    const level = vectorBakeZoomLevel(10);
    // 同じ段階に収まる 2 つのズーム
    const z1 = vectorBakeZoomFor(level) * 0.95;
    const z2 = vectorBakeZoomFor(level) * 0.99;
    expect(vectorBakeZoomLevel(z1)).toBe(vectorBakeZoomLevel(z2));
    expect(planVectorBake(cam(0, 0, z1), VP).key).toBe(planVectorBake(cam(0, 0, z2), VP).key);
  });

  it('段階をまたぐズームでは鍵が変わり、解像度が上がる', () => {
    const a = planVectorBake(cam(0, 0, 4), VP);
    const b = planVectorBake(cam(0, 0, 64), VP);
    expect(b.key).not.toBe(a.key);
    // 拡大すると同じ画面を覆う度数が減るので、度あたりの画素は増える
    const aPxPerDeg = a.widthPx / (a.rect.lonEast - a.rect.lonWest);
    const bPxPerDeg = b.widthPx / (b.rect.lonEast - b.rect.lonWest);
    expect(bPxPerDeg).toBeGreaterThan(aPxPerDeg);
  });

  it('焼く矩形は画面より広く、緯度は世界の外へ出ない', () => {
    const plan = planVectorBake(cam(0, 0, 10), VP);
    expect(plan.rect.lonEast - plan.rect.lonWest).toBeGreaterThan(VP.widthCss / 10);
    expect(plan.rect.latNorth).toBeLessThanOrEqual(90);
    expect(plan.rect.latSouth).toBeGreaterThanOrEqual(-90);
  });

  it('極付近でも緯度は ±90 に収まる', () => {
    const plan = planVectorBake(cam(0, 89, 2), VP);
    expect(plan.rect.latNorth).toBeLessThanOrEqual(90);
    expect(plan.rect.latSouth).toBeGreaterThanOrEqual(-90);
  });

  it('経度は世界一周を超えない (超える分はシーム複製が担う)', () => {
    const plan = planVectorBake(cam(0, 0, 0.5), VP);
    expect(plan.rect.lonEast - plan.rect.lonWest).toBeLessThanOrEqual(360 + 1e-9);
  });

  it('焼き付け寸法は上限を超えない (メモリの安全弁)', () => {
    const plan = planVectorBake(cam(0, 0, 5000), VP);
    expect(plan.widthPx).toBeLessThanOrEqual(MAX_VECTOR_BAKE_PX);
    expect(plan.heightPx).toBeLessThanOrEqual(MAX_VECTOR_BAKE_PX);
    expect(plan.widthPx).toBeGreaterThan(0);
    expect(plan.heightPx).toBeGreaterThan(0);
  });

  it('未計測 (0×0) のビューポートでも世界全体を返す', () => {
    const plan = planVectorBake(cam(0, 0, 0), { widthCss: 0, heightCss: 0, devicePixelRatio: 1 });
    expect(plan.rect).toEqual({ lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 });
    expect(plan.widthPx).toBeGreaterThan(0);
  });
});
