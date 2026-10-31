// time-anchor-history-undo-redo の検査 3/3。全体の説明と共有の生成器は time-anchor-history-undo-redo.arbitraries.ts。
// ファイル単位でしか並列に分配されないので割ってある（開発ガイド §1.12）。

import { describe, it } from 'vitest';

import { expect } from '../../test-support/fast-expect';
import fc from 'fast-check';
import { changeStart } from '../anchor-series';
import { createHistory, execute, executeIfChanged, undo } from '../command/history';
import {
  NUM_RUNS_44001,
  type RichMixedModelState,
  type RichMixedSut,
  SEED_44001,
  applyRichMixedEdit,
  assertRichStepInvariants,
  cal,
  checkpointReload,
  expectAggregateForestValid,
  expectAllInvariants,
  expectHistoryMatchesModel,
  expectProbeSelectionValid,
  expectRingHierarchyValid,
  makeSeriesCommand,
  mixedEditOpArb,
  mixedTimePointArb,
  nonTargetEntriesEqual,
  probeTimeArb,
  richMixedAnchorSeriesArb,
  richMixedCommandsArb,
  viewSeries,
} from './time-anchor-history-undo-redo.arbitraries';

describe('time-anchor + history undo/redo — seed 44001 stateful rich+mixed bounded-model + checkpoint', () => {
  it('fc.commands: bounded rich+mixed history stays model-consistent, structurally valid, and survives save→load checkpoints (seed 44001)', () => {
    fc.assert(
      fc.property(
        richMixedAnchorSeriesArb(),
        fc.integer({ min: 1, max: 3 }), // SMALL limit ⇒ FR-74 trimming is common
        probeTimeArb,
        richMixedCommandsArb,
        (initial, limit, probe, commands) => {
          assertRichStepInvariants(initial);
          expectProbeSelectionValid(initial, probe);
          const clampedLimit = Math.max(1, Math.floor(limit));
          const setup = (): { model: RichMixedModelState; real: RichMixedSut } => {
            const history = createHistory(initial, clampedLimit);
            const model: RichMixedModelState = {
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
      { seed: SEED_44001, numRuns: NUM_RUNS_44001 },
    );
  });

  it('metamorphic (rich+mixed): changeStart(t) then changeStart-back to the original start is identity on the target, via execute/undo (seed 44001)', () => {
    // Move the target's start to a new mixed-granularity point, then move it back
    // to its ORIGINAL start. When both moves are accepted and nothing collided
    // away (every non-target entry is byte-identical across the round-trip), the
    // result must equal the original series. We additionally drive the first move
    // through the dual-stack history and verify undo restores the pre-move series,
    // folding a history round-trip into the spatial-temporal inverse law.
    fc.assert(
      fc.property(
        richMixedAnchorSeriesArb(),
        fc.nat(),
        mixedTimePointArb,
        (initial, targetN, newStart) => {
          const target = initial.entries[targetN % initial.entries.length]!;
          const id = target.anchor.id;
          const originalStart = target.start;

          const moved = changeStart(initial, id, newStart, cal);
          if (!moved.ok) return; // rejected move is out of scope for this law
          const afterMove = moved.series;
          if (JSON.stringify(viewSeries(afterMove)) === JSON.stringify(viewSeries(initial))) {
            return; // no-op move (newStart resolved to the same start)
          }
          expectAllInvariants(afterMove);
          expectRingHierarchyValid(afterMove);
          expectAggregateForestValid(afterMove);

          // Drive the move through history and confirm undo restores the original.
          let history = createHistory(initial, 10);
          history = execute(history, makeSeriesCommand('changeStart', initial, afterMove)).history;
          expect(viewSeries(history.state)).toEqual(viewSeries(afterMove));
          const undone = undo(history).history;
          expect(viewSeries(undone.state)).toEqual(viewSeries(initial));

          // The moved entry must still be present (changeStart preserves count
          // unless a start collision collapsed it).
          if (!afterMove.entries.some((e) => e.anchor.id === id)) return;

          // Move back to the original start.
          const back = changeStart(afterMove, id, originalStart, cal);
          if (!back.ok) return;
          const afterBack = back.series;
          expectAllInvariants(afterBack);
          expectRingHierarchyValid(afterBack);
          expectAggregateForestValid(afterBack);

          // The round-trip is an identity ONLY when nothing collided away in
          // either direction (every non-target entry unchanged across both moves
          // AND the original still holds the same set of ids). Otherwise the move
          // legitimately reorganized neighbors and is not reversible by spec.
          const sameNonTargetThere = nonTargetEntriesEqual(initial, afterMove, id);
          const sameNonTargetBack = nonTargetEntriesEqual(afterMove, afterBack, id);
          const sameIds =
            JSON.stringify(initial.entries.map((e) => e.anchor.id).sort()) ===
            JSON.stringify(afterBack.entries.map((e) => e.anchor.id).sort());
          if (sameNonTargetThere && sameNonTargetBack && sameIds) {
            expect(viewSeries(afterBack)).toEqual(viewSeries(initial));
          }
        },
      ),
      { seed: SEED_44001, numRuns: NUM_RUNS_44001 },
    );
  });

  it('save→load checkpoint is an exact identity AND a history no-op for any reachable rich+mixed series (seed 44001)', () => {
    // Independent (non-stateful) confirmation of the checkpoint law: after a
    // random rich+mixed edit stream, serializing→reloading the series yields a
    // structurally identical series, and pushing it through executeIfChanged with
    // a content-derived no-op guard pushes NOTHING (the history is untouched).
    fc.assert(
      fc.property(
        richMixedAnchorSeriesArb(),
        fc.array(mixedEditOpArb, { maxLength: 16 }),
        (initial, ops) => {
          let s = initial;
          for (const op of ops) {
            const after = applyRichMixedEdit(s, op);
            if (after !== undefined) s = after;
          }
          assertRichStepInvariants(s);
          const reloaded = checkpointReload(s);
          // save∘load == identity (full rich fidelity).
          expect(viewSeries(reloaded)).toEqual(viewSeries(s));
          expectRingHierarchyValid(reloaded);
          expectAggregateForestValid(reloaded);

          // Pushing the checkpoint through history must be a no-op.
          let history = createHistory(s, 10);
          const depthBefore = history.undoStack.length;
          history = executeIfChanged(
            history,
            makeSeriesCommand('checkpoint', s, reloaded),
            (cur) =>
              JSON.stringify(viewSeries(reloaded)) === JSON.stringify(viewSeries(cur)),
          ).history;
          expect(history.undoStack.length).toBe(depthBefore);
          expect(viewSeries(history.state)).toEqual(viewSeries(s));
        },
      ),
      { seed: SEED_44001, numRuns: NUM_RUNS_44001 },
    );
  });
});
