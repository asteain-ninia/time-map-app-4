// P0-A — the host's frame composition (CONVERGE-2): COMMITTED features must reach
// the draw batch, UNDER the tool overlay and ABOVE the grid, and a changed
// committed set (e.g. after a time change) must change the batch. `composeFrame`
// is the pure core the live host delegates to on every paint, so this fixes the
// behavior without a DOM / Canvas (host-ports itself is DOM-only by design).

import { describe, expect, it } from 'vitest';

import { DEFAULT_CAMERA } from '../state/session';
import type { Camera, Viewport } from '../../render/camera';
import type { DrawPrimitive } from '../../render/map-renderer';
import type { EvaluatedFeature, FeatureStyle } from '../../render/feature-layer';

import type { GridStyle } from '../../render/grid-layer';
import { DEFAULT_GRID_STYLE, withOpacity } from '../../render/grid-layer';

import {
  DEFAULT_SCREEN_SIZES,
  selectVisibleFeatures,
} from '../../render/feature-layer';

import { composeFrame, composeFrameWithCount } from './host-ports';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const CAMERA: Camera = DEFAULT_CAMERA;

const STYLE: FeatureStyle = { fill: '#123456', stroke: '#000', selectedColor: '#0ff' };

function point(id: string, lon: number, lat: number): EvaluatedFeature {
  return { kind: 'point', id, at: { lon, lat }, style: STYLE, label: '', selected: false };
}

function kinds(prims: readonly DrawPrimitive[]): string[] {
  return prims.map((p) => p.kind);
}

describe('composeFrame', () => {
  it('includes committed features ABOVE the grid and UNDER the tool overlay', () => {
    const overlay: DrawPrimitive[] = [
      { kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 4, fill: '#f00' },
    ];
    const prims = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20)],
      overlay,
      camera: CAMERA,
      viewport: VIEWPORT,
    });

    // The committed point produced a point primitive.
    const committedPoint = prims.find(
      (p): p is Extract<DrawPrimitive, { kind: 'point' }> =>
        p.kind === 'point' && p.fill === STYLE.fill,
    );
    expect(committedPoint).toBeDefined();

    // Order: at least one gridline precedes the committed point, which precedes
    // the overlay point (the last primitive).
    const ks = kinds(prims);
    const firstGrid = ks.indexOf('gridline');
    const committedIdx = prims.indexOf(committedPoint!);
    const overlayIdx = prims.length - 1;
    expect(firstGrid).toBeGreaterThanOrEqual(0);
    expect(firstGrid).toBeLessThan(committedIdx);
    expect(committedIdx).toBeLessThan(overlayIdx);
    expect(prims[overlayIdx]).toBe(overlay[0]);
  });

  it('draws no committed primitives when there are none (grid still drawn)', () => {
    const prims = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(kinds(prims)).toContain('gridline');
    expect(prims.every((p) => p.kind !== 'point')).toBe(true);
  });

  // 回帰: グリッド設定(間隔/色/不透明度)が地図描画に反映される (bughunt)。
  // 以前は composeFrame が buildGridPrimitives(true, DEFAULT_GRID_STYLE, ...) と
  // 固定値を渡しており、projectSettings の grid 設定を無視していた。
  describe('grid style is honored (FR-13 / FR-109 即時反映 — bughunt regression)', () => {
    const gridLines = (prims: readonly DrawPrimitive[]) =>
      prims.filter(
        (p): p is Extract<DrawPrimitive, { kind: 'gridline' }> => p.kind === 'gridline',
      );

    it('a wider SPACING yields fewer graticule lines than the default', () => {
      const dense = composeFrame({
        baseImage: null,
        committed: [],
        overlay: [],
        camera: CAMERA,
        viewport: VIEWPORT,
        grid: { ...DEFAULT_GRID_STYLE, spacing: 5 },
      });
      const sparse = composeFrame({
        baseImage: null,
        committed: [],
        overlay: [],
        camera: CAMERA,
        viewport: VIEWPORT,
        grid: { ...DEFAULT_GRID_STYLE, spacing: 30 },
      });
      expect(gridLines(dense).length).toBeGreaterThan(gridLines(sparse).length);
    });

    it('the live COLOR + OPACITY reach the normal gridline stroke', () => {
      const style: GridStyle = {
        ...DEFAULT_GRID_STYLE,
        color: '#123456',
        opacity: 0.25,
      };
      const prims = composeFrame({
        baseImage: null,
        committed: [],
        overlay: [],
        camera: CAMERA,
        viewport: VIEWPORT,
        grid: style,
      });
      const expectedStroke = withOpacity(style.color, style.opacity);
      // A normal (non-emphasized) gridline must carry the folded rgba() stroke; a
      // change to the project color/opacity therefore changes what is drawn.
      const normalLines = gridLines(prims).filter((l) => l.stroke === expectedStroke);
      expect(normalLines.length).toBeGreaterThan(0);
      // The default style produced a DIFFERENT stroke, proving the override took.
      const defaultStroke = withOpacity(
        DEFAULT_GRID_STYLE.color,
        DEFAULT_GRID_STYLE.opacity,
      );
      expect(expectedStroke).not.toBe(defaultStroke);
      expect(gridLines(prims).some((l) => l.stroke === defaultStroke)).toBe(false);
    });

    it('falls back to DEFAULT_GRID_STYLE when no live grid is supplied', () => {
      const prims = composeFrame({
        baseImage: null,
        committed: [],
        overlay: [],
        camera: CAMERA,
        viewport: VIEWPORT,
      });
      const defaultStroke = withOpacity(
        DEFAULT_GRID_STYLE.color,
        DEFAULT_GRID_STYLE.opacity,
      );
      expect(gridLines(prims).some((l) => l.stroke === defaultStroke)).toBe(true);
    });
  });

  it('reflects a CHANGED committed set in the batch (time-change reflection)', () => {
    const before = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20)],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    const after = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20), point('pt-2', 30, 40)],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });

    const committedPointCount = (prims: readonly DrawPrimitive[]): number =>
      prims.filter((p) => p.kind === 'point' && p.fill === STYLE.fill).length;

    expect(committedPointCount(before)).toBe(1);
    expect(committedPointCount(after)).toBe(2);
  });
});

