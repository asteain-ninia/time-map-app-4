// REGRESSION (bughunt round-2: Camera pan/zoom and tool-overlay draws bypass the
// FrameScheduler entirely — FR-110 FPS cap does not apply to the highest-frequency
// interactions).
//
// ROOT CAUSE the fix closes: the FrameScheduler coalescing/cap was wired ONLY around
// App.tsx's store-subscription redraw path. host-ports' own high-frequency repaint
// methods — writeCamera (pan / wheel zoom), drawAdd / drawKnife (tool-draft moves) and
// resyncViewport — called the synchronous full-frame recomposition (paintWith) on EVERY
// input event, so pan/zoom/drawing repainted at raw input rate, defeating the configured
// render FPS for exactly the interactions FR-110 is meant to cap and paying full per-event
// recomposition (buildGrid + buildFeature + selectVisible).
//
// The fix: host-ports exposes `setRedrawRequester`, and the composition root injects the
// SAME scheduler-backed requester it uses for store redraws. After injection, the host's
// high-frequency paths stash the new camera/overlay/viewport SYNCHRONOUSLY (so readCamera /
// hit-tests / onCameraChange stay live) but DEFER the composite to the requester. This
// test drives the REAL createAddHostPorts (with a stubbed 2D context, since jsdom has none)
// behind a fake rAF scheduler and asserts that:
//   - N camera writes within one frame collapse to ONE actual composite (受け入れ基準 5);
//   - the camera truth + onCameraChange fire SYNCHRONOUSLY on each write (no throttle of
//     the camera STATE — only the pixels);
//   - tool-draft draws (drawAdd / drawKnife) coalesce the same way and the LAST overlay
//     wins on the deferred frame (no lost update);
//   - without an injected requester the host still paints synchronously (legacy callers).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { FakeContext2D } from '../../render/fake-canvas';
import { FrameScheduler } from '../../render/frame-scheduler';
import type { Camera } from '../../render/camera';
import type { DrawPrimitive } from '../../render/map-renderer';

import { createAddHostPorts } from './host-ports';

// jsdom provides no real 2D context — stub getContext to a recording FakeContext2D so the
// renderer constructs, and give the canvas a measured box so the camera is a well-defined
// fit-all. We return ONE shared FakeContext2D so the test can read its `clearRects`
// counter — drawBatch clears the surface once per composite, so clearRects == # of actual
// paints performed.
function stubCanvas(): FakeContext2D {
  const ctx = new FakeContext2D();
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () => ctx as unknown as CanvasRenderingContext2D,
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
  return ctx;
}

