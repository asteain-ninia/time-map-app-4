// U42 — the REAL measurement采取 adapter (render/shell-side side-effect layer).
//
// This is the side-effecting half of the harness (技術方針 2.14 / 教訓 5.41): it
// actually reads the clock (performance.now) and memory. It implements the
// framework-free `PerfSampler` contract from the domain so the pure集計/判定
// (src/domain/perf/metrics) never imports anything impure — it only consumes the
// sample arrays this returns. Tests mock `PerfSampler` directly and DO NOT need
// this file (受け入れ基準 2: 採取アダプタをモック).
//
// Memory: reads `performance.memory.usedJSHeapSize` when present (Chromium
// renderer), else `process.memoryUsage().heapUsed` (Node/Electron main), else 0
// — a defensive read that never throws in a headless/unknown environment.

import type { PerfSampler } from '../../domain/perf/index';

/** Optional Chromium `performance.memory` shape (not in lib.dom typings). */
interface PerfWithMemory {
  readonly memory?: { readonly usedJSHeapSize?: number };
  now: () => number;
}

/** Optional Node `process.memoryUsage` shape (Electron main / Node tests). */
interface MaybeProcess {
  readonly memoryUsage?: () => { readonly heapUsed?: number };
}

function readMemoryBytes(): number {
  const perf = globalThis.performance as unknown as PerfWithMemory | undefined;
  const heap = perf?.memory?.usedJSHeapSize;
  if (typeof heap === 'number' && Number.isFinite(heap)) return heap;
  const proc = (globalThis as { process?: MaybeProcess }).process;
  const nodeHeap = proc?.memoryUsage?.().heapUsed;
  if (typeof nodeHeap === 'number' && Number.isFinite(nodeHeap)) return nodeHeap;
  return 0;
}

function now(): number {
  const perf = globalThis.performance as unknown as PerfWithMemory | undefined;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

/**
 * The real sampler. `sampleFrameTimes` runs `action(frame)` `frames` times,
 * recording the wall-clock ms BETWEEN successive frames (the frame time), which
 * the pure `fpsFromFrameTimes` converts to a representative FPS. `measureResponse`
 * times one confirmed commit (技術方針 R5: 操作確定の応答). `readMemoryBytes`
 * reads the current heap defensively.
 */
export function createRealSampler(): PerfSampler {
  return {
    sampleFrameTimes(action, frames) {
      const times: number[] = [];
      let prev = now();
      for (let f = 0; f < frames; f += 1) {
        action(f);
        const t = now();
        times.push(t - prev);
        prev = t;
      }
      return times;
    },
    measureResponse(commit) {
      const start = now();
      commit();
      return now() - start;
    },
    readMemoryBytes,
  };
}
