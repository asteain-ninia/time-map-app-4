// UI layer (composition root seam): the redraw-FPS wiring (FR-110 / 受け入れ基準 5).
//
// ROOT FIX (bughunt: App 設定の renderFps が描画/スケジューラに一切消費されない).
// The U19 `FrameScheduler` (render/frame-scheduler.ts) was complete — coalescing N
// requests into ONE draw per frame and capping the rate at 1000/clampFps(fps) — but
// the composition root never instantiated it: App.tsx called `ports.redraw()`
// synchronously on every store change, so the configured render FPS was validated,
// clamped and persisted yet had ZERO runtime effect (教訓 5.7「ロジックがあっても UI
// から呼ばれず機能しない」).
//
// This module is the single, testable place that owns the scheduler lifecycle so the
// inline mount effect in App.tsx stays thin and the wiring can be unit-tested in
// plain Node (NFR 5.8) with an injected fake scheduler. It holds ONE rule:
//   - every redraw goes through a FrameScheduler whose cap = the CURRENT renderFps;
//   - because the cap is fixed at construction, a renderFps change rebuilds the
//     scheduler (disposing the old one) so a live settings confirm takes effect at
//     once (FR-110 即時反映) without a second copy of the throttle logic.

import { FrameScheduler } from '../../render/frame-scheduler';
import type {
  CancelFrame,
  FrameSchedulerOptions,
  ScheduleFrame,
} from '../../render/frame-scheduler';

/** Options for {@link createRedrawScheduler}. */
export interface RedrawSchedulerOptions {
  /** The actual re-composite, invoked at most once per frame when dirty. */
  readonly draw: () => void;
  /** The initial render FPS (FR-110, clamped to [1, 60] by the scheduler). */
  readonly initialFps: number;
  /** Injected rAF-like scheduler (defaults to requestAnimationFrame inside U19). */
  readonly schedule?: ScheduleFrame;
  /** Injected cancel (defaults to cancelAnimationFrame inside U19). */
  readonly cancel?: CancelFrame;
}

/**
 * A redraw requester whose frame-rate cap tracks the live renderFps app setting.
 * `request()` schedules a single throttled draw; `setFps(fps)` re-arms the cap (a
 * no-op when unchanged); `dispose()` cancels any pending frame (teardown).
 */
export interface RedrawScheduler {
  /** Request a throttled redraw (FR-71 / 受け入れ基準 5). */
  request(): void;
  /** Apply a new render FPS (rebuilds the cap; no-op when unchanged). */
  setFps(fps: number): void;
  /** Cancel any pending frame and release the scheduler (teardown). */
  dispose(): void;
}

/**
 * Build a {@link RedrawScheduler}. The FPS cap is fixed at FrameScheduler
 * construction, so `setFps` with a CHANGED value disposes the current scheduler and
 * builds a fresh one with the new budget; an unchanged value is ignored so a noisy
 * store subscription does not churn the scheduler. The injected schedule/cancel let
 * a test drive frames deterministically.
 */
export function createRedrawScheduler(options: RedrawSchedulerOptions): RedrawScheduler {
  const { draw, schedule, cancel } = options;
  let fps = options.initialFps;
  // Build the FrameScheduler options without ever assigning `undefined` to the
  // optional schedule/cancel (exactOptionalPropertyTypes: omit ⇒ U19's rAF defaults).
  const build = (): FrameScheduler => {
    const opts: FrameSchedulerOptions = {
      draw,
      fps,
      ...(schedule !== undefined ? { schedule } : {}),
      ...(cancel !== undefined ? { cancel } : {}),
    };
    return new FrameScheduler(opts);
  };
  let scheduler = build();

  return {
    request(): void {
      scheduler.request();
    },
    setFps(nextFps: number): void {
      if (nextFps === fps) return;
      fps = nextFps;
      // ROOT FIX (bughunt round-2: renderFps-only settings change silently DROPS a
      // pending throttled redraw). The cap is fixed at construction, so a CHANGED fps
      // must rebuild the FrameScheduler. dispose() cancels the old scheduler's pending
      // rAF AND clears its dirty flag, so a frame that was already requested (time
      // slider drag / playback / pan-driven redraw in flight) would be lost forever:
      // App.tsx's store subscription calls setFps *before* its content-changed gate,
      // and a pure renderFps change early-returns without re-requesting. We therefore
      // carry the old scheduler's pending state into the new one — if a draw was
      // outstanding, re-request it on the rebuilt scheduler so the in-flight frame is
      // honored under the new budget instead of being dropped.
      const wasPending = scheduler.isDirty;
      scheduler.dispose();
      scheduler = build();
      if (wasPending) scheduler.request();
    },
    dispose(): void {
      scheduler.dispose();
    },
  };
}
