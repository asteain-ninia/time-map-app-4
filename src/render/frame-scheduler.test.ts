// U19 frame-scheduler tests (FR-71 / FR-110, 受け入れ基準 5). A fake scheduler drives
// frames deterministically so we can assert N requests collapse to 1 draw per
// frame and the FR-110 fps cap gates extra draws within a budget window.

import { describe, expect, it } from 'vitest';

import { FrameScheduler, clampFps } from './frame-scheduler';

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
  /** Run exactly the next queued frame at the given time. Returns false if empty. */
  const tick = (timeMs: number): boolean => {
    const frame = queue.shift();
    if (frame === undefined) return false;
    frame.cb(timeMs);
    return true;
  };
  return { schedule, cancel, tick, pending: () => queue.length };
}

describe('clampFps (FR-110)', () => {
  it('defaults to 60 when unset/invalid; clamps to [1,60]', () => {
    expect(clampFps(undefined)).toBe(60);
    expect(clampFps(Number.NaN)).toBe(60);
    expect(clampFps(0)).toBe(1);
    expect(clampFps(120)).toBe(60);
    expect(clampFps(30)).toBe(30);
  });
});

describe('受け入れ基準 5: N requests collapse to 1 draw per frame', () => {
  it('coalesces many requests in one frame into a single draw', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 60,
    });

    // Many high-frequency requests before any frame runs.
    for (let i = 0; i < 50; i += 1) fs.request();
    expect(fake.pending()).toBe(1); // only ONE frame scheduled
    expect(draws).toBe(0); // nothing drawn yet

    fake.tick(100); // first frame runs
    expect(draws).toBe(1); // exactly one draw for all 50 requests
    expect(fs.drawsPerformed).toBe(1);
    expect(fs.isDirty).toBe(false);
  });

  it('does not draw when nothing requested', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    expect(fake.tick(16)).toBe(false); // no frame queued
    expect(draws).toBe(0);
  });
});

describe('FR-71: a time-change request draws on the next frame', () => {
  it('a single request after a prior frame draws again', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 60,
    });
    fs.request();
    fake.tick(0);
    expect(draws).toBe(1);
    // a later time-change (>= 1 frame budget later) draws again.
    fs.request();
    fake.tick(100);
    expect(draws).toBe(2);
  });
});

describe('FR-110: fps cap reschedules instead of drawing twice in a budget window', () => {
  it('skips a draw that arrives faster than the per-frame budget', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 10, // budget = 100ms
    });
    fs.request();
    fake.tick(0); // first draw at t=0
    expect(draws).toBe(1);

    fs.request();
    fake.tick(50); // only 50ms later (< 100ms budget) ⇒ reschedule, no draw
    expect(draws).toBe(1);
    expect(fs.isDirty).toBe(true); // still pending
    expect(fake.pending()).toBe(1);

    fake.tick(150); // now > budget since last draw ⇒ draw
    expect(draws).toBe(2);
  });
});

