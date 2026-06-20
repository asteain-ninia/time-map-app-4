// U42 — the harness ENTRYPOINT produces machine-readable records (受け入れ基準 2 / 6).
//
// Runs the full wire (anchored synthetic DOMAIN project → domain→render adapter →
// sampler → pure判定) with a DETERMINISTIC fake sampler so the test is fast and
// reproducible (no real clock / GPU). Proves: one record per metric, the records
// carry the ACTUAL measured scale (resolved feature count + the project's real mean
// 錨 — NOT a constant) + the single-source thresholds, and a未達 sampler is DETECTED
// (受け入れ基準 2). The real-sampler path is its own test (real-sampler.test.ts);
// here we pin the orchestration.

import { describe, it, expect } from 'vitest';

import {
  type PerfSampler,
  PERF_METRIC,
  PERF_SCALE,
  PERF_THRESHOLDS,
  failedRecords,
  generateSyntheticProject,
} from '../../domain/perf/index';
import {
  evaluateProjectForMeasurement,
  defaultMeasurementTime,
  syntheticCalendar,
} from './project-features';

import { runPerfHarness } from './harness';

function fakeSampler(o: { frameMs: number; responseMs: number; memoryBytes: number }): PerfSampler {
  return {
    sampleFrameTimes(action, frames) {
      const out: number[] = [];
      for (let f = 0; f < frames; f += 1) {
        action(f);
        out.push(o.frameMs);
      }
      return out;
    },
    measureResponse(commit) {
      commit();
      return o.responseMs;
    },
    readMemoryBytes() {
      return o.memoryBytes;
    },
  };
}

describe('runPerfHarness', () => {
  it('produces exactly one record per metric (FPS / response / memory)', () => {
    const report = runPerfHarness({
      objectCount: 50,
      sampler: fakeSampler({ frameMs: 16, responseMs: 25, memoryBytes: 1_000_000 }),
      fpsFrames: 10,
      responseReps: 5,
      memoryReads: 3,
    });
    const metrics = report.records.map((r) => r.metric).sort();
    expect(metrics).toEqual(
      [PERF_METRIC.fps, PERF_METRIC.memoryBytes, PERF_METRIC.responseMs].sort(),
    );
  });

  it('every record carries the ACTUAL measured scale (from data, not a constant) + single-source thresholds', () => {
    const objectCount = 30;
    const report = runPerfHarness({
      objectCount,
      seed: 1,
      sampler: fakeSampler({ frameMs: 16, responseMs: 25, memoryBytes: 1_000_000 }),
      fpsFrames: 8,
      responseReps: 4,
      memoryReads: 2,
    });

    // Derive the EXPECTED scale the SAME way the harness does — by generating the
    // anchored project and resolving it through the domain→render adapter. The
    // record's scale must equal this MEASURED scale, NOT the PERF_SCALE constant.
    const expected = evaluateProjectForMeasurement(
      generateSyntheticProject({ objectCount, seed: 1 }),
      defaultMeasurementTime(),
      syntheticCalendar(),
    ).scale;

    for (const r of report.records) {
      expect(r.scale).toEqual(expected);
      // Guard against a regression to the constant-stamp bug: a 30-object run is
      // NOT the 5,000-object NFR constant.
      expect(r.scale.objectCount).not.toBe(PERF_SCALE.objectCount);
      expect(r.scale.objectCount).toBeGreaterThan(0);
      // The real mean anchors/feature is the NFR target (~10) by construction.
      expect(r.scale.meanAnchorsPerFeature).toBeCloseTo(PERF_SCALE.meanAnchorsPerFeature, 0);
    }
    const fps = report.records.find((r) => r.metric === PERF_METRIC.fps)!;
    expect(fps.threshold).toBe(PERF_THRESHOLDS.targetFps);
    const mem = report.records.find((r) => r.metric === PERF_METRIC.memoryBytes)!;
    expect(mem.threshold).toBe(PERF_THRESHOLDS.memoryMaxBytes);
  });

  it('the default run measures the full NFR 5.2 scale: 5,000-object project × ~10 anchors actually resolved', () => {
    // No objectCount override → the domain generator builds the PERF_SCALE.objectCount
    // (5,000) anchored project, resolved at year 0 through the real anchor path. This
    // is the integration proof that the 5,000×10錨 fixture is run at the harness level
    // (受け入れ基準 2): every history resolves present and contributes its drawable(s).
    const project = generateSyntheticProject();
    const scene = evaluateProjectForMeasurement(
      project,
      defaultMeasurementTime(),
      syntheticCalendar(),
    );

    // The DOMAIN project is at the 5,000-object NFR scale (aggregates absorb children
    // into a single history, so history count is below 5,000 but every generated
    // object is represented).
    expect(project.histories.length).toBeGreaterThan(1000);

    // The resolved render scene is at the multi-thousand drawable scale (aggregates
    // emit their absorbed leaves, not themselves), and the stamped objectCount equals
    // the actually-drawn feature count — measured, not a constant.
    expect(scene.features.length).toBeGreaterThan(4000);
    expect(scene.scale.objectCount).toBe(scene.features.length);

    // The real mean anchors over the resolved project is the NFR target (~10), which
    // is what the record stamps — proving the 錨 dimension is actually measured.
    expect(scene.scale.meanAnchorsPerFeature).toBeCloseTo(
      PERF_SCALE.meanAnchorsPerFeature,
      0,
    );
  });

  it('a HEALTHY fake (16ms / 25ms / 1GB) yields an all-pass report', () => {
    const report = runPerfHarness({
      objectCount: 40,
      sampler: fakeSampler({
        frameMs: 16,
        responseMs: 25,
        memoryBytes: PERF_THRESHOLDS.memoryMaxBytes / 2,
      }),
      fpsFrames: 10,
      responseReps: 5,
      memoryReads: 3,
    });
    expect(report.allPass).toBe(true);
  });

  it('an UNHEALTHY fake is DETECTED: failed records carry the未達 metric+value (受け入れ基準 2)', () => {
    const report = runPerfHarness({
      objectCount: 40,
      sampler: fakeSampler({
        frameMs: 50, // ~20 FPS < 60
        responseMs: 250, // > 100ms
        memoryBytes: PERF_THRESHOLDS.memoryMaxBytes * 2, // > 2GB
      }),
      fpsFrames: 10,
      responseReps: 5,
      memoryReads: 3,
    });
    expect(report.allPass).toBe(false);
    const failed = failedRecords(report);
    expect(failed).toHaveLength(3);
    // The records are machine-readable: each names its metric and measured value.
    for (const r of failed) {
      expect(Number.isFinite(r.measured)).toBe(true);
      expect(r.pass).toBe(false);
    }
  });
});
