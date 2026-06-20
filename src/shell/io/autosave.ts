// U15 — AUTO-SAVE scheduler (FR-108 / 受け入れ基準3).
//
// A settings-driven interval timer that triggers a save callback. The interval
// is ALWAYS supplied by the caller (from settings) — only the既定値 5 分 lives
// here as a constant (注意点: 設定値のハードコード禁止). The auto-save callback
// is expected to route through the SAME atomic save path as a manual save
// (受け入れ基準3); that wiring is the IPC handler's job, this module owns timing.
//
// The timer port is INJECTED so the scheduler is unit-testable with a fake clock
// (受け入れ基準7) — no real `setInterval`, no Electron. `realTimerPort` binds to
// the host timer for production.

/** Default auto-save interval (FR-108: デフォルト 5 分). The ONLY hardcoded value. */
export const DEFAULT_AUTO_SAVE_INTERVAL_MS = 5 * 60 * 1000;

/** Port over an interval timer so tests can drive it with a fake clock. */
export interface TimerPort {
  /** Start a repeating timer; returns an opaque handle. */
  setInterval: (callback: () => void, ms: number) => unknown;
  /** Stop a timer started by {@link setInterval}. */
  clearInterval: (handle: unknown) => void;
}

/** Production timer port over the host `setInterval` / `clearInterval`. */
export const realTimerPort: TimerPort = {
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
};

/** A running auto-save scheduler. */
export interface AutoSaveScheduler {
  /** (Re)configure the interval from settings and (re)start the timer. */
  reconfigure: (intervalMs: number) => void;
  /** Stop auto-saving (no further triggers until reconfigured). */
  stop: () => void;
  /** Whether a timer is currently armed. */
  isRunning: () => boolean;
}

/**
 * Create an auto-save scheduler that invokes `onTick` every `intervalMs`. The
 * interval is validated (must be a positive finite number); a non-positive value
 * stops the timer rather than spinning. Reconfiguring replaces any prior timer
 * so the interval always reflects the latest settings value (FR-108 即時反映).
 */
export function createAutoSaveScheduler(
  onTick: () => void,
  timer: TimerPort = realTimerPort,
): AutoSaveScheduler {
  let handle: unknown = undefined;

  function stop(): void {
    if (handle !== undefined) {
      timer.clearInterval(handle);
      handle = undefined;
    }
  }

  function reconfigure(intervalMs: number): void {
    stop();
    if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
    handle = timer.setInterval(onTick, intervalMs);
  }

  return {
    reconfigure,
    stop,
    isRunning: () => handle !== undefined,
  };
}
