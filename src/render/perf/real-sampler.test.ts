// U42 — the REAL sampler is a valid PerfSampler in a real (Node test) environment.
//
// We cannot assert wall-clock 60FPS in CI (machine-dependent — that is exactly
// why判定 uses percentiles), so this proves the采取 SHAPE: frame times are
// recorded per frame, a commit is timed, and memory reads a non-negative byte
// count via the defensive fallback (process.memoryUsage in Node).

import { describe, it, expect } from 'vitest';

import { fpsFromFrameTimes, judgeMemory } from '../../domain/perf/index';

import { createRealSampler } from './real-sampler';

describe('createRealSampler', () => {
  it('sampleFrameTimes runs the action per frame and returns one time per frame', () => {
    const sampler = createRealSampler();
    let calls = 0;
    const times = sampler.sampleFrameTimes(() => (calls += 1), 5);
    expect(calls).toBe(5);
    expect(times).toHaveLength(5);
    for (const t of times) expect(t).toBeGreaterThanOrEqual(0);
  });

  it('the recorded frame times feed the pure FPS aggregator without error', () => {
    const sampler = createRealSampler();
    // Do a little work each frame so the frame time is plausibly > 0.
    const times = sampler.sampleFrameTimes(() => {
      let x = 0;
      for (let i = 0; i < 1000; i += 1) x += i;
      return x;
    }, 10);
    const fps = fpsFromFrameTimes(times);
    expect(Number.isFinite(fps)).toBe(true);
    expect(fps).toBeGreaterThanOrEqual(0);
  });

  it('measureResponse times the commit and runs it exactly once', () => {
    const sampler = createRealSampler();
    let ran = 0;
    const ms = sampler.measureResponse(() => (ran += 1));
    expect(ran).toBe(1);
    expect(ms).toBeGreaterThanOrEqual(0);
  });

  it('readMemoryBytes returns a non-negative byte count (defensive fallback)', () => {
    const sampler = createRealSampler();
    const bytes = sampler.readMemoryBytes();
    expect(bytes).toBeGreaterThanOrEqual(0);
    // A real reading should be FAR under the 2GB cap in a test process; if the
    // fallback returned 0 (unknown env), the record is still well-formed.
    const record = judgeMemory([bytes], 'test-process heap', {
      objectCount: 5000,
      meanAnchorsPerFeature: 10,
    });
    expect(record.measured).toBe(bytes);
  });
});
