// U42 — the single threshold/scale source is internally consistent (受け入れ基準 6).
//
// Pins the NFR 5.1 / 5.2 numbers AS the contract (60FPS / 100ms / 2GB / 5000×10)
// and verifies the distribution is a valid probability vector. This is the ONE
// place these literals are asserted; production code imports them, never re-types.

import { describe, it, expect } from 'vitest';

import { PERF_THRESHOLDS, PERF_SCALE, PERF_PERCENTILES, bytesToGiB } from './thresholds';

describe('PERF_THRESHOLDS (NFR 5.1 / 5.2)', () => {
  it('targets 60FPS, 100ms response, and a 2GB memory cap', () => {
    expect(PERF_THRESHOLDS.targetFps).toBe(60);
    expect(PERF_THRESHOLDS.responseMaxMs).toBe(100);
    expect(bytesToGiB(PERF_THRESHOLDS.memoryMaxBytes)).toBe(2);
  });
});

describe('PERF_SCALE (NFR 5.2)', () => {
  it('is the 5,000 object × mean 10 anchor scale', () => {
    expect(PERF_SCALE.objectCount).toBe(5000);
    expect(PERF_SCALE.meanAnchorsPerFeature).toBe(10);
  });

  it('the kind distribution is a valid probability vector (sums to 1)', () => {
    const d = PERF_SCALE.distribution;
    const sum = d.point + d.line + d.leaf + d.aggregate;
    expect(sum).toBeCloseTo(1, 10);
    for (const v of Object.values(d)) expect(v).toBeGreaterThan(0);
  });

  it('hole/enclave ratios are fractions in [0,1]', () => {
    expect(PERF_SCALE.holeRatio).toBeGreaterThanOrEqual(0);
    expect(PERF_SCALE.holeRatio).toBeLessThanOrEqual(1);
    expect(PERF_SCALE.enclaveRatio).toBeGreaterThanOrEqual(0);
    expect(PERF_SCALE.enclaveRatio).toBeLessThanOrEqual(1);
  });
});

describe('PERF_PERCENTILES (技術方針 R5)', () => {
  it('uses high percentiles for representative values', () => {
    expect(PERF_PERCENTILES.frameTimePercentile).toBeGreaterThanOrEqual(90);
    expect(PERF_PERCENTILES.responsePercentile).toBeGreaterThanOrEqual(90);
  });
});
