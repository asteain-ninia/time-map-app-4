// U15 受け入れ基準3: 自動保存間隔は設定値から取得（ハードコードしない）、既定 5 分。
// fake clock で Electron 無しに検証（受け入れ基準7）。

import { describe, expect, it, vi } from 'vitest';

import {
  createAutoSaveScheduler,
  DEFAULT_AUTO_SAVE_INTERVAL_MS,
  type TimerPort,
} from './autosave';

/** A fake timer port that lets a test fire the registered tick on demand. */
function makeFakeTimer(): TimerPort & { fire: () => void; armedMs: number | undefined } {
  let cb: (() => void) | undefined;
  const state = {
    armedMs: undefined as number | undefined,
    setInterval: (callback: () => void, ms: number) => {
      cb = callback;
      state.armedMs = ms;
      return { id: 1 };
    },
    clearInterval: () => {
      cb = undefined;
      state.armedMs = undefined;
    },
    fire: () => {
      cb?.();
    },
  };
  return state;
}

describe('auto-save scheduler (受け入れ基準3)', () => {
  it('default interval is 5 minutes', () => {
    expect(DEFAULT_AUTO_SAVE_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it('uses the interval passed from settings, NOT a hardcoded one', () => {
    const timer = makeFakeTimer();
    const sched = createAutoSaveScheduler(() => {}, timer);
    sched.reconfigure(12_345);
    expect(timer.armedMs).toBe(12_345);
    sched.reconfigure(60_000);
    expect(timer.armedMs).toBe(60_000);
  });

  it('fires the save callback on each tick', () => {
    const timer = makeFakeTimer();
    const onTick = vi.fn();
    const sched = createAutoSaveScheduler(onTick, timer);
    sched.reconfigure(1000);
    timer.fire();
    timer.fire();
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('reconfigure replaces the prior timer (即時反映)', () => {
    const timer = makeFakeTimer();
    const sched = createAutoSaveScheduler(() => {}, timer);
    sched.reconfigure(1000);
    expect(sched.isRunning()).toBe(true);
    sched.reconfigure(2000);
    expect(timer.armedMs).toBe(2000);
  });

  it('stop() disarms; a non-positive interval also disarms', () => {
    const timer = makeFakeTimer();
    const sched = createAutoSaveScheduler(() => {}, timer);
    sched.reconfigure(1000);
    sched.stop();
    expect(sched.isRunning()).toBe(false);
    sched.reconfigure(0);
    expect(sched.isRunning()).toBe(false);
    sched.reconfigure(-5);
    expect(sched.isRunning()).toBe(false);
  });
});
