// Canvas2DMapRenderer tests (U17): FR-17 constant on-screen size, HiDPI backing
// buffer vs. CSS-pixel transform separation, and FR-07 seam wrap-replica passes.
// Uses the recording FakeCanvasSurface (no jsdom).

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport } from './camera';
import { Canvas2DMapRenderer, MAX_LABEL_WIDTH_PX } from './canvas2d-renderer';
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

  it('caps label width with maxWidth on both the halo stroke and the fill text', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'label',
          at: { lon: 0, lat: 0 },
          text: '非常に長い地物名前前前前前前前前前前前前前前前前前前前前前前前前前前前前前',
          fontPx: 14,
          fill: '#000',
          halo: '#fff',
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1 });
    r.drawBatch(batch);
    // The overprint guard (maxWidth) is passed to BOTH the halo stroke and the fill.
    expect(surface.ctx.strokeTexts[0]!.maxWidth).toBe(MAX_LABEL_WIDTH_PX);
    expect(surface.ctx.fillTexts[0]!.maxWidth).toBe(MAX_LABEL_WIDTH_PX);
  });
});

// FR-82 点線アウトライン — the `dashPx` channel on a LinePrimitive. Optional by design
// (省略時 = 現挙動): every pre-existing line must keep stroking SOLID, and a dashed line
// must not leak its pattern into the next stroke of the same frame (状態復元作法 — the
// same discipline as the label lineJoin / textAlign restores).
describe('FR-82: LinePrimitive.dashPx (点線アウトライン)', () => {
  const seg = (dashPx?: readonly number[]) => ({
    kind: 'line' as const,
    points: [
      { lon: -10, lat: 0 },
      { lon: 10, lat: 0 },
    ],
    widthPx: 2,
    stroke: '#00e5ff',
    ...(dashPx === undefined ? {} : { dashPx }),
  });

  it('omitting dashPx strokes SOLID and never touches the dash state (既定は無変化)', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    r.drawBatch({ primitives: [seg()] });
    expect(surface.ctx.strokes).toHaveLength(1);
    expect(surface.ctx.strokeDashes[0]).toEqual([]);
    expect(surface.ctx.setLineDashes).toEqual([]);
  });

  it('dashPx is in force for that line stroke', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    r.drawBatch({ primitives: [seg([6, 4])] });
    expect(surface.ctx.strokeDashes[0]).toEqual([6, 4]);
  });

  it('the dash is RESTORED afterwards: a later solid line in the SAME frame is solid', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    r.drawBatch({ primitives: [seg([6, 4]), seg()] });
    expect(surface.ctx.strokeDashes[0]).toEqual([6, 4]);
    expect(surface.ctx.strokeDashes[1]).toEqual([]);
    expect(surface.ctx.getLineDash()).toEqual([]);
  });

  it('a polygon/shape stroke after a dashed line is NOT dashed (leak guard)', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    r.drawBatch({
      primitives: [
        seg([6, 4]),
        {
          kind: 'polygon',
          ring: [
            { lon: 0, lat: 0 },
            { lon: 5, lat: 0 },
            { lon: 5, lat: 5 },
          ],
          fill: '#123456',
          stroke: '#000',
          strokeWidthPx: 1,
        },
      ],
    });
    expect(surface.ctx.strokeDashes[0]).toEqual([6, 4]);
    expect(surface.ctx.strokeDashes[1]).toEqual([]);
  });

  it('the dash is applied to EVERY seam replica of a wrapped dashed line (FR-07)', () => {
    // A wide zoom-out draws the primitive once per ±360° turn; each replica must be
    // dashed (a restore placed at the wrong level would leave replicas 2..n solid).
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 0.5 });
    r.drawBatch({ primitives: [seg([6, 4])] });
    expect(surface.ctx.strokes.length).toBeGreaterThan(1);
    for (const d of surface.ctx.strokeDashes) expect(d).toEqual([6, 4]);
  });
});

