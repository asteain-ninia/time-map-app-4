// U42 — pure performance aggregation + judgement (技術方針 2.14 / 教訓 5.41).
//
// The「集計・判定」half of the self-built measurement harness, kept PURE and
// framework-free so Vitest can pin it with known sample arrays (受け入れ基準 2):
//   - frame-time samples (ms) → representative FPS,
//   - response-time samples (ms) → representative response,
//   - memory samples (bytes) → peak / representative memory,
//   - (metric, threshold) → a machine-readable pass/fail record.
// The side-effecting sample采取 (clock / performance API / process memory) lives
// in the adapter layer (src/render/perf), NOT here. All thresholds come from the
// single source `./thresholds` (受け入れ基準 6 / 開発ガイド §4).

import {
  PERF_PERCENTILES,
  PERF_THRESHOLDS,
  bytesToGiB,
} from './thresholds';

/**
 * The percentile (`p` in [0,100]) of a sample array via linear interpolation
 * between the closest ranks. Pure & deterministic: the same array + p always
 * yields the same value (NFR 5.8). An empty array yields `NaN` (no data).
 *
 * Exported so judgement code and tests share ONE percentile definition rather
 * than each re-deriving "representative value" (開発ガイド §4).
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN;
  if (p <= 0) return Math.min(...samples);
  if (p >= 100) return Math.max(...samples);
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const loVal = sorted[lo]!;
  if (lo === hi) return loVal;
  const hiVal = sorted[hi]!;
  return loVal + (hiVal - loVal) * (rank - lo);
}

/**
 * Representative FPS from frame-time samples (ms/frame). Uses the high-percentile
 * frame time (slow frames) → FPS, so the figure is the SUSTAINED rate rather than
 * the optimistic mean (技術方針 R5 / thresholds.frameTimePercentile). A frame time
 * of 0 or a negative value is ignored as invalid; no valid samples → 0 FPS.
 */
export function fpsFromFrameTimes(frameTimesMs: readonly number[]): number {
  const valid = frameTimesMs.filter((t) => t > 0 && Number.isFinite(t));
  if (valid.length === 0) return 0;
  const repFrameMs = percentile(valid, PERF_PERCENTILES.frameTimePercentile);
  if (!(repFrameMs > 0)) return 0;
  return 1000 / repFrameMs;
}

/**
 * Representative response time (ms) from operation-commit samples. The high
 * percentile (technically the slow-tail latency the user feels) is the figure
 * compared against the 100ms bound (技術方針 R5: 操作確定の応答を測る). Empty → NaN.
 */
export function representativeResponseMs(responseMs: readonly number[]): number {
  const valid = responseMs.filter((t) => t >= 0 && Number.isFinite(t));
  if (valid.length === 0) return Number.NaN;
  return percentile(valid, PERF_PERCENTILES.responsePercentile);
}

/** Peak (max) memory in bytes from samples. Empty → NaN (no data, not "0 used"). */
export function peakMemoryBytes(memoryBytes: readonly number[]): number {
  const valid = memoryBytes.filter((b) => b >= 0 && Number.isFinite(b));
  if (valid.length === 0) return Number.NaN;
  return Math.max(...valid);
}

/** The performance metric a record describes. */
export const PERF_METRIC = {
  fps: 'fps',
  responseMs: 'responseMs',
  memoryBytes: 'memoryBytes',
} as const;
export type PerfMetric = (typeof PERF_METRIC)[keyof typeof PERF_METRIC];

/** The comparison direction a threshold uses. */
export const PERF_COMPARISON = {
  /** Pass when measured >= threshold (e.g. FPS). */
  atLeast: 'atLeast',
  /** Pass when measured <= threshold (e.g. response ms, memory bytes). */
  atMost: 'atMost',
} as const;
export type PerfComparison = (typeof PERF_COMPARISON)[keyof typeof PERF_COMPARISON];

/**
 * A machine-readable measurement record (受け入れ基準 2 / 計測結果レコード). Carries
 * the metric, the measurement condition, the data scale, the measured value, the
 * threshold, the comparison direction, and the computed pass/fail — so a CI/回帰
 * consumer can detect a未達 without re-deriving anything.
 */
