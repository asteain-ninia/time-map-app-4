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

import { composeFrame } from './host-ports';

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
