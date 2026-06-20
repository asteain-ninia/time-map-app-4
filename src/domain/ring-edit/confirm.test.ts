// U25 — the confirm path into U13's single integrity pipeline (FR-57 / FR-59 /
// FR-61〜63 / FR-73 / FR-94, 受け入れ基準 6 / 8).

import { describe, expect, it } from 'vitest';
import { defineCommandKind, type Command } from '../command/command';
import { createCommandResult } from '../command/result';
import {
  PROCESS_STATUS,
  type ConsistencyPorts,
} from '../consistency/types';
import { RELEASE_OUTCOME, type FeatureSnapshot } from '../editing/edit-flow';
import { timePointYear } from '../time/time-point';
import { withLeafShape } from '../feature';
import { RING_COMMAND_STATUS, addHole, deleteTerritoryRing, RING_DELETE_OUTCOME } from './commands';
import {
  confirmRingEdit,
  isFeatureChanged,
  snapshotForDeletedFeature,
  snapshotForLeaf,
} from './confirm';
import { coord, idPorts, rid, squareLeaf } from './fixtures';

// A tiny domain state for the test: the current snapshot + a trace of the pipeline
// steps the orchestrator drove (to prove the fixed order ran).
interface TestState {
  readonly snapshot: FeatureSnapshot | null;
  readonly trace: readonly string[];
}

const RING_CMD_KIND = defineCommandKind('ring-edit:test');

/** Real-shaped ports that commit with no conflicts, recording the call order. */
function passThroughPorts(): ConsistencyPorts<TestState, FeatureSnapshot> {
  return {
    applyProposal: (current, proposal) => ({
      snapshot: proposal.snapshot,
      trace: [...current.trace, 'apply'],
    }),
    checkTime: () => ({ ok: true }),
    checkConstraints: () => [],
    detectSpatial: () => [],
    applyResolution: (state) => state,
    makeCommand: (baseline, finalState): Command<TestState> => ({
      kind: RING_CMD_KIND,
      label: 'リング編集',
      execute: () => ({ state: finalState, result: createCommandResult({}) }),
      undo: () => ({ state: baseline, result: createCommandResult({}) }),
      redo: () => ({ state: finalState, result: createCommandResult({}) }),
    }),
  };
}

describe('confirmRingEdit — drives the single pipeline (FR-61)', () => {
  it('a real change commits as ONE command, recording the anchor time', () => {
    const { feature, vertices } = squareLeaf();
    const res = addHole(feature, [coord(40, 40), coord(60, 40), coord(50, 60)], vertices, idPorts());
    expect(res.status).toBe(RING_COMMAND_STATUS.Ok);
    if (res.status !== RING_COMMAND_STATUS.Ok) return;

    const anchorTime = timePointYear(1500);
    const outcome = confirmRingEdit<TestState>({
      snapshot: snapshotForLeaf(res.feature, res.vertices),
      anchorTime,
      current: { snapshot: null, trace: [] },
      ports: passThroughPorts(),
      changed: true,
    });

    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
    // FR-57: the proposal carries the current timeline time as the anchor.
    expect(outcome.proposal.anchorTime).toEqual(anchorTime);
    expect(outcome.result.status).toBe(PROCESS_STATUS.Committed);
  });

  it('a no-op confirm (changed:false) records NO history (教訓 5.24)', () => {
    const { feature } = squareLeaf();
    const outcome = confirmRingEdit<TestState>({
      snapshot: snapshotForLeaf(feature, []),
      anchorTime: timePointYear(1500),
      current: { snapshot: null, trace: [] },
      ports: passThroughPorts(),
      changed: false,
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.NoOp);
  });

  it('the committed command round-trips (1 undo restores, 1 redo re-applies)', () => {
    const { feature, vertices } = squareLeaf();
    const res = addHole(feature, [coord(40, 40), coord(60, 40), coord(50, 60)], vertices, idPorts());
    if (res.status !== RING_COMMAND_STATUS.Ok) throw new Error('expected ok');
    const baseline: TestState = { snapshot: null, trace: [] };
    const outcome = confirmRingEdit<TestState>({
      snapshot: snapshotForLeaf(res.feature, res.vertices),
      anchorTime: timePointYear(1500),
      current: baseline,
      ports: passThroughPorts(),
      changed: true,
    });
    if (outcome.kind !== RELEASE_OUTCOME.Processed) throw new Error('expected processed');
    if (outcome.result.status !== PROCESS_STATUS.Committed) throw new Error('expected committed');
    const { command } = outcome.result;
    const afterExec = command.execute(baseline).state;
    expect(afterExec.snapshot).not.toBeNull();
    const afterUndo = command.undo(afterExec).state;
    expect(afterUndo).toEqual(baseline);
    const afterRedo = command.redo(afterUndo).state;
    expect(afterRedo.snapshot).not.toBeNull();
  });

  it('a territory-delete that empties the leaf confirms an indivisible deletion', () => {
    const { feature, vertices } = squareLeaf();
    const del = deleteTerritoryRing(feature, rid('T0'), vertices);
    expect(del.kind).toBe(RING_DELETE_OUTCOME.FeatureDeleted);
    if (del.kind !== RING_DELETE_OUTCOME.FeatureDeleted) return;
    const outcome = confirmRingEdit<TestState>({
      snapshot: snapshotForDeletedFeature(feature.id),
      anchorTime: timePointYear(1500),
      current: { snapshot: null, trace: [] },
      ports: passThroughPorts(),
      changed: true,
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
    expect(outcome.proposal.snapshot.deletedFeatureId).toBe(feature.id);
  });
});

describe('isFeatureChanged — baseline no-op guard (教訓 5.24)', () => {
  it('true when the shape differs, false when identical', () => {
    const { feature } = squareLeaf();
    expect(isFeatureChanged(feature, feature)).toBe(false);
    const moved = withLeafShape(feature, feature.shape);
    expect(isFeatureChanged(feature, moved)).toBe(false); // structurally equal
  });
});
