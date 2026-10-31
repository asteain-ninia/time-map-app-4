// time-anchor-history-undo-redo の検査 1/3。全体の説明と共有の生成器は time-anchor-history-undo-redo.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import fc from 'fast-check';
import { createAnchor } from '../anchor';
import { changeStart, deleteAnchor, setEnd, type AnchorSeries } from '../anchor-series';
import { applyPastEdit } from '../anchor-series';
import { anchorSeriesArb, makeAnchor, makeSnapshot } from '../anchor-series.arbitraries';
import { type Command } from '../command/command';
import { canUndo, clearRedo, createHistory, execute, executeIfChanged, redo, undo, withLimit, type History } from '../command/history';
import { createCompositeCommand } from '../command/command';
import { asAnchorId } from '../ids';
import { timePointYear } from '../time/time-point';
import { compare } from '../time/normalized';
import {
  type Model,
  NUM_RUNS,
  NUM_RUNS_24001,
  NUM_RUNS_24002,
  NUM_RUNS_24003,
  NUM_RUNS_24004,
  NUM_RUNS_4002,
  NUM_RUNS_4004,
  SEED,
  SEED_24001,
  SEED_24002,
  SEED_24003,
  SEED_24004,
  SEED_4002,
  SEED_4004,
  type SeriesPair,
  actionArb,
  applyEdit,
  applyMixedEdit,
  applyRichEdit,
  assertPairInvariants,
  assertRichStepInvariants,
  assertStepInvariants,
  boundedActionArb,
  cal,
  editOpArb,
  entrySnapshotView,
  expectAggregateForestValid,
  expectAllInvariants,
  expectHistoryMatchesModel,
  expectProbeSelectionValid,
  expectRichSaveLoadIdentity,
  expectRingHierarchyValid,
  expectSaveLoadIdentity,
  expectSelectionValid,
  makePairCommand,
  makeSeriesCommand,
  mixedActionArb,
  mixedAnchorSeriesArb,
  mixedEditOpArb,
  modelClearRedo,
  modelExecute,
  modelRedo,
  modelUndo,
  modelWithLimit,
  nonTargetEntriesEqual,
  pairActionArb,
  probeTimeArb,
  richAnchorSeriesArb,
  seriesViewEqual,
  viewPair,
  viewSeries,
} from './time-anchor-history-undo-redo.arbitraries';

