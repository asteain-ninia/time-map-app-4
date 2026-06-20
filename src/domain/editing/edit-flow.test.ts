// U24 受け入れ基準8 / 10 / 12 — confirm-time edit flow: the no-op guard (no ghost
// undo), the single confirm path through U13 (fixed pipeline), and snap→share-pair
// decision at release (only a surviving candidate shares). 教訓5.7 / 5.24 / 5.26.

import { describe, expect, it } from 'vitest';

import {
  confirmRelease,
  decideSharePairAtRelease,
  isFeatureUnchanged,
  buildSnapshot,
  RELEASE_OUTCOME,
  type FeatureSnapshot,
} from './edit-flow';
import { beginDrag, updateDrag, EDIT_TOOL, type DragTarget } from './drag-session';
import { coord, fid, line, vid, rid } from './fixtures';
import { timePointYear } from '../time/time-point';
import { PROCESS_STATUS, type ConsistencyPorts, type EditProposal } from '../consistency/types';
import { defineCommandKind, type Command } from '../command/command';
import { createCommandResult } from '../command/result';

// --- a fake S (domain state) + recording ports -----------------------------

interface FakeState {
  readonly applied: number;
}

const KIND = defineCommandKind('test/u24');

function fakeCommand(): Command<FakeState> {
  const result = createCommandResult({});
  const outcome = (state: FakeState) => ({ state, result });
  return { kind: KIND, label: 'test', execute: outcome, undo: outcome, redo: outcome };
}

interface PortLog {
  applyProposal: number;
  checkTime: number;
  detectSpatial: number;
  makeCommand: number;
}

function recordingPorts(log: PortLog): ConsistencyPorts<FakeState, FeatureSnapshot> {
  return {
    applyProposal: (current) => {
      log.applyProposal += 1;
      return { applied: current.applied + 1 };
    },
    checkTime: () => {
      log.checkTime += 1;
      return { ok: true };
    },
    checkConstraints: () => [],
    detectSpatial: () => {
      log.detectSpatial += 1;
      return [];
    },
    applyResolution: (state) => state,
    makeCommand: () => {
      log.makeCommand += 1;
      return fakeCommand();
    },
  };
}

const vertexTarget: DragTarget = {
  tool: EDIT_TOOL.VertexMove,
  featureId: fid('L'),
  vertexId: vid('v0'),
  ringId: rid('r0'),
};

const snapshot: FeatureSnapshot = buildSnapshot({ feature: line('L', ['a', 'b']), vertices: [] });

