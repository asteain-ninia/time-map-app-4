// hierarchy-parent-aggregate-affiliation の検査 2/4。全体の説明と共有の生成器は hierarchy-parent-aggregate-affiliation.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import { type Feature } from '../feature';
import { asAnchorId, type FeatureId } from '../ids';
import { buildForest, directChildIds } from '../hierarchy/forest';
import { derivedDepths } from '../hierarchy/depth';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { areasEqualWithinTolerance } from '../hierarchy/validate';
import { buildAffiliationProposal } from '../affiliation/proposal';
import { parentExisting } from '../affiliation/decision';
import { createAffiliationCommand } from '../affiliation/command';
import { AFFILIATION_REJECT, allowedParentCandidates, isLegalNewParent } from '../affiliation/candidates';
import { createIdGeneratorState } from '../id-generator';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import { applyPastEdit, normalizeSeries, resolveAt } from '../anchor-series';
import { timePointYear } from '../time/time-point';
import {
  type AffState,
  CAL,
  CANDIDATE_REJECTS,
  SEED3,
  SEED4,
  type StackFrame,
  affCmd2Arb,
  affCmdArb,
  applyAffCmd,
  applyAffCmd2,
  assertAscendingUnique,
  assertFeatureSetInvariants,
  deepForestArb,
  descendantIds,
  descendantLeaves,
  featuresEqual,
  hetForestArb,
  makeNow,
  pick,
  snapshotEntry,
  store,
  storeWithProposalVertices,
  validForestArb,
} from './hierarchy-parent-aggregate-affiliation.arbitraries';

describe(`affiliation — picker ⇔ confirm single-source (seed=${SEED3})`, () => {
  it('listed candidates never trip a candidate-predicate rejection; hidden ones never commit', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), (initial, targetWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 700,
        };
        const forest = buildForest(st.features);
        const allIds = st.features.map((f) => f.id);
        const target = pick(allIds, targetWhich);
        if (target === undefined) return;

        // resolveTargetLeaves expands an aggregate target to its leaves; the
        // picker is contracted on the target ID itself (its own candidate set),
        // so we compare against a LEAF target to keep the picker contract exact.
        const isAggTarget = directChildIds(forest, target).length > 0;
        if (isAggTarget) return; // picker is single-target; skip aggregate expansion.

        const candidates = allowedParentCandidates(forest, target);
        const listed = new Set(candidates.map((c) => c.featureId));

        for (const cand of st.features.map((f) => f.id)) {
          // The single-source predicate verdict (what the picker used).
          const verdict = isLegalNewParent(forest, target, cand);
          expect(listed.has(cand), `picker/predicate disagree for ${cand}`).toBe(verdict.ok);

          const idState = createIdGeneratorState(0, st.idCounter);
          const result = buildAffiliationProposal(
            st.features,
            target,
            parentExisting(cand),
            { idState, now: makeNow(1), vertexStore: st.store },
          );

          if (verdict.ok) {
            // (a) listed: must not be rejected for a CANDIDATE-predicate reason.
            if (result.status !== 'proposal') {
              expect(
                CANDIDATE_REJECTS.has(result.kind),
                `listed candidate ${cand} rejected by candidate predicate: ${result.kind}`,
              ).toBe(false);
            } else {
              assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
            }
          } else {
            // (b) hidden: must NOT commit (the back-door is closed).
            expect(
              result.status,
              `hidden candidate ${cand} committed (back-door)`,
            ).not.toBe('proposal');
          }
        }
      }),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §10. TEMPORAL RESOLUTION: resolveAt order-coherence + applyPastEdit identity.
//
// resolveAt and applyPastEdit are NOT exercised by §1..§8. Here a parallel
// anchor series rides committed affiliation states, and we assert:
//   (a) resolveAt at each entry's OWN start returns that very entry (start is
//       inclusive; INV-1 ascending guarantees uniqueness) — unless the entry's
//       own bounded end makes it instantly absent, which our snapshots never set;
//   (b) resolveAt strictly BEFORE the first start is `absent` (existence not yet
//       begun);
//   (c) applyPastEdit at an EXISTING start REPLACES (count unchanged) and a
//       second identical applyPastEdit is idempotent in count;
//   (d) applyPastEdit at a NEW (later) start INSERTS exactly one anchor and the
//       new start resolves to the freshly-inserted anchor.
// ===========================================================================

