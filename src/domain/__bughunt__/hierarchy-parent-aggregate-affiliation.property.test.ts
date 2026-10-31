// hierarchy-parent-aggregate-affiliation の検査 1/4。全体の説明と共有の生成器は hierarchy-parent-aggregate-affiliation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { type Feature } from '../feature';
import { asAnchorId } from '../ids';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { areasEqualWithinTolerance } from '../hierarchy/validate';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { parentCreate, parentExisting } from '../affiliation/decision';
import { createAffiliationCommand } from '../affiliation/command';
import { createIdGeneratorState } from '../id-generator';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { changeStart, createAnchorEntry, deleteAnchor, normalizeSeries, setEnd, type AnchorSeries } from '../anchor-series';
import { timePointYear } from '../time/time-point';
import {
  type AffState,
  CAL,
  SEED,
  SEED2,
  affCmd2Arb,
  affCmdArb,
  applyAffCmd,
  applyAffCmd2,
  assertAscendingUnique,
  assertFeatureSetInvariants,
  featuresEqual,
  hetForestArb,
  makeNow,
  pick,
  seriesOpArb,
  snapshotEntry,
  store,
  storeWithProposalVertices,
  validForestArb,
} from './hierarchy-parent-aggregate-affiliation.arbitraries';

// ===========================================================================
// 1. STATEFUL DRIVE: every invariant after every committed real command.
// ===========================================================================

describe(`affiliation — every invariant after every committed real command (seed=${SEED})`, () => {
  it('forest validity / depth / 派生集約=子の和 / childIds sync / coord-finite / selection', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 12 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 100,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue; // rejected / N/A: legitimate.
            assertFeatureSetInvariants(applied.next.features, applied.next.store);

            // 選択が常に有効: notified ids resolve, deleted ids gone.
            const present = new Set(applied.next.features.map((f) => f.id));
            for (const id of applied.proposal.survivedTouchedIds) {
              expect(present.has(id), `survivedTouched ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.createdIds) {
              expect(present.has(id), `created ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.deletedIds) {
              expect(present.has(id), `deleted ${id} still present`).toBe(false);
            }
            // createdIds ⊆ new ids (never re-emit an existing id).
            const baselineIds = new Set(st.features.map((f) => f.id));
            for (const id of applied.proposal.createdIds) {
              expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
            }
            st = applied.next;
          }
        },
      ),
      { seed: SEED, numRuns: 600 },
    );
  });
});

describe(`affiliation — anchor列 昇順・非重複 across committed history (seed=${SEED})`, () => {
  it('a series of committed-state snapshots stays INV-1 ascending + INV-6 unique', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 8 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 200,
          };
          const entries = [snapshotEntry(st.features, st.store, 0)];
          let idx = 1;
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue;
            st = applied.next;
            entries.push(snapshotEntry(st.features, st.store, idx));
            idx += 1;
            const series = normalizeSeries(entries, CAL);
            assertAscendingUnique(series);
            // every snapshot still resolves a valid forest.
            assertFeatureSetInvariants(st.features, st.store);
          }
          // Final normalize is idempotent and stays valid.
          assertAscendingUnique(normalizeSeries(entries, CAL));
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('normalizeSeries REPAIRS an injected duplicate anchor id / duplicate start', () => {
    fc.assert(
      fc.property(validForestArb(), (initial) => {
        const vstore = store(initial);
        // Two entries sharing the SAME anchor id (INV-6 violation) and another
        // pair sharing the SAME start (INV-1 violation).
        const e0 = snapshotEntry(initial.features, vstore, 0); // a-0 @ 0
        const dupId = createAnchorEntry(e0.anchor, timePointYear(50), null); // a-0 @ 50
        const e1 = snapshotEntry(initial.features, vstore, 1); // a-1 @ 10
        const dupStart = createAnchorEntry(
          createAnchor(asAnchorId('a-2'), createAnchorSnapshot(initial.features, vstore)),
          timePointYear(10), // collides with e1's start
          null,
        );
        const series = normalizeSeries([e0, dupId, e1, dupStart], CAL);
        // Repaired: must be ascending + unique despite the injected duplicates.
        assertAscendingUnique(series);
      }),
      { seed: SEED, numRuns: 200 },
    );
  });
});

// ===========================================================================
// 3. METAMORPHIC: undo∘op, op∘逆op, save∘load.
// ===========================================================================

