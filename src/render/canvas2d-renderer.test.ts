// Canvas2DMapRenderer tests (U17): FR-17 constant on-screen size, HiDPI backing
// buffer vs. CSS-pixel transform separation, and FR-07 seam wrap-replica passes.
// Uses the recording FakeCanvasSurface (no jsdom).

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport } from './camera';
import { Canvas2DMapRenderer } from './canvas2d-renderer';
import { FakeCanvasSurface } from './fake-canvas';
import type { RenderBatch } from './map-renderer';

const VP: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

function makeRenderer(camera: Camera, viewport: Viewport = VP): {
  r: Canvas2DMapRenderer;
  surface: FakeCanvasSurface;
} {
  const surface = new FakeCanvasSurface();
  const r = new Canvas2DMapRenderer(surface, { camera, viewport });
  return { r, surface };
}

describe('FR-17: point radius is constant on screen across zoom', () => {
  it('keeps the arc radius fixed while the position moves with zoom', () => {
    const batch: RenderBatch = {
      primitives: [{ kind: 'point', at: { lon: 20, lat: 10 }, radiusPx: 6, fill: '#f00' }],
    };

    const a = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    a.r.drawBatch(batch);
    const b = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 16 });
    b.r.drawBatch(batch);

    // Radius identical (screen-fixed); position different (world-transformed).
    expect(a.surface.ctx.arcs[0]!.r).toBe(6);
    expect(b.surface.ctx.arcs[0]!.r).toBe(6);
    expect(a.surface.ctx.arcs[0]!.x).not.toBeCloseTo(b.surface.ctx.arcs[0]!.x, 1);
  });
});

describe('FR-17: line width and label font are constant on screen across zoom', () => {
  it('keeps lineWidth fixed regardless of zoom', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'line',
          points: [
            { lon: -10, lat: 0 },
            { lon: 10, lat: 0 },
          ],
          widthPx: 3,
          stroke: '#000',
        },
      ],
    };
    const a = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 2 });
    a.r.drawBatch(batch);
    const b = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 20 });
    b.r.drawBatch(batch);
    expect(a.surface.ctx.lineWidths).toContain(3);
    expect(b.surface.ctx.lineWidths).toContain(3);
  });

  it('keeps the label font px fixed regardless of zoom', () => {
    const batch: RenderBatch = {
      primitives: [{ kind: 'label', at: { lon: 0, lat: 0 }, text: 'X', fontPx: 14, fill: '#000' }],
    };
    const a = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1 });
    a.r.drawBatch(batch);
    const b = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 30 });
    b.r.drawBatch(batch);
    expect(a.surface.ctx.fonts[0]).toBe('14px sans-serif');
    expect(b.surface.ctx.fonts[0]).toBe('14px sans-serif');
  });
});

describe('HiDPI: backing buffer is physical px; transform is CSS px', () => {
  it('sizes the backing buffer by devicePixelRatio', () => {
    const { surface } = makeRenderer(
      { centerLon: 0, centerLat: 0, zoom: 10 },
      { widthCss: 800, heightCss: 600, devicePixelRatio: 2 },
    );
    expect(surface.width).toBe(1600);
    expect(surface.height).toBe(1200);
  });

  it('gives the SAME CSS-pixel arc position for different dpr (FR-17 device-stable)', () => {
    const batch: RenderBatch = {
      primitives: [{ kind: 'point', at: { lon: 20, lat: -5 }, radiusPx: 4, fill: '#0f0' }],
    };
    const dpr1 = makeRenderer(
      { centerLon: 0, centerLat: 0, zoom: 8 },
      { widthCss: 800, heightCss: 600, devicePixelRatio: 1 },
    );
    const dpr3 = makeRenderer(
      { centerLon: 0, centerLat: 0, zoom: 8 },
      { widthCss: 800, heightCss: 600, devicePixelRatio: 3 },
    );
    dpr1.r.drawBatch(batch);
    dpr3.r.drawBatch(batch);
    // Position and radius are equal in CSS px; the dpr only changed the setTransform
    // scale and the backing-buffer size, not the transform math.
    expect(dpr1.surface.ctx.arcs[0]!.x).toBeCloseTo(dpr3.surface.ctx.arcs[0]!.x, 9);
    expect(dpr1.surface.ctx.arcs[0]!.r).toBe(dpr3.surface.ctx.arcs[0]!.r);
    expect(dpr3.surface.ctx.setTransforms[0]).toEqual([3, 0, 0, 3, 0, 0]);
  });
});