describe('V1 判読性: label offsetPx / align / baseline', () => {
  it('defaults to the canvas defaults so existing (feature) labels are unaffected', () => {
    const batch: RenderBatch = {
      primitives: [
        // wrap:false ⇒ exactly one pass, so index 0 is the identity-turn draw.
        {
          kind: 'label',
          at: { lon: 0, lat: 0 },
          text: 'X',
          fontPx: 12,
          fill: '#000',
          wrap: false,
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1 });
    r.drawBatch(batch);
    // No offset ⇒ drawn exactly at the projected anchor (viewport centre).
    expect(surface.ctx.fillTexts[0]!.x).toBeCloseTo(400, 6);
    expect(surface.ctx.fillTexts[0]!.y).toBeCloseTo(300, 6);
    expect(surface.ctx.textAligns[0]).toBe('left');
    expect(surface.ctx.textBaselines[0]).toBe('alphabetic');
  });

  it('applies the screen-space offset and the declared alignment', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'label',
          at: { lon: 0, lat: 0 },
          text: '0°',
          fontPx: 11,
          fill: '#000',
          halo: '#fff',
          offsetPx: { x: 6, y: -4 },
          align: 'center',
          baseline: 'middle',
          wrap: false,
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1 });
    r.drawBatch(batch);
    expect(surface.ctx.fillTexts[0]!.x).toBeCloseTo(406, 6);
    expect(surface.ctx.fillTexts[0]!.y).toBeCloseTo(296, 6);
    // The halo stroke uses the SAME offset placement as the fill (they must overlap).
    expect(surface.ctx.strokeTexts[0]!.x).toBeCloseTo(406, 6);
    expect(surface.ctx.strokeTexts[0]!.y).toBeCloseTo(296, 6);
    expect(surface.ctx.textAligns[0]).toBe('center');
    expect(surface.ctx.textBaselines[0]).toBe('middle');
  });

  it('restores the canvas text defaults after drawing (no leak into later draws)', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'label',
          at: { lon: 0, lat: 0 },
          text: 'A',
          fontPx: 11,
          fill: '#000',
          align: 'center',
          baseline: 'top',
          wrap: false,
        },
        {
          kind: 'label',
          at: { lon: 0, lat: 0 },
          text: 'B',
          fontPx: 11,
          fill: '#000',
          wrap: false,
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1 });
    r.drawBatch(batch);
    expect(surface.ctx.textAligns[1]).toBe('left');
    expect(surface.ctx.textBaselines[1]).toBe('alphabetic');
    // …and the context itself is left at the defaults for whatever draws next.
    expect(surface.ctx.textAlign).toBe('left');
    expect(surface.ctx.textBaseline).toBe('alphabetic');
  });
});