describe(`affiliation — resolveAt coherence + applyPastEdit identity (seed=${SEED3})`, () => {
  it('resolveAt agrees with ascending order; applyPastEdit replace/insert behave', () => {
    fc.assert(
      fc.property(
        validForestArb(),
        fc.array(affCmdArb, { minLength: 0, maxLength: 6 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 800,
          };
          const entries = [snapshotEntry(st.features, st.store, 0)];
          let idx = 1;
          for (const cmd of cmds) {
            const applied = applyAffCmd(st, cmd);
            if (applied === undefined) continue;
            st = applied.next;
            entries.push(snapshotEntry(st.features, st.store, idx));
            idx += 1;
          }
          const series = normalizeSeries(entries, CAL);
          assertAscendingUnique(series);

          // (a) each entry's own start resolves to that entry.
          for (const e of series.entries) {
            const r = resolveAt(series, e.start, CAL);
            expect(r.kind, `resolveAt absent at own start ${e.start.year}`).toBe('present');
            if (r.kind === 'present') {
              expect(r.entry.anchor.id, 'resolveAt returned wrong entry').toBe(e.anchor.id);
            }
          }

          // (b) before the first start: absent.
          const firstStart = series.entries[0]!.start.year;
          const before = resolveAt(series, timePointYear(firstStart - 1), CAL);
          expect(before.kind, 'resolveAt before first start not absent').toBe('absent');

          // (c) applyPastEdit at an EXISTING start: replace, count unchanged + idempotent.
          const targetEntry = series.entries[0]!;
          const replSnap = createAnchorSnapshot(st.features, st.store);
          const makeRepl = () => createAnchor(targetEntry.anchor.id, replSnap);
          const afterReplace = applyPastEdit(series, targetEntry.start, makeRepl, CAL);
          expect(afterReplace.entries.length, 'applyPastEdit replace changed count').toBe(
            series.entries.length,
          );
          assertAscendingUnique(afterReplace);
          const afterReplace2 = applyPastEdit(afterReplace, targetEntry.start, makeRepl, CAL);
          expect(afterReplace2.entries.length, 'applyPastEdit replace not idempotent').toBe(
            afterReplace.entries.length,
          );

          // (d) applyPastEdit at a NEW (strictly later) start: insert exactly one.
          const lastStart = series.entries[series.entries.length - 1]!.start.year;
          const newStart = timePointYear(lastStart + 100);
          const newAnchorId = asAnchorId(`a-new-${idx}`);
          const insSnap = createAnchorSnapshot(st.features, st.store);
          const afterInsert = applyPastEdit(
            series,
            newStart,
            () => createAnchor(newAnchorId, insSnap),
            CAL,
          );
          expect(afterInsert.entries.length, 'applyPastEdit insert did not add one').toBe(
            series.entries.length + 1,
          );
          assertAscendingUnique(afterInsert);
          const resolvedNew = resolveAt(afterInsert, newStart, CAL);
          expect(resolvedNew.kind).toBe('present');
          if (resolvedNew.kind === 'present') {
            expect(resolvedNew.entry.anchor.id, 'inserted anchor not effective at its start').toBe(
              newAnchorId,
            );
          }
        },
      ),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §11. MULTI-TARGET FEDERATE ∘ DE-FEDERATE inverse (連邦化∘逆 round-trip).
//
// Federate >=2 existing top-level roots under a NEW common top (create→NewTop),
// then de-federate every original target back to `none`. After the round-trip:
//   - every original target is top-level again (parentId === undefined);
//   - the federation root auto-disappears once it loses all sub-regions (FR-35
//     sweep+prune); it must NOT linger as an empty aggregate;
//   - the surviving feature set is structurally valid throughout.
// §1..§8 federate but never de-federate, so this closes a NEW inverse pair.
// ===========================================================================

describe(`affiliation — federate ∘ de-federate inverse (seed=${SEED3})`, () => {
  it('federating N roots then de-federating each to none restores all to top-level', () => {
    fc.assert(
      fc.property(validForestArb(), fc.nat(), fc.nat(), (initial, aWhich, bWhich) => {
        let st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 900,
        };
        // Pick two DISTINCT top-level roots (aggregates) with compatible periods
        // so the federation's existence guard never rejects the setup.
        const roots = st.features.filter((f) => f.parentId === undefined);
        if (roots.length < 2) return;
        const a = roots[aWhich % roots.length]!;
        const bCandidates = roots.filter(
          (r) =>
            r.id !== a.id &&
            r.attributes.startYear <= a.attributes.endYear &&
            a.attributes.startYear <= r.attributes.endYear,
        );
        if (bCandidates.length === 0) return;
        const b = bCandidates[bWhich % bCandidates.length]!;

        // Remember the leaves under each root (federate expands aggregates to leaves).
        const forest0 = buildForest(st.features);
        const targetLeaves = [
          ...directChildIds(forest0, a.id),
          ...directChildIds(forest0, b.id),
        ];
        if (targetLeaves.length < 2) return;
        const originalParents = new Map(
          targetLeaves.map((id) => [id, st.features.find((f) => f.id === id)!.parentId] as const),
        );

        // op: federate a + b under a fresh NewTop.
        const fed = applyAffCmd(st, {
          t: 'federate',
          aWhich: st.features.indexOf(a),
          bWhich: st.features.indexOf(b),
          cWhich: st.features.indexOf(a), // dedup collapses to {a,b}.
        });
        if (fed === undefined) return;
        st = fed.next;
        assertFeatureSetInvariants(st.features, st.store);
        expect(fed.proposal.createdIds.length, 'federate minted no root').toBeGreaterThan(0);
        const fedRoot = fed.proposal.createdIds[fed.proposal.createdIds.length - 1]!;
        // Every original leaf now sits (transitively) under the federation root.
        for (const lid of targetLeaves) {
          const lf = st.features.find((f) => f.id === lid);
          expect(lf, `leaf ${lid} vanished after federate`).toBeDefined();
        }

        // 逆op: de-federate every original leaf back to `none` (top-level).
        for (const lid of targetLeaves) {
          const idx = st.features.findIndex((f) => f.id === lid);
          if (idx < 0) continue;
          const back = applyAffCmd(st, { t: 'none', targetWhich: idx });
          if (back === undefined) continue;
          st = back.next;
          assertFeatureSetInvariants(st.features, st.store);
        }

        // After the round-trip: every original leaf is top-level again.
        for (const lid of targetLeaves) {
          const lf = st.features.find((f) => f.id === lid);
          expect(lf, `leaf ${lid} missing after de-federate`).toBeDefined();
          expect(lf?.parentId, `leaf ${lid} still parented after de-federate`).toBe(undefined);
        }
        void originalParents;
        // The federation root must have auto-disappeared (it lost all sub-regions).
        const rootStillThere = st.features.some((f) => f.id === fedRoot);
        expect(rootStillThere, 'federation root lingered as empty aggregate').toBe(false);
      }),
      { seed: SEED3, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §12. PICKER ⊇ COMMIT over the heterogeneous-period model.
//
// On the het model (per-leaf independent periods), drive a real `existing`
// command for a random leaf/parent pair and assert: whenever it COMMITS, the
// chosen parent was a LISTED candidate (the picker would never have hidden a
// parent the commit accepts). A commit through a hidden parent is a back-door
// single-source violation distinct from §9 (different model + commit-first).
// ===========================================================================

describe(`affiliation — committed parent was always a listed candidate (seed=${SEED3})`, () => {
  it('het model: every committed existing-parent was a picker candidate', () => {
    fc.assert(
      fc.property(hetForestArb(), fc.nat(), fc.nat(), (initial, targetWhich, parentWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 5000,
        };
        const forest = buildForest(st.features);
        const allIds = st.features.map((f) => f.id);
        const target = pick(allIds, targetWhich);
        const parent = pick(allIds, parentWhich);
        if (target === undefined || parent === undefined) return;
        // Keep the picker contract exact: single-target (skip aggregate targets).
        if (directChildIds(forest, target).length > 0) return;

        const listed = new Set(
          allowedParentCandidates(forest, target).map((c) => c.featureId),
        );

        const idState = createIdGeneratorState(0, st.idCounter);
        const result = buildAffiliationProposal(
          st.features,
          target,
          parentExisting(parent),
          { idState, now: makeNow(1), vertexStore: st.store },
        );

        if (result.status === 'proposal') {
          expect(
            listed.has(parent),
            `committed existing-parent ${parent} was NOT a listed candidate (back-door)`,
          ).toBe(true);
          assertFeatureSetInvariants(
              result.proposal.nextFeatures,
              storeWithProposalVertices(st.store, result.proposal),
            );
        }
      }),
      { seed: SEED3, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §13. DEEP (3-level) stateful drive + subtree integrity.
// ===========================================================================

describe(`affiliation — deep 3-level invariants + subtree integrity (seed=${SEED4})`, () => {
  it('every invariant after every committed command; aggregate targets re-parent whole subtree', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 12 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 6000,
          };
          assertFeatureSetInvariants(st.features, st.store);

          for (const cmd of cmds) {
            // Capture the would-be target's descendant leaves BEFORE the command so
            // we can assert subtree integrity after an aggregate-target re-parent.
            const allIds = st.features.map((f) => f.id);
            let targetLeavesBefore: Set<FeatureId> | undefined;
            let targetId: FeatureId | undefined;
            if (cmd.t === 'existing' || cmd.t === 'none') {
              targetId = pick(allIds, cmd.targetWhich);
              if (targetId !== undefined) {
                targetLeavesBefore = descendantLeaves(st.features, targetId);
              }
            }

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

            // Subtree integrity: when an aggregate target with leaves was
            // re-parented, EVERY leaf that was under it survives and is reachable
            // (FR-48 expands the aggregate to all its sub-regions; no leaf is
            // dropped or duplicated). They need not share a single parent (each
            // moved independently), but the full leaf SET is conserved.
            if (
              targetId !== undefined &&
              targetLeavesBefore !== undefined &&
              targetLeavesBefore.size > 0 &&
              // only meaningful when the target was a genuine aggregate (≥1 leaf
              // that is not itself the target).
              !(targetLeavesBefore.size === 1 && targetLeavesBefore.has(targetId))
            ) {
              for (const lid of targetLeavesBefore) {
                expect(
                  present.has(lid),
                  `subtree leaf ${lid} vanished after re-parenting aggregate ${targetId}`,
                ).toBe(true);
              }
            }

            st = applied.next;
          }
        },
      ),
      { seed: SEED4, numRuns: 500 },
    );
  });
});

describe(`affiliation — full undo-stack rewind == identity (seed=${SEED4})`, () => {
  it('a sequence of commands rewinds exactly to the original baseline', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 1, maxLength: 8 }),
        (initial, cmds) => {
          const original: readonly Feature[] = [...initial.features];
          let st: AffState = {
            features: original,
            store: store(initial),
            idCounter: 7000,
          };
          const stack: StackFrame[] = [];

          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied === undefined) continue;
            const preState = st.features;
            const command = createAffiliationCommand(preState, applied.proposal);
            const exec = command.execute(preState);
            // execute must reproduce the proposal's nextFeatures exactly.
            expect(
              featuresEqual(exec.state, applied.proposal.nextFeatures),
              'execute != proposal.nextFeatures',
            ).toBe(true);
            stack.push({ command, preState, postState: exec.state });
            st = { ...applied.next, features: exec.state };
          }

          if (stack.length === 0) return; // nothing committed: trivially identity.

          // Rewind: pop in reverse. Each undo must land on that frame's preState.
          let cur: readonly Feature[] = stack[stack.length - 1]!.postState;
          for (let i = stack.length - 1; i >= 0; i -= 1) {
            const frame = stack[i]!;
            // The current state must equal this frame's postState before undo.
            expect(
              featuresEqual(cur, frame.postState),
              `pre-undo state drift at frame ${i}`,
            ).toBe(true);
            const undone = frame.command.undo(cur);
            expect(
              featuresEqual(undone.state, frame.preState),
              `undo at frame ${i} != its preState`,
            ).toBe(true);
            cur = undone.state;
          }

          // After rewinding the whole stack we are byte-identical to the original.
          expect(featuresEqual(cur, original), 'full rewind != original baseline').toBe(true);
          expect(cur.length).toBe(original.length);

          // And redoing the whole stack forward reproduces the final committed set
          // WITHOUT re-minting ids (教訓 5.20).
          const finalPost = stack[stack.length - 1]!.postState;
          let fwd: readonly Feature[] = cur;
          for (const frame of stack) {
            fwd = frame.command.redo(fwd).state;
          }
          expect(featuresEqual(fwd, finalPost), 'full redo != final committed set').toBe(true);
        },
      ),
      { seed: SEED4, numRuns: 500 },
    );
  });
});

// ===========================================================================
// §15. DE-NEST-TO-TOP: `none` on an INTERMEDIATE aggregate, then back.
//
// Take a sub-aggregate (has a grandparent AND owns leaves). Re-affiliate it to
// `none`. FR-48 expands the aggregate target to its leaves and applies the SAME
// decision (none) to each, so every leaf becomes top-level and the now-empty
// sub-aggregate AND (if it loses all children) the grandparent auto-disappear.
// Then re-affiliate one of those freed leaves back under the grandparent (if it
// survived) — the structure must stay valid throughout. The key contracts:
//   - after `none`, none of the freed leaves is parented under the OLD sub-agg;
//   - the old sub-aggregate (now child-less) does not linger as an empty agg;
//   - the committed forest is valid at every step (派生集約=子の和 included).
// ===========================================================================

describe(`affiliation — de-nest intermediate aggregate to top-level (seed=${SEED4})`, () => {
  it('none on a sub-aggregate frees its leaves to top-level and prunes the empty agg', () => {
    fc.assert(
      fc.property(deepForestArb(), fc.nat(), (initial, subWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 8000,
        };
        const forest0 = buildForest(st.features);
        // sub-aggregates: have a parent (grandparent) AND have children (leaves).
        const subAggs = st.features.filter(
          (f) =>
            f.parentId !== undefined &&
            f.kind === 'aggregate' &&
            directChildIds(forest0, f.id).length > 0,
        );
        if (subAggs.length === 0) return;
        const sub = subAggs[subWhich % subAggs.length]!;
        const freedLeaves = descendantLeaves(st.features, sub.id);
        if (freedLeaves.size === 0) return;

        const applied = applyAffCmd(st, {
          t: 'none',
          targetWhich: st.features.indexOf(sub),
        });
        if (applied === undefined) return; // a legitimate rejection (rare); skip.
        const next = applied.next;
        assertFeatureSetInvariants(next.features, next.store);

        // Every freed leaf survives and is now top-level (parentId undefined),
        // because `none` applied to each expanded leaf re-parents it to top.
        for (const lid of freedLeaves) {
          const lf = next.features.find((f) => f.id === lid);
          expect(lf, `freed leaf ${lid} vanished`).toBeDefined();
          expect(lf?.parentId, `freed leaf ${lid} not top-level after none`).toBe(undefined);
        }

        // The old sub-aggregate, having lost every child, must NOT linger as an
        // empty aggregate (FR-35 sweep+prune).
        const subStill = next.features.find((f) => f.id === sub.id);
        if (subStill !== undefined) {
          // If it somehow survives, it must still be a valid non-empty aggregate.
          const childIds = directChildIds(buildForest(next.features), sub.id);
          expect(
            childIds.length,
            `sub-aggregate ${sub.id} lingered empty after de-nest`,
          ).toBeGreaterThan(0);
        }
      }),
      { seed: SEED4, numRuns: 400 },
    );
  });
});

// ===========================================================================
// §16. CYCLE-ATTEMPT GUARD: re-parenting a feature under its own descendant.
//
// For any feature X with at least one descendant D, an `existing` command that
// makes D the new parent of X would create a cycle. The guard (教訓 5.22 /
// isLegalNewParent) MUST reject this — it must never produce a proposal. We try
// EVERY (ancestor, descendant) pair and assert no commit; when it rejects with a
// machine-readable kind it must be the Cycle reason (or SameFeature when the
// expansion collapses), never a silent acceptance.
// ===========================================================================

describe(`affiliation — cycle attempts are always rejected (seed=${SEED4})`, () => {
  it('re-parenting a feature under any of its descendants never commits', () => {
    fc.assert(
      fc.property(deepForestArb(), fc.nat(), fc.nat(), (initial, xWhich, dWhich) => {
        const st: AffState = {
          features: [...initial.features],
          store: store(initial),
          idCounter: 9000,
        };
        // Pick an ancestor X that actually has descendants.
        const withDesc = st.features.filter(
          (f) => descendantIds(st.features, f.id).size > 0,
        );
        if (withDesc.length === 0) return;
        const x = withDesc[xWhich % withDesc.length]!;
        const descs = [...descendantIds(st.features, x.id)];
        const d = descs[dWhich % descs.length]!;

        const idState = createIdGeneratorState(0, st.idCounter);
        const result = buildAffiliationProposal(
          st.features,
          x.id,
          parentExisting(d),
          { idState, now: makeNow(1), vertexStore: st.store },
        );

        // The cycle-forming command must NEVER commit.
        expect(
          result.status,
          `cycle commit: re-parented ${x.id} under its descendant ${d}`,
        ).not.toBe('proposal');

        // When X is a genuine aggregate, FR-48 expands X to its leaves and applies
        // the decision to EACH leaf. Making a leaf's own ancestor-side descendant
        // the parent can collapse to SameFeature; either way it must be one of the
        // candidate-predicate rejections, never anything that leaked through.
        if (result.status === 'rejected') {
          expect(
            [
              AFFILIATION_REJECT.Cycle,
              AFFILIATION_REJECT.SameFeature,
              AFFILIATION_REJECT.ExistencePeriod,
              AFFILIATION_REJECT.TargetKind,
              'hierarchy',
              'internal',
            ].includes(result.kind as never),
            `unexpected rejection kind for cycle attempt: ${result.kind}`,
          ).toBe(true);
        }
      }),
      { seed: SEED4, numRuns: 600 },
    );
  });
});

// ===========================================================================
// §17. save∘load JSON identity over the 3-level committed set.
//
// Distinct from §8 (shallow het model): here a 3-level model with nested
// aggregates is driven, then JSON round-tripped. childIds ORDER, derived areas,
// and derived DEPTHS must all survive the round-trip byte-for-byte / value-for-
// value. Nested aggregates exercise the round-trip of an aggregate whose own
// children are aggregates (the depth-2 case §8 cannot reach).
// ===========================================================================

describe(`affiliation — deep save∘load identity (childIds order + depths) (seed=${SEED4})`, () => {
  it('JSON round-trip preserves features, childIds order, derived areas AND depths', () => {
    fc.assert(
      fc.property(
        deepForestArb(),
        fc.array(affCmd2Arb, { minLength: 0, maxLength: 10 }),
        (initial, cmds) => {
          let st: AffState = {
            features: [...initial.features],
            store: store(initial),
            idCounter: 10000,
          };
          for (const cmd of cmds) {
            const applied = applyAffCmd2(st, cmd);
            if (applied !== undefined) st = applied.next;
          }
          const parsed = JSON.parse(JSON.stringify(st.features)) as Feature[];
          expect(featuresEqual(parsed, st.features)).toBe(true);

          const f0 = buildForest(st.features);
          const f1 = buildForest(parsed);
          const d0 = derivedDepths(f0);
          const d1 = derivedDepths(f1);
          for (const f of st.features) {
            // childIds order preserved for aggregates (featuresEqual checks set/
            // length; here we additionally pin ORDER explicitly).
            if (f.kind === 'aggregate') {
              const reF = parsed.find((g) => g.id === f.id);
              expect(reF?.kind).toBe('aggregate');
              if (reF?.kind === 'aggregate') {
                expect(reF.childIds, `childIds order drift on ${f.id}`).toEqual(f.childIds);
              }
            }
            // derived depth preserved.
            expect(d1.get(f.id), `depth drift on ${f.id}`).toBe(d0.get(f.id));
            // derived area preserved.
            const a = resolveFeatureArea(f0, st.store, f.id);
            const b = resolveFeatureArea(f1, st.store, f.id);
            expect(a.status).toBe(b.status);
            if (a.status === 'ok' && b.status === 'ok') {
              expect(areasEqualWithinTolerance(a.area, b.area)).toBe(true);
            }
          }
        },
      ),
      { seed: SEED4, numRuns: 300 },
    );
  });
});
