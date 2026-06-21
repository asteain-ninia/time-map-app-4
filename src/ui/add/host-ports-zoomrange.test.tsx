// REGRESSION (bughunt: ズーム上限/下限の設定変更が現在のカメラ zoom を再クランプしない).
//
// ROOT CAUSE the fix closes: a zoomMax/zoomMin settings change reached the host's
// setZoomRange (supplyZoomRange → ports.setZoomRange), but the host only forwarded
// it to the renderer, which merely stored the new range without re-clamping the LIVE
// camera. So after zooming to 50× and lowering the max to 10× in settings, the map
// kept rendering at 50× until the NEXT wheel notch finally clamped it — the settings
// change did not take effect at once (FR-10 / FR-109 即時反映 違反), and the U16 store
// zoom truth (mirrored via onCameraChange) stayed at the stale 50×.
//
// The fix: the renderer re-clamps its live camera inside setZoomRange, and the host
// detects that re-clamp (getCamera diff) to RE-PAINT and fire onCameraChange — the
// SAME single store-mirror path the wheel/pan use. This test drives the REAL
// createAddHostPorts (with a stubbed 2D context, since jsdom has none) and asserts
// that lowering the max below the live zoom both repaints AND notifies with the
// bounded zoom, while an in-range range update stays a silent no-op.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeContext2D } from '../../render/fake-canvas';
import type { Camera } from '../../render/camera';

import { createAddHostPorts } from './host-ports';

// jsdom provides no real 2D context — stub getContext to a recording FakeContext2D
// so the renderer constructs, and give the canvas a measured box so the camera is a
// well-defined fit-all (not the unmeasured 0×0 degenerate camera).
function stubCanvas(): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => new FakeContext2D() as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () =>
      ({
        x: 0,
        y: 0,
        left: 0,
        top: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAddHostPorts.setZoomRange re-clamps + reflects at once (FR-10 / FR-109)', () => {
  it('repaints and fires onCameraChange with the bounded zoom when the live zoom exceeds the new max', () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const cameras: Camera[] = [];
    const ports = createAddHostPorts(mount, {
      onCameraChange: (c) => cameras.push(c),
    });

    // Drive the live camera up to 50× through the renderer-backed write path, then
    // forget the initial-paint / write notifications so we observe only the effect of
    // the settings change below.
    const base = ports.readCamera().camera;
    ports.writeCamera({ ...base, zoom: 50 });
    expect(ports.readCamera().camera.zoom).toBe(50);
    cameras.length = 0;

    // Lower the max to 10× (the FR-10 即時反映 contract): the live 50× must drop to 10×
    // NOW, not on the next wheel notch.
    ports.setZoomRange({ minZoom: 1, maxZoom: 10 });

    expect(ports.readCamera().camera.zoom).toBe(10);
    // The store mirror / observation hooks are notified through the single
    // onCameraChange path with the bounded zoom.
    expect(cameras).toHaveLength(1);
    expect(cameras[0]!.zoom).toBe(10);

    ports.dispose();
    mount.remove();
  });

  it('does NOT repaint or notify for an in-range range update (no-op)', () => {
    stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const cameras: Camera[] = [];
    const ports = createAddHostPorts(mount, {
      onCameraChange: (c) => cameras.push(c),
    });

    const base = ports.readCamera().camera;
    ports.writeCamera({ ...base, zoom: 8 });
    cameras.length = 0;

    // 8× is inside [1, 50] → the live camera is untouched, so no spurious notify.
    ports.setZoomRange({ minZoom: 1, maxZoom: 50 });

    expect(ports.readCamera().camera.zoom).toBe(8);
    expect(cameras).toHaveLength(0);

    ports.dispose();
    mount.remove();
  });
});
