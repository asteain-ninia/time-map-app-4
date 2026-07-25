// U20 pure-logic tests: map-size store + trailing throttle (FR-114 / NFR 5.1,
// 受け入れ基準 4 / 10).

import { describe, expect, it, vi } from 'vitest';

import {
  MapSizeStore,
  throttleTrailing,
  type MapSize,
  type ThrottleClock,
} from './map-resize';

describe('MapSizeStore (size notification path)', () => {
  it('delivers the current size immediately on subscribe (no stale holder)', () => {
    const store = new MapSizeStore({ width: 10, height: 20 });
    const seen: MapSize[] = [];
    store.subscribe((s) => seen.push(s));
    expect(seen).toEqual([{ width: 10, height: 20 }]);
  });

  it('notifies subscribers on a real change only', () => {
    const store = new MapSizeStore({ width: 0, height: 0 });
    const seen: MapSize[] = [];
    const unsub = store.subscribe((s) => seen.push(s));
    store.set({ width: 100, height: 100 });
    store.set({ width: 100, height: 100 }); // no change -> no notify
    store.set({ width: 100, height: 200 });
    unsub();
    store.set({ width: 999, height: 999 }); // after unsub -> no notify
    expect(seen).toEqual([
      { width: 0, height: 0 },
      { width: 100, height: 100 },
      { width: 100, height: 200 },
    ]);
  });
});

/** A controllable fake clock for deterministic throttle tests. */
function fakeClock() {
  let t = 0;
  const timers: { id: number; fn: () => void; due: number }[] = [];
  let nextId = 1;
  const clock: ThrottleClock = {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ id, fn, due: t + ms });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  const advance = (ms: number): void => {
    t += ms;
    const due = timers.filter((x) => x.due <= t);
    for (const x of due) {
      timers.splice(timers.indexOf(x), 1);
      x.fn();
    }
  };
  return { clock, advance };
}

describe('throttleTrailing (NFR 5.1)', () => {
  it('runs the leading call immediately', () => {
    const { clock } = fakeClock();
    const fn = vi.fn();
    const throttled = throttleTrailing<[number]>(fn, 100, clock);
    throttled(1);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenLastCalledWith(1);
  });

  it('coalesces a burst and always delivers the LAST args (trailing)', () => {
    const { clock, advance } = fakeClock();
    const fn = vi.fn();
    const throttled = throttleTrailing<[number]>(fn, 100, clock);
    throttled(1); // leading, runs now
    throttled(2); // within interval -> pending
    throttled(3); // within interval -> replaces pending
    expect(fn).toHaveBeenCalledTimes(1);
    advance(100); // trailing fires with the last args
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(3);
  });

  it('runs again immediately once the interval has elapsed', () => {
    const { clock, advance } = fakeClock();
    const fn = vi.fn();
    const throttled = throttleTrailing<[number]>(fn, 100, clock);
    throttled(1);
    advance(100);
    throttled(2);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });

  // Review fix: a trailing throttle keeps a PENDING call that outlives the reason the
  // caller was throttling. The cursor readout hits this — pointermove, pointermove,
  // then the pointer leaves the map: without a cancel the pending trailing call lands
  // AFTER the leave and resurrects a coordinate for a cursor that is gone.
  it('cancel() discards a pending trailing call', () => {
    const { clock, advance } = fakeClock();
    const fn = vi.fn();
    const throttled = throttleTrailing<[number]>(fn, 100, clock);
    throttled(1); // leading, runs now
    throttled(2); // within interval -> pending
    throttled.cancel();
    advance(100);
    expect(fn).toHaveBeenCalledTimes(1); // the pending (2) never lands
    expect(fn).toHaveBeenLastCalledWith(1);
  });

  it('cancel() is idempotent and leaves the throttle usable', () => {
    const { clock, advance } = fakeClock();
    const fn = vi.fn();
    const throttled = throttleTrailing<[number]>(fn, 100, clock);
    throttled.cancel(); // nothing pending -> no-op
    throttled.cancel();
    throttled(1);
    expect(fn).toHaveBeenCalledTimes(1);
    // A cancel does NOT reset the interval: a later call inside it still coalesces,
    // and the throttle still delivers that trailing call when not cancelled.
    throttled(2);
    advance(100);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenLastCalledWith(2);
  });
});
