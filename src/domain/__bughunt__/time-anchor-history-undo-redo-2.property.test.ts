// time-anchor-history-undo-redo の検査 2/3。全体の説明と共有の生成器は time-anchor-history-undo-redo.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド「テストの速さ」）。

import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import fc from 'fast-check';
import { changeStart, deleteAnchor, setEnd, type AnchorSeries } from '../anchor-series';
import { type Command } from '../command/command';
import { clearRedo, createHistory, execute, executeIfChanged, redo, undo, withLimit, type History } from '../command/history';
import { createCompositeCommand } from '../command/command';
import { asAnchorId } from '../ids';
import { timePointYear } from '../time/time-point';
import { compare } from '../time/normalized';
import {
  type MixedEditOp,
  type MixedModelState,
  type MixedSut,
  type Model,
  NUM_RUNS_34002,
  NUM_RUNS_34003,
  NUM_RUNS_34004,
  type RichModelState,
  type RichSut,
  SEED_34002,
  SEED_34003,
  SEED_34004,
  applyMixedEdit,
  applyRichEdit,
  assertRichStepInvariants,
  assertStepInvariants,
  cal,
  editOpArb,
  expectAllInvariants,
  expectHistoryMatchesModel,
  expectProbeSelectionValid,
  expectSaveLoadIdentity,
  makeSeriesCommand,
  mixedAnchorSeriesArb,
  mixedBoundedActionArb,
  mixedCommandsArb,
  mixedEditOpArb,
  mixedTimePointArb,
  modelClearRedo,
  modelExecute,
  modelRedo,
  modelUndo,
  modelWithLimit,
  nonTargetEntriesEqual,
  probeTimeArb,
  richAnchorSeriesArb,
  richCommandsArb,
  viewSeries,
} from './time-anchor-history-undo-redo.arbitraries';