export interface PerfRecord {
  readonly metric: PerfMetric;
  /** What was measured (e.g. 'zoom/pan FPS', '選択応答', 'レンダラ heap'). */
  readonly condition: string;
  /** The data scale the measurement ran at (objects × mean anchors). */
  readonly scale: { readonly objectCount: number; readonly meanAnchorsPerFeature: number };
  readonly measured: number;
  readonly threshold: number;
  readonly comparison: PerfComparison;
  readonly pass: boolean;
}

/**
 * Judge a measured value against a threshold, producing a {@link PerfRecord}.
 * A `NaN` measured value (no samples) is always a FAIL (we cannot prove the
 * target was met, 教訓 5.6: 判定は結果状態で). Pure & deterministic.
 */
export function judge(args: {
  readonly metric: PerfMetric;
  readonly condition: string;
  readonly scale: PerfRecord['scale'];
  readonly measured: number;
  readonly threshold: number;
  readonly comparison: PerfComparison;
}): PerfRecord {
  const { measured, threshold, comparison } = args;
  const pass =
    Number.isFinite(measured) &&
    (comparison === PERF_COMPARISON.atLeast
      ? measured >= threshold
      : measured <= threshold);
  return {
    metric: args.metric,
    condition: args.condition,
    scale: args.scale,
    measured,
    threshold,
    comparison,
    pass,
  };
}

/** Convenience: judge FPS samples against the 60FPS target (NFR 5.1). */
export function judgeFps(
  frameTimesMs: readonly number[],
  condition: string,
  scale: PerfRecord['scale'],
): PerfRecord {
  return judge({
    metric: PERF_METRIC.fps,
    condition,
    scale,
    measured: fpsFromFrameTimes(frameTimesMs),
    threshold: PERF_THRESHOLDS.targetFps,
    comparison: PERF_COMPARISON.atLeast,
  });
}

/** Convenience: judge response samples against the 100ms bound (NFR 5.1 / R5). */
export function judgeResponse(
  responseMs: readonly number[],
  condition: string,
  scale: PerfRecord['scale'],
): PerfRecord {
  return judge({
    metric: PERF_METRIC.responseMs,
    condition,
    scale,
    measured: representativeResponseMs(responseMs),
    threshold: PERF_THRESHOLDS.responseMaxMs,
    comparison: PERF_COMPARISON.atMost,
  });
}

/** Convenience: judge memory samples against the 2GB bound (NFR 5.2 / R4). */
export function judgeMemory(
  memoryBytes: readonly number[],
  condition: string,
  scale: PerfRecord['scale'],
): PerfRecord {
  return judge({
    metric: PERF_METRIC.memoryBytes,
    condition,
    scale,
    measured: peakMemoryBytes(memoryBytes),
    threshold: PERF_THRESHOLDS.memoryMaxBytes,
    comparison: PERF_COMPARISON.atMost,
  });
}

/** A full report: all three records + an overall pass (every record passes). */
export interface PerfReport {
  readonly records: readonly PerfRecord[];
  readonly allPass: boolean;
}

/** Bundle records into a report, computing the overall pass (教訓 5.6: 結果状態で判定). */
export function buildReport(records: readonly PerfRecord[]): PerfReport {
  return { records, allPass: records.every((r) => r.pass) };
}

/**
 * The records that did NOT meet target (受け入れ基準 2: 未達指標・条件・値を含むレコード
 * として検出でき回帰計測に再利用できる). Used by a CI consumer to surface failures.
 */
export function failedRecords(report: PerfReport): readonly PerfRecord[] {
  return report.records.filter((r) => !r.pass);
}

/** Human label for a record (for logs / CI output). memory shown in GiB. */
export function describeRecord(r: PerfRecord): string {
  const value =
    r.metric === PERF_METRIC.memoryBytes
      ? `${bytesToGiB(r.measured).toFixed(2)}GiB`
      : r.metric === PERF_METRIC.fps
        ? `${r.measured.toFixed(1)}FPS`
        : `${r.measured.toFixed(1)}ms`;
  const limit =
    r.metric === PERF_METRIC.memoryBytes
      ? `${bytesToGiB(r.threshold).toFixed(2)}GiB`
      : r.metric === PERF_METRIC.fps
        ? `${r.threshold}FPS`
        : `${r.threshold}ms`;
  const op = r.comparison === PERF_COMPARISON.atLeast ? '>=' : '<=';
  return `[${r.pass ? 'PASS' : 'FAIL'}] ${r.condition} (${r.metric}): ${value} ${op} ${limit}`;
}