describe('time-anchor + history undo/redo — invariants under random edit streams', () => {
  it('every history state (after edit/undo/redo) satisfies all invariants', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 24 }),
        (initial, actions) => {
          // Sanity: the generator itself must produce a valid series.
          assertStepInvariants(initial);

          let history: History<AnchorSeries> = createHistory(initial, 50);
          // A reference stack of the states we expect undo to walk back through.
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) continue; // rejected / no-op
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: undo ∘ execute restores the exact pre-execute state', () => {
    fc.assert(
      fc.property(anchorSeriesArb(cal), editOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyEdit(history0.state, op);
        if (after === undefined) return; // nothing to test for a rejected/no-op
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        // post-execute state must equal the computed `after`.
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        const undone = undo(executed).history;
        // undo ∘ execute == identity
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        // redo restores the post-execute state exactly.
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root state', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let history = createHistory(initial, 100);
          let pushed = 0;
          for (const op of ops) {
            const after = applyEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('metamorphic: save ∘ load == identity for any reachable series', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it('op ∘ inverse-op == identity: setEnd(end) then setEnd(null) round-trips through normalize', () => {
    // A targeted metamorphic law on the temporal axis: setting then clearing an
    // end is a round-trip ONLY when the set is accepted and the normalized
    // result preserves the original (no overrun-shortening side effect). We
    // verify against the SINGLE source of truth (validateSeries) and structural
    // equality of the cleared form vs the original entry's open-ended form.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: -600, max: 600 }),
        (initial, targetN, endYear) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          // Establish a clean open-ended baseline for the target first.
          const cleared = setEnd(initial, target.anchor.id, null, cal);
          if (!cleared.ok) return;
          const base = cleared.series;
          const set = setEnd(base, target.anchor.id, timePointYear(endYear), cal);
          if (!set.ok) return; // rejected end is out of scope for this law
          expectAllInvariants(set.series);
          const recleared = setEnd(set.series, target.anchor.id, null, cal);
          expect(recleared.ok).toBe(true);
          if (recleared.ok) {
            expectAllInvariants(recleared.series);
            // Clearing the end must yield a series structurally equal to the
            // open-ended baseline (the set+clear pair is reversible).
            expect(viewSeries(recleared.series)).toEqual(viewSeries(base));
          }
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});

describe('time-anchor + history undo/redo — seed 4002 expansion', () => {
  it('every history state (edit/undo/redo) satisfies all invariants (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 30 }),
        (initial, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: changeStart then changeStart-back round-trips (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: -600, max: 600 }),
        (initial, targetN, newYear) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const originalStart = target.start;
          const id = target.anchor.id;

          const moved = changeStart(initial, id, timePointYear(newYear), cal);
          if (!moved.ok) return; // rejected move is out of scope
          expectAllInvariants(moved.series);

          // Move the SAME anchor back to its original start.
          const back = changeStart(moved.series, id, originalStart, cal);
          if (!back.ok) return;
          expectAllInvariants(back.series);

          // changeStart auto-reorganizes via normalization (§5.6 「短縮」):
          // moving the target THROUGH a bounded neighbor permanently shortens
          // that neighbor's end, and a keep-last collision can drop an entry.
          // Both are destructive and NOT undone by moving the target back, so
          // the round-trip is an identity ONLY when the forward move left every
          // OTHER entry (by id → start/end) byte-identical. We verify that
          // precondition directly against the forward result rather than via a
          // coarse count check (a count-preserving move can still shorten a
          // neighbor — see the 4002 counterexample that motivated this guard).
          const othersUnchanged = nonTargetEntriesEqual(initial, moved.series, id);
          if (othersUnchanged) {
            // Target untouched elsewhere ⇒ moving it back must restore the
            // exact original series (full reversibility on the temporal axis).
            expect(viewSeries(back.series)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let history = createHistory(initial, 200);
          let pushed = 0;
          for (const op of ops) {
            const after = applyEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('metamorphic: execute∘undo∘redo restores post-execute state across a stream (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let history = createHistory(initial, 200);
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            const executed = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            const postExecute = executed.state;
            // undo then redo must reproduce the exact post-execute state, and
            // the intermediate undo must reproduce the exact pre-execute state.
            const undone = undo(executed).history;
            expect(viewSeries(undone.state)).toEqual(viewSeries(before));
            const redone = redo(undone).history;
            expect(viewSeries(redone.state)).toEqual(viewSeries(postExecute));
            // continue the stream from the redone (== post-execute) history.
            history = redone;
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });

  it('save ∘ load == identity for any reachable series (seed 4002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 20 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_4002, numRuns: NUM_RUNS_4002 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 24002 bounded-limit + model', () => {
  it('bounded history agrees with a reference model under random edit/undo/redo/limit streams', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: 1, max: 4 }), // SMALL limit so trimming is common
        fc.array(boundedActionArb, { maxLength: 40 }),
        (initial, limit, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          // The clamped limit the production history actually uses.
          expectHistoryMatchesModel(history, model);

          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) {
                // No-op / rejected. For editIfChanged we still call the real
                // API with an always-true isNoOp so the ghost-suppression path
                // (教訓 5.24) is exercised and must leave history untouched.
                if (action.t === 'editIfChanged') {
                  const step = executeIfChanged(
                    history,
                    makeSeriesCommand(action.op.kind, before, before),
                    () => true,
                  );
                  history = step.history;
                }
                continue;
              }
              const cmd = makeSeriesCommand(action.op.kind, before, after);
              if (action.t === 'edit') {
                history = execute(history, cmd).history;
              } else {
                // Real change ⇒ isNoOp false ⇒ behaves exactly like execute.
                history = executeIfChanged(history, cmd, () => false).history;
              }
              model = modelExecute(model, viewSeries(before), viewSeries(after));
            } else if (action.t === 'undo') {
              history = undo(history).history;
              model = modelUndo(model);
            } else if (action.t === 'redo') {
              history = redo(history).history;
              model = modelRedo(model);
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
              model = modelClearRedo(model);
            } else {
              history = withLimit(history, action.limit);
              model = modelWithLimit(model, action.limit);
            }
            // Production history and reference model must agree at every step…
            expectHistoryMatchesModel(history, model);
            // …and the reachable series must satisfy the whole contract.
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('FR-74: after overflowing the limit, undoing the WHOLE retained stack lands on the oldest retained pre-state', () => {
    // When more edits are executed than the limit allows, the oldest undo units
    // are dropped, so "undo everything possible" must NOT return to the original
    // root — it must return to the `before` state of the OLDEST RETAINED edit.
    // The reference model computes that target independently; a trim bug (wrong
    // end trimmed, off-by-one) would make the two disagree.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: 1, max: 3 }),
        fc.array(editOpArb, { minLength: 1, maxLength: 16 }),
        (initial, limit, ops) => {
          let history = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          const retained = model.undo.length;
          // Drain the entire retained undo stack.
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          assertStepInvariants(history.state);
          // After draining, the model's current is the `before` of the oldest
          // retained edit (or the root if nothing was ever pushed).
          const expectedFloor =
            model.undo.length === 0 && retained === 0
              ? viewSeries(initial)
              : model.current;
          expect(viewSeries(history.state)).toEqual(expectedFloor);
          // A further undo is a no-op (stack is empty).
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('composite command of an edit-chain is ONE indivisible undo unit (FR-73/FR-94)', () => {
    // Bundle a chain of accepted edits into a single composite. Executing it must
    // move the series to the post-chain state in ONE history entry; undo must
    // jump back to the pre-composite series in ONE step (never an intermediate
    // sub-edit), and redo must restore the post-chain series in ONE step.
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 6 }),
        (initial, ops) => {
          // Build the chain of sub-commands by folding the edits, skipping
          // rejected / no-op ones so every sub-command is a real change.
          const subCommands: Command<AnchorSeries>[] = [];
          let cursor = initial;
          for (const op of ops) {
            const after = applyEdit(cursor, op);
            if (after === undefined) continue;
            subCommands.push(makeSeriesCommand(op.kind, cursor, after));
            cursor = after;
          }
          if (subCommands.length === 0) return; // nothing to bundle
          const postChain = cursor;

          const composite = createCompositeCommand('bughunt/edit-chain', subCommands);
          let history = createHistory(initial, 10);

          history = execute(history, composite).history;
          // ONE undo unit for the whole chain.
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(postChain));
          assertStepInvariants(history.state);

          // Undo: ONE step back to the exact pre-composite series.
          const undone = undo(history).history;
          expect(undone.undoStack.length).toBe(0);
          expect(undone.redoStack.length).toBe(1);
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undone.state);

          // Redo: ONE step forward to the exact post-chain series.
          const redone = redo(undone).history;
          expect(viewSeries(redone.state)).toEqual(viewSeries(postChain));
          assertStepInvariants(redone.state);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });

  it('clearRedo drops only the redo branch and never resurrects on redo (seed 24002)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 10 }),
        (initial, ops) => {
          let history = createHistory(initial, 20);
          const pushedStates: AnchorSeries[] = [];
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            pushedStates.push(after);
          }
          if (pushedStates.length === 0) return;
          // Undo a few to populate the redo stack.
          const undos = Math.min(pushedStates.length, 3);
          for (let i = 0; i < undos; i += 1) history = undo(history).history;
          expect(history.redoStack.length).toBe(undos);
          const stateBeforeClear = history.state;
          const undoDepth = history.undoStack.length;

          history = clearRedo(history);
          // Redo branch gone, undo branch + state untouched.
          expect(history.redoStack.length).toBe(0);
          expect(history.undoStack.length).toBe(undoDepth);
          expect(viewSeries(history.state)).toEqual(viewSeries(stateBeforeClear));

          // A redo now is a no-op — the cleared redo can never resurrect.
          const afterRedo = redo(history).history;
          expect(viewSeries(afterRedo.state)).toEqual(viewSeries(stateBeforeClear));
          expect(afterRedo.redoStack.length).toBe(0);
          assertStepInvariants(afterRedo.state);
        },
      ),
      { seed: SEED_24002, numRuns: NUM_RUNS_24002 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 4004 rich-snapshot expansion', () => {
  it('rich snapshots keep ring-alternation + hierarchy-forest + save/load through edit/undo/redo', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(actionArb, { maxLength: 24 }),
        (initial, actions) => {
          assertRichStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyRichEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertRichStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('metamorphic: undo∘execute == identity and redo restores post-execute (rich, seed 4004)', () => {
    fc.assert(
      fc.property(richAnchorSeriesArb(), editOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyRichEdit(history0.state, op);
        if (after === undefined) return;
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        expectRingHierarchyValid(executed.state);
        expectAggregateForestValid(executed.state);
        const undone = undo(executed).history;
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        expectRingHierarchyValid(undone.state);
        expectAggregateForestValid(undone.state);
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
        expectRingHierarchyValid(redone.state);
        expectAggregateForestValid(redone.state);
      }),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('metamorphic: undoing every executed edit returns to the root (rich, seed 4004)', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let history = createHistory(initial, 100);
          let pushed = 0;
          for (const op of ops) {
            const after = applyRichEdit(history.state, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, history.state, after),
            ).history;
            pushed += 1;
          }
          for (let i = 0; i < pushed; i += 1) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expectRingHierarchyValid(history.state);
          expectAggregateForestValid(history.state);
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });

  it('full-fidelity save∘load == identity for any reachable rich series (seed 4004)', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.array(editOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyRichEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectRichSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_4004, numRuns: NUM_RUNS_4004 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 24001 mixed-granularity expansion', () => {
  it('mixed-granularity series keep every invariant through edit/undo/redo (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedActionArb, { maxLength: 28 }),
        (initial, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('resolveAt over arbitrary probe times is always selection-valid (mixed, seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { maxLength: 14 }),
        fc.array(probeTimeArb, { minLength: 1, maxLength: 8 }),
        (initial, ops, probes) => {
          let s = initial;
          for (const op of ops) {
            const after = applyMixedEdit(s, op);
            if (after !== undefined) s = after;
          }
          // Series invariants hold on the reachable state…
          expectAllInvariants(s);
          // …and resolveAt is selection-valid at every probe (incl. off-anchor).
          for (const probe of probes) {
            expectProbeSelectionValid(s, probe);
          }
          // Plus the standard at-start selection-validity.
          expectSelectionValid(s);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('metamorphic: undo∘execute == identity over mixed-granularity edits (seed 24001)', () => {
    fc.assert(
      fc.property(mixedAnchorSeriesArb(), mixedEditOpArb, (initial, op) => {
        const history0 = createHistory(initial, 50);
        const after = applyMixedEdit(history0.state, op);
        if (after === undefined) return;
        const executed = execute(
          history0,
          makeSeriesCommand(op.kind, history0.state, after),
        ).history;
        expect(viewSeries(executed.state)).toEqual(viewSeries(after));
        const undone = undo(executed).history;
        expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
        const redone = redo(undone).history;
        expect(viewSeries(redone.state)).toEqual(viewSeries(after));
      }),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('history branch divergence: execute after undo drops the redo branch (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        mixedEditOpArb,
        mixedEditOpArb,
        (initial, opA, opB) => {
          let history: History<AnchorSeries> = createHistory(initial, 50);

          // First edit (A): need a real change to have something to undo.
          const afterA = applyMixedEdit(history.state, opA);
          if (afterA === undefined) return;
          history = execute(
            history,
            makeSeriesCommand(opA.kind, history.state, afterA),
          ).history;
          const stateAfterA = history.state;

          // Undo A → back to root, A now sits on the redo stack.
          history = undo(history).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expect(history.redoStack.length).toBe(1);

          // Diverge: execute a DIFFERENT edit (B) from the root. Per FR-74 this
          // must clear the redo stack entirely so the undone A can never be
          // replayed onto the B branch.
          const afterB = applyMixedEdit(history.state, opB);
          if (afterB === undefined) {
            // B was a no-op/rejected from root; redo of A must still be possible
            // and must restore exactly the post-A state (history still coherent).
            const redoneA = redo(history).history;
            expect(viewSeries(redoneA.state)).toEqual(viewSeries(stateAfterA));
            assertStepInvariants(redoneA.state);
            return;
          }
          history = execute(
            history,
            makeSeriesCommand(opB.kind, history.state, afterB),
          ).history;

          // Redo stack dropped; state is the B branch and every invariant holds.
          expect(history.redoStack.length).toBe(0);
          expect(viewSeries(history.state)).toEqual(viewSeries(afterB));
          assertStepInvariants(history.state);

          // A redo() now is a no-op (nothing to redo) — the stale A is gone.
          const afterRedoAttempt = redo(history).history;
          expect(viewSeries(afterRedoAttempt.state)).toEqual(viewSeries(afterB));
          assertStepInvariants(afterRedoAttempt.state);

          // Undo of B returns to the root (single-step branch is coherent).
          const undoneB = undo(history).history;
          expect(viewSeries(undoneB.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undoneB.state);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });

  it('save∘load == identity for any reachable mixed-granularity series (seed 24001)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { maxLength: 18 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyMixedEdit(s, op);
            if (after !== undefined) s = after;
          }
          expectSaveLoadIdentity(s);
        },
      ),
      { seed: SEED_24001, numRuns: NUM_RUNS_24001 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 24003 in-place replace + laws', () => {
  it('applyPastEdit at an EXISTING start replaces ONLY the snapshot; count/start/end preserved; undo/redo round-trips (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: 0, max: 100000 }),
        (initial, targetN, seed) => {
          assertStepInvariants(initial);
          const target = initial.entries[targetN % initial.entries.length]!;
          const baseTime = target.start; // EXACT existing start ⇒ REPLACE branch.

          const next = applyPastEdit(
            initial,
            baseTime,
            () => makeAnchor(seed, `-rep-${seed}`),
            cal,
          );

          // The REPLACE branch must preserve the entry COUNT (no insert).
          expect(next.entries.length).toBe(initial.entries.length);
          assertStepInvariants(next);

          // The entry that owns baseTime must keep its start and end; only its
          // snapshot may differ. Locate it by start (unique under INV-1).
          const newTarget = next.entries.find(
            (e) => compare(e.start, baseTime, cal) === 0,
          );
          expect(newTarget).toBeDefined();
          if (newTarget) {
            expect(compare(newTarget.start, target.start, cal)).toBe(0);
            if (target.end === null) {
              expect(newTarget.end).toBeNull();
            } else {
              expect(newTarget.end).not.toBeNull();
              if (newTarget.end) {
                expect(compare(newTarget.end, target.end, cal)).toBe(0);
              }
            }
          }

          // Every OTHER entry (by start) is byte-identical (no neighbor touched).
          const otherKey = (s: AnchorSeries) =>
            JSON.stringify(
              s.entries
                .filter((e) => compare(e.start, baseTime, cal) !== 0)
                .map((e) => ({
                  id: e.anchor.id,
                  start: e.start,
                  end: e.end,
                  snap: entrySnapshotView(e),
                })),
            );
          expect(otherKey(next)).toBe(otherKey(initial));

          // Drive through the dual-stack history: execute, undo (restores the
          // ORIGINAL snapshot exactly), redo (restores the replacement).
          if (seriesViewEqual(next, initial)) return; // identical snapshot ⇒ no-op
          let history = createHistory(initial, 20);
          history = execute(
            history,
            makeSeriesCommand('pastEdit-replace', initial, next),
          ).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(next));
          const undone = undo(history).history;
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          assertStepInvariants(undone.state);
          const redone = redo(undone).history;
          expect(viewSeries(redone.state)).toEqual(viewSeries(next));
          assertStepInvariants(redone.state);
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('idempotency: setEnd(null) twice == once; in-place pastEdit with identical snapshot twice == once (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.integer({ min: 0, max: 100000 }),
        (initial, targetN, seed) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;

          // setEnd(null) idempotency.
          const c1 = setEnd(initial, id, null, cal);
          expect(c1.ok).toBe(true);
          if (c1.ok) {
            expectAllInvariants(c1.series);
            const c2 = setEnd(c1.series, id, null, cal);
            expect(c2.ok).toBe(true);
            if (c2.ok) {
              // Clearing an already-open end must be a structural no-op.
              expect(viewSeries(c2.series)).toEqual(viewSeries(c1.series));
            }
          }

          // In-place pastEdit idempotency: replacing the snapshot at an existing
          // start with the SAME factory twice yields the same series the first
          // replace produced (a second identical replace is a no-op).
          const make = () => makeAnchor(seed, `-idem-${seed}`);
          const r1 = applyPastEdit(initial, target.start, make, cal);
          expectAllInvariants(r1);
          const r2 = applyPastEdit(r1, target.start, make, cal);
          expectAllInvariants(r2);
          expect(viewSeries(r2)).toEqual(viewSeries(r1));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('no-resurrection: deleting an id then deleting it again rejects with anchorNotFound (seed 24003)', () => {
    fc.assert(
      fc.property(anchorSeriesArb(cal), fc.nat(), (initial, targetN) => {
        // Need >= 2 entries so the first delete is allowed (INV-5 guard).
        if (initial.entries.length < 2) return;
        const target = initial.entries[targetN % initial.entries.length]!;
        const id = target.anchor.id;

        const first = deleteAnchor(initial, id, cal);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expectAllInvariants(first.series);
        // The id must be GONE — no entry resolves to it.
        expect(first.series.entries.some((e) => e.anchor.id === id)).toBe(false);

        // Deleting the same id again must be a clean rejection, never a silent
        // misroute onto a different entry.
        const second = deleteAnchor(first.series, id, cal);
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.reason.code).toBe('anchorNotFound');
        }
        // The series is unchanged by the rejected second delete.
        expectAllInvariants(first.series);
      }),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('commutativity: deleting two distinct ids in either order yields the same series (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.nat(),
        fc.nat(),
        (initial, aN, bN) => {
          // Need >= 3 entries so BOTH deletes are individually allowed (each
          // delete keeps >= 1; with 3 entries deleting any 2 keeps >= 1).
          if (initial.entries.length < 3) return;
          const n = initial.entries.length;
          const i = aN % n;
          let j = bN % n;
          if (j === i) j = (j + 1) % n;
          const idA = initial.entries[i]!.anchor.id;
          const idB = initial.entries[j]!.anchor.id;
          if (idA === idB) return;

          const ab1 = deleteAnchor(initial, idA, cal);
          if (!ab1.ok) return;
          const ab2 = deleteAnchor(ab1.series, idB, cal);
          if (!ab2.ok) return;

          const ba1 = deleteAnchor(initial, idB, cal);
          if (!ba1.ok) return;
          const ba2 = deleteAnchor(ba1.series, idA, cal);
          if (!ba2.ok) return;

          expectAllInvariants(ab2.series);
          expectAllInvariants(ba2.series);
          // Delete is order-independent on the time axis: the two orders must
          // produce the structurally-identical series.
          expect(viewSeries(ab2.series)).toEqual(viewSeries(ba2.series));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('executeIfChanged with a content-derived isNoOp pushes iff the edit really changes the series (seed 24003)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { maxLength: 24 }),
        (initial, ops) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const op of ops) {
            const before = history.state;
            // Compute the candidate AFTER state. applyEdit returns undefined for a
            // rejected/no-op edit; model that as a command that maps to `before`
            // (a true no-op) so the content-derived isNoOp suppresses it.
            const computed = applyEdit(before, op);
            const after = computed ?? before;
            const cmd = makeSeriesCommand(op.kind, before, after);
            const depthBefore = history.undoStack.length;

            // isNoOp derived from the SAME source as the resulting state: the
            // command's post-state view equals the current baseline view.
            const step = executeIfChanged(history, cmd, (s) =>
              JSON.stringify(viewSeries(after)) === JSON.stringify(viewSeries(s)),
            );
            history = step.history;

            if (computed === undefined) {
              // True no-op ⇒ NO ghost entry pushed (教訓 5.24).
              expect(history.undoStack.length).toBe(depthBefore);
              expect(viewSeries(history.state)).toEqual(viewSeries(before));
            } else {
              // Real change ⇒ exactly one entry pushed and state advanced.
              expect(history.undoStack.length).toBe(depthBefore + 1);
              expect(viewSeries(history.state)).toEqual(viewSeries(after));
            }
            assertStepInvariants(history.state);
          }

          // Undo everything pushed ⇒ back to root (history coherence under the
          // ghost-suppressed stream).
          while (canUndo(history)) {
            history = undo(history).history;
          }
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });

  it('every history state (edit/undo/redo) satisfies all invariants (seed 24003, fresh stream)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(actionArb, { maxLength: 32 }),
        (initial, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op) {
              const before = history.state;
              const after = applyEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24003, numRuns: NUM_RUNS_24003 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 24004 multi-feature + inverse + pointer-walk', () => {
  it('two features share ONE history: every state keeps both halves valid; undo/redo restores both (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        anchorSeriesArb(cal),
        fc.array(pairActionArb, { maxLength: 30 }),
        (initialA, initialB, actions) => {
          const initial: SeriesPair = { a: initialA, b: initialB };
          assertPairInvariants(initial);

          let history: History<SeriesPair> = createHistory(initial, 50);
          for (const action of actions) {
            if (action.t === 'edit' && action.op && action.which) {
              const before = history.state;
              const target = action.which === 'a' ? before.a : before.b;
              const edited = applyEdit(target, action.op);
              if (edited === undefined) continue; // rejected / no-op
              const after: SeriesPair =
                action.which === 'a'
                  ? { a: edited, b: before.b }
                  : { a: before.a, b: edited };
              history = execute(
                history,
                makePairCommand(`${action.which}:${action.op.kind}`, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else {
              history = redo(history).history;
            }
            // Both halves must independently satisfy the whole contract, and an
            // edit to one feature must never have mutated the other.
            assertPairInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('multi-feature metamorphic: undo∘execute restores BOTH halves; the untouched half is byte-identical (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        anchorSeriesArb(cal),
        fc.constantFrom('a' as const, 'b' as const),
        editOpArb,
        (initialA, initialB, which, op) => {
          const initial: SeriesPair = { a: initialA, b: initialB };
          const target = which === 'a' ? initial.a : initial.b;
          const edited = applyEdit(target, op);
          if (edited === undefined) return;
          const after: SeriesPair =
            which === 'a' ? { a: edited, b: initial.b } : { a: initial.a, b: edited };

          let history: History<SeriesPair> = createHistory(initial, 50);
          history = execute(history, makePairCommand(`${which}:${op.kind}`, initial, after)).history;

          // Post-execute: edited half advanced, OTHER half byte-identical.
          expect(viewPair(history.state)).toEqual(viewPair(after));
          const otherBefore = which === 'a' ? viewSeries(initial.b) : viewSeries(initial.a);
          const otherAfter =
            which === 'a' ? viewSeries(history.state.b) : viewSeries(history.state.a);
          expect(otherAfter).toEqual(otherBefore); // no cross-feature bleed

          // undo restores BOTH halves exactly; redo re-advances both.
          const undone = undo(history).history;
          expect(viewPair(undone.state)).toEqual(viewPair(initial));
          const redone = redo(undone).history;
          expect(viewPair(redone.state)).toEqual(viewPair(after));
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('op∘inverse-op == identity: applyPastEdit INSERT then deleteAnchor of the inserted id restores the series (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.integer({ min: -1200, max: 1200 }),
        fc.integer({ min: 0, max: 100000 }),
        (initial, year, seed) => {
          assertStepInvariants(initial);
          const at = timePointYear(year);
          // Only the INSERT branch is in scope: skip when an entry already starts
          // exactly at `at` (that is the REPLACE branch, covered by seed 24003).
          const collides = initial.entries.some(
            (e) => compare(e.start, at, cal) === 0,
          );
          if (collides) return;

          const insertedId = asAnchorId(`a-${seed}-ins24004`);
          const inserted = applyPastEdit(
            initial,
            at,
            () => createAnchor(insertedId, makeSnapshot(seed)),
            cal,
          );
          // Insert must have actually added the new id (no silent dedup loss).
          const present = inserted.entries.some((e) => e.anchor.id === insertedId);
          if (!present) {
            // The only way an insert "vanishes" is a degenerate-drop in
            // normalize (the inserted open-ended entry can never be degenerate),
            // so this must not happen — assert it explicitly rather than skipping.
            expect(present).toBe(true);
            return;
          }
          expect(inserted.entries.length).toBe(initial.entries.length + 1);
          assertStepInvariants(inserted);

          // §5.6「短縮」caveat (the SAME destructive auto-reorganization the 4002
          // changeStart round-trip guards against): inserting at `at` between a
          // bounded predecessor whose end OVERRUNS `at` and the next start
          // permanently SHORTENS that predecessor's end to `at` (INV-2). Deleting
          // the inserted anchor afterwards re-opens a gap but does NOT restore the
          // shortened end, so insert∘delete is an identity ONLY when the insert
          // left every PRE-EXISTING entry (by id → start/end) byte-identical. We
          // verify that precondition directly against the forward result; when it
          // does not hold, the shortening is correct (documented) behavior and the
          // round-trip is legitimately not an identity — out of scope for this law.
          const originalKey = JSON.stringify(
            initial.entries.map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
          );
          const preservedKey = JSON.stringify(
            inserted.entries
              .filter((e) => e.anchor.id !== insertedId)
              .map((e) => ({ id: e.anchor.id, start: e.start, end: e.end })),
          );
          const noNeighborShortened = originalKey === preservedKey;

          // Inverse op: delete the exact inserted id. It must succeed (the series
          // has >= 2 entries now). When no neighbor was shortened, it restores the
          // original series structurally (op∘inverse-op == identity).
          const back = deleteAnchor(inserted, insertedId, cal);
          expect(back.ok).toBe(true);
          if (back.ok) {
            assertStepInvariants(back.series);
            if (noNeighborShortened) {
              expect(viewSeries(back.series)).toEqual(viewSeries(initial));
            }
          }
          if (!noNeighborShortened) return; // shortening case: not an identity.

          // Drive the same insert/delete pair through the dual-stack history as a
          // composite: ONE undo must jump from post-delete back to the original.
          const cInsert = makeSeriesCommand('pastEdit-insert', initial, inserted);
          if (!back.ok) return;
          const cDelete = makeSeriesCommand('delete-inserted', inserted, back.series);
          const composite = createCompositeCommand('bughunt/insert-then-delete', [
            cInsert,
            cDelete,
          ]);
          let history = createHistory(initial, 10);
          history = execute(history, composite).history;
          // The net effect of insert+delete is identity, so the post-composite
          // state equals the original — but it is still ONE undo unit.
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          const undone = undo(history).history;
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));
          expect(undone.undoStack.length).toBe(0);
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('history pointer-walk coherence: any undo/redo-only walk lands on the recorded state for that pointer (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 14 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 40 }), // walk: true=redo,false=undo
        (initial, ops, walk) => {
          // Build a straight line of states by executing the accepted edits.
          let history: History<AnchorSeries> = createHistory(initial, 200);
          const line: unknown[] = [viewSeries(initial)]; // line[k] = state at pointer k
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            line.push(viewSeries(after));
          }
          const top = line.length - 1; // current pointer == top of the line
          if (top === 0) return; // nothing to walk

          // The current pointer equals undoStack depth; track it as we walk and
          // assert the production state matches the recorded line state at every
          // step. undo decrements (floored at 0), redo increments (capped at top).
          let pointer = history.undoStack.length;
          expect(pointer).toBe(top);
          for (const goRedo of walk) {
            if (goRedo) {
              history = redo(history).history;
              pointer = Math.min(top, pointer + 1);
            } else {
              history = undo(history).history;
              pointer = Math.max(0, pointer - 1);
            }
            // Production pointer (undo depth) and the model pointer must agree…
            expect(history.undoStack.length).toBe(pointer);
            // …and the observable state must equal the independently-recorded
            // state that occupies that pointer position on the line.
            expect(viewSeries(history.state)).toEqual(line[pointer]);
            // The redo stack depth is the distance from the top.
            expect(history.redoStack.length).toBe(top - pointer);
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });

  it('withLimit grow-then-shrink agrees with the model and never drops the redo stack (seed 24004)', () => {
    fc.assert(
      fc.property(
        anchorSeriesArb(cal),
        fc.array(editOpArb, { minLength: 1, maxLength: 12 }),
        fc.integer({ min: 1, max: 8 }), // undos to populate a redo stack
        fc.array(fc.integer({ min: 1, max: 50 }), { minLength: 1, maxLength: 6 }), // limit walk
        (initial, ops, undoN, limitWalk) => {
          // Start with a generous limit so the initial edits never trim.
          let history = createHistory(initial, 100);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: 100,
          };
          for (const op of ops) {
            const before = history.state;
            const after = applyEdit(before, op);
            if (after === undefined) continue;
            history = execute(history, makeSeriesCommand(op.kind, before, after)).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          // Populate a redo stack by undoing a few accepted edits.
          const pushed = history.undoStack.length;
          const undos = Math.min(pushed, undoN);
          for (let i = 0; i < undos; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          const redoDepthBefore = history.redoStack.length;

          // Now walk the limit up and down. Each withLimit must: trim only the
          // OLDEST undo entries when the new limit is below the current undo
          // depth, leave the undo stack alone when the limit grows, and NEVER
          // touch the redo stack or the observable state.
          for (const lim of limitWalk) {
            const stateBefore = viewSeries(history.state);
            history = withLimit(history, lim);
            model = modelWithLimit(model, lim);
            expectHistoryMatchesModel(history, model);
            // withLimit never changes the current state…
            expect(viewSeries(history.state)).toEqual(stateBefore);
            // …and never drops a redo entry (a limit change is not a new edit).
            expect(history.redoStack.length).toBe(redoDepthBefore);
            assertStepInvariants(history.state);
          }

          // After all the limit churn, the retained undo stack must still undo
          // coherently down to its (possibly trimmed) floor without throwing.
          const retained = history.undoStack.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
            expectHistoryMatchesModel(history, model);
            assertStepInvariants(history.state);
          }
          // A further undo is a no-op on the empty stack.
          const extra = undo(history).history;
          expect(extra.undoStack.length).toBe(0);
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
        },
      ),
      { seed: SEED_24004, numRuns: NUM_RUNS_24004 },
    );
  });
});
