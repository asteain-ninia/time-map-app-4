// U25 — property tests: deleting ANY ring through the U25 commands preserves the
// territory↔hole alternation U07 owns (FR-24), and re-organization never leaves a
// dangling parent. Reuses U07's ring-hierarchy generator (技術方針 R7 / 教訓 5.39:
// real values, never literals).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ringHierarchyArb, ringIdFromShapeArb } from '../ring-hierarchy.arbitraries';
import { validateAlternation } from '../ring-hierarchy';
import { RING_KIND, createShape, type Shape } from '../ring';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId } from '../ids';
import { createVertexStore } from '../vertex';
import { RING_DELETE_OUTCOME, deleteHoleRing, deleteTerritoryRing } from './commands';

const ATTRS = createBasicAttributes('p', 0, 100);
const COLOR = createColorInfo(true, '#1', '#2', '#3');

function leafOf(shape: Shape): LeafFeature {
  return createLeafFeature(asFeatureId('F'), ATTRS, COLOR, shape);
}

describe('U25 delete commands preserve the alternation invariant (FR-24)', () => {
  it('deleting any ring (hole or territory) yields an alternation-valid shape or deletes the leaf', () => {
    fc.assert(
      fc.property(
        ringHierarchyArb(3).chain((shape) =>
          ringIdFromShapeArb(shape).map((ringId) => ({ shape, ringId } as const)),
        ),
        ({ shape, ringId }) => {
          const feature = leafOf(shape);
          // Geometry is not meaningful in the structural generator, so use an empty
          // store: the delete commands validate via U07, but the STRUCTURAL
          // alternation is what this property targets; we assert it directly on the
          // reorganized shape to avoid coupling to geometry resolution.
          const store = createVertexStore([]);
          const target = shape.rings.find((r) => r.id === ringId);
          if (target === undefined) return true;

          const out =
            target.kind === RING_KIND.Hole
              ? deleteHoleRing(feature, ringId, store)
              : deleteTerritoryRing(feature, ringId, store);

          if (out.kind === RING_DELETE_OUTCOME.FeatureDeleted) {
            // No territory left → the leaf is deleted; nothing further to check.
            return true;
          }
          if (out.kind === RING_DELETE_OUTCOME.Rejected) {
            // The ring exists with the matching kind and the empty store skips
            // geometry, so the ONLY rejection cause would be a hierarchy invariant
            // break in the reorganized shape — that must NEVER happen (FR-24). Fail
            // the property if it does rather than masking the bug.
            expect(out.reason).toBe('never');
            return false;
          }

          const after = out.feature.shape;
          // The deleted ring is gone.
          expect(after.rings.some((r) => r.id === ringId)).toBe(false);
          // Alternation holds (no hole-at-top-level, no broken parent chain, no
          // dangling parent — U07's structured validator must report valid).
          expect(validateAlternation(after).valid).toBe(true);
          return true;
        },
      ),
      { numRuns: 200 },
    );
  });

  it('an empty shape (0 rings) is alternation-valid (教訓 5.18 boundary)', () => {
    expect(validateAlternation(createShape([])).valid).toBe(true);
  });
});