describe('flush drains a pending frame NOW (bughunt round-2: stale-frame hit-test window)', () => {
  it('draws the pending frame immediately, bypassing the fps cap, and only once', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 2, // 500ms budget — a frame that would otherwise be held back by the cap
    });

    // First draw establishes lastDrawMs at t=0.
    fs.request();
    fake.tick(0);
    expect(draws).toBe(1);

    // A request 10ms later is WELL under the 500ms budget: the next frame would be
    // rescheduled (held back), so the pixels would lag the store — exactly the
    // stale-frame hit-test window. A flush must draw it NOW regardless of the cap.
    fs.request();
    expect(fs.isDirty).toBe(true);
    expect(fake.pending()).toBe(1); // a frame is scheduled

    fs.flush(10); // a pointerdown drains it before hit-testing
    expect(draws).toBe(2); // drawn immediately despite < budget
    expect(fs.isDirty).toBe(false);
    expect(fake.pending()).toBe(0); // the scheduled frame was cancelled (no double draw)

    // The cancelled frame, if it still ran, must NOT draw a second time.
    expect(fake.tick(20)).toBe(false);
    expect(draws).toBe(2);
  });

  it('is a no-op when nothing is pending', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 60,
    });
    fs.flush(100); // nothing requested
    expect(draws).toBe(0);
    expect(fs.isDirty).toBe(false);
  });

  it('advances the cap budget so a frame scheduled right after a flush is still gated', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 10, // 100ms budget
    });

    fs.request();
    fs.flush(0); // flush draws at t=0 and sets lastDrawMs = 0
    expect(draws).toBe(1);

    // A new request 50ms later (< 100ms budget since the flush draw) must be GATED —
    // the flush honoured the per-frame budget accounting, so no double-draw window.
    fs.request();
    fake.tick(50);
    expect(draws).toBe(1);
    expect(fs.isDirty).toBe(true);
    fake.tick(150); // > budget since the flush ⇒ now it draws
    expect(draws).toBe(2);
  });

  it('flush() WITHOUT a timestamp draws but leaves lastDrawMs on the rAF basis (bughunt round-2: no draw-hang)', () => {
    // Repro of the finding: when no rAF-compatible clock is available, flush() must NOT
    // seed lastDrawMs with a foreign (e.g. epoch Date.now) value, because onFrame compares
    // it against small origin-relative rAF timestamps. The previous code did `lastDrawMs =
    // nowMs` unconditionally; an epoch value (~1.7e12) made every later `timeMs - lastDrawMs`
    // hugely negative ⇒ < minFrameMs ⇒ infinite reschedule ⇒ the map never repaints.
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 2, // 500ms budget
    });

    // Establish a draw on the rAF basis at t=0.
    fs.request();
    fake.tick(0);
    expect(draws).toBe(1);
    expect(fs.lastDraw).toBe(0);

    // A pointerdown flush with NO timestamp drains the pending frame now...
    fs.request();
    fs.flush(); // omitted nowMs ⇒ draw but do not touch the budget clock
    expect(draws).toBe(2);
    // ...and crucially leaves lastDrawMs on the rAF basis (0), NOT some epoch value.
    expect(fs.lastDraw).toBe(0);

    // The very bug: a subsequent rAF frame at an origin-relative timestamp MUST still be
    // able to draw. With the old epoch poisoning this delta was negative forever and the
    // frame was rescheduled into oblivion. Now the budget gate sees 600 - 0 = 600ms ≥ 500,
    // so the frame draws instead of hanging.
    fs.request();
    fake.tick(600);
    expect(draws).toBe(3); // NOT stuck — the scheduler recovered, no draw-hang
  });
});

describe('initialLastDrawMs seeds the cap budget (bughunt round-2: rebuild reset)', () => {
  it('gates the first frame against the seeded last-draw time instead of drawing uncapped', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    // A scheduler built with initialLastDrawMs = 0 must treat t=0 as its last draw, so a
    // frame arriving within the per-frame budget is held back — NOT drawn immediately as
    // it would be with the default lastDrawMs = -Infinity.
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 1, // 1000ms budget
      initialLastDrawMs: 0,
    });
    expect(fs.lastDraw).toBe(0);

    fs.request();
    fake.tick(100); // only 100ms after the seeded last draw (< 1000ms) ⇒ gated, no draw
    expect(draws).toBe(0);
    expect(fs.isDirty).toBe(true);
    expect(fake.pending()).toBe(1);

    fake.tick(2000); // now past the budget ⇒ the held frame draws
    expect(draws).toBe(1);
  });

  it('defaults lastDraw to NEGATIVE_INFINITY (first frame draws at once) when unseeded', () => {
    const fake = makeFakeScheduler();
    let draws = 0;
    const fs = new FrameScheduler({
      draw: () => {
        draws += 1;
      },
      schedule: fake.schedule,
      cancel: fake.cancel,
      fps: 1,
    });
    expect(fs.lastDraw).toBe(Number.NEGATIVE_INFINITY);
    fs.request();
    fake.tick(100); // no prior draw ⇒ draws immediately despite the 1000ms budget
    expect(draws).toBe(1);
  });
});

describe('dispose cancels a pending frame', () => {
  it('clears dirty and cancels', () => {
    const fake = makeFakeScheduler();
    const fs = new FrameScheduler({
      draw: () => {},
      schedule: fake.schedule,
      cancel: fake.cancel,
    });
    fs.request();
    expect(fake.pending()).toBe(1);
    fs.dispose();
    expect(fake.pending()).toBe(0);
    expect(fs.isDirty).toBe(false);
  });
});
