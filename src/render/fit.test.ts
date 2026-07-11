// Render-layer camera FIT tests (HB5-3): cameraForBounds frames a world bbox.

import { describe, expect, it } from 'vitest';

import type { Viewport } from './camera';
import { cameraForBounds, DEFAULT_FIT_PADDING_RATIO } from './fit';

const vp = (widthCss: number, heightCss: number): Viewport => ({
  widthCss,
  heightCss,
  devicePixelRatio: 1,
});

describe('cameraForBounds (HB5-3 錨起点の視点合わせ)', () => {
  it('centers on the bbox midpoint', () => {
    const cam = cameraForBounds(
      { minLon: -10, maxLon: 10, minLat: -2, maxLat: 6 },
      vp(400, 400),
    );
    expect(cam.centerLon).toBe(0);
    expect(cam.centerLat).toBe(2);
  });

  it('the tighter axis constrains the zoom (padded span fits the viewport)', () => {
    // Lon span 20, lat span 4 → lon is the tighter axis at a square viewport.
    const cam = cameraForBounds(
      { minLon: -10, maxLon: 10, minLat: -2, maxLat: 2 },
      vp(400, 400),
      { paddingRatio: 0.2 },
    );
    // paddedLon = 20 * (1 + 2*0.2) = 28 → zoom = 400 / 28.
    expect(cam.zoom).toBeCloseTo(400 / 28, 6);
    // The whole padded span fits: half-span in screen px ≤ half the viewport.
    const halfSpanPx = 10 * cam.zoom; // 10° each side of center
    expect(halfSpanPx).toBeLessThanOrEqual(200);
  });

  it('padding 0 makes the content exactly fill the tighter axis', () => {
    const cam = cameraForBounds(
      { minLon: -10, maxLon: 10, minLat: -1, maxLat: 1 },
      vp(400, 400),
      { paddingRatio: 0 },
    );
    expect(cam.zoom).toBeCloseTo(400 / 20, 6); // width / lonSpan
  });

  it('more padding yields a smaller (further-out) zoom', () => {
    const bounds = { minLon: -10, maxLon: 10, minLat: -2, maxLat: 2 };
    const tight = cameraForBounds(bounds, vp(400, 400), { paddingRatio: 0.1 });
    const loose = cameraForBounds(bounds, vp(400, 400), { paddingRatio: 0.4 });
    expect(loose.zoom).toBeLessThan(tight.zoom);
  });

  it('a degenerate (point) bbox snaps to the range MAX zoom, centered on the point', () => {
    const cam = cameraForBounds(
      { minLon: 5, maxLon: 5, minLat: 7, maxLat: 7 },
      vp(400, 400),
      { range: { minZoom: 1, maxZoom: 50 } },
    );
    expect(cam.centerLon).toBe(5);
    expect(cam.centerLat).toBe(7);
    expect(cam.zoom).toBe(50); // +∞ raw zoom saturates to max
  });

  it('clamps a whole-world bbox down to the range MIN zoom', () => {
    const cam = cameraForBounds(
      { minLon: -180, maxLon: 180, minLat: -90, maxLat: 90 },
      vp(360, 180),
      { range: { minZoom: 1, maxZoom: 50 } },
    );
    expect(cam.zoom).toBe(1); // padded span forces a sub-1 raw zoom → clamped to min
  });

  it('keeps centerLon CONTINUOUS for an antimeridian-straddling bbox (short-way frame)', () => {
    // A continuous run 170..190 (a feature aligned across the seam) centers at 180,
    // NOT folded to 0. The render layer wraps at draw time.
    const cam = cameraForBounds(
      { minLon: 170, maxLon: 190, minLat: -1, maxLat: 1 },
      vp(400, 400),
    );
    expect(cam.centerLon).toBe(180);
  });

  it('clamps the center latitude into the physical [-90, 90] world', () => {
    const cam = cameraForBounds(
      { minLon: 0, maxLon: 2, minLat: 80, maxLat: 120 },
      vp(400, 400),
    );
    expect(cam.centerLat).toBe(90);
  });

  it('defaults the padding to DEFAULT_FIT_PADDING_RATIO', () => {
    const bounds = { minLon: -10, maxLon: 10, minLat: -2, maxLat: 2 };
    const explicit = cameraForBounds(bounds, vp(400, 400), {
      paddingRatio: DEFAULT_FIT_PADDING_RATIO,
    });
    const defaulted = cameraForBounds(bounds, vp(400, 400));
    expect(defaulted.zoom).toBe(explicit.zoom);
  });

  it('produces a finite-positive zoom for an unmeasured (0×0) viewport', () => {
    const cam = cameraForBounds(
      { minLon: -10, maxLon: 10, minLat: -2, maxLat: 2 },
      vp(0, 0),
      { range: { minZoom: 1, maxZoom: 50 } },
    );
    expect(Number.isFinite(cam.zoom)).toBe(true);
    expect(cam.zoom).toBeGreaterThan(0);
  });
});
