// UI layer (U20 / shell): map-area size notification (FR-114, NFR 5.1).
//
// The central map area mounts the imperative render layer (later unit). React
// does NOT drive the 60FPS draw path (技术方针 2.3); instead this unit observes
// the map container's pixel size and notifies subscribers, so the render layer
// can resize its Canvas WITHOUT a React re-render. High-frequency resize events
// are throttled (NFR 5.1). The throttle and the size store are pure / DOM-free
// here so they unit-test without a layout engine (教訓 5.41).

/** A pixel size of the map area. */
export interface MapSize {
  readonly width: number;
  readonly height: number;
}

export type MapSizeListener = (size: MapSize) => void;

/**
 * A tiny pub/sub for the map area size. The render layer subscribes; the React
 * shell pushes new sizes from a ResizeObserver. Subscribers receive the current
 * size immediately on subscribe so a late-mounting renderer is never stale
 * (教訓 5.35: notify all dependents, no stale holder).
 */
export class MapSizeStore {
  private size: MapSize;
  private readonly listeners = new Set<MapSizeListener>();

  constructor(initial: MapSize = { width: 0, height: 0 }) {
    this.size = initial;
  }

  get(): MapSize {
    return this.size;
  }

  /** Set the size; notifies listeners only when it actually changed. */
  set(size: MapSize): void {
    if (size.width === this.size.width && size.height === this.size.height) return;
    this.size = size;
    for (const l of this.listeners) l(size);
  }

  /** Subscribe; immediately invoked with the current size. Returns unsubscribe. */
  subscribe(listener: MapSizeListener): () => void {
    this.listeners.add(listener);
    listener(this.size);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

/**
 * A trailing-edge throttle: at most one call per `intervalMs`, and the last
 * call in a burst is always delivered (so the final resize size is never
 * dropped, NFR 5.1). Time and timers are injected so the throttle is fully
 * deterministic in tests (教訓 5.41).
 */
export interface ThrottleClock {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
}

/**
 * A trailing throttle handle: callable, plus {@link Throttled.cancel} to drop a
 * still-pending trailing call.
 */
export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  /**
   * Discard the pending trailing call (and its timer) WITHOUT invoking it. Needed
   * whenever the reason for the last call can END before the trailing edge fires: the
   * status-bar cursor readout publishes on pointermove but the pointer can LEAVE the map
   * inside the interval, and a trailing call landing after that leave would resurrect a
   * coordinate for a cursor that is no longer there (a discarded value, not a dropped
   * one — 教訓 5.2 全経路で破棄). Idempotent; the throttle stays usable afterwards.
   */
  cancel: () => void;
}

export function throttleTrailing<A extends unknown[]>(
  fn: (...args: A) => void,
  intervalMs: number,
  clock: ThrottleClock,
): Throttled<A> {
  let lastRun = Number.NEGATIVE_INFINITY;
  let timer: unknown = null;
  let pending: A | null = null;

  const invoke = (args: A): void => {
    lastRun = clock.now();
    fn(...args);
  };

  const throttled = (...args: A): void => {
    const elapsed = clock.now() - lastRun;
    if (elapsed >= intervalMs) {
      if (timer !== null) {
        clock.clearTimer(timer);
        timer = null;
      }
      pending = null;
      invoke(args);
      return;
    }
    // Within the interval: remember the latest args, schedule the trailing call.
    pending = args;
    if (timer === null) {
      timer = clock.setTimer(() => {
        timer = null;
        if (pending !== null) {
          const a = pending;
          pending = null;
          invoke(a);
        }
      }, intervalMs - elapsed);
    }
  };

  throttled.cancel = (): void => {
    pending = null;
    if (timer !== null) {
      clock.clearTimer(timer);
      timer = null;
    }
  };

  return throttled;
}

/** The default browser-backed clock (used by the React hook, not by tests). */
export const BROWSER_CLOCK: ThrottleClock = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};