describe('confirmRelease — no-op guard (受け入れ基準10 / 教訓5.24)', () => {
  it('a zero-move release runs NO consistency process and pushes NO history', () => {
    const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
    const session = beginDrag(vertexTarget, coord(1, 1)); // no move → click
    const outcome = confirmRelease({
      session,
      anchorTime: timePointYear(0),
      snapshot,
      current: { applied: 0 },
      ports: recordingPorts(log),
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.NoOp);
    expect(log).toEqual({ applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 });
  });

  it('forceChanged (attribute-only edit with no gesture move) still confirms', () => {
    const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
    const session = beginDrag(vertexTarget, coord(1, 1));
    const outcome = confirmRelease({
      session,
      anchorTime: timePointYear(0),
      snapshot,
      current: { applied: 0 },
      ports: recordingPorts(log),
      forceChanged: true,
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    expect(log.applyProposal).toBe(1);
  });
});

describe('confirmRelease — single confirm path through U13 (受け入れ基準8 / 教訓5.26)', () => {
  it('a real move assembles ONE proposal and drives the fixed-order pipeline', () => {
    const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
    let session = beginDrag(vertexTarget, coord(1, 1));
    session = updateDrag(session, { preview: coord(3, 3) }); // moved
    const outcome = confirmRelease({
      session,
      anchorTime: timePointYear(0),
      snapshot,
      current: { applied: 0 },
      ports: recordingPorts(log),
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
    expect(outcome.result.status).toBe(PROCESS_STATUS.Committed);
    // The U13 pipeline ran: time check + spatial detect + one command (one undo unit).
    expect(log.checkTime).toBe(1);
    expect(log.detectSpatial).toBe(1);
    expect(log.makeCommand).toBe(1);
    // The proposal targets the touched feature with the complete snapshot (FR-59).
    const proposal: EditProposal<FeatureSnapshot> = outcome.proposal;
    expect(proposal.featureId).toBe(fid('L'));
    expect(proposal.snapshot).toBe(snapshot);
  });

  it('a deletion snapshot still assembles a proposal keyed on the deleted feature', () => {
    const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
    let session = beginDrag(vertexTarget, coord(1, 1));
    session = updateDrag(session, { preview: coord(2, 2) });
    const delSnap = buildSnapshot({ deletedFeatureId: fid('L'), vertices: [] });
    const outcome = confirmRelease({
      session,
      anchorTime: timePointYear(0),
      snapshot: delSnap,
      current: { applied: 0 },
      ports: recordingPorts(log),
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
    expect(outcome.proposal.featureId).toBe(fid('L'));
  });
});

describe('decideSharePairAtRelease — snap survives to release (受け入れ基準12)', () => {
  it('a standing snap candidate at release becomes a share pair', () => {
    let session = beginDrag(vertexTarget, coord(1, 1));
    session = updateDrag(session, { preview: coord(5, 5), snap: { vertexId: vid('target'), screenDistance: 3 } });
    const pair = decideSharePairAtRelease(session);
    expect(pair).toEqual({ dragged: vid('v0'), target: vid('target') });
  });

  it('a snap candidate that LAPSED before release is dropped → no share (FR-31)', () => {
    let session = beginDrag(vertexTarget, coord(1, 1));
    session = updateDrag(session, { preview: coord(5, 5), snap: { vertexId: vid('target'), screenDistance: 3 } });
    session = updateDrag(session, { preview: coord(9, 9), snap: null }); // moved away
    expect(decideSharePairAtRelease(session)).toBeUndefined();
  });

  it('feature-move (no single dragged vertex) never produces a share pair', () => {
    let session = beginDrag({ tool: EDIT_TOOL.FeatureMove, featureId: fid('F') }, coord(0, 0));
    session = updateDrag(session, { preview: coord(1, 1), snap: { vertexId: vid('t'), screenDistance: 1 } });
    expect(decideSharePairAtRelease(session)).toBeUndefined();
  });

  it('edge-add: a vertex GENERATED on an edge becomes a share pair when its snap survives (FR-89 / 受け入れ基準6 最終項)', () => {
    // The reserved id of the to-be-created vertex is the dragged vertex; a snap that
    // survives to release promotes it to a share pair, so an edge-handle-generated
    // vertex can be shared just like a moved one (the previously impossible case).
    let session = beginDrag(
      {
        tool: EDIT_TOOL.EdgeAdd,
        featureId: fid('L'),
        startVertexId: vid('a'),
        endVertexId: vid('b'),
        newVertexId: vid('gen'),
      },
      coord(1, 1),
    );
    session = updateDrag(session, {
      preview: coord(5, 5),
      snap: { vertexId: vid('target'), screenDistance: 2 },
    });
    expect(decideSharePairAtRelease(session)).toEqual({ dragged: vid('gen'), target: vid('target') });
  });

  it('confirmRelease includes the decided share pair in the proposal snapshot', () => {
    const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
    let session = beginDrag(vertexTarget, coord(1, 1));
    session = updateDrag(session, { preview: coord(5, 5), snap: { vertexId: vid('target'), screenDistance: 3 } });
    const pair = decideSharePairAtRelease(session);
    const withShare = buildSnapshot({ feature: line('L', ['a', 'b']), vertices: [], sharePair: pair });
    const outcome = confirmRelease({
      session,
      anchorTime: timePointYear(0),
      snapshot: withShare,
      current: { applied: 0 },
      ports: recordingPorts(log),
    });
    expect(outcome.kind).toBe(RELEASE_OUTCOME.Processed);
    if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
    expect(outcome.proposal.snapshot.sharePair).toEqual({ dragged: vid('v0'), target: vid('target') });
  });
});

describe('isFeatureUnchanged — attribute baseline (受け入れ基準10)', () => {
  it('identical feature state is unchanged (no ghost commit)', () => {
    expect(isFeatureUnchanged(line('L', ['a', 'b']), line('L', ['a', 'b']))).toBe(true);
  });
  it('a changed feature is detected', () => {
    expect(isFeatureUnchanged(line('L', ['a', 'b']), line('L', ['a', 'c']))).toBe(false);
  });
});
