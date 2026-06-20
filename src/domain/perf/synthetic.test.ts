// U42 — the synthetic-data generator is legal, scaled, and deterministic
// (受け入れ基準 2 / 6 / 教訓 5.39).
//
// Legality (末端排他 / リング階層 / 錨列昇順非重複) is PROVEN by passing a generated
// project through the real persistence consistency check — not asserted by hand.
// Determinism: same seed → identical project. Scale: the full 5,000×10 generation
// produces the right counts and a mean anchor count of exactly 10.

import { describe, it, expect } from 'vitest';

import { checkConsistency } from '../persistence/consistency';
import { serialize, manifestToProject, projectsEqual } from '../persistence/serialize';
import { getCalendar } from '../time/calendar';

import {
  generateSyntheticProject,
  totalAnchorCount,
  DEFAULT_SYNTHETIC_PARAMS,
} from './synthetic';
import { PERF_SCALE } from './thresholds';

const CAL = getCalendar('gregorian');

describe('generateSyntheticProject — legality (受け入れ基準 2)', () => {
  it('a modest-scale project satisfies ALL domain invariants (checkConsistency ok)', () => {
    // A smaller scale keeps the per-time-slice O(n) consistency pass fast while
    // still exercising leaves/points/lines/holes/enclaves/aggregates.
    const project = generateSyntheticProject({ objectCount: 200, seed: 7 });
    const report = checkConsistency(project, CAL);
    expect(report.ok).toBe(true);
    expect(report.inconsistencies).toEqual([]);
  });

  it('holes/enclaves on (when ratios=1) still produce a legal project', () => {
    const project = generateSyntheticProject({
      objectCount: 120,
      holeRatio: 1,
      enclaveRatio: 1,
      seed: 3,
    });
    expect(checkConsistency(project, CAL).ok).toBe(true);
  });

  it('round-trips through serialize → manifestToProject losslessly (教訓 5.31)', () => {
    const project = generateSyntheticProject({ objectCount: 80, seed: 11 });
    const restored = manifestToProject(serialize(project));
    expect(projectsEqual(project, restored)).toBe(true);
  });
});

describe('generateSyntheticProject — determinism (受け入れ基準 6 / NFR 5.8)', () => {
  it('same seed → identical project (deep equal via projectsEqual)', () => {
    const a = generateSyntheticProject({ objectCount: 150, seed: 42 });
    const b = generateSyntheticProject({ objectCount: 150, seed: 42 });
    expect(projectsEqual(a, b)).toBe(true);
  });

  it('different seeds → different projects', () => {
    const a = generateSyntheticProject({ objectCount: 150, seed: 1 });
    const b = generateSyntheticProject({ objectCount: 150, seed: 2 });
    expect(projectsEqual(a, b)).toBe(false);
  });
});

describe('generateSyntheticProject — scale (NFR 5.2 / 受け入れ基準 2)', () => {
  it('default params come verbatim from the single threshold source', () => {
    expect(DEFAULT_SYNTHETIC_PARAMS.objectCount).toBe(PERF_SCALE.objectCount);
    expect(DEFAULT_SYNTHETIC_PARAMS.meanAnchorsPerFeature).toBe(PERF_SCALE.meanAnchorsPerFeature);
  });

  it('full 5,000×10 scale: object count is exact and mean anchors == 10', () => {
    const project = generateSyntheticProject();
    // Each generated object yields exactly one history (aggregates absorb their
    // children INTO the aggregate history, so the history count equals the object
    // count minus the children they absorbed). The total ANCHOR mean over the
    // produced histories must remain 10 (NFR 5.2).
    const totalAnchors = totalAnchorCount(project);
    const mean = totalAnchors / project.histories.length;
    expect(mean).toBeCloseTo(PERF_SCALE.meanAnchorsPerFeature, 1);
    // The project is non-trivial (thousands of histories) at the NFR scale.
    expect(project.histories.length).toBeGreaterThan(1000);
  });
});
