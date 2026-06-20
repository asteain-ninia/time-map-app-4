// U42 — the采取 adapter contract works with a MOCK sampler (受け入れ基準 2).
//
// Proves the harness集計/判定 runs end-to-end against a deterministic FAKE
// `PerfSampler` (no real clock), exactly the substitution the spec requires:
// 「採取アダプタをモックして集計・判定ロジックを単体検証」.

import { describe, it, expect } from 'vitest';

import {
  collectResponses,
  collectMemory,
  type PerfSampler,
} from './adapter';
import { judgeFps, judgeResponse, judgeMemory, buildReport } from './metrics';
import { PERF_THRESHOLDS } from './thresholds';

const SCALE = { objectCount: 5000, meanAnchorsPerFeature: 10 };

/** A deterministic fake sampler returning scripted values (no real environment). */
function fakeSampler(opts: {
  frameMs: number;
  responseMs: number;
  memoryBytes: number;
}): PerfSampler {
  return {
    sampleFrameTimes(action, frames) {
      const times: number[] = [];
      for (let f = 0; f < frames; f += 1) {
        action(f);
        times.push(opts.frameMs);
      }
      return times;
    },
    measureResponse(commit) {
      commit();
      return opts.responseMs;
    },
    readMemoryBytes() {
      return opts.memoryBytes;
    },
  };
}

describe('collect* over a mock sampler', () => {
  it('collectResponses runs the commit N times and gathers N samples', () => {
    let commits = 0;
    const sampler = fakeSampler({ frameMs: 16, responseMs: 25, memoryBytes: 1000 });
    const samples = collectResponses(sampler, () => (commits += 1), 5);
    expect(commits).toBe(5);
    expect(samples).toEqual([25, 25, 25, 25, 25]);
  });

  it('collectMemory reads the sampler N times', () => {
    const sampler = fakeSampler({ frameMs: 16, responseMs: 25, memoryBytes: 2048 });
    expect(collectMemory(sampler, 3)).toEqual([2048, 2048, 2048]);
  });

  it('sampleFrameTimes drives the action per frame and tags each frame time', () => {
    const sampler = fakeSampler({ frameMs: 16, responseMs: 25, memoryBytes: 1000 });
    const seen: number[] = [];
    const times = sampler.sampleFrameTimes((f) => seen.push(f), 4);
    expect(seen).toEqual([0, 1, 2, 3]);
    expect(times).toEqual([16, 16, 16, 16]);
  });
});

describe('full harness pipeline over a mock sampler → records (受け入れ基準 2)', () => {
  it('a healthy fake (16ms frames / 25ms ops / 1GB) yields an all-pass report', () => {
    const sampler = fakeSampler({
      frameMs: 16,
      responseMs: 25,
      memoryBytes: PERF_THRESHOLDS.memoryMaxBytes / 2,
    });
    const frames = sampler.sampleFrameTimes(() => {}, 60);
    const responses = collectResponses(sampler, () => {}, 10);
    const memory = collectMemory(sampler, 5);

    const report = buildReport([
      judgeFps(frames, 'zoom/pan FPS', SCALE),
      judgeResponse(responses, '選択応答', SCALE),
      judgeMemory(memory, 'レンダラ heap', SCALE),
    ]);
    expect(report.allPass).toBe(true);
  });

  it('an unhealthy fake (40ms frames / 300ms ops / 3GB) yields three failed records', () => {
    const sampler = fakeSampler({
      frameMs: 40,
      responseMs: 300,
      memoryBytes: PERF_THRESHOLDS.memoryMaxBytes * 1.5,
    });
    const frames = sampler.sampleFrameTimes(() => {}, 60);
    const responses = collectResponses(sampler, () => {}, 10);
    const memory = collectMemory(sampler, 5);

    const report = buildReport([
      judgeFps(frames, 'zoom/pan FPS', SCALE),
      judgeResponse(responses, '選択応答', SCALE),
      judgeMemory(memory, 'レンダラ heap', SCALE),
    ]);
    expect(report.allPass).toBe(false);
    expect(report.records.every((r) => !r.pass)).toBe(true);
  });
});
