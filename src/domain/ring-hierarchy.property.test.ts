// U07 property-based tests (FR-24, acceptance criterion 4).
//
// Generators produce structurally-valid (alternation-correct) ring hierarchies;
// the property under test is that deleting ANY ring and reorganizing yields a
// hierarchy that STILL satisfies the alternation invariant. Combined with the
// boolean U06 `isAlternationValid` and the structured `validateAlternation`, this
// covers "after any deletion the territory→hole alternation is preserved".

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ringHierarchyArb, ringIdFromShapeArb } from './ring-hierarchy.arbitraries';
import { isAlternationValid } from './ring';
import { deleteRingAndReorganize, validateAlternation } from './ring-hierarchy';

describe('ring-hierarchy reorganization (property)', () => {
  it('generated hierarchies are alternation-valid by construction', () => {
    fc.assert(
      fc.property(ringHierarchyArb(), (shape) => {
        expect(isAlternationValid(shape)).toBe(true);
        expect(validateAlternation(shape).valid).toBe(true);
      }),
    );
  });

  it('deleting any ring preserves the alternation invariant', () => {
    fc.assert(
      fc.property(
        ringHierarchyArb().chain((shape) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, targetId })),
        ),
        ({ shape, targetId }) => {
          const after = deleteRingAndReorganize(shape, targetId);
          // Post-condition: alternation holds after reorganization.
          expect(isAlternationValid(after)).toBe(true);
          expect(validateAlternation(after).valid).toBe(true);
          // The deleted ring is gone.
          expect(after.rings.some((r) => r.id === targetId)).toBe(false);
          // No dangling parent references remain (referential integrity).
          const ids = new Set(after.rings.map((r) => r.id));
          for (const r of after.rings) {
            const parentId = r.kind === 'hole' ? r.parentRingId : r.parentRingId;
            if (parentId !== undefined) expect(ids.has(parentId)).toBe(true);
          }
        },
      ),
    );
  });

  it('deletion is deterministic (same input -> same output)', () => {
    fc.assert(
      fc.property(
        ringHierarchyArb().chain((shape) =>
          ringIdFromShapeArb(shape).map((targetId) => ({ shape, targetId })),
        ),
        ({ shape, targetId }) => {
          const a = deleteRingAndReorganize(shape, targetId);
          const b = deleteRingAndReorganize(shape, targetId);
          expect(a).toEqual(b);
        },
      ),
    );
  });
});
