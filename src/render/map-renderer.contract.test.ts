// MapRenderer contract — BOTH-SIDES test (U17, 開発ガイド §5.33 / 受け入れ基準 5).
//
// The same contract suite runs against TWO implementations: the default
// `Canvas2DMapRenderer` and a minimal NON-Canvas mock renderer. If a caller can
// drive either through the `MapRenderer` interface with identical observable
// results, the WebGL退避路 (R1) is structurally credible: swapping the backend
// needs no caller change. The transform results MUST agree between backends
// because both delegate to the same pure VTransform.

import { describe, expect, it } from 'vitest';

import type { Camera, Viewport, ZoomRange } from './camera';
import { Canvas2DMapRenderer } from './canvas2d-renderer';
import { FakeCanvasSurface } from './fake-canvas';
import type { HitTestResult, MapRenderer } from './map-renderer';
import type { ScreenPoint, WorldPoint } from './vtransform';
import { initialCamera, screenToWorld, worldToScreen, zoomStepAtCursor } from './vtransform';
import { clampZoom, DEFAULT_ZOOM_RANGE } from './camera';

const VP: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 2 };

// A second, deliberately non-Canvas backend that satisfies the SAME contract by
// reusing the pure VTransform. It records nothing visual — it proves the contract
// is renderer-independent (a caller cannot tell which backend it holds for the
// transform / hit-test / camera methods).
class MockMapRenderer implements MapRenderer {
  private camera: Camera;
  private viewport: Viewport;
  private zoomRange: ZoomRange = DEFAULT_ZOOM_RANGE;
  drawnFrames = 0;

  constructor(camera: Camera, viewport: Viewport) {
    this.camera = camera;
    this.viewport = viewport;
  }
  setCamera(c: Camera): void {
    this.camera = c;
  }
  getCamera(): Camera {
    return this.camera;
  }
  setViewport(v: Viewport): void {
    this.viewport = v;
  }
  getViewport(): Viewport {
    return this.viewport;
  }
  setZoomRange(r: ZoomRange): void {
    this.zoomRange = r;
  }
  worldToScreen(world: WorldPoint): ScreenPoint {
    return worldToScreen(world, this.camera, this.viewport);
  }
  screenToWorld(screen: ScreenPoint): WorldPoint {
    return screenToWorld(screen, this.camera, this.viewport);
  }
  drawBatch(): void {
    this.drawnFrames += 1;
  }
  hitTest(screen: ScreenPoint): HitTestResult {
    return { world: this.screenToWorld(screen) };
  }
  cameraForWheelZoom(cursor: ScreenPoint, factor: number): Camera {
    return zoomStepAtCursor(this.camera, this.viewport, cursor, factor, this.zoomRange);
  }
}

function makeBackends(camera: Camera, viewport: Viewport): { name: string; r: MapRenderer }[] {
  const surface = new FakeCanvasSurface();
  return [
    { name: 'Canvas2DMapRenderer', r: new Canvas2DMapRenderer(surface, { camera, viewport }) },
    { name: 'MockMapRenderer', r: new MockMapRenderer(camera, viewport) },
  ];
}

const CAM: Camera = { centerLon: 30, centerLat: 10, zoom: 4 };

describe('MapRenderer contract (both-sides)', () => {
  for (const { name, r } of makeBackends(CAM, VP)) {
    describe(name, () => {
      it('reflects the camera set on it', () => {
        r.setCamera(CAM);
        expect(r.getCamera()).toEqual(CAM);
      });

      it('reflects the viewport set on it', () => {
        r.setViewport(VP);
        expect(r.getViewport()).toEqual(VP);
      });

      it('worldToScreen / screenToWorld are mutual inverses (教訓 5.29)', () => {
        r.setCamera(CAM);
        r.setViewport(VP);
        const w = { lon: 42.5, lat: -7.25 };
        const back = r.screenToWorld(r.worldToScreen(w));
        expect(back.lon).toBeCloseTo(w.lon, 8);
        expect(back.lat).toBeCloseTo(w.lat, 8);
      });

      it('hitTest returns the world point under a screen position', () => {
        r.setCamera(CAM);
        r.setViewport(VP);
        const screen = { x: 123, y: 456 };
        expect(r.hitTest(screen).world).toEqual(r.screenToWorld(screen));
      });

      it('cameraForWheelZoom clamps and keeps the cursor world point fixed', () => {
        r.setCamera(CAM);
        r.setViewport(VP);
        r.setZoomRange(DEFAULT_ZOOM_RANGE);
        const cursor = { x: 600, y: 150 };
        const before = r.screenToWorld(cursor);
        const next = r.cameraForWheelZoom(cursor, 2);
        expect(next.zoom).toBe(clampZoom(CAM.zoom * 2, DEFAULT_ZOOM_RANGE));
        const after = worldToScreen(before, next, VP);
        expect(after.x).toBeCloseTo(cursor.x, 6);
        expect(after.y).toBeCloseTo(cursor.y, 6);
      });

      it('drawBatch accepts an empty frame without error (教訓 5.18)', () => {
        r.setCamera(CAM);
        r.setViewport(VP);
        expect(() => r.drawBatch({ primitives: [] })).not.toThrow();
      });
    });
  }

  it('both backends produce IDENTICAL transform results (R1 swap-safety)', () => {
    const [a, b] = makeBackends(CAM, VP);
    const ra = a!.r;
    const rb = b!.r;
    ra.setCamera(CAM);
    rb.setCamera(CAM);
    ra.setViewport(VP);
    rb.setViewport(VP);
    const samples: WorldPoint[] = [
      { lon: 0, lat: 0 },
      { lon: 179.5, lat: 80 },
      { lon: -200, lat: -45 },
    ];
    for (const w of samples) {
      expect(ra.worldToScreen(w)).toEqual(rb.worldToScreen(w));
    }
    const screens: ScreenPoint[] = [
      { x: 0, y: 0 },
      { x: 400, y: 300 },
      { x: 799, y: 599 },
    ];
    for (const s of screens) {
      expect(ra.screenToWorld(s)).toEqual(rb.screenToWorld(s));
      expect(ra.cameraForWheelZoom(s, 1.3)).toEqual(rb.cameraForWheelZoom(s, 1.3));
    }
  });
});

describe('MapRenderer initial camera (FR-11 via the contract)', () => {
  it('a renderer built without a camera fits the whole world', () => {
    const surface = new FakeCanvasSurface();
    const r = new Canvas2DMapRenderer(surface, { viewport: VP });
    expect(r.getCamera()).toEqual(initialCamera(VP));
  });
});