describe('HB3-9 / FR-17: edit handle markers draw at constant on-screen size', () => {
  it('keeps the vertex-handle disc radius fixed while the position moves with zoom', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'handle',
          at: { lon: 10, lat: 5 },
          radiusPx: 5,
          fill: '#fff',
          stroke: '#0a66c2',
          strokeWidthPx: 1.5,
          handleKind: 'vertex',
        },
      ],
    };
    const a = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    a.r.drawBatch(batch);
    const b = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 16 });
    b.r.drawBatch(batch);
    // Disc radius is screen-fixed; the projected position moves with zoom.
    expect(a.surface.ctx.arcs[0]!.r).toBe(5);
    expect(b.surface.ctx.arcs[0]!.r).toBe(5);
    expect(a.surface.ctx.arcs[0]!.x).not.toBeCloseTo(b.surface.ctx.arcs[0]!.x, 1);
    // It is stroked (outlined) at the screen-fixed width.
    expect(a.surface.ctx.lineWidths).toContain(1.5);
  });

  it('draws an edge-midpoint handle as a screen-fixed square (rect), not a disc', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'handle',
          at: { lon: 0, lat: 0 },
          radiusPx: 3.5,
          fill: '#bde3ff',
          stroke: '#0a66c2',
          strokeWidthPx: 1.5,
          handleKind: 'edge',
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 8 });
    r.drawBatch(batch);
    expect(surface.ctx.rects).toHaveLength(1);
    expect(surface.ctx.rects[0]!.w).toBe(7); // 2 * radiusPx, screen-fixed
    expect(surface.ctx.arcs).toHaveLength(0); // an edge handle is a square, not a disc
  });

  it('strokes the FR-82 selection RING outside the disc at a screen-fixed radius', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'handle',
          at: { lon: 10, lat: 5 },
          radiusPx: 5,
          fill: '#ffd54a',
          stroke: '#0a66c2',
          strokeWidthPx: 1.5,
          handleKind: 'vertex',
          ring: { radiusPx: 8, stroke: '#00e5ff', widthPx: 2 },
        },
      ],
    };
    const a = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    a.r.drawBatch(batch);
    const b = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 16 });
    b.r.drawBatch(batch);
    // Two arcs per ringed handle: the disc (r=5) then the ring (r=8), both screen-fixed.
    expect(a.surface.ctx.arcs.map((arc) => arc.r)).toEqual([5, 8]);
    expect(b.surface.ctx.arcs.map((arc) => arc.r)).toEqual([5, 8]);
    // The ring is concentric with the disc (same projected centre).
    expect(a.surface.ctx.arcs[1]!.x).toBe(a.surface.ctx.arcs[0]!.x);
    expect(a.surface.ctx.arcs[1]!.y).toBe(a.surface.ctx.arcs[0]!.y);
    // …and stroked in the ring's own colour/width (composed OVER the fill, not replacing).
    expect(a.surface.ctx.strokes).toContain('#00e5ff');
    expect(a.surface.ctx.lineWidths).toContain(2);
  });

  it('draws no ring arc when the handle carries no selection ring', () => {
    const batch: RenderBatch = {
      primitives: [
        {
          kind: 'handle',
          at: { lon: 10, lat: 5 },
          radiusPx: 5,
          fill: '#fff',
          stroke: '#0a66c2',
          strokeWidthPx: 1.5,
          handleKind: 'vertex',
        },
      ],
    };
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 4 });
    r.drawBatch(batch);
    expect(surface.ctx.arcs).toHaveLength(1);
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

  it('does NOT re-tile a wrap:false gridline across turns (Codex high #2)', () => {
    // Zoomed out across several turns: a wrapping point replicates, but a wrap:false
    // gridline (already continuous-tiled by grid-layer) is drawn exactly ONCE — so
    // its translucent stroke is not painted N× over the same pixels (no alpha
    // compounding) and the path work stays O(turns), not O(turns²).
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 0.5 });
    r.drawBatch({
      primitives: [
        { kind: 'point', at: { lon: 0, lat: 0 }, radiusPx: 3, fill: '#000' },
        {
          kind: 'gridline',
          points: [
            { lon: -180, lat: 0 },
            { lon: 180, lat: 0 },
          ],
          widthPx: 1,
          stroke: 'rgba(0,0,0,0.5)',
          wrap: false,
        },
      ],
    });
    const turns = surface.ctx.arcs.length; // == number of replicated point passes
    expect(turns).toBeGreaterThanOrEqual(4);
    // The gridline stroke is issued once total, NOT once per turn.
    expect(surface.ctx.strokes.length).toBe(1);
  });

  it('HB-14: draws a CONTINUOUS-longitude point ON SCREEN when zoomed in (no vanish)', () => {
    // The recurring classic: a feature carries a continuous-scalar longitude (U03
    // never folds; committed-features passes it verbatim). A point at lon=360 with the
    // camera centred at lon=0 must paint at screen centre (its −1 turn replica lands
    // there). The old base-[-180,180) turn list collapsed to [0] at this zoom and drew
    // the point at x=4000 (off-screen) ⇒ it disappeared. Per-primitive turns fix it.
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 10 });
    r.drawBatch({
      primitives: [{ kind: 'point', at: { lon: 360, lat: 0 }, radiusPx: 3, fill: '#000' }],
    });
    // At least one drawn arc lands inside the 800×600 viewport (the −1 turn replica).
    const onScreen = surface.ctx.arcs.filter(
      (a) => a.x >= 0 && a.x <= VP.widthCss && a.y >= 0 && a.y <= VP.heightCss,
    );
    expect(onScreen.length).toBeGreaterThanOrEqual(1);
    expect(onScreen[0]!.x).toBeCloseTo(VP.widthCss / 2, 5);
  });

  it('HB-14: draws a seam-crossing line (continuous lon∈[179,181]) when zoomed in near +180', () => {
    // An antimeridian-crossing line whose vertices are unwrapped to a continuous run
    // [179, 181] (lat 0). Camera centred at lon=180, zoomed in. The renderer must
    // trace the segment across the viewport centre — it must NOT be skipped because
    // its longitudes lie outside [-180,180).
    const { r, surface } = makeRenderer({ centerLon: 180, centerLat: 0, zoom: 50 });
    r.drawBatch({
      primitives: [
        {
          kind: 'line',
          points: [
            { lon: 179, lat: 0 },
            { lon: 181, lat: 0 },
          ],
          widthPx: 2,
          stroke: '#000',
        },
      ],
    });
    // The polyline was traced (moveTo+lineTo) and stroked at least once on screen.
    expect(surface.ctx.strokes.length).toBeGreaterThanOrEqual(1);
    const onScreenMoves = surface.ctx.moveTos.filter(
      (m) => m.x >= -100 && m.x <= VP.widthCss + 100,
    );
    expect(onScreenMoves.length).toBeGreaterThanOrEqual(1);
  });

  it('still tiles a gridline WITHOUT wrap:false (default wraps)', () => {
    const { r, surface } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 0.5 });
    r.drawBatch({
      primitives: [
        {
          kind: 'gridline',
          points: [
            { lon: -180, lat: 0 },
            { lon: 180, lat: 0 },
          ],
          widthPx: 1,
          stroke: '#000',
        },
      ],
    });
    expect(surface.ctx.strokes.length).toBeGreaterThanOrEqual(4);
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

