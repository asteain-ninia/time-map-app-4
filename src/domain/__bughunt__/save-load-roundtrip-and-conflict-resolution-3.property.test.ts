// save-load-roundtrip-and-conflict-resolution の検査 3/3。全体の説明と共有の生成器は save-load-roundtrip-and-conflict-resolution.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';
import { checkConsistency, type Inconsistency } from '../persistence/consistency';
import {
  CAL,
  EditStatefulCmd,
  OverlapCorruptRepairStatefulCmd,
  type ProjectModel,
  type ProjectReal,
  SEED10,
  SaveLoadStatefulCmd,
  UndoOpStatefulCmd,
  boundaryRoundTrips,
  checkBaseInvariants,
  cmdArb,
  corruptOverlapEnd,
  projectArbBounded,
  repairToFixpoint,
} from './save-load-roundtrip-and-conflict-resolution.arbitraries';

describe('bug hunt #4 / INV-2 overlap corruption (seed 46001)', () => {
  it('a bounded end that overruns the next start (INV-2) is DETECTED as TimeConflict', () => {
    fc.assert(
      fc.property(projectArbBounded(), fc.nat(), (project, pick) => {
        const inj = corruptOverlapEnd(project, pick);
        if (inj === null) return;
        const report = checkConsistency(inj.project, CAL);
        if (report.ok) throw new Error('INV-2 overlap corruption was NOT detected');
        const kinds = new Set(report.inconsistencies.map((i) => i.kind));
        if (!kinds.has(inj.expectKind as Inconsistency['kind'])) {
          throw new Error(`expected ${inj.expectKind} but got: ${[...kinds].join(', ')}`);
        }
      }),
      { seed: SEED10, numRuns: 600 },
    );
  });

  it('INV-2 overlap repair is HONEST, converges, and round-trips through Zod', () => {
    fc.assert(
      fc.property(projectArbBounded(), fc.nat(), (project, pick) => {
        const inj = corruptOverlapEnd(project, pick);
        if (inj === null) return;
        const fix = repairToFixpoint(inj.project);
        if (fix.honestyViolated) {
          throw new Error('applyRepairChecked reported resolved:true while growing/leaving target');
        }
        if (!fix.converged) {
          throw new Error(`INV-2 overlap repair did not converge (stuck=${fix.stuck})`);
        }
        const finalReport = checkConsistency(fix.project, CAL);
        if (!finalReport.ok) {
          throw new Error(
            `post-repair still inconsistent: ${finalReport.inconsistencies.map((i) => i.kind).join(', ')}`,
          );
        }
        const rt = boundaryRoundTrips(fix.project);
        if (!rt.ok) throw new Error(`repaired project failed boundary round-trip (${rt.reason})`);
      }),
      { seed: SEED10, numRuns: 600 },
    );
  });
});

describe('bug hunt #4 / bounded-series stateful with conflict-resolution (seed 46001)', () => {
  it('a stateful sequence over a bounded-gap base (edit / save→load / undo / overlap-corrupt→repair) holds every law', () => {
    const allCommands = fc.commands(
      [
        cmdArb().map((c) => new EditStatefulCmd(c)),
        fc.constant(new SaveLoadStatefulCmd()),
        cmdArb().map((c) => new UndoOpStatefulCmd(c)),
        fc.nat().map((pick) => new OverlapCorruptRepairStatefulCmd(pick)),
      ],
      { maxCommands: 26 },
    );
    fc.assert(
      fc.property(projectArbBounded(), allCommands, (initial, cmds) => {
        const base = checkBaseInvariants(initial);
        if (!base.ok) throw new Error(`bounded stateful base invalid: ${base.failed}`);
        const setup = (): { model: ProjectModel; real: ProjectReal } => ({
          model: { historyCount: initial.histories.length },
          real: { project: initial },
        });
        fc.modelRun(setup, cmds);
      }),
      { seed: SEED10, numRuns: 350 },
    );
  });
});
