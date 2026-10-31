// hierarchy-parent-aggregate-affiliation の検査 4/4。全体の説明と共有の生成器は hierarchy-parent-aggregate-affiliation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';
import {
  SEED8,
  type StatefulModel8,
  StatefulSut8,
  mediumForestArb,
  statefulCommands8Arb,
} from './hierarchy-parent-aggregate-affiliation.arbitraries';

describe(`affiliation — STATEFUL model #4: live resolveAt/applyPastEdit + create∘isolate (seed=${SEED8})`, () => {
  it('fc.commands drives the real pipeline; temporal reader + history edits + inverse hold', () => {
    fc.assert(
      fc.property(mediumForestArb(), statefulCommands8Arb, (initial, cmds) => {
        let sut: StatefulSut8 | undefined;
        const setup: fc.ModelRunSetup<StatefulModel8, StatefulSut8> = () => {
          const real = new StatefulSut8(initial);
          sut = real;
          return { model: { commits: 0 }, real };
        };
        fc.modelRun(setup, cmds);
        // End-of-run: forward replay == live state, and full reverse rewind ==
        // original baseline (no journal drift across the whole interleaved run).
        sut?.verifyTimeline();
      }),
      { seed: SEED8, numRuns: 800 },
    );
  });
});