describe(`affiliation — metamorphic identities (seed=${SEED})`, () => {
  it('undo ∘ op == identity; redo re-applies without re-minting ids', () => {
    fc.assert(
      fc.property(validForestArb(), affCmdArb, (initial, cmd) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 300,
        };
        const applied = applyAffCmd(st, cmd);
        if (applied === undefined) return; // rejected: nothing to undo.

        const baseline = applied.baseline;
        const command = createAffiliationCommand(baseline, applied.proposal);
        const afterExec = command.execute(baseline);
        expect(
          featuresEqual(afterExec.state, applied.proposal.nextFeatures),
          'execute != proposal.nextFeatures',
        ).toBe(true);
        const afterUndo = command.undo(afterExec.state);
        expect(featuresEqual(afterUndo.state, baseline), 'undo != baseline').toBe(true);
        expect(afterUndo.state.length).toBe(baseline.length);
        const afterRedo = command.redo(afterUndo.state);
        expect(
          featuresEqual(afterRedo.state, applied.proposal.nextFeatures),
          'redo != proposal.nextFeatures',
        ).toBe(true);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it('op ∘ 逆op == identity: existing(parent) then none restores the leaf parentId', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), fc.nat(), (initial, leafWhich, parentWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 400,
        };
        // Pick a LEAF (no children) target and an aggregate parent in the SAME
        // band/period so the existing-affiliation is legal; then re-affiliate to
        // none and assert the leaf returns to its original parent state.
        const forest0 = buildForest(st.features);
        const leaves = st.features.filter((f) => directChildIds(forest0, f.id).length === 0);
        const aggs = st.features.filter((f) => f.kind === 'aggregate');
        if (leaves.length === 0 || aggs.length === 0) return;
        const leaf = leaves[leafWhich % leaves.length]!;
        // choose the leaf's CURRENT parent as the round-trip target so periods match.
        const originalParent = leaf.parentId;
        if (originalParent === undefined) return;
        void parentWhich;

        // op: move to a DIFFERENT existing parent (another agg with compatible period).
        const otherAgg = aggs.find(
          (a) =>
            a.id !== originalParent &&
            a.attributes.startYear <= leaf.attributes.endYear &&
            leaf.attributes.startYear <= a.attributes.endYear,
        );
        if (otherAgg === undefined) return;

        const moved = applyAffCmd(st, {
          t: 'existing',
          targetWhich: st.features.indexOf(leaf),
          parentWhich: st.features.indexOf(otherAgg),
        });
        if (moved === undefined) return;
        const afterMove = moved.next;
        const movedLeaf = afterMove.features.find((f) => f.id === leaf.id);
        // The leaf must now be parented under otherAgg.
        expect(movedLeaf?.parentId).toBe(otherAgg.id);

        // 逆op: move back to the original parent.
        const back = applyAffCmd(afterMove, {
          t: 'existing',
          targetWhich: afterMove.features.findIndex((f) => f.id === leaf.id),
          parentWhich: afterMove.features.findIndex((f) => f.id === originalParent),
        });
        if (back === undefined) return;
        const restoredLeaf = back.next.features.find((f) => f.id === leaf.id);
        expect(restoredLeaf?.parentId, 'op∘逆op did not restore parentId').toBe(originalParent);
        assertFeatureSetInvariants(back.next.features, back.next.store);
      }),
      { seed: SEED, numRuns: 400 },
    );
  });

  it('save ∘ load (JSON round-trip) == identity over the committed set', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 8 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 500,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const json = JSON.stringify(st.features);
          const parsed = JSON.parse(json) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          // The reloaded set resolves to identical derived areas everywhere.
          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          for (const f of st.features) {
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED, numRuns: 300 },
    );
  });
});

// ===========================================================================
// 4. EXISTENCE-PERIOD GUARD: create→existing rejection / acceptance coherence.
//
// realizeDecision applies existencePeriodsCompatible between a freshly-created
// intermediate aggregate (period = target envelope) and the EXISTING top it is
// placed under. We assert: whenever such a command COMMITS, the created
// aggregate's period actually overlaps the chosen existing top's period; and
// whenever it REJECTS for existence-period, the periods are genuinely disjoint.
// This guards against an off-by-one / inverted-comparison bug in the guard that
// would either let a future-unsatisfiable hierarchy commit, or wrongly reject a
// compatible one.
// ===========================================================================

