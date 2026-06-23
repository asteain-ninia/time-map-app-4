// U40 pan math — press-origin + screen-move → camera center (受け入れ基準 1 / 4).

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { panCameraTo, type PanReference } from './pan';
import { screenToWorld, type Camera, type Viewport } from '../../render';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };
const BASE: Camera = { centerLon: 10, centerLat: 5, zoom: 4 };

function refAt(origin: { x: number; y: number }, camera = BASE): PanReference {
  return { camera, viewport: VIEWPORT, origin };
}

describe('panCameraTo', () => {
  it('no movement (current === origin) leaves the center unchanged', () => {
    const ref = refAt({ x: 400, y: 300 });
    const next = panCameraTo(ref, { x: 400, y: 300 });
    expect(next.centerLon).toBeCloseTo(BASE.centerLon, 9);
    expect(next.centerLat).toBeCloseTo(BASE.centerLat, 9);
    expect(next.zoom).toBe(BASE.zoom);
  });

  it('dragging right moves the camera center LEFT (content follows pointer)', () => {
    const ref = refAt({ x: 400, y: 300 });
    // Drag +40px right at zoom 4 = +10° world; center moves -10°.
    const next = panCameraTo(ref, { x: 440, y: 300 });
    expect(next.centerLon).toBeCloseTo(BASE.centerLon - 10, 9);
    expect(next.centerLat).toBeCloseTo(BASE.centerLat, 9);
  });

  it('dragging down moves the camera center UP (lat increases)', () => {
    const ref = refAt({ x: 400, y: 300 });
    // Drag +40px down; screen y down = world lat down, so center lat goes UP.
    const next = panCameraTo(ref, { x: 400, y: 340 });
    expect(next.centerLat).toBeCloseTo(BASE.centerLat + 10, 9);
    expect(next.centerLon).toBeCloseTo(BASE.centerLon, 9);
  });

  it('never mutates zoom (pan does not zoom)', () => {
    const ref = refAt({ x: 0, y: 0 });
    expect(panCameraTo(ref, { x: 123, y: 456 }).zoom).toBe(BASE.zoom);
  });

  it('clamps centerLat to +90 for a northward pan past the north pole (REGRESSION bughunt2)', () => {
    // The bug: centerLat = camera.centerLat - dLat was UNCLAMPED. Latitude is NOT
    // periodic (unlike the continuous-scalar centerLon), so a pan dragging far enough
    // toward the pole pushed centerLat beyond +90°, scrolling the whole world
    // off-screen with no recovery gesture. The result must be bounded to [−90, 90].
    // Drag DOWN (origin y=0 → current y=600) at zoom 4 moves the center UP by 150°,
    // so the unclamped center would be 5 + 150 = 155° — far past the pole.
    const ref = refAt({ x: 400, y: 0 });
    const next = panCameraTo(ref, { x: 400, y: 600 });
    expect(next.centerLat).toBe(90);
    expect(next.zoom).toBe(BASE.zoom);
  });

  it('clamps centerLat to -90 for a southward pan past the south pole (REGRESSION bughunt2)', () => {
    // Drag UP (origin y=600 → current y=0) at zoom 4 moves the center DOWN by 150°,
    // so the unclamped center would be 5 - 150 = -145°. Clamp → -90.
    const ref = refAt({ x: 400, y: 600 });
    const next = panCameraTo(ref, { x: 400, y: 0 });
    expect(next.centerLat).toBe(-90);
  });

  it('keeps centerLon a continuous scalar across the ±180° seam (R3)', () => {
    // Start near +175°, drag far enough that the continuous center exceeds +180.
    const camera: Camera = { centerLon: 175, centerLat: 0, zoom: 4 };
    const ref = refAt({ x: 400, y: 300 }, camera);
    // Drag left 80px = -20° world; center moves +20° to 195° — NOT folded.
    const next = panCameraTo(ref, { x: 320, y: 300 });
    expect(next.centerLon).toBeCloseTo(195, 9);
  });

  it('the grabbed world point stays under the pointer (the pan invariant)', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 800, noNaN: true }),
        fc.double({ min: 0, max: 600, noNaN: true }),
        fc.double({ min: -300, max: 300, noNaN: true }),
        fc.double({ min: -300, max: 300, noNaN: true }),
        (ox, oy, dx, dy) => {
          const origin = { x: ox, y: oy };
          const current = { x: ox + dx, y: oy + dy };
          const ref = refAt(origin);
          const next = panCameraTo(ref, current);
          // The world point grabbed at the origin (under the OLD camera) must now
          // sit under `current` (under the NEW camera).
          const grabbed = screenToWorld(origin, BASE, VIEWPORT);
          const nowAtCurrent = screenToWorld(current, next, VIEWPORT);
          expect(nowAtCurrent.lon).toBeCloseTo(grabbed.lon, 6);
          expect(nowAtCurrent.lat).toBeCloseTo(grabbed.lat, 6);
        },
      ),
    );
  });

  it('is computed against the PRESS reference (no accumulation across moves)', () => {
    const ref = refAt({ x: 400, y: 300 });
    // Two independent computations from the same reference are deterministic and
    // do not drift — the second is not relative to the first.
    const a = panCameraTo(ref, { x: 500, y: 300 });
    const b = panCameraTo(ref, { x: 500, y: 300 });
    expect(a.centerLon).toBe(b.centerLon);
    expect(a.centerLat).toBe(b.centerLat);
  });
});