// 回帰 (bughunt round-2): paintWith はかつて 1 フレームにつき選別(O(n) view clip)を
// 二度走らせていた — composeFrame 内 buildFeaturePrimitives で一度、観測フック
// onVisibleFeatureCount 用に selectVisibleFeatures をもう一度。フックは本番(App.tsx)で
// 常時配線されるため、毎フレーム二重の地物コストを払っていた。修正後は composeFrame が
// 同一の clip パスから可視数を返す(composeFrameWithCount.visibleCount)。本テストは
// その単一真実源契約を固定する:
//   1. visibleCount は selectVisibleFeatures(...).length と厳密一致(ドリフトなし)。
//   2. 画面外の確定地物は visibleCount から除外される(生の length ではなく clip 後の数)。
describe('composeFrameWithCount visibleCount — single clip pass (bughunt round-2)', () => {
  // ズームインしたカメラ: 原点付近のみが可視。遠方の地物は view clip で落ちる。
  const ZOOMED_IN: Camera = { ...CAMERA, zoom: 10, centerLon: 0, centerLat: 0 };

  it('visibleCount equals selectVisibleFeatures(...).length over the SAME clipped set', () => {
    const committed: EvaluatedFeature[] = [
      point('near-1', 0, 0),
      point('near-2', 1, 1),
      point('far-1', 170, 80), // off-screen at this zoom/center
    ];
    const { visibleCount } = composeFrameWithCount({
      baseImage: null,
      committed,
      overlay: [],
      camera: ZOOMED_IN,
      viewport: VIEWPORT,
    });
    const expected = selectVisibleFeatures(
      committed,
      ZOOMED_IN,
      VIEWPORT,
      DEFAULT_SCREEN_SIZES,
    ).length;
    // The hook count is read off the SAME clip pass that built the primitives, so it
    // must match the standalone selector exactly (no recomputed estimate, 教訓 5.29).
    expect(visibleCount).toBe(expected);
    // And it must reflect the CLIPPED set, not the raw committed length: the far
    // feature is excluded (HB-14 count is clip-aware, not a count of all committed).
    expect(visibleCount).toBeLessThan(committed.length);
    expect(visibleCount).toBe(2);
  });

  it('reports 0 for an empty committed set (no spurious count)', () => {
    const { visibleCount } = composeFrameWithCount({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(visibleCount).toBe(0);
  });
});

// S7 出界図 結線: the base-map primitive must be placed at the RESOLVED meta (the loaded
// user map's stored meta, or the preset full-world meta) — no longer hard-coded to the
// preset meta. A fake image source stands in for the decoded bitmap (composeFrame is
// pure; it only forwards the image + meta to a BaseMapPrimitive).
describe('composeFrame base-map meta (S7)', () => {
  const IMG = {} as unknown as CanvasImageSource;

  const baseMapPrim = (prims: readonly DrawPrimitive[]) =>
    prims.find(
      (p): p is Extract<DrawPrimitive, { kind: 'basemap' }> => p.kind === 'basemap',
    );

  it('draws the base image at the SUPPLIED meta (a loaded user map)', () => {
    const meta = { lonWest: -180, lonEast: 180, latNorth: 85, latSouth: -85 };
    const prims = composeFrame({
      baseImage: IMG,
      baseMeta: meta,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    const bm = baseMapPrim(prims);
    expect(bm).toBeDefined();
    expect(bm!.image).toBe(IMG);
    expect({
      lonWest: bm!.lonWest,
      lonEast: bm!.lonEast,
      latNorth: bm!.latNorth,
      latSouth: bm!.latSouth,
    }).toEqual(meta);
  });

  it('falls back to the preset full-world meta when none is supplied', () => {
    const prims = composeFrame({
      baseImage: IMG,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    const bm = baseMapPrim(prims);
    expect(bm).toBeDefined();
    // The preset spans the full 2:1 world (受け入れ基準 2).
    expect(bm!.lonEast - bm!.lonWest).toBe(360);
    expect(bm!.latNorth - bm!.latSouth).toBe(180);
  });

  it('emits NO base-map primitive when there is no image (graticule-only fallback)', () => {
    const prims = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(baseMapPrim(prims)).toBeUndefined();
  });

  it('counts every committed feature when all survive the clip (zoomed out)', () => {
    const committed: EvaluatedFeature[] = [
      point('a', 0, 0),
      point('b', 10, 20),
      point('c', 30, 40),
    ];
    const { visibleCount } = composeFrameWithCount({
      baseImage: null,
      committed,
      overlay: [],
      camera: CAMERA, // zoom 1: whole world visible
      viewport: VIEWPORT,
    });
    expect(visibleCount).toBe(committed.length);
  });
});

// U37 測量レイヤ (FR-14 / FR-15) — the PERSISTENT survey slot in the frame
// composition. The survey lines must NOT ride the single tool-overlay slot
// (drawKnife/lastOverlay — knife/merge/reparent/ring/drill all share it and
// overwrite each other), because FR-15 keeps the confirmed lines visible AFTER
// survey mode is exited and while other tools draw. This pins the layer ORDER
// (base → grid → committed → survey → editHandles → overlay) and the omitted-slot
// pass-through, so a survey line always draws above the map content but never
// covers the edit handles / live tool draft.
describe('composeFrame survey layer (U37 / FR-15 独立スロット)', () => {
  const SURVEY_STROKE = '#15c0b5';
  const surveyPrims: DrawPrimitive[] = [
    {
      kind: 'line',
      points: [
        { lon: 0, lat: 0 },
        { lon: 5, lat: 5 },
      ],
      widthPx: 2,
      stroke: SURVEY_STROKE,
    },
    { kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 5, fill: SURVEY_STROKE },
  ];
  const editHandles: DrawPrimitive[] = [
    {
      kind: 'handle',
      at: { lon: 10, lat: 20 },
      radiusPx: 6,
      fill: '#fff',
      stroke: '#000',
      strokeWidthPx: 1,
      handleKind: 'vertex',
    },
  ];
  const overlay: DrawPrimitive[] = [
    { kind: 'point', at: { lon: 1, lat: 1 }, radiusPx: 4, fill: '#f00' },
  ];

  it('composites survey ABOVE committed and UNDER editHandles + tool overlay', () => {
    const prims = composeFrame({
      baseImage: null,
      committed: [point('pt-1', 10, 20)],
      overlay,
      editHandles,
      survey: surveyPrims,
      camera: CAMERA,
      viewport: VIEWPORT,
    });

    const committedIdx = prims.findIndex(
      (p) => p.kind === 'point' && p.fill === STYLE.fill,
    );
    const surveyIdx = prims.findIndex(
      (p) => p.kind === 'line' && p.stroke === SURVEY_STROKE,
    );
    const handleIdx = prims.findIndex((p) => p.kind === 'handle');
    const overlayIdx = prims.indexOf(overlay[0]!);

    expect(committedIdx).toBeGreaterThanOrEqual(0);
    expect(surveyIdx).toBeGreaterThan(committedIdx);
    expect(handleIdx).toBeGreaterThan(surveyIdx);
    expect(overlayIdx).toBeGreaterThan(handleIdx);
    // Both survey primitives are present verbatim (line + endpoint marker).
    expect(prims).toContain(surveyPrims[0]);
    expect(prims).toContain(surveyPrims[1]);
  });

  it('an OMITTED survey slot is a pass-through (legacy callers unchanged)', () => {
    const prims = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(prims.some((p) => p.kind === 'line' && p.stroke === SURVEY_STROKE)).toBe(
      false,
    );
  });

  it('an EMPTY survey slot draws nothing extra (教訓 5.18: empty is a true frame)', () => {
    const withEmpty = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      survey: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    const without = composeFrame({
      baseImage: null,
      committed: [],
      overlay: [],
      camera: CAMERA,
      viewport: VIEWPORT,
    });
    expect(withEmpty.length).toBe(without.length);
  });
});
