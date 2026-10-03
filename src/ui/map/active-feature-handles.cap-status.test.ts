// 増分 8A（V9 / §H.5）— 「上限のため印を出していません」の判定は、印を描く側の上限の
// 判定と食い違わない（教訓 5.29）。描画の結果（頂点の印の本数）と突き合わせて固定する。
//
// あわせて［拡大］の計算（handle-cap.ts）が「印が出るところまで」寄り、地物を画面の外へ
// 追い出さないことを見る。

import { afterEach, describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createCoordinate } from '../../domain/coordinate';
import { createLeafFeature } from '../../domain/feature';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { DomainProject } from '../../domain/persistence/index';
import {
  DEFAULT_BASEMAP,
  DEFAULT_SETTINGS,
  singleAnchorHistory,
} from '../../domain/persistence/fixtures';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { timePointYear } from '../../domain/time/time-point';
import { createVertex, createVertexStore } from '../../domain/vertex';
import type { Camera, Viewport } from '../../render';
import type { DisplayControlInput } from '../../render/display-pipeline';
import type { HandlePrimitive } from '../../render/map-renderer';
import { DEFAULT_FILTER_STATE } from '../discovery/index';

import {
  activeFeatureHandleCapStatus,
  buildActiveFeatureHandlePrimitives,
} from './active-feature-handles';
import { clearDisplayResolutionCache } from './display-resolution-cache';
import { clearFilteredDisplayCache } from './filtered-display';
import {
  canZoomInFurther,
  featureAnchorNearCentre,
  handleCapText,
  zoomUntilHandlesShow,
} from './handle-cap';

const DISPLAY: DisplayControlInput = {
  globalDepth: 0,
  focus: { originId: null, depth: 0, emphasize: false },
};
const VIEWPORT: Viewport = { widthCss: 900, heightCss: 600, devicePixelRatio: 1 };
const T = timePointYear(10);
const ID = asFeatureId('ring');

afterEach(() => {
  clearDisplayResolutionCache();
  clearFilteredDisplayCache();
});

