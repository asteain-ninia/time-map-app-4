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
    // A pending frame on the old scheduler is carried onto the rebuilt scheduler (so a
    // renderFps-only change never drops an in-flight draw), and the new budget governs.
    rs.request();
    expect(fake.pending()).toBe(1);
    rs.setFps(1);
    expect(fake.pending()).toBe(1); // the pending frame survives the rebuild (re-requested)
    fake.tick(0);
    expect(draws).toBe(1); // the rebuilt scheduler drew the carried-over frame
  });

  it('setFps does NOT drop a pending throttled redraw (bughunt round-2 regression)', () => {
    // Repro of the round-1 regression: a frame is already pending (time-slider drag /
    // playback / pan-driven domain redraw in flight) at the instant a settings confirm
    // changes ONLY renderFps. The old setFps disposed the scheduler — cancelling the
    // pending rAF and clearing dirty — and App.tsx's content gate early-returned without
    // re-requesting, so the in-flight frame was lost and the map showed a stale frame
    // until the next unrelated store change. The carry-over must keep the draw alive.
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

    rs.request(); // a redraw is in flight (frame pending, dirty)
    expect(fake.pending()).toBe(1);
    expect(draws).toBe(0);

    rs.setFps(30); // settings confirm changes ONLY renderFps — must NOT drop the frame

    // No further request() is issued (App.tsx's content gate early-returns for a pure
    // renderFps change). The carried-over frame must still draw on the next tick.
    expect(fake.pending()).toBe(1); // still pending after the rebuild
    fake.tick(0);
    expect(draws).toBe(1); // the in-flight frame survived and drew

    // And the new budget governs subsequent draws (the rebuild took effect).
    rs.request();
    fake.tick(10); // 10ms < 1000/30 ≈ 33.3ms budget ⇒ gated, no draw yet
    expect(draws).toBe(1);
    fake.tick(100); // > budget since last draw ⇒ the gated draw runs
    expect(draws).toBe(2);
  });

  it('setFps carries the last-draw time so the new budget gates the FIRST post-change frame (bughunt round-2: rebuild resets lastDrawMs)', () => {
    // Repro of the finding: rebuilding the FrameScheduler on a renderFps change seeded a
    // fresh lastDrawMs = -Infinity, so the first onFrame after the change ALWAYS satisfied
    // the cap gate and drew immediately — leaking one uncapped frame on the boundary. When
    // renderFps is LOWERED while frames are flowing, that first frame ignored the (much
    // larger) new budget. Carrying the outgoing scheduler's last-draw time fixes it.
    const fake = makeFakeScheduler();
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 60, // fast budget initially
      schedule: fake.schedule,
      cancel: fake.cancel,
    });

    // A draw at t=0 establishes the last-draw time on the original scheduler.
    rs.request();
    fake.tick(0);
    expect(draws).toBe(1);

    // Lower renderFps to 1 (1000ms budget) — the kind of change that should slow drawing.
    rs.setFps(1);

    // A redraw 100ms after the last draw must now be HELD to the new 1000ms budget. Before
    // the fix the rebuilt scheduler's lastDrawMs was -Infinity, so this frame drew at once.
    rs.request();
    fake.tick(100); // 100ms < 1000ms since the carried last draw ⇒ gated, no draw
    expect(draws).toBe(1);
    expect(fake.pending()).toBe(1); // the frame is held, not leaked

    fake.tick(2000); // now past the new budget ⇒ the held frame finally draws
    expect(draws).toBe(2);
  });

  it('setFps with no pending frame does not spuriously schedule one', () => {
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
    // No request() outstanding ⇒ a renderFps change must not conjure a draw.
    expect(fake.pending()).toBe(0);
    rs.setFps(15);
    expect(fake.pending()).toBe(0);
    fake.tick(0);
    expect(draws).toBe(0);
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

  it('flush drains a throttled redraw NOW so drawn == state before a pointerdown hit-test (bughunt round-2: stale-frame hit-test window)', () => {
    // The map hit-test reads LIVE store state + the live camera, but the redraw is
    // FPS-capped. When the cap holds a frame back the store has already advanced while
    // the user still sees the OLD frame, so a press would resolve against the NEW
    // feature set, not the visible one (『見える ≠ 掴める』). The composition root drains
    // the scheduler synchronously before processing a pointerdown so drawn == state at
    // the instant of the press. This pins that drain on the wiring unit.
    const fake = makeFakeScheduler();
    let now = 0;
    let draws = 0;
    const rs = createRedrawScheduler({
      draw: () => {
        draws += 1;
      },
      initialFps: 2, // 500ms budget — the kind of low renderFps that opens the window
      schedule: fake.schedule,
      cancel: fake.cancel,
      now: () => now,
    });

    // First draw establishes the budget baseline.
    rs.request();
    fake.tick(0);
    expect(draws).toBe(1);

    // A store change requests a redraw 10ms later; the 500ms cap would HOLD it back, so
    // the pixels lag the store (the stale-frame window). A pointerdown flush must paint
    // it NOW, exactly once, cancelling the scheduled frame (no double draw, 受け入れ基準 5).
    now = 10;
    rs.request();
    expect(fake.pending()).toBe(1);

    rs.flush(); // pointerdown drains the pending frame before hit-testing
    expect(draws).toBe(2); // drawn immediately despite being under the cap budget
    expect(fake.pending()).toBe(0); // the scheduled frame was cancelled

    // The cancelled frame must not draw a second time even if a stray tick arrives.
    expect(fake.tick(20)).toBe(false);
    expect(draws).toBe(2);

    // flush with nothing pending is a no-op.
    rs.flush();
    expect(draws).toBe(2);
  });

  it('flush does NOT poison the cap budget when performance.now is unavailable (bughunt round-2: draw-hang)', () => {
    // ROOT regression for the finding: the default `now` used by flush() previously fell
    // back to Date.now() (epoch ~1.7e12) when performance.now was absent (headless/special
    // runners). flush() then seeded the FrameScheduler's lastDrawMs with that epoch value,
    // while onFrame compares it against small origin-relative rAF timestamps — so every
    // subsequent frame failed the cap gate (huge negative delta < minFrameMs) and was
    // rescheduled forever: the map NEVER repainted again. We pin the default-clock path
    // (no injected `now`) with performance.now removed, proving flush stays on the rAF
    // basis and drawing recovers.
    const savedPerformance = (globalThis as { performance?: unknown }).performance;
    // Remove performance entirely so the default clock takes the no-monotonic-clock branch.
    delete (globalThis as { performance?: unknown }).performance;
    try {
      const fake = makeFakeScheduler();
      let draws = 0;
      const rs = createRedrawScheduler({
        draw: () => {
          draws += 1;
        },
        initialFps: 2, // 500ms budget — low enough that the cap actually holds frames
        schedule: fake.schedule,
        cancel: fake.cancel,
        // NOTE: no `now` injected ⇒ exercises the real default-clock fallback path.
      });

      // Establish a first draw on the rAF basis at t=0.
      rs.request();
      fake.tick(0);
      expect(draws).toBe(1);

      // A pointerdown flush (no rAF-compatible clock) drains the pending frame now. With the
      // old Date.now fallback this seeded lastDrawMs ≈ 1.7e12.
      rs.request();
      rs.flush();
      expect(draws).toBe(2);
      expect(fake.pending()).toBe(0); // the scheduled frame was cancelled (no double draw)

      // THE BUG: a subsequent throttled redraw must still be able to draw. Before the fix
      // the rAF timestamp (600) minus the epoch lastDrawMs was hugely negative, so onFrame
      // rescheduled forever and the map hung. Now it draws.
      rs.request();
      fake.tick(600); // ≥ 500ms budget on the rAF basis ⇒ draws (does NOT reschedule)
      expect(draws).toBe(3);
      expect(fake.pending()).toBe(0); // recovered — NOT stuck in an infinite reschedule loop
    } finally {
      if (savedPerformance !== undefined) {
        (globalThis as { performance?: unknown }).performance = savedPerformance;
      }
    }
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