describe('wheel zoom range honors the fit-all floor (Codex medium #6)', () => {
  it('a first zoom-OUT from a sub-1 fit zoom does NOT clamp UP (no inversion)', () => {
    // Small/short viewport: fitWorldZoom = min(300/360, 100/180) = 100/180 ≈ 0.556,
    // which is BELOW the configured min (1). The OLD clamp (min 1) would push a
    // first zoom-OUT UP to 1 — i.e. zoom IN, an inversion. The effective floor is now
    // the fit zoom, so zoom-out from the fit-zoomed initial state stays AT the floor
    // (it cannot go below fit-all), and crucially never jumps up to 1.
    const small: Viewport = { widthCss: 300, heightCss: 100, devicePixelRatio: 1 };
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, { viewport: small });
    const before = r.getCamera().zoom;
    expect(before).toBeLessThan(1); // fit zoom is sub-1 for this viewport
    const next = r.cameraForWheelZoom({ x: 150, y: 50 }, 1 / 1.1); // zoom out
    expect(next.zoom).toBeLessThanOrEqual(before); // never inverts to a zoom-IN
    expect(next.zoom).toBeLessThan(1);
  });

  it('a zoom-IN from a sub-1 fit zoom still increases (toward the configured max)', () => {
    const small: Viewport = { widthCss: 300, heightCss: 100, devicePixelRatio: 1 };
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, { viewport: small });
    const before = r.getCamera().zoom;
    const next = r.cameraForWheelZoom({ x: 150, y: 50 }, 1.1); // zoom in
    expect(next.zoom).toBeGreaterThan(before);
  });

  it('still clamps to the configured min for a normal viewport', () => {
    // A large viewport's fit zoom exceeds the configured min, so the floor is the
    // configured min (1): zooming out far enough pins at 1, never below.
    const { r } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 1.05 });
    const next = r.cameraForWheelZoom({ x: 400, y: 300 }, 1 / 2);
    expect(next.zoom).toBe(1);
  });
});

describe('setZoomRange re-clamps the LIVE camera (FR-10 / FR-109 即時反映 — bughunt regression)', () => {
  // ROOT CAUSE the fix closes: setZoomRange only stored `this.zoomRange` and never
  // re-clamped the current camera. So after zooming to 50× then lowering the max to
  // 10× in settings, the renderer kept drawing at 50× until the NEXT wheel notch
  // finally clamped it — a settings change that did not take effect at once
  // (FR-10 / FR-109 即時反映 違反). setZoomRange now re-clamps the live camera zoom
  // into the new effective range so the very next paint shows the bounded zoom.
  it('lowers the current zoom to the new max when the live zoom exceeds it', () => {
    const { r } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 50 });
    r.setZoomRange({ minZoom: 1, maxZoom: 10 });
    expect(r.getCamera().zoom).toBe(10);
    // The center is untouched — only the zoom is clamped.
    expect(r.getCamera().centerLon).toBe(0);
    expect(r.getCamera().centerLat).toBe(0);
  });

  it('raises the current zoom to the new min when the live zoom is below it', () => {
    // A large viewport so the fit-all floor (min(w/360,h/180)=2) does NOT swallow the
    // configured min: with fit (2) < configured min (5) the effective floor is fit,
    // which would mask the configured min — pick a viewport whose fit floor is below
    // the configured min so the configured min is the effective floor. Here fit =
    // min(1800/360, 900/180) = 5, so the effective floor IS the configured min (5).
    const big: Viewport = { widthCss: 1800, heightCss: 900, devicePixelRatio: 1 };
    const { r } = makeRenderer({ centerLon: 0, centerLat: 0, zoom: 2 }, big);
    r.setZoomRange({ minZoom: 5, maxZoom: 50 });
    // fit = min(1800/360, 900/180) = 5 ≥ configured min (5), so the effective floor IS
    // the configured min — the live zoom (2) is re-clamped up to it.
    expect(r.effectiveZoomRange().minZoom).toBe(5);
    expect(r.getCamera().zoom).toBe(5);
  });

  it('leaves the camera identity untouched when the live zoom is already in range (no-op)', () => {
    const cam: Camera = { centerLon: 7, centerLat: -3, zoom: 8 };
    const { r } = makeRenderer(cam);
    const before = r.getCamera();
    r.setZoomRange({ minZoom: 1, maxZoom: 50 });
    // Stable identity so the host's getCamera() diff stays a no-op (no spurious
    // repaint / onCameraChange notify for an in-range range update).
    expect(r.getCamera()).toBe(before);
    expect(r.getCamera().zoom).toBe(8);
  });

  it('clamps to the fit-all floor, not the configured min, on a sub-1 fit viewport', () => {
    // The effective floor is the fit-all zoom when it is below the configured min, so
    // re-clamping must use effectiveZoomRange() (the SAME range wheel-zoom obeys),
    // never landing on a zoom the wheel path could not reach.
    const small: Viewport = { widthCss: 300, heightCss: 100, devicePixelRatio: 1 };
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, {
      camera: { centerLon: 0, centerLat: 0, zoom: 0.1 },
      viewport: small,
    });
    const floor = r.effectiveZoomRange().minZoom;
    expect(floor).toBeLessThan(1); // fit-all floor for this small viewport
    r.setZoomRange({ minZoom: 1, maxZoom: 50 });
    expect(r.getCamera().zoom).toBe(floor);
  });
});