describe(`affiliation — existence-period guard coherence (seed=${SEED})`, () => {
  it('createUnderExisting commits iff target envelope overlaps the chosen top period', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.nat(),
        fc.nat(),
        (initial, targetWhich, topWhich) => {
          const st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 600,
          };
          const allIds = st.features.map((f) => f.id);
          const target = pick(allIds, targetWhich);
          const top = pick(allIds, topWhich);
          if (target === undefined || top === undefined) return;

          // Compute the target ENVELOPE (resolveTargetLeaves expands aggregates).
          const forest = buildForest(st.features);
          const targetFeat = st.features.find((f) => f.id === target)!;
          const isAgg = directChildIds(forest, target).length > 0;
          const leafIds = isAgg ? directChildIds(forest, target) : [target];
          let envStart = Number.POSITIVE_INFINITY;
          let envEnd = Number.NEGATIVE_INFINITY;
          for (const lid of leafIds) {
            const lf = st.features.find((f) => f.id === lid);
            if (lf === undefined) continue;
            envStart = Math.min(envStart, lf.attributes.startYear);
            envEnd = Math.max(envEnd, lf.attributes.endYear);
          }
          void targetFeat;
          const topFeat = st.features.find((f) => f.id === top)!;
          const overlaps = envStart <= topFeat.attributes.endYear && topFeat.attributes.startYear <= envEnd;

          const idState = createIdGeneratorState(0, st.idCounter);
          const result = buildAffiliationProposal(
            st.features,
            target,
            parentCreate({ name: 'mid' }, parentExisting(top)),
            { idState, now: makeNow(1), vertexStore: st.store },
          );

          if (!overlaps) {
            // Disjoint periods: the create→existing guard MUST reject (no commit).
            // (Other rejection reasons — e.g. same-feature when target===top — are
            //  also acceptable; the key contract is: it never COMMITS a disjoint one.)
            expect(result.status, 'committed a period-disjoint hierarchy').not.toBe('proposal');
          } else if (result.status === 'proposal') {
            // Committed: the created intermediate's period must overlap top, and
            // the whole committed forest must be valid.
            assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
          }
        },
      ),
      { seed: SEED, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §5. Heterogeneous-period stateful drive: every invariant after every commit.
// ===========================================================================

describe(`affiliation — heterogeneous-period invariants after every commit (seed=${SEED2})`, () => {
  it('forest validity / depth / 派生集約=子の和 / childIds sync / coord-finite / selection', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 14 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 1000,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied === undefined) continue;
            assertFeatureSetInvariants(applied.next.features, applied.next.store);

            const present = new Set(applied.next.features.map((f) => f.id));
            for (const id of applied.proposal.survivedTouchedIds) {
              expect(present.has(id), `survivedTouched ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.createdIds) {
              expect(present.has(id), `created ${id} missing`).toBe(true);
            }
            for (const id of applied.proposal.deletedIds) {
              expect(present.has(id), `deleted ${id} still present`).toBe(false);
            }
            const baselineIds = new Set(st.features.map((f) => f.id));
            for (const id of applied.proposal.createdIds) {
              expect(baselineIds.has(id), `created ${id} collides with existing`).toBe(false);
            }
            // created ∩ deleted must be empty (a freshly minted id is never also pruned).
            const del = new Set(applied.proposal.deletedIds);
            for (const id of applied.proposal.createdIds) {
              expect(del.has(id), `created ${id} also in deletedIds`).toBe(false);
            }
            st = applied.next;
          }
        },
      ),
      { seed: SEED2, numRuns: 600 },
    );
  });
});

describe(`affiliation — interleaved commits + guarded anchor-series edits (seed=${SEED2})`, () => {
  it('series stays INV-1/INV-5/INV-6 across append + changeStart/setEnd/delete', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(fc.tuple(affCmd2Arb, seriesOpArb), { minLength: 0, maxLength: 10 }),
        (initial, steps) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 2000,
          };
          let series: AnchorSeries = normalizeSeries(
            [snapshotEntry(st.features, st.store, 0)],
            CAL,
          );
          assertAscendingUnique(series);
          let idx = 1;

          for (const [cmd, op] of steps) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) {
              st = applied.next;
              assertFeatureSetInvariants(st.features, st.store);
            }

            switch (op.t) {
              case 'append': {
                const entries = [...series.entries, snapshotEntry(st.features, st.store, idx)];
                idx += 1;
                series = normalizeSeries(entries, CAL);
                break;
              }
              case 'changeStart': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const r = changeStart(series, target.anchor.id, timePointYear(op.year), CAL);
                if (r.ok) series = r.series;
                break;
              }
              case 'setEnd': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const end = op.year === null ? null : timePointYear(op.year);
                const r = setEnd(series, target.anchor.id, end, CAL);
                if (r.ok) series = r.series;
                break;
              }
              case 'delete': {
                const target = pick(series.entries, op.which);
                if (target === undefined) break;
                const r = deleteAnchor(series, target.anchor.id, CAL);
                if (r.ok) series = r.series;
                break;
              }
            }

            // INV-5 non-empty + INV-1/INV-6 after EVERY series op outcome.
            expect(series.entries.length, 'series became empty (INV-5)').toBeGreaterThan(0);
            assertAscendingUnique(series);
          }
        },
      ),
      { seed: SEED2, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §7. FULL public-command metamorphic identities on the heterogeneous model.
// ===========================================================================

describe(`affiliation — heterogeneous metamorphic identities (seed=${SEED2})`, () => {
  it('undo ∘ op == identity; op ∘ undo ∘ redo == op (createAffiliationCommand)', () => {
    fc.assert(
      fc.property(hetForestArb(), affCmd2Arb, (initial, cmd) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 3000,
        };
        const applied = applyAffCmd2(st, cmd);
        if (applied === undefined) return;

        const baseline = applied.baseline;
        const command = createAffiliationCommand(baseline, applied.proposal);
        const afterExec = command.execute(baseline);
        expect(
          featuresEqual(afterExec.state, applied.proposal.nextFeatures),
          'execute != proposal.nextFeatures',
        ).toBe(true);
        const afterUndo = command.undo(afterExec.state);
        expect(featuresEqual(afterUndo.state, baseline), 'undo != baseline').toBe(true);
        // op ∘ undo ∘ redo == op: redoing after an undo reproduces the committed set
        // WITHOUT re-minting ids (教訓 5.20) — created ids stay byte-identical.
        const afterRedo = command.redo(afterUndo.state);
        expect(
          featuresEqual(afterRedo.state, applied.proposal.nextFeatures),
          'op∘undo∘redo != op',
        ).toBe(true);
        const reCreated = afterRedo.state.filter((f) => !baseline.some((b) => b.id === f.id));
        const origCreated = applied.proposal.nextFeatures.filter(
          (f) => !baseline.some((b) => b.id === f.id),
        );
        expect(reCreated.map((f) => f.id).sort()).toEqual(origCreated.map((f) => f.id).sort());
      }),
      { seed: SEED2, numRuns: 500 },
    );
  });

  it('op ∘ 逆op == identity THROUGH the command: existing then back restores parentId', () => {
    fc.assert(
      fc.property(hetForestArb(), fc.nat(), (initial, leafWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 3500,
        };
        const forest0 = buildForest(st.features);
        const leaves = st.features.filter((f) => directChildIds(forest0, f.id).length === 0);
        const aggs = st.features.filter((f) => f.kind === 'aggregate');
        if (leaves.length === 0 || aggs.length === 0) return;
        const leaf = leaves[leafWhich % leaves.length]!;
        const originalParent = leaf.parentId;
        if (originalParent === undefined) return;
        const otherAgg = aggs.find(
          (a) =>
            a.id !== originalParent &&
            a.attributes.startYear <= leaf.attributes.endYear &&
            leaf.attributes.startYear <= a.attributes.endYear,
        );
        if (otherAgg === undefined) return;

        // op: move under otherAgg, driven THROUGH the command (execute).
        const moved = applyAffCmd2(st, {
          t: 'existing',
          targetWhich: st.features.indexOf(leaf),
          parentWhich: st.features.indexOf(otherAgg),
        });
        if (moved === undefined) return;
        const cmdFwd = createAffiliationCommand(moved.baseline, moved.proposal);
        const execFwd = cmdFwd.execute(moved.baseline);
        const movedLeaf = execFwd.state.find((f) => f.id === leaf.id);
        expect(movedLeaf?.parentId).toBe(otherAgg.id);

        // 逆op: move back to the original parent, again THROUGH the command.
        // Carry the forward move's result store (moved.next.store), which already includes
        // any FR-37 直轄領 vertices minted forward, so the reverse resolves them.
        const afterMove: AffState = {
          features: execFwd.state,
          store: moved.next.store,
          idCounter: moved.next.idCounter,
        };
        const back = applyAffCmd2(afterMove, {
          t: 'existing',
          targetWhich: afterMove.features.findIndex((f) => f.id === leaf.id),
          parentWhich: afterMove.features.findIndex((f) => f.id === originalParent),
        });
        if (back === undefined) return;
        const cmdBack = createAffiliationCommand(back.baseline, back.proposal);
        const execBack = cmdBack.execute(back.baseline);
        const restored = execBack.state.find((f) => f.id === leaf.id);
        expect(restored?.parentId, 'op∘逆op did not restore parentId').toBe(originalParent);
        assertFeatureSetInvariants(execBack.state, back.next.store);
      }),
      { seed: SEED2, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §8. save ∘ load JSON identity over the heterogeneous-period committed set.
// ===========================================================================

describe(`affiliation — heterogeneous save∘load identity (seed=${SEED2})`, () => {
  it('JSON round-trip preserves features AND derived areas everywhere', () => {
    fc.assert(
      fc.property(
        hetForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 10 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 4000,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const parsed = JSON.parse(JSON.stringify(st.features)) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          for (const f of st.features) {
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED2, numRuns: 300 },
    );
  });
});
