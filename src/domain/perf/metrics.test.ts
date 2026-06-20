// U42 — unit tests for the PURE perf aggregation/judgement (受け入れ基準 2 / 6).
//
// Known sample arrays → expected representative values + pass/fail, proving the
// 集計/判定 half works WITHOUT a real clock (採取アダプタは別レンズ). Thresholds are
// asserted to come from the single source, never re-typed here.

import { describe, it, expect } from 'vitest';

import {
  percentile,
  fpsFromFrameTimes,
  representativeResponseMs,
  peakMemoryBytes,
  judge,
  judgeFps,
  judgeResponse,
  judgeMemory,
  buildReport,
  failedRecords,
  describeRecord,
  PERF_METRIC,
  PERF_COMPARISON,
} from './metrics';
import { PERF_THRESHOLDS } from './thresholds';

const SCALE = { objectCount: 5000, meanAnchorsPerFeature: 10 };

describe('percentile', () => {
  it('returns NaN for an empty array', () => {
    expect(percentile([], 50)).toBeNaN();
  });

  it('clamps p<=0 to min and p>=100 to max', () => {
    expect(percentile([3, 1, 2], 0)).toBe(1);
    expect(percentile([3, 1, 2], 100)).toBe(3);
  });

  it('interpolates the median of a known set', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 10);
  });

  it('matches a known 95th percentile by interpolated rank', () => {
    const samples = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // rank = 0.95 * 9 = 8.55 → between idx8(90) and idx9(100): 90 + 10*0.55 = 95.5
    expect(percentile(samples, 95)).toBeCloseTo(95.5, 10);
  });
});

describe('fpsFromFrameTimes', () => {
  it('a steady 16ms/frame yields ~60 FPS at p95', () => {
    const fps = fpsFromFrameTimes(Array.from({ length: 100 }, () => 16));
    expect(fps).toBeCloseTo(1000 / 16, 6);
  });

  it('uses the SLOW-tail (p95) frame time, not the mean', () => {
    // 99 fast frames (10ms) + a few 50ms stalls → p95 leans toward the stalls,
    // so the representative FPS is BELOW the mean-based optimistic value.
    const frames = [...Array.from({ length: 95 }, () => 10), 50, 50, 50, 50, 50];
    const fps = fpsFromFrameTimes(frames);
    expect(fps).toBeLessThan(1000 / 10);
  });

  it('ignores non-positive/invalid frame times; all-invalid → 0', () => {
    expect(fpsFromFrameTimes([0, -1, Number.NaN])).toBe(0);
    expect(fpsFromFrameTimes([])).toBe(0);
  });
});

describe('representativeResponseMs', () => {
  it('returns the p95 of valid response samples', () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
    // p95 of 1..100 = 1 + 99*0.95 = 95.05
    expect(representativeResponseMs(samples)).toBeCloseTo(95.05, 6);
  });

  it('empty → NaN (no data is not "0ms")', () => {
    expect(representativeResponseMs([])).toBeNaN();
  });
});

describe('peakMemoryBytes', () => {
  it('returns the max valid sample', () => {
    expect(peakMemoryBytes([100, 5000, 200])).toBe(5000);
  });
  it('empty → NaN', () => {
    expect(peakMemoryBytes([])).toBeNaN();
  });
});

describe('judge', () => {
  it('atLeast passes when measured >= threshold', () => {
    const r = judge({
      metric: PERF_METRIC.fps,
      condition: 'pan',
      scale: SCALE,
      measured: 60,
      threshold: 60,
      comparison: PERF_COMPARISON.atLeast,
    });
    expect(r.pass).toBe(true);
  });

  it('atMost fails when measured > threshold', () => {
    const r = judge({
      metric: PERF_METRIC.responseMs,
      condition: '選択',
      scale: SCALE,
      measured: 150,
      threshold: 100,
      comparison: PERF_COMPARISON.atMost,
    });
    expect(r.pass).toBe(false);
  });

  it('a NaN measured value is ALWAYS a fail (cannot prove the target, 教訓 5.6)', () => {
    const r = judge({
      metric: PERF_METRIC.fps,
      condition: 'no samples',
      scale: SCALE,
      measured: Number.NaN,
      threshold: 60,
      comparison: PERF_COMPARISON.atLeast,
    });
    expect(r.pass).toBe(false);
  });
});

describe('judge* convenience use the single threshold source', () => {
  it('judgeFps compares against PERF_THRESHOLDS.targetFps', () => {
    const r = judgeFps(Array.from({ length: 60 }, () => 16), 'zoom', SCALE);
    expect(r.threshold).toBe(PERF_THRESHOLDS.targetFps);
    expect(r.comparison).toBe(PERF_COMPARISON.atLeast);
    expect(r.pass).toBe(true);
  });

  it('judgeResponse compares against PERF_THRESHOLDS.responseMaxMs', () => {
    const r = judgeResponse([10, 20, 30], '頂点ドラッグ確定', SCALE);
    expect(r.threshold).toBe(PERF_THRESHOLDS.responseMaxMs);
    expect(r.pass).toBe(true);
  });

  it('judgeMemory compares against PERF_THRESHOLDS.memoryMaxBytes', () => {
    const overBudget = PERF_THRESHOLDS.memoryMaxBytes + 1;
    const r = judgeMemory([overBudget], 'レンダラ heap', SCALE);
    expect(r.threshold).toBe(PERF_THRESHOLDS.memoryMaxBytes);
    expect(r.pass).toBe(false);
  });
});

describe('report aggregation (受け入れ基準 2: 未達検出)', () => {
  it('allPass only when every record passes; failedRecords lists the misses', () => {
    const good = judgeFps(Array.from({ length: 60 }, () => 16), 'fps', SCALE);
    const bad = judgeResponse([200, 200, 200], 'slow op', SCALE);
    const report = buildReport([good, bad]);
    expect(report.allPass).toBe(false);
    const failed = failedRecords(report);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.condition).toBe('slow op');
  });

  it('describeRecord renders a readable PASS/FAIL line', () => {
    const r = judgeFps(Array.from({ length: 60 }, () => 16), 'pan', SCALE);
    expect(describeRecord(r)).toContain('PASS');
    expect(describeRecord(r)).toContain('pan');
  });
});