/** 中心 (cx, cy)・半径 r 度の円周に `n` 個の頂点を持つ 1 地物（密な国境の代わり）。 */
function ringProject(n: number, cx = 0, cy = 0, r = 30): DomainProject {
  const vertices = Array.from({ length: n }, (_, i) =>
    createVertex(
      asVertexId(`v${String(i)}`),
      createCoordinate(
        cx + r * Math.cos((2 * Math.PI * i) / n),
        cy + r * Math.sin((2 * Math.PI * i) / n),
      ),
    ),
  );
  const feature = createLeafFeature(
    ID,
    createBasicAttributes('円の国', 0, 100),
    createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1'),
    createShape([createTerritoryRing(asRingId('ring-r'), vertices.map((v) => v.id))]),
  );
  return {
    histories: [singleAnchorHistory('ring', [feature], createVertexStore(vertices), 0)],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

const FIT: Camera = { centerLon: 0, centerLat: 0, zoom: 900 / 360 };

function drawnVertexHandles(root: DomainProject, cap: number, camera: Camera): number {
  return buildActiveFeatureHandlePrimitives(
    root,
    T,
    ID,
    DISPLAY,
    null,
    undefined,
    undefined,
    cap,
    DEFAULT_FILTER_STATE,
    {},
    undefined,
    { camera, viewport: VIEWPORT },
  ).filter((p): p is HandlePrimitive => p.kind === 'handle' && p.handleKind === 'vertex')
    .length;
}

function status(root: DomainProject, cap: number, camera: Camera) {
  return activeFeatureHandleCapStatus(root, T, ID, DISPLAY, cap, DEFAULT_FILTER_STATE, {}, {
    camera,
    viewport: VIEWPORT,
  });
}

describe('上限の理由は、描画の上限の判定と食い違わない', () => {
  it('視野内が上限を超えると「印は 0 本・理由あり」、超えなければ「印あり・理由なし」', () => {
    const root = ringProject(300);
    // 上限 200: 全体表示では 300 個が視野内 → 印は出ず、理由が出る。
    expect(drawnVertexHandles(root, 200, FIT)).toBe(0);
    expect(status(root, 200, FIT)).toEqual({ counted: 300, cap: 200 });
    // 上限 400: 印が出て、理由は出ない。
    expect(drawnVertexHandles(root, 400, FIT)).toBe(300);
    expect(status(root, 400, FIT)).toBeNull();
  });

  it('拡大して視野内が上限を下回れば、理由は消えて印が出る（同じカメラで両方を見る）', () => {
    const root = ringProject(300);
    // 円の右端（30°E, 0°N）へ 20 倍で寄る。
    const close: Camera = { centerLon: 30, centerLat: 0, zoom: FIT.zoom * 20 };
    const drawn = drawnVertexHandles(root, 200, close);
    expect(drawn).toBeGreaterThan(0);
    expect(status(root, 200, close)).toBeNull();
  });

  it('文は設計書のとおり（桁区切り）。上限 0 のときは拡大を勧めない', () => {
    expect(handleCapText(2230, 2000)).toBe(
      '頂点が 2,230 あり、上限 2,000 のため印を出していません。拡大すると出ます',
    );
    expect(handleCapText(12, 0)).toBe('頂点が 12 あり、上限 0 のため印を出していません。');
  });

  it('ズームの上限まで寄っているときは「拡大すると出ます」を言わず、事実だけを言う（設計適合 2-4）', () => {
    const text = handleCapText(2230, 2000, true);
    expect(text).toBe(
      '頂点が 2,230 あり、上限 2,000 のため印を出していません。これ以上は拡大できません。',
    );
    expect(text).not.toContain('拡大すると出ます');
  });

  it('まだ拡大できるかは［拡大］と同じ判定（次の段で倍率が上がるか）', () => {
    const range = { minZoom: 0.1, maxZoom: FIT.zoom * 4 };
    expect(canZoomInFurther(FIT, VIEWPORT, range)).toBe(true);
    const atMax: Camera = { ...FIT, zoom: FIT.zoom * 4 };
    expect(canZoomInFurther(atMax, VIEWPORT, range)).toBe(false);
    // 上限ちょうどまで寄せた［拡大］の結果も「もう寄れない」と答える（2 つの判定が割れない）。
    const stuck = zoomUntilHandlesShow({
      camera: FIT,
      viewport: VIEWPORT,
      range,
      anchor: { x: 450, y: 300 },
      stillCapped: () => true,
    });
    expect(canZoomInFurther(stuck, VIEWPORT, range)).toBe(false);
  });
});

describe('［拡大］は印が出るところまで寄る', () => {
  it('地物の頂点を動かない点にして寄り、止まったところでは印が出ている', () => {
    const root = ringProject(300);
    const anchor = featureAnchorNearCentre(root, T, DISPLAY, ID, {
      camera: FIT,
      viewport: VIEWPORT,
    });
    // 円の中心（画面の真ん中）には頂点が無いので、動かない点は円周の上になる。
    expect(anchor).not.toEqual({ x: 450, y: 300 });
    const next = zoomUntilHandlesShow({
      camera: FIT,
      viewport: VIEWPORT,
      range: { minZoom: 0.1, maxZoom: 10_000 },
      anchor,
      stillCapped: (c) => status(root, 200, c) !== null,
    });
    expect(next.zoom).toBeGreaterThan(FIT.zoom);
    expect(status(root, 200, next)).toBeNull();
    // 「視野内 0 個 ≤ 上限」で黙って止まったのではなく、印が実際に出ている。
    expect(drawnVertexHandles(root, 200, next)).toBeGreaterThan(0);
  });

  it('ズームの上限に当たったらそこで止まる（無限に回らない）', () => {
    const root = ringProject(300);
    const next = zoomUntilHandlesShow({
      camera: FIT,
      viewport: VIEWPORT,
      range: { minZoom: 0.1, maxZoom: FIT.zoom * 1.2 },
      anchor: { x: 450, y: 300 },
      stillCapped: (c) => status(root, 200, c) !== null,
    });
    expect(next.zoom).toBeLessThanOrEqual(FIT.zoom * 1.2 + 1e-9);
  });
});
