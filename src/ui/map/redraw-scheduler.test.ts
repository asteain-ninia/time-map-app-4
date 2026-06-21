// Regression (bughunt: App 設定の renderFps が描画/スケジューラに一切消費されない).
//
// The U19 FrameScheduler was complete but never instantiated by the composition
// root — App.tsx called ports.redraw() synchronously on every store change, so the
// renderFps app setting was validated/clamped/persisted yet had ZERO runtime effect
// (FR-110 未適用). This test pins the結線 unit `createRedrawScheduler`:
//   - it routes every redraw through the FrameScheduler (N requests collapse to ONE
//     draw per frame, 受け入れ基準 5);
//   - a renderFps change re-arms the per-frame budget so a live settings confirm
//     actually changes the draw cap (FR-110 即時反映);
//   - dispose cancels any pending frame (teardown).
// A fake scheduler drives frames deterministically (NFR 5.8, no real rAF).

import { describe, expect, it } from 'vitest';

import { createRedrawScheduler } from './redraw-scheduler';

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

describe('createRedrawScheduler (FR-110 renderFps 結線)', () => {
  it('routes redraws through the throttle: N requests collapse to ONE draw per frame (受け入れ基準 5)', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 60,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    for (let i = 0; i < 30; i += 1) rs.request();
    expect(fake.pending()).toBe(1); // a single frame scheduled, not 30
    expect(draws).toBe(0); // nothing drawn until the frame runs

    fake.tick(100);
    expect(draws).toBe(1); // exactly one draw for all 30 requests
  });

  it('the configured FPS actually caps the draw rate (FR-110 — the dead-setting bug)', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 1, // 1000ms per-frame budget
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    // First draw establishes the last-draw time.
    rs.request();
    fake.tick(0);
    expect(draws).toBe(1);

    // A request only 100ms later is GATED by the 1 FPS budget (1000ms) — it would have
    // drawn at 60 FPS. This is exactly the runtime effect renderFps had NONE of before
    // the结線 fix (the scheduler was never instantiated, so every request drew at once).
    rs.request();
    fake.tick(100); // 100ms < 1000ms budget ⇒ reschedule, no draw
    expect(draws).toBe(1);
    expect(fake.pending()).toBe(1); // still pending

    fake.tick(2000); // now > 1000ms since last draw ⇒ the gated draw runs
    expect(draws).toBe(2);
  });

  it('setFps rebuilds the scheduler so a CHANGED rate applies (FR-110 即時反映)', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 60,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    // A pending frame on the old scheduler is cancelled when the rate changes; the new
    // scheduler schedules fresh on the next request (so the new budget governs).
    rs.request();
    expect(fake.pending()).toBe(1);
    rs.setFps(1);
    expect(fake.pending()).toBe(0); // old pending frame cancelled by the rebuild
    rs.request();
    fake.tick(0);
    expect(draws).toBe(1); // the new scheduler drew on the next request
  });

  it('setFps with an unchanged value does not churn (keeps the pending frame)', () => {
    const fake = makeFakeScheduler();
    const rs = createRedrawScheduler({
      draw: () => {},
      initialFps: 30,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    rs.request();
    expect(fake.pending()).toBe(1);
    rs.setFps(30); // same fps ⇒ no rebuild, the scheduled frame survives
    expect(fake.pending()).toBe(1);
  });

  it('dispose cancels a pending frame (teardown)', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 60,
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    rs.request();
    expect(fake.pending()).toBe(1);
    rs.dispose();
    expect(fake.pending()).toBe(0);
    expect(fake.tick(100)).toBe(false);
    expect(draws).toBe(0);
  });
});
