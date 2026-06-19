// U10 measurement harness — criterion 5 (NFR 5.2): exclusion detection on a
// 5,000-terminal synthetic dataset runs in a realistic time, and the indexed
// detector's geometric-predicate call count is dramatically lower than the naive
// all-pairs reference. Run as a normal Vitest test so `npm run test` exercises
// it; timings are recorded to the console (not asserted, since wall-clock varies
// by machine — 教訓1.7: keep a measurable indicator, assert the structural win).

import { describe, expect, it } from 'vitest';

import { createCoordinate } from '../coordinate';
import { asFeatureId } from '../ids';
import type { GeoMultiPolygon, GeoRing } from '../geometry/types';
import {
  detectTerminalOverlaps,
  detectTerminalOverlapsNaive,
  type PredicateCounter,
  type TerminalShape,
} from './overlap';

function square(x: number, y: number, size: number): GeoMultiPolygon {
  const ring: GeoRing = [
    createCoordinate(x, y),
    createCoordinate(x + size, y),
    createCoordinate(x + size, y + size),
    createCoordinate(x, y + size),
  ];
  return [[ring]];
}

/**
 * A deterministic synthetic field of `n` mostly-disjoint terminals laid on a
 * grid with a fixed pseudo-random jitter (no RNG → reproducible). A small unit
 * size relative to the grid pitch keeps overlaps sparse, like a real map.
 */
function syntheticTerminals(n: number): TerminalShape[] {
  const cols = Math.ceil(Math.sqrt(n));
  const pitch = 8;
  const size = 6;
  const out: TerminalShape[] = [];
  for (let i = 0; i < n; i += 1) {
    const gx = (i % cols) * pitch;
    const gy = Math.floor(i / cols) * pitch;
    // Deterministic jitter in [0, 4) from a hash of i (no Math.random). With a
    // pitch of 8 and size 6, this makes SOME neighbours' bboxes touch/overlap —
    // so the predicate IS exercised on real candidates — while most cells stay
    // apart, keeping the predicate-call count far below the all-pairs total.
    const jitter = ((i * 2654435761) % 1000) / 250;
    out.push({ id: asFeatureId(`F${i}`), shape: square(gx + jitter, gy + jitter, size) });
  }
  return out;
}

describe('criterion 5: 5,000-terminal scale measurement (NFR 5.2)', () => {
  it('detects overlaps on 5,000 terminals within a realistic time and O(n)-ish predicate calls', () => {
    const n = 5000;
    const terminals = syntheticTerminals(n);
    const counter: PredicateCounter = { count: 0 };

    const start = performance.now();
    const pairs = detectTerminalOverlaps(terminals, { seamTurns: [0], counter });
    const elapsedMs = performance.now() - start;

    const allPairs = (n * (n - 1)) / 2; // 12,497,500
    // The structural win: candidate narrowing keeps predicate calls a tiny
    // fraction of the all-pairs count (grid is sparse, so ~O(n)).
    expect(counter.count).toBeLessThan(allPairs / 100);
    // Sanity: the detector still produced a (deterministic) result set.
    expect(Array.isArray(pairs)).toBe(true);

    // Recorded, not asserted (machine-dependent). NFR 5.2 wants "realistic time".
    console.log(
      `[U10 bench] n=${n} indexed: ${elapsedMs.toFixed(1)}ms, predicateCalls=${counter.count} (allPairs=${allPairs})`,
    );
  });

  it('indexed vs naive: same result, far fewer predicate calls (基準3 / 5)', () => {
    // Smaller n so the O(n^2) naive reference stays fast, while still proving the
    // narrowing advantage and result equivalence.
    const n = 300;
    const terminals = syntheticTerminals(n);

    const idxCounter: PredicateCounter = { count: 0 };
    const naiveCounter: PredicateCounter = { count: 0 };

    const tIdx0 = performance.now();
    const indexed = detectTerminalOverlaps(terminals, { seamTurns: [0], counter: idxCounter });
    const tIdx = performance.now() - tIdx0;

    const tNaive0 = performance.now();
    const naive = detectTerminalOverlapsNaive(terminals, { seamTurns: [0], counter: naiveCounter });
    const tNaive = performance.now() - tNaive0;

    // Result sets must match exactly (narrowing loses nothing).
    const keys = (ps: typeof indexed): Set<string> => new Set(ps.map((p) => `${p.a}|${p.b}`));
    expect(keys(indexed)).toEqual(keys(naive));

    // The predicate IS exercised via real candidates (narrowing reaches it)...
    expect(idxCounter.count).toBeGreaterThan(0);
    // ...yet the indexed run calls the costly predicate far less than all-pairs.
    expect(idxCounter.count).toBeLessThan(naiveCounter.count);

    console.log(
      `[U10 bench] n=${n} indexed=${tIdx.toFixed(1)}ms/${idxCounter.count} calls vs naive=${tNaive.toFixed(1)}ms/${naiveCounter.count} calls`,
    );
  });
});
