import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { asFeatureId } from '../ids';
import { GAP_AGGREGATE_ID, validForestArb, withGap } from './arbitraries';
import { buildForest } from './forest';
import { derivedDepth } from './depth';
import {
  HIERARCHY_VIOLATION,
  checkAggregateShapes,
  validateHierarchy,
} from './validate';

// 5. fast-check forest invariant preservation
describe('forest invariants hold for any valid forest (受け入れ基準5)', () => {
  it('a valid forest has no top-level / cycle / dangling / shape violations', () => {
    fc.assert(
      fc.property(validForestArb(), ({ features, store }) => {
        const result = validateHierarchy(features, { vertexStore: store });
        // Valid by construction: aggregates tile their children with no gap/overflow,
        // every aggregate has children, no cycles, no dangling links.
        expect(result.violations.filter(
          (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
        )).toHaveLength(0);
        expect(result.violations.filter(
          (v) => v.kind === HIERARCHY_VIOLATION.Cycle,
        )).toHaveLength(0);
        expect(result.violations.filter(
          (v) => v.kind === HIERARCHY_VIOLATION.DanglingParent,
        )).toHaveLength(0);
      }),
      { numRuns: 50 },
    );
  });

  it('child depth = parent depth + 1 for every parented feature', () => {
    fc.assert(
      fc.property(validForestArb(), ({ features }) => {
        const forest = buildForest(features);
        for (const f of features) {
          if (f.parentId === undefined) {
            expect(derivedDepth(forest, f.id)).toBe(0);
          } else {
            const parentDepth = derivedDepth(forest, f.parentId);
            expect(derivedDepth(forest, f.id)).toBe(parentDepth + 1);
          }
        }
      }),
      { numRuns: 50 },
    );
  });

  it('a deliberately broken forest (added cycle) is always detected (no false negative)', () => {
    fc.assert(
      fc.property(validForestArb(), ({ features }) => {
        // Turn the first root aggregate into a self-cycle.
        const forest0 = buildForest(features);
        const rootId = forest0.rootIds[0];
        if (rootId === undefined) return; // empty case skipped
        const broken = features.map((f) =>
          f.id === rootId ? ({ ...f, parentId: rootId } as typeof f) : f,
        );
        const result = validateHierarchy(broken);
        expect(result.violations.some((v) => v.kind === HIERARCHY_VIOLATION.Cycle)).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('a deliberately introduced shape gap is always detected (no false negative)', () => {
    fc.assert(
      fc.property(validForestArb(), (sample) => {
        // Baseline: the valid forest has no shape mismatch.
        const base = validateHierarchy(sample.features, { vertexStore: sample.store });
        expect(
          base.violations.filter((v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch),
        ).toHaveLength(0);

        // Mutate: append an aggregate whose children frame an interior hole.
        const broken = withGap(sample);
        const result = validateHierarchy(broken.features, { vertexStore: broken.store });
        const mismatches = result.violations.filter(
          (v) => v.kind === HIERARCHY_VIOLATION.AggregateShapeMismatch,
        );
        // The gap MUST be detected, and on the holed aggregate specifically.
        expect(mismatches.length).toBeGreaterThanOrEqual(1);
        expect(mismatches.some((v) => v.featureIds.includes(GAP_AGGREGATE_ID))).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('a deliberately broken top-level flag is always detected (no false negative)', () => {
    fc.assert(
      fc.property(validForestArb(), ({ features }) => {
        const forest = buildForest(features);
        // Mark a NON-root feature as top-level=true (a mismatch), or a root as
        // top-level=false. Pick a parented feature when available.
        const parented = features.find((f) => f.parentId !== undefined);
        const flags = new Map<ReturnType<typeof asFeatureId>, boolean>();
        if (parented !== undefined) {
          flags.set(parented.id, true); // claims root yet nested -> mismatch
        } else {
          const rootId = forest.rootIds[0];
          if (rootId === undefined) return;
          flags.set(rootId, false); // claims nested yet rootless -> mismatch
        }
        const result = validateHierarchy(features, { topLevelFlags: flags });
        expect(
          result.violations.some((v) => v.kind === HIERARCHY_VIOLATION.TopLevelMismatch),
        ).toBe(true);
      }),
      { numRuns: 50 },
    );
  });

  it('checkAggregateShapes never throws on any valid forest (finite, pure)', () => {
    fc.assert(
      fc.property(validForestArb(), ({ features, store }) => {
        const forest = buildForest(features);
        expect(() => checkAggregateShapes(forest, store)).not.toThrow();
      }),
      { numRuns: 30 },
    );
  });
});
