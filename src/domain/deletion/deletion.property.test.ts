// U31 deletion — property tests (受け入れ基準 7 / NFR 5.8, R7).
//
// For any valid forest and any deletable target, deleting it (sweep + chain prune)
// must (a) leave the post-deletion state satisfying U08's invariants and (b) remove
// EVERY reference to the target from EVERY surviving feature (双方向, no dangling).
// Built from U08's valid-forest arbitrary (教訓 5.39: real factories).

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validForestArb, type ForestSample } from '../hierarchy/arbitraries';
import { buildForest } from '../hierarchy/forest';
import { checkDanglingParents, validateHierarchy } from '../hierarchy/validate';
import type { FeatureId } from '../ids';

import { anchorOf, stateOf } from './fixtures';
import { createDeleteFeatureCommand } from './command';
import { isDeletable, judgeDeletion } from './eligibility';

function verticesOf(sample: ForestSample) {
  return Array.from(sample.store.byId.values());
}

describe('deletion property: 削除後は不変条件を満たし参照が残らない (受け入れ基準 7)', () => {
  it('deleting a deletable target keeps U08 invariants and leaves no reference to it', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.nat(),
        (sample, pick) => {
          const ids: FeatureId[] = sample.features.map((f) => f.id);
          if (ids.length === 0) return true;
          const target = ids[pick % ids.length]!;

          const st = stateOf(anchorOf('an1', sample.features, verticesOf(sample)));
          const verdict = judgeDeletion(st, target);
          if (!isDeletable(verdict)) return true; // only assert the deletable case.

          const out = createDeleteFeatureCommand(st, target).execute(st);
          const survivors = out.state.anchors[0]!.snapshot.features;

          // (a) invariants hold after deletion.
          const validation = validateHierarchy(survivors, {
            vertexStore: out.state.anchors[0]!.snapshot.vertices,
          });
          expect(validation.ok).toBe(true);

          // (b) no surviving feature references the deleted ids (双方向).
          const deleted = out.result.deleted;
          for (const f of survivors) {
            if (f.parentId !== undefined) expect(deleted.has(f.parentId)).toBe(false);
            if (f.kind === 'aggregate') {
              for (const cid of f.childIds) expect(deleted.has(cid)).toBe(false);
            }
          }
          // and no dangling parent links remain.
          expect(checkDanglingParents(buildForest(survivors))).toEqual([]);
          return true;
        },
      ),
      { numRuns: 100 },
    );
  });
});
