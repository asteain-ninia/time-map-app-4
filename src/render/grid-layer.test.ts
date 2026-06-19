// U18 render grid-layer tests (FR-03 / FR-06 / FR-07 / FR-13 / FR-17, 受け入れ
// 基準 2 / 6 / 7 / 8 / 9 / 10). Pure primitive building + the base-map hit-test
// exclusion + constant-on-screen label font across zoom.

import { describe, expect, it } from 'vitest';

import { GRID_EMPHASIS, longitudeEmphasis } from '../domain/basemap/index';

import type { Camera, Viewport } from './camera';
import { Canvas2DMapRenderer } from './canvas2d-renderer';
import { FakeCanvasSurface } from './fake-canvas';
import {
  DEFAULT_GRID_STYLE,
  buildBaseMapPrimitive,
  buildGridPrimitives,
  viewportLonSpan,
  withOpacity,
} from './grid-layer';
import type { GridLinePrimitive, LabelPrimitive } from './map-renderer';

const viewport: Viewport = { widthCss: 800, heightCss: 400, devicePixelRatio: 1 };
const worldCamera: Camera = { centerLon: 0, centerLat: 0, zoom: 800 / 360 };

const fakeImage = {} as unknown as CanvasImageSource;
const fullWorld = { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 };

function gridlines(prims: readonly { kind: string }[]): GridLinePrimitive[] {
  return prims.filter((p): p is GridLinePrimitive => p.kind === 'gridline');
}
function labels(prims: readonly { kind: string }[]): LabelPrimitive[] {
  return prims.filter((p): p is LabelPrimitive => p.kind === 'label');
}

describe('withOpacity', () => {
  it('folds opacity into an rgba string', () => {
    expect(withOpacity('#888888', 0.5)).toBe('rgba(136, 136, 136, 0.5)');
  });
  it('passes through a non-hex color', () => {
    expect(withOpacity('red', 0.5)).toBe('red');
  });
});

describe('buildBaseMapPrimitive (FR-03 / 受け入れ基準 2)', () => {
  it('places the image at the equirectangular world meta', () => {
    const p = buildBaseMapPrimitive(fakeImage, fullWorld);
    expect(p.kind).toBe('basemap');
    expect(p.lonEast - p.lonWest).toBe(360);
    expect(p.latNorth - p.latSouth).toBe(180);
  });
});

describe('buildGridPrimitives (FR-13)', () => {
  it('returns no primitives when the grid is OFF (受け入れ基準 9)', () => {
    expect(buildGridPrimitives(false, DEFAULT_GRID_STYLE, worldCamera, viewport)).toEqual([]);
  });

  it('draws parallels + meridians + labels at default 10° spacing (受け入れ基準 7)', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    expect(gridlines(prims).length).toBeGreaterThan(0);
    expect(labels(prims).length).toBeGreaterThan(0);
    // The equator label "0°" is present.
    expect(labels(prims).some((l) => l.text === '0°')).toBe(true);
  });

  it('emphasizes equator / prime meridian / antimeridian distinctly (受け入れ基準 8)', () => {
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport);
    const lines = gridlines(prims);
    // An emphasized line uses the emphasis width; a normal one the normal width.
    const widths = new Set(lines.map((l) => l.widthPx));
    expect(widths.has(DEFAULT_GRID_STYLE.lineWidthPx)).toBe(true);
    expect(widths.has(DEFAULT_GRID_STYLE.emphasisLineWidthPx)).toBe(true);
    // The label color and line color of an emphasized meridian share the SAME
    // emphasis判定 (受け入れ基準 8): the prime-meridian label is the emphasis color.
    const primeLabel = labels(prims).find((l) => l.text === '0°' && l.at.lat === 0);
    expect(primeLabel?.fill).toBe(DEFAULT_GRID_STYLE.emphasisColor);
  });

  it('label font px is constant regardless of zoom (受け入れ基準 10 / FR-17)', () => {
    const zoomedIn: Camera = { ...worldCamera, zoom: worldCamera.zoom * 8 };
    const a = labels(buildGridPrimitives(true, DEFAULT_GRID_STYLE, worldCamera, viewport));
    const b = labels(buildGridPrimitives(true, DEFAULT_GRID_STYLE, zoomedIn, viewport));
    expect(a.every((l) => l.fontPx === DEFAULT_GRID_STYLE.labelFontPx)).toBe(true);
    expect(b.every((l) => l.fontPx === DEFAULT_GRID_STYLE.labelFontPx)).toBe(true);
  });

  it('meridian labels are U05-normalized across the seam (受け入れ基準 13)', () => {
    // Center near +180 so the visible continuous span crosses the seam.
    const seamCamera: Camera = { centerLon: 180, centerLat: 0, zoom: 800 / 90 };
    const prims = buildGridPrimitives(true, DEFAULT_GRID_STYLE, seamCamera, viewport);
    const ls = labels(prims).filter((l) => l.at.lat === 0);
    // No meridian label winds past ±180 in TEXT (always a representative value).
    for (const l of ls) {
      const m = /^(\d+)°/.exec(l.text);
      if (m) expect(Number(m[1])).toBeLessThanOrEqual(180);
    }
    // The antimeridian appears and reads "180°".
    expect(ls.some((l) => l.text === '180°')).toBe(true);
  });
});

describe('viewportLonSpan', () => {
  it('full world at the fit zoom', () => {
    const span = viewportLonSpan(worldCamera, viewport);
    expect(span.west).toBeCloseTo(-180, 6);
    expect(span.east).toBeCloseTo(180, 6);
  });
  it('degenerate viewport falls back to the full world', () => {
    const span = viewportLonSpan(worldCamera, { ...viewport, widthCss: 0 });
    expect(span).toEqual({ west: -180, east: 180 });
  });
});

describe('base-map is NOT a hit-test target (FR-06 / 受け入れ基準 6)', () => {
  it('hitTest returns the world point under the cursor regardless of any base-map', () => {
    // The renderer's hitTest goes through the shared transform (screenToWorld) and
    // never consults drawn primitives — so a full-screen base map can never steal
    // the click. Drawing a base map and then hit-testing yields the same world
    // point as the pure transform (重なり層テスト, 教訓 5.14).
    const surface = new FakeCanvasSurface();
    const renderer = new Canvas2DMapRenderer(surface, { camera: worldCamera, viewport });
    renderer.drawBatch({ primitives: [buildBaseMapPrimitive(fakeImage, fullWorld)] });
    const center = renderer.hitTest({ x: 400, y: 200 });
    expect(center.world.lon).toBeCloseTo(0, 6);
    expect(center.world.lat).toBeCloseTo(0, 6);
    // And the base map WAS drawn (so it is a background, not absent).
    expect(surface.ctx.drawImages.length).toBeGreaterThan(0);
  });

  it('emphasis判定 is shared: the drawn antimeridian replica is still emphasized', () => {
    // A meridian enumerated at continuous +180 (the seam) is emphasized; its
    // +1-turn replica at +540 folds to the same antimeridian判定.
    expect(longitudeEmphasis(180)).toBe(GRID_EMPHASIS.Antimeridian);
    expect(longitudeEmphasis(540)).toBe(GRID_EMPHASIS.Antimeridian);
  });
});
