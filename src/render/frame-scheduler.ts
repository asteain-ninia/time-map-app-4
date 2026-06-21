// U19 redraw scheduler — single-rAF throttling (FR-71 / FR-110, NFR 5.1, 受け入れ
// 基準 5, 技術方針 2.3 / R5).
//
// High-frequency events (pan/zoom/drag mousemove, time-slider drag) must NOT each
// trigger an immediate redraw — that would exceed the configured frame rate and
// burn cost. Instead every source calls `request()`, which sets a SINGLE dirty
// flag and schedules ONE frame via the injected scheduler; the next frame draws
// once and clears the flag. N requests within one frame collapse to ONE draw
// (受け入れ基準 5: 1 フレーム 1 描画). This is the ONE place the throttling unit lives
// (no double-application elsewhere, 教訓 5.16 の精神).
//
// The scheduler (requestAnimationFrame in the browser) is INJECTED so the logic
// is testable in plain Node with a fake scheduler (NFR 5.8). The frame-rate cap
// (FR-110, 1..60, default 60) is honored by skipping frames whose time since the
// last draw is below the per-frame budget; a time-CHANGE always draws on the next
// frame (it is just another `request`, never gated away — FR-71 即時更新).

/** Schedules a callback to run on the next animation frame; returns a handle. */
export type ScheduleFrame = (cb: (timeMs: number) => void) => number;
/** Cancels a previously scheduled frame by handle. */
export type CancelFrame = (handle: number) => void;

export interface FrameSchedulerOptions {
  /** Draw callback invoked at most once per frame when dirty. */
  readonly draw: () => void;
  /** The rAF-like scheduler (injected; defaults to requestAnimationFrame). */
  readonly schedule?: ScheduleFrame;
  /** The cancel function (injected; defaults to cancelAnimationFrame). */
  readonly cancel?: CancelFrame;
  /** Target frames per second (FR-110, clamped to [1, 60]). Default 60. */
  readonly fps?: number;
}

/** Clamp the configured fps into FR-110's [1, 60] range (default 60 when invalid). */
export function clampFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) return 60;
  if (fps < 1) return 1;
  if (fps > 60) return 60;
  return fps;
}

/**
 * A redraw scheduler that collapses many `request()` calls into one draw per
 * frame and respects the FR-110 frame-rate cap. Not pure (it holds the dirty flag
 * and the last-draw time), but every effect goes through the injected scheduler so
 * tests drive frames deterministically.
 */
export class FrameScheduler {
  private readonly draw: () => void;
  private readonly schedule: ScheduleFrame;
  private readonly cancel: CancelFrame;
  private readonly minFrameMs: number;

  private dirty = false;
  private handle: number | null = null;
  private lastDrawMs = Number.NEGATIVE_INFINITY;
  /** Number of actual draws performed (test/instrumentation, 受け入れ基準 5). */
  private drawCount = 0;

  constructor(options: FrameSchedulerOptions) {
    this.draw = options.draw;
    this.schedule =
      options.schedule ??
      ((cb) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(cb) : 0));
    this.cancel =
      options.cancel ??
      ((h) => {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(h);
      });
    this.minFrameMs = 1000 / clampFps(options.fps);
  }

  /**
   * Request a redraw. Sets the dirty flag and schedules a single frame if one is
   * not already pending. Calling this N times before the next frame results in ONE
   * scheduled frame (受け入れ基準 5). A time-change calls this like any other source,
   * so FR-71 即時更新 is honored on the next frame.
   */
  request(): void {
    this.dirty = true;
    if (this.handle !== null) return; // a frame is already pending — coalesce.
    this.handle = this.schedule((t) => this.onFrame(t));
  }

  /** The number of actual draws performed so far (1 フレーム 1 描画 の検証用). */
  get drawsPerformed(): number {
    return this.drawCount;
  }

  /** Whether a redraw is currently pending. */
  get isDirty(): boolean {
    return this.dirty;
  }

  /**
   * Draw NOW if a frame is pending, bypassing the FR-110 per-frame cap, and cancel
   * the scheduled frame so it does not draw a SECOND time (受け入れ基準 5: 1 フレーム
   * 1 描画 is preserved — the pending draw is honoured exactly once, just earlier).
   *
   * WHY (bughunt round-2 — stale-frame hit-test window): the map hit-test reads LIVE
   * store state + the live camera, but the redraw is throttled, so when the cap is
   * holding a frame back the store has advanced while the pixels still show the OLD
   * frame. A pointerdown in that gap resolves against the NEW set while the user aims
   * at the OLD drawing (『見える ≠ 掴める』). The composition root drains the scheduler
   * synchronously before processing a pointerdown so `drawn == state` at the instant
   * of the hit-test, restoring the clip ⊇ draw ⊇ hit (= current state) invariant the
   * hit-test is built on. This is the SAME single draw closure the frame would have
   * run (no second paint rule, 教訓 5.16) — only the timing changes.
   *
   * The cap accounting stays honest: `lastDrawMs` is advanced to the supplied `nowMs`
   * (a `performance.now()`-style timestamp from the caller) so a frame scheduled
   * immediately after a flush is still gated by the per-frame budget from THIS draw,
   * never double-drawing within one budget window. A no-op when nothing is pending.
   */
  flush(nowMs: number): void {
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.lastDrawMs = nowMs;
    this.drawCount += 1;
    this.draw();
  }

  /** Cancel any pending frame and clear the dirty flag (teardown). */
  dispose(): void {
    if (this.handle !== null) {
      this.cancel(this.handle);
      this.handle = null;
    }
    this.dirty = false;
  }

  private onFrame(timeMs: number): void {
    this.handle = null;
    if (!this.dirty) return;
    // FR-110 cap: if we are ahead of the per-frame budget, reschedule rather than
    // draw twice within one budget window. The dirty flag stays set.
    if (timeMs - this.lastDrawMs < this.minFrameMs) {
      this.handle = this.schedule((t) => this.onFrame(t));
      return;
    }
    this.dirty = false;
    this.lastDrawMs = timeMs;
    this.drawCount += 1;
    this.draw();
  }
}