describe('FR-07: seam wrap replicates primitives per turn', () => {
  it('draws one pass when the viewport stays within a single world turn', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 10 });
    r.drawBatch({
      primitives: [{ kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' }],
    });
    expect(surface.ctx.arcs.length).toBe(1);
  });

  it('draws multiple passes when zoomed out across several world turns', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 0.5 });
    // 800/0.5 = 1600° wide ⇒ ~5 turns ⇒ the single point is replicated per turn.
    r.drawBatch({
      primitives: [{ kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' }],
    });
    expect(surface.ctx.arcs.length).toBeGreaterThanOrEqual(4);
  });

  it('clears the surface once per frame regardless of turn count', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 0.5 });
    r.drawBatch({
      primitives: [{ kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' }],
    });
    expect(surface.ctx.clearRects).toBe(1);
  });
});

describe('empty batch (教訓 5.18)', () => {
  it('clears the surface and draws nothing', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 10 });
    r.drawBatch({ primitives: [] });
    expect(surface.ctx.clearRects).toBe(1);
    expect(surface.ctx.arcs.length).toBe(0);
  });
});

describe('FR-21: shape primitive fills holes透過 via even-odd, single fill', () => {
  it('traces outer + hole into one path and fills evenodd once (hole透過)', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 10 });
    r.drawBatch({
      primitives: [
        {
          kind: 'shape',
          pieces: [
            [
              [
                { lon: -5, lat: -5 },
                { lon: 5, lat: -5 },
                { lon: 5, lat: 5 },
                { lon: -5, lat: 5 },
              ],
              [
                { lon: -1, lat: -1 },
                { lon: 1, lat: -1 },
                { lon: 1, lat: 1 },
                { lon: -1, lat: 1 },
              ],
            ],
          ],
          fill: '#3366cc',
          stroke: '#123456',
          strokeWidthPx: 2,
        },
      ],
    });
    // exactly one even-odd fill (hole透過), with the single feature fill color.
    expect(surface.ctx.fills.length).toBe(1);
    expect(surface.ctx.fills[0]).toEqual({ style: '#3366cc', rule: 'evenodd' });
    // two rings closed (outer + hole) in the one path.
    expect(surface.ctx.closePaths).toBe(2);
  });

  it('draws飛び地 pieces with the SAME fill (no per-ring recolor, FR-101)', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 10 });
    r.drawBatch({
      primitives: [
        {
          kind: 'shape',
          pieces: [
            [
              [
                { lon: -10, lat: -2 },
                { lon: -6, lat: -2 },
                { lon: -6, lat: 2 },
                { lon: -10, lat: 2 },
              ],
            ],
            [
              [
                { lon: 6, lat: -2 },
                { lon: 10, lat: -2 },
                { lon: 10, lat: 2 },
                { lon: 6, lat: 2 },
              ],
            ],
          ],
          fill: '#3366cc',
        },
      ],
    });
    // one even-odd fill for the whole feature, single color (飛び地 not recolored).
    expect(surface.ctx.fills.length).toBe(1);
    expect(surface.ctx.fills[0]!.style).toBe('#3366cc');
  });
});

describe('constructor', () => {
  it('throws when the 2D context is unavailable', () => {
    const badSurface = {
      width: 0,
      height: 0,
      getContext: () => null,
    };
    expect(() => new Canvas2DMapRenderer(badSurface)).toThrow(/2D context/);
  });
});
