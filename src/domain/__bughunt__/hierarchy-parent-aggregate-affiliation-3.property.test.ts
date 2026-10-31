// hierarchy-parent-aggregate-affiliation の検査 3/4。全体の説明と共有の生成器は hierarchy-parent-aggregate-affiliation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  SEED5,
  SEED6,
  SEED7,
  type StatefulModel,
  type StatefulModel6,
  type StatefulModel7,
  StatefulSut,
  StatefulSut6,
  StatefulSut7,
  denseForestArb,
  mixedForestArb,
  statefulCommands6Arb,
  statefulCommands7Arb,
  statefulCommandsArb,
  wideForestArb,
} from './hierarchy-parent-aggregate-affiliation.arbitraries';

describe(`affiliation — STATEFUL model: full invariant battery per command (seed=${SEED5})`, () => {
  it('fc.commands drives the real pipeline; every invariant + metamorphic id holds', () => {
    fc.assert(
      fc.property(mixedForestArb(), statefulCommandsArb, (initial, cmds) => {
        const setup: fc.ModelRunSetup<StatefulModel, StatefulSut> = () => ({
          model: { commits: 0 },
          real: new StatefulSut(initial),
        });
        fc.modelRun(setup, cmds);
      }),
      { seed: SEED5, numRuns: 700 },
    );
  });
});

describe(`affiliation — STATEFUL model #2: live picker/cycle/de-nest + full rewind (seed=${SEED6})`, () => {
  it('fc.commands drives the real pipeline; live single-source + cycle guard + end-of-run rewind hold', () => {
    fc.assert(
      fc.property(wideForestArb(), statefulCommands6Arb, (initial, cmds) => {
        let sut: StatefulSut6 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel6, StatefulSut6> = () => {
          const real = new StatefulSut6(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // Contract (D): full undo-stack rewind == identity over the whole sequence.
        sut?.rewindAll();
      }),
      { seed: SEED6, numRuns: 700 },
    );
  });
});

describe(`affiliation — STATEFUL model #3: live undo/redo stack + series edits (seed=${SEED7})`, () => {
  it('fc.commands interleaves commit/undo/redo/series; stacks stay consistent + redo truncated', () => {
    fc.assert(
      fc.property(denseForestArb(), statefulCommands7Arb, (initial, cmds) => {
        let sut: StatefulSut7 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel7, StatefulSut7> = () => {
          const real = new StatefulSut7(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // End-of-run: the live state is exactly the forward replay of the undo
        // stack from the original baseline (no stale-redo corruption ever leaked).
        sut?.verifyTimeline();
      }),
      { seed: SEED7, numRuns: 700 },
    );
  });
});