describe('setViewport re-clamps the LIVE camera into the new fit floor (第7波 setviewport-reclamp)', () => {
  // ROOT CAUSE the fix closes: setViewport only stored the viewport + re-sized the
  // backing buffer and never re-clamped the camera. On a SMALL viewport whose fit-all
  // zoom is sub-1, the effective floor drops to that sub-1 fit, so a max zoom-out parks
  // the camera BELOW the configured min (1). Enlarging the window raises the fit ABOVE
  // the configured min, so the effective floor snaps back UP to the configured min (1)
  // while the camera is still parked below it — stranded BELOW effectiveZoomRange().
  // minZoom. The next wheel zoom-OUT then clamps UP to that floor — i.e. zooms IN, an
  // inversion. setViewport now re-clamps the live camera zoom into the new effective
  // range so the camera never sits below the floor.
  it('raises a stranded sub-floor zoom up to the enlarged viewport fit floor', () => {
    const small: Viewport = { widthCss: 300, heightCss: 100, devicePixelRatio: 1 };
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, { viewport: small });
    // Fit-zoomed initial camera sits AT the sub-1 fit floor of the small viewport.
    const stranded = r.getCamera().zoom;
    expect(stranded).toBeLessThan(1);
    const big: Viewport = { widthCss: 1800, heightCss: 900, devicePixelRatio: 1 };
    r.setViewport(big);
    // The enlarged viewport's fit (min(1800/360, 900/180) = 5) exceeds the configured
    // min, so the effective floor snaps back to the configured min (1). The parked zoom
    // is below it, so the camera is re-clamped up to the floor — never left below it.
    const floor = r.effectiveZoomRange().minZoom;
    expect(floor).toBe(1);
    expect(r.getCamera().zoom).toBeGreaterThanOrEqual(floor);
    expect(r.getCamera().zoom).toBe(floor);
  });

  it('a first zoom-OUT after the resize does NOT invert (increase) the zoom', () => {
    const small: Viewport = { widthCss: 300, heightCss: 100, devicePixelRatio: 1 };
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, { viewport: small });
    const big: Viewport = { widthCss: 1800, heightCss: 900, devicePixelRatio: 1 };
    r.setViewport(big);
    const afterResize = r.getCamera().zoom;
    // The very next wheel zoom-OUT must not clamp UP: with the camera already re-clamped
    // to the floor, one notch out stays at the floor and never increases (no inversion).
    const next = r.cameraForWheelZoom({ x: 900, y: 450 }, 1 / 1.1);
    expect(next.zoom).toBeLessThanOrEqual(afterResize);
  });

  it('leaves the camera identity untouched when the live zoom is already in range (no-op)', () => {
    // A resize that keeps the fit floor at/below the live zoom must not re-assign the
    // camera, so the host's getCamera() diff stays a no-op (no spurious notify/repaint).
    const cam: Camera = { centerLon: 7, centerLat: -3, zoom: 8 };
    const { r } = makeRenderer(cam);
    const before = r.getCamera();
    // Resize to a smaller-but-still-fit-below-8 viewport (fit = min(1200/360, 600/180) =
    // 3.33 ≤ 8), so the live zoom stays in range and the camera identity is preserved.
    r.setViewport({ widthCss: 1200, heightCss: 600, devicePixelRatio: 1 });
    expect(r.getCamera()).toBe(before);
    expect(r.getCamera().zoom).toBe(8);
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
