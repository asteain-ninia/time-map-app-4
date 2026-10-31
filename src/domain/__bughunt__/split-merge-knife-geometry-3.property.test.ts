// split-merge-knife-geometry の検査 3/3。全体の説明と共有の生成器は split-merge-knife-geometry.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { projectsEqual } from '../persistence/serialize';
import {
  RUNS_41001,
  SEED_41001,
  checkSeamWorldInvariants,
  saveThenLoad,
  seamApplyCmd,
  seamCmdArb,
  seamInitialWorld,
  worldToProject,
} from './split-merge-knife-geometry.arbitraries';

describe('seed=41001 — seam stateful split/merge chains keep every invariant + persist', () => {
  it('chained seam edits stay valid/finite/resolvable/round-trippable after each op', () => {
    fc.assert(
      fc.property(fc.array(seamCmdArb, { minLength: 1, maxLength: 12 }), (cmds) => {
        let world = seamInitialWorld();
        checkSeamWorldInvariants(world);
        for (const cmd of cmds) {
          world = seamApplyCmd(world, cmd);
          checkSeamWorldInvariants(world);
          expect(world.features.length).toBeGreaterThanOrEqual(1);
          // Extra seam-specific check: every stored vertex stays a representative.
          for (const leaf of world.features) {
            for (const ring of leaf.shape.rings) {
              for (const vid of ring.vertexIds) {
                const v = world.store.byId.get(vid);
                if (v) {
                  expect(v.coordinate.lon).toBeGreaterThanOrEqual(-180);
                  expect(v.coordinate.lon).toBeLessThan(180);
                }
              }
            }
          }
        }
        // (S5) the final seam world round-trips through the REAL U14 path.
        const project = worldToProject(world);
        const reloaded = saveThenLoad(project);
        expect(reloaded).toBeDefined();
        if (reloaded === undefined) return;
        expect(projectsEqual(project, reloaded)).toBe(true);
      }),
      { seed: SEED_41001, numRuns: RUNS_41001 },
    );
  });
});