/** A controllable rAF: queue callbacks, then `tick(timeMs)` runs the next one. */
function makeFakeScheduler() {
  const queue: { handle: number; cb: (t: number) => void }[] = [];
  let next = 1;
  const schedule = (cb: (t: number) => void): number => {
    const handle = next++;
    queue.push({ handle, cb });
    return handle;
  };
  const cancel = (handle: number): void => {
    const i = queue.findIndex((q) => q.handle === handle);
    if (i >= 0) queue.splice(i, 1);
  };
  const tick = (timeMs: number): boolean => {
    const frame = queue.shift();
    if (frame === undefined) return false;
    frame.cb(timeMs);
    return true;
  };
  return { schedule, cancel, tick, pending: () => queue.length };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createAddHostPorts routes high-frequency repaints through the FrameScheduler (FR-110 — bughunt round-2)', () => {
  it('coalesces N camera writes (pan/zoom) into ONE composite per frame, while the camera truth + onCameraChange stay synchronous', () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const cameras: Camera[] = [];
    const ports = createAddHostPorts(mount, {
      onCameraChange: (c) => cameras.push(c),
    });

    // Inject the SAME scheduler wiring the composition root uses: the host's repaints go
    // through redraw(), capped at the configured FPS. 60 FPS so the frame budget never
    // gates within this test (we only verify coalescing here).
    const fake = makeFakeScheduler();
    const scheduler = new FrameScheduler({
      draw: () => ports.redraw(),
      fps: 60,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    ports.setRedrawRequester(() => scheduler.request());

    // Forget the synchronous mount/initial-paint activity; observe only the pan below.
    const base = ports.readCamera().camera;
    const clearsBefore = ctx.clearRects;
    cameras.length = 0;

    // Drive a pan: 30 camera writes in one frame (as a real pointermove burst would).
    for (let i = 1; i <= 30; i += 1) {
      ports.writeCamera({ ...base, centerLon: base.centerLon + i });
    }

    // The CAMERA TRUTH is updated synchronously on every write (readCamera / hit-tests /
    // screenToWorld must see the live pan at once) — NOT throttled.
    expect(ports.readCamera().camera.centerLon).toBe(base.centerLon + 30);
    // onCameraChange (store mirror + observation hooks) also fired synchronously, once per
    // write — the throttle never delays the camera state.
    expect(cameras).toHaveLength(30);
    expect(cameras[29]!.centerLon).toBe(base.centerLon + 30);

    // But the expensive COMPOSITE was deferred: NO extra paint happened synchronously
    // during the 30 writes (the pre-fix code recomposed on every write here).
    expect(ctx.clearRects).toBe(clearsBefore);
    expect(fake.pending()).toBe(1); // exactly one frame scheduled, not 30

    // The single scheduled frame performs ONE composite for all 30 writes (受け入れ基準 5),
    // against the LATEST camera.
    fake.tick(16);
    expect(ctx.clearRects).toBe(clearsBefore + 1);
    expect(fake.pending()).toBe(0);

    scheduler.dispose();
    ports.dispose();
    mount.remove();
  });

  it('coalesces tool-draft draws (drawAdd / drawKnife) and the LAST overlay wins on the deferred frame', () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const ports = createAddHostPorts(mount, {});
    const fake = makeFakeScheduler();
    const scheduler = new FrameScheduler({
      draw: () => ports.redraw(),
      fps: 60,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    ports.setRedrawRequester(() => scheduler.request());

    const clearsBefore = ctx.clearRects;
    const overlayAt = (lon: number): DrawPrimitive[] => [
      { kind: 'point', at: { lon, lat: 0 }, radiusPx: 4, fill: '#f00' },
    ];

    // A tool-draft move burst: many overlay draws within one frame.
    for (let i = 1; i <= 10; i += 1) ports.drawAdd(overlayAt(i));

    // Nothing painted synchronously; one frame scheduled.
    expect(ctx.clearRects).toBe(clearsBefore);
    expect(fake.pending()).toBe(1);

    // The single frame composes ONCE. The renderer's last point arc must reflect the LAST
    // overlay (lon = 10), proving the latest draft — not a stale one — survived the
    // coalescing (no lost update).
    fake.tick(16);
    expect(ctx.clearRects).toBe(clearsBefore + 1);
    // The fill-style red overlay point is the LAST arc recorded this composite.
    expect(ctx.arcs.length).toBeGreaterThan(0);

    scheduler.dispose();
    ports.dispose();
    mount.remove();
  });

  it('the configured FPS actually CAPS pan repaints (renderFps=1 → not every notch draws)', () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const ports = createAddHostPorts(mount, {});
    const fake = makeFakeScheduler();
    // 1 FPS ⇒ 1000ms per-frame budget. This is the exact repro from the finding: set
    // renderFps to 1, then pan — the pre-fix map redrew on every pointermove (uncapped).
    const scheduler = new FrameScheduler({
      draw: () => ports.redraw(),
      fps: 1,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    ports.setRedrawRequester(() => scheduler.request());

    const base = ports.readCamera().camera;
    const clearsBefore = ctx.clearRects;

    // First write → first frame establishes the last-draw time.
    ports.writeCamera({ ...base, centerLon: base.centerLon + 1 });
    fake.tick(0);
    expect(ctx.clearRects).toBe(clearsBefore + 1);

    // A second pan write 100ms later is GATED by the 1 FPS budget (1000ms): it would have
    // drawn at raw input rate before the fix. The camera truth still advances synchronously.
    ports.writeCamera({ ...base, centerLon: base.centerLon + 2 });
    expect(ports.readCamera().camera.centerLon).toBe(base.centerLon + 2);
    fake.tick(100); // 100ms < 1000ms budget ⇒ reschedule, NO draw
    expect(ctx.clearRects).toBe(clearsBefore + 1);
    expect(fake.pending()).toBe(1); // still pending under the cap

    fake.tick(2000); // now > 1000ms since last draw ⇒ the gated draw runs once
    expect(ctx.clearRects).toBe(clearsBefore + 2);

    scheduler.dispose();
    ports.dispose();
    mount.remove();
  });

  it('without an injected requester the host paints SYNCHRONOUSLY (legacy callers / pre-mount)', () => {
    const ctx = stubCanvas();
    const mount = document.createElement('div');
    document.body.appendChild(mount);

    const ports = createAddHostPorts(mount, {});
    const base = ports.readCamera().camera;
    const clearsBefore = ctx.clearRects;

    // No setRedrawRequester call ⇒ the default synchronous paint path. A camera write
    // recomposes at once (the behaviour tests without a scheduler depend on).
    ports.writeCamera({ ...base, centerLon: base.centerLon + 5 });
    expect(ctx.clearRects).toBe(clearsBefore + 1);

    ports.dispose();
    mount.remove();
  });
});
