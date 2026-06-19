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
