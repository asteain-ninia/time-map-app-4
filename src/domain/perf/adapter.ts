// U42 — measurement-采取 adapter interface (技術方針 2.14 / 教訓 5.41).
//
// The side-effect boundary of the harness:采取 raw samples from the real
// environment (clock / performance API / requestAnimationFrame frame timing /
// process memory). This file declares ONLY the contract (an interface), kept in
// domain so it is framework-free and can be mock-substituted in Vitest. The real
// implementations (which actually touch performance.now / process.memoryUsage /
// rAF) live in the render/shell layers (src/render/perf) — pure集計/判定 never
// imports them, only this interface.

/**
 * A side-effect sampler the harness drives to collect raw measurements. The pure
 * aggregation/judgement functions (./metrics) consume the returned sample arrays;
 * they never call these methods themselves (依存方向は内向き). A test supplies a
 * deterministic fake implementing this interface to exercise the harness without
 * a real clock (受け入れ基準 2: 採取アダプタをモック).
 */
export interface PerfSampler {
  /**
   * Run `action` over a measured window, collecting per-frame times (ms) for the
   * duration. Used for FPS during a zoom/pan区間 (技術方針 R5: 連続操作区間で測る).
   * Returns the frame-time samples in ms.
   */
  readonly sampleFrameTimes: (action: (frame: number) => void, frames: number) => readonly number[];

  /**
   * Measure ONE operation's commit→reflect latency (ms). `commit` performs the
   * confirmed operation (NOT the transient drag — 技術方針 R5). Returns elapsed ms.
   */
  readonly measureResponse: (commit: () => void) => number;

  /** Read current memory usage (bytes) — e.g. renderer heap / process RSS (R4). */
  readonly readMemoryBytes: () => number;
}

/**
 * Drive a sampler to collect N response samples by repeating a commit action.
 * Pure orchestration over the (impure) sampler — the sampler is the only side
 * effect. Returns the raw response-time samples (ms) for ./metrics to aggregate.
 */
export function collectResponses(
  sampler: PerfSampler,
  commit: () => void,
  repetitions: number,
): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < repetitions; i += 1) out.push(sampler.measureResponse(commit));
  return out;
}

/** Collect N memory samples (bytes) from the sampler — one read per call. */
export function collectMemory(sampler: PerfSampler, reads: number): readonly number[] {
  const out: number[] = [];
  for (let i = 0; i < reads; i += 1) out.push(sampler.readMemoryBytes());
  return out;
}