describe('time-anchor + history undo/redo — seed 34002 mixed-granularity bounded-model', () => {
  it('mixed-granularity edits through a SMALL-limit history agree with a reference model (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 4 }), // SMALL limit ⇒ trimming is the common case
        fc.array(mixedBoundedActionArb, { maxLength: 44 }),
        (initial, limit, actions) => {
          assertStepInvariants(initial);
          let history: History<AnchorSeries> = createHistory(initial, limit);
          let model: Model = {
            current: viewSeries(initial),
            undo: [],
            redo: [],
            limit: Math.max(1, Math.floor(limit)),
          };
          expectHistoryMatchesModel(history, model);

          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) {
                // No-op / rejected mixed edit. For editIfChanged exercise the
                // ghost-suppression path with an always-true isNoOp (教訓 5.24);
                // it must leave both history AND model untouched.
                if (action.t === 'editIfChanged') {
                  const step = executeIfChanged(
                    history,
                    makeSeriesCommand(action.op.kind, before, before),
                    () => true,
                  );
                  history = step.history;
                }
                expectHistoryMatchesModel(history, model);
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
            expectHistoryMatchesModel(history, model);
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('FR-74 (mixed): after overflowing a small limit, draining the retained stack lands on the oldest retained pre-state (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 18 }),
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
            const after = applyMixedEdit(before, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
          }
          const retained = model.undo.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
          }
          expectHistoryMatchesModel(history, model);
          assertStepInvariants(history.state);
          // Production and model must agree on the (possibly trimmed) floor.
          expect(viewSeries(history.state)).toEqual(model.current);
          // A further undo is a no-op on the drained stack.
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('composite branch divergence: a second composite from the root drops the first composite from redo (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 6 }),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 6 }),
        (initial, opsA, opsB) => {
          // Build composite A from the root by folding accepted mixed edits.
          const buildComposite = (
            from: AnchorSeries,
            ops: readonly MixedEditOp[],
            label: string,
          ): { cmd: Command<AnchorSeries>; post: AnchorSeries } | undefined => {
            const subs: Command<AnchorSeries>[] = [];
            let cursor = from;
            for (const op of ops) {
              const after = applyMixedEdit(cursor, op);
              if (after === undefined) continue;
              subs.push(makeSeriesCommand(op.kind, cursor, after));
              cursor = after;
            }
            if (subs.length === 0) return undefined;
            return { cmd: createCompositeCommand(label, subs), post: cursor };
          };

          const a = buildComposite(initial, opsA, 'bughunt/mixed-chain-A');
          if (a === undefined) return;

          let history = createHistory(initial, 10);
          history = execute(history, a.cmd).history;
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(a.post));
          assertStepInvariants(history.state);

          // Undo composite A as ONE unit → root, A sits on the redo stack.
          history = undo(history).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(initial));
          expect(history.redoStack.length).toBe(1);
          assertStepInvariants(history.state);

          // Diverge: build composite B from the SAME root.
          const b = buildComposite(history.state, opsB, 'bughunt/mixed-chain-B');
          if (b === undefined) {
            // B produced nothing from the root; redo of A must still restore the
            // exact post-A state (history coherence preserved on a no-op diverge).
            const redoneA = redo(history).history;
            expect(viewSeries(redoneA.state)).toEqual(viewSeries(a.post));
            assertStepInvariants(redoneA.state);
            return;
          }
          history = execute(history, b.cmd).history;

          // FR-74: executing B drops the redo branch entirely; A is gone.
          expect(history.redoStack.length).toBe(0);
          expect(history.undoStack.length).toBe(1);
          expect(viewSeries(history.state)).toEqual(viewSeries(b.post));
          assertStepInvariants(history.state);

          // A redo() now is a no-op — the stale A composite cannot resurrect.
          const afterRedo = redo(history).history;
          expect(viewSeries(afterRedo.state)).toEqual(viewSeries(b.post));
          expect(afterRedo.redoStack.length).toBe(0);

          // Undo of B is ONE step back to the root (single indivisible unit).
          const undoneB = undo(history).history;
          expect(viewSeries(undoneB.state)).toEqual(viewSeries(initial));
          expect(undoneB.undoStack.length).toBe(0);
          assertStepInvariants(undoneB.state);
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('3-hop changeStart inverse: move P→Q→original restores the series when no neighbor was shortened (mixed, seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.nat(),
        mixedTimePointArb,
        mixedTimePointArb,
        (initial, targetN, pointP, pointQ) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;
          const originalStart = target.start;

          // Hop 1: original → P.
          const hop1 = changeStart(initial, id, pointP, cal);
          if (!hop1.ok) return;
          expectAllInvariants(hop1.series);
          const othersAfter1 = nonTargetEntriesEqual(initial, hop1.series, id);

          // Hop 2: P → Q.
          const hop2 = changeStart(hop1.series, id, pointQ, cal);
          if (!hop2.ok) return;
          expectAllInvariants(hop2.series);
          const othersAfter2 = nonTargetEntriesEqual(hop1.series, hop2.series, id);

          // Hop 3: Q → original start.
          const hop3 = changeStart(hop2.series, id, originalStart, cal);
          if (!hop3.ok) return;
          expectAllInvariants(hop3.series);

          // The composed move is an identity ONLY when neither forward hop
          // destructively shortened / dropped a NON-target neighbor (§5.6「短縮」).
          // We verify that precondition directly against each hop's result, then
          // assert the full 3-hop round-trip restores the exact original series.
          if (othersAfter1 && othersAfter2) {
            expect(viewSeries(hop3.series)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });

  it('save∘load == identity for any reachable mixed series under a small-limit stream (seed 34002)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 4 }),
        fc.array(mixedBoundedActionArb, { maxLength: 36 }),
        (initial, limit, actions) => {
          let history: History<AnchorSeries> = createHistory(initial, limit);
          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else if (action.t === 'redo') {
              history = redo(history).history;
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
            } else {
              history = withLimit(history, action.limit);
            }
            expectSaveLoadIdentity(history.state);
          }
        },
      ),
      { seed: SEED_34002, numRuns: NUM_RUNS_34002 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 34003 stateful rich bounded-model', () => {
  it('fc.commands: bounded rich history stays model-consistent and structurally valid (seed 34003)', () => {
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }), // SMALL limit ⇒ FR-74 trimming is common
        probeTimeArb,
        richCommandsArb,
        (initial, limit, probe, commands) => {
          assertRichStepInvariants(initial);
          expectProbeSelectionValid(initial, probe);
          const clampedLimit = Math.max(1, Math.floor(limit));
          const setup = (): { model: RichModelState; real: RichSut } => {
            const history = createHistory(initial, clampedLimit);
            const model: RichModelState = {
              model: {
                current: viewSeries(initial),
                undo: [],
                redo: [],
                limit: clampedLimit,
              },
              probe,
            };
            // Sanity at t0.
            expectHistoryMatchesModel(history, model.model);
            return { model, real: { history } };
          };
          fc.modelRun(setup, commands);
        },
      ),
      { seed: SEED_34003, numRuns: NUM_RUNS_34003 },
    );
  });

  it('FR-74 (rich): draining the retained undo stack lands on the oldest retained pre-state (seed 34003)', () => {
    // Overflow a small limit with rich edits, then drain the WHOLE retained undo
    // stack: the result must equal the reference model's floor (the `before` of
    // the oldest retained edit), NOT the original root, and every reachable state
    // — including the floor — must keep ring/hierarchy/forest validity.
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.integer({ min: 1, max: 2 }),
        fc.array(editOpArb, { minLength: 1, maxLength: 14 }),
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
            const after = applyRichEdit(before, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
            assertRichStepInvariants(history.state);
          }
          const retained = model.undo.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
            assertRichStepInvariants(history.state);
          }
          expectHistoryMatchesModel(history, model);
          const expectedFloor =
            retained === 0 ? viewSeries(initial) : model.current;
          expect(viewSeries(history.state)).toEqual(expectedFloor);
          // A further undo is a no-op.
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_34003, numRuns: NUM_RUNS_34003 },
    );
  });

  it('op∘inverse-op (rich): applyPastEdit INSERT then deleteAnchor of the inserted id restores the series (seed 34003)', () => {
    // A targeted reversibility law on the rich axis: inserting a fresh rich
    // anchor at a NON-existing start, then deleting exactly that anchor id, must
    // restore the original series byte-for-byte (the insert/delete pair is the
    // identity ON THE SERIES), and every intermediate state stays structurally
    // valid. Skipped when the insert collides with an existing start (replace,
    // not insert) or when the delete would empty the series.
    fc.assert(
      fc.property(
        richAnchorSeriesArb(),
        fc.integer({ min: -400, max: 400 }),
        fc.integer({ min: 0, max: 100000 }),
        (initial, year, seed) => {
          const at = timePointYear(year);
          // Only the pure-INSERT case is in scope: skip when a start already
          // exists at `at` (that path REPLACES a snapshot, not reversible by
          // delete).
          const existing = initial.entries.some(
            (e) => compare(e.start, at, cal) === 0,
          );
          if (existing) return;

          const tag = `inv${seed}`;
          const insertedId = asAnchorId(`${tag}-anchor`);
          // Reuse the rich pastEdit construction by routing through applyRichEdit.
          const inserted = applyRichEdit(initial, {
            kind: 'pastEdit',
            year,
            seed,
          });
          if (inserted === undefined) return; // no-op insert (shouldn't happen)
          // The inserted anchor id used by applyRichEdit's pastEdit branch.
          // It mints id `pe<seed>-anchor`; align our delete target with it.
          const peId = asAnchorId(`pe${seed}-anchor`);
          void insertedId;
          void tag;
          assertRichStepInvariants(inserted);

          // The insert must have added exactly one entry (or replaced via dedup,
          // in which case the count is unchanged and this law does not apply).
          if (inserted.entries.length !== initial.entries.length + 1) return;

          const del = deleteAnchor(inserted, peId, cal);
          if (!del.ok) return; // would-be-empty etc.: out of scope
          assertRichStepInvariants(del.series);

          // Insert∘delete on the series is the identity ONLY when the insert did
          // not auto-shorten a neighbor's end (normalization §5.6「短縮」). Verify
          // that precondition against the non-target entries, then assert the
          // exact round-trip.
          const othersUnchanged = nonTargetEntriesEqual(
            initial,
            inserted,
            peId as unknown as string,
          );
          if (othersUnchanged) {
            expect(viewSeries(del.series)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_34003, numRuns: NUM_RUNS_34003 },
    );
  });
});

describe('time-anchor + history undo/redo — seed 34004 stateful mixed-granularity bounded-model', () => {
  it('fc.commands: bounded mixed-granularity history stays model-consistent + selection-valid (seed 34004)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }), // SMALL limit ⇒ FR-74 trimming is common
        probeTimeArb,
        mixedCommandsArb,
        (initial, limit, probe, commands) => {
          assertStepInvariants(initial);
          expectProbeSelectionValid(initial, probe);
          const clampedLimit = Math.max(1, Math.floor(limit));
          const setup = (): { model: MixedModelState; real: MixedSut } => {
            const history = createHistory(initial, clampedLimit);
            const model: MixedModelState = {
              model: {
                current: viewSeries(initial),
                undo: [],
                redo: [],
                limit: clampedLimit,
              },
              probe,
            };
            expectHistoryMatchesModel(history, model.model); // sanity at t0
            return { model, real: { history } };
          };
          fc.modelRun(setup, commands);
        },
      ),
      { seed: SEED_34004, numRuns: NUM_RUNS_34004 },
    );
  });

  it('FR-74 (mixed, stateful-built): draining the retained undo stack lands on the oldest retained pre-state (seed 34004)', () => {
    // Overflow a small limit with mixed-granularity edits, then drain the WHOLE
    // retained undo stack: the floor must equal the reference model's current
    // (the `before` of the oldest retained edit), NOT the original root, and
    // every reachable state must keep all invariants.
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 2 }),
        fc.array(mixedEditOpArb, { minLength: 1, maxLength: 16 }),
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
            const after = applyMixedEdit(before, op);
            if (after === undefined) continue;
            history = execute(
              history,
              makeSeriesCommand(op.kind, before, after),
            ).history;
            model = modelExecute(model, viewSeries(before), viewSeries(after));
            assertStepInvariants(history.state);
          }
          const retained = model.undo.length;
          for (let i = 0; i < retained; i += 1) {
            history = undo(history).history;
            model = modelUndo(model);
            assertStepInvariants(history.state);
          }
          expectHistoryMatchesModel(history, model);
          const expectedFloor = retained === 0 ? viewSeries(initial) : model.current;
          expect(viewSeries(history.state)).toEqual(expectedFloor);
          // A further undo is a no-op on the drained stack.
          const extra = undo(history).history;
          expect(viewSeries(extra.state)).toEqual(viewSeries(history.state));
          expect(extra.undoStack.length).toBe(history.undoStack.length);
        },
      ),
      { seed: SEED_34004, numRuns: NUM_RUNS_34004 },
    );
  });

  it('op∘inverse-op (mixed end axis): setEnd(end) then setEnd(null) restores the open-ended baseline (seed 34004)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.nat(),
        mixedTimePointArb,
        (initial, targetN, endPoint) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;
          // Establish a clean open-ended baseline for the target.
          const cleared = setEnd(initial, id, null, cal);
          if (!cleared.ok) return;
          const base = cleared.series;
          // Set a mixed-granularity end; rejected ends are out of scope.
          const set = setEnd(base, id, endPoint, cal);
          if (!set.ok) return;
          expectAllInvariants(set.series);
          // Clearing it must restore the open-ended baseline structurally.
          const recleared = setEnd(set.series, id, null, cal);
          expect(recleared.ok).toBe(true);
          if (recleared.ok) {
            expectAllInvariants(recleared.series);
            expect(viewSeries(recleared.series)).toEqual(viewSeries(base));
          }
        },
      ),
      { seed: SEED_34004, numRuns: NUM_RUNS_34004 },
    );
  });

  it('no-resurrection (mixed): deleting an id then deleting it again rejects with anchorNotFound (seed 34004)', () => {
    fc.assert(
      fc.property(mixedAnchorSeriesArb(), fc.nat(), (initial, targetN) => {
        if (initial.entries.length < 2) return; // INV-5 guard on the first delete
        const target = initial.entries[targetN % initial.entries.length]!;
        const id = target.anchor.id;

        const first = deleteAnchor(initial, id, cal);
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expectAllInvariants(first.series);
        expect(first.series.entries.some((e) => e.anchor.id === id)).toBe(false);

        const second = deleteAnchor(first.series, id, cal);
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.reason.code).toBe('anchorNotFound');
        }
        expectAllInvariants(first.series);
      }),
      { seed: SEED_34004, numRuns: NUM_RUNS_34004 },
    );
  });

  it('save∘load == identity for any reachable mixed series under a stateful small-limit stream (seed 34004)', () => {
    fc.assert(
      fc.property(
        mixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }),
        fc.array(mixedBoundedActionArb, { maxLength: 40 }),
        (initial, limit, actions) => {
          let history: History<AnchorSeries> = createHistory(initial, limit);
          for (const action of actions) {
            if (action.t === 'edit' || action.t === 'editIfChanged') {
              const before = history.state;
              const after = applyMixedEdit(before, action.op);
              if (after === undefined) continue;
              history = execute(
                history,
                makeSeriesCommand(action.op.kind, before, after),
              ).history;
            } else if (action.t === 'undo') {
              history = undo(history).history;
            } else if (action.t === 'redo') {
              history = redo(history).history;
            } else if (action.t === 'clearRedo') {
              history = clearRedo(history);
            } else {
              history = withLimit(history, action.limit);
            }
            expectSaveLoadIdentity(history.state);
            assertStepInvariants(history.state);
          }
        },
      ),
      { seed: SEED_34004, numRuns: NUM_RUNS_34004 },
    );
  });
});
