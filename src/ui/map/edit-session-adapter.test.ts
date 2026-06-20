// U40↔U24 integration — 受け入れ基準9 / 教訓5.7「ロジックがあっても UI から呼ばれず
// 機能しない状態を作らない」.
//
// This fixes the contract the review flagged as missing: a real edit-mode pointer
// gesture, routed by the PointerDispatcher through the EditSessionPort adapter,
// MUST actually run U24's completion trigger (confirmRelease → U13). We assert the
// U13 pipeline ran (time check + spatial detect + one command) — i.e. the confirm
// is reached from the UI, not only from the domain barrel.

import { describe, expect, it } from 'vitest';

import { PointerDispatcher, type NormalizedPointer } from './PointerDispatcher';
import { POINTER_BUTTON, type PointerButton } from './dispatch';
import {
  createEditSessionPort,
  type EditSessionAdapterDeps,
  type SlideSnapNeighbours,
} from './edit-session-adapter';
import { NO_MODIFIERS, type PointerModifiers, type SelectionPort } from './ports';
import {
  featureBodyHit,
  vertexHit,
  type HitResult,
} from '../../domain/selection';
import { buildSnapshot, type FeatureSnapshot, type ReleaseOutcome } from '../../domain/editing';
import { PROCESS_STATUS, type ConsistencyPorts } from '../../domain/consistency';
import { defineCommandKind, createCommandResult, type Command } from '../../domain/command';
import { timePointYear } from '../../domain/time';
import { asFeatureId, asVertexId } from '../../domain/ids';
import { createLineFeature } from '../../domain/feature';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import type { WorldCoordinate } from '../../domain/coordinate';
import { EDIT_MODE } from '../state/session';
import type { Camera, ScreenPoint, Viewport } from '../../render';

const VIEWPORT: Viewport = { widthCss: 800, heightCss: 600, devicePixelRatio: 1 };

// --- recording U13 ports (the proof the confirm pipeline ran) ---------------

interface FakeState {
  readonly applied: number;
}

const KIND = defineCommandKind('test/u40-u24');

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

// --- fakes for the other dispatcher ports -----------------------------------

class FakeCamera {
  camera: Camera = { centerLon: 0, centerLat: 0, zoom: 4 };
  read() {
    return { camera: this.camera, viewport: VIEWPORT };
  }
  write() {
    /* unused here */
  }
}

class FakeSelection implements SelectionPort {
  events: string[] = [];
  start(hit: HitResult) {
    this.events.push(`start:${hit.kind}`);
  }
  move() {
    this.events.push('move');
  }
  end(_point: ScreenPoint, wasDrag: boolean) {
    this.events.push(`end:${wasDrag ? 'drag' : 'click'}`);
  }
  cancel() {
    this.events.push('cancel');
  }
}

const FEATURE = createLineFeature(
  asFeatureId('L'),
  createBasicAttributes('t', 0, 100),
  createColorInfo(true, '#1', '#2', '#3'),
  [asVertexId('v0'), asVertexId('v1')],
);

// screen px → world: a trivial 1:1 mapping is enough; we only need a real move.
const screenToWorld = (p: ScreenPoint): WorldCoordinate => ({ lon: p.x, lat: p.y });

function setup(hit: HitResult, extra: Partial<EditSessionAdapterDeps<FakeState>> = {}) {
  const log: PortLog = { applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 };
  const outcomes: ReleaseOutcome<FakeState>[] = [];
  const editSession = createEditSessionPort<FakeState>({
    screenToWorld,
    anchorTime: () => timePointYear(0),
    currentState: () => ({ applied: 0 }),
    ports: recordingPorts(log),
    buildSnapshot: () => buildSnapshot({ feature: FEATURE, vertices: [] }),
    onReleased: (o) => outcomes.push(o),
    ...extra,
  });
  const selection = new FakeSelection();
  const dispatcher = new PointerDispatcher({
    getMode: () => EDIT_MODE.Edit,
    camera: new FakeCamera(),
    hitTester: { hitTest: () => hit },
    selection,
    editSession,
    add: { press: () => {} },
    contextMenu: { request: () => {} },
  });
  return { dispatcher, log, outcomes, selection };
}

function ptr(
  pointerId: number,
  x: number,
  y: number,
  button: PointerButton = POINTER_BUTTON.Left,
  modifiers: PointerModifiers = NO_MODIFIERS,
): NormalizedPointer {
  return { pointerId, x, y, button, modifiers };
}

describe('edit-mode vertex drag drives U24 confirmRelease from the UI (受け入れ基準9 / 教訓5.7)', () => {
  it('press→move→release on a VERTEX hit actually runs the U13 confirm pipeline', () => {
    const { dispatcher, log, outcomes } = setup(vertexHit(asFeatureId('L'), asVertexId('v0')));
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 40, 40)); // a real move (crosses threshold)
    dispatcher.pointerUp(ptr(1, 40, 40));

    // THE proof: the completion trigger ran the U13 fixed-order pipeline.
    expect(log.applyProposal).toBe(1);
    expect(log.checkTime).toBe(1);
    expect(log.detectSpatial).toBe(1);
    expect(log.makeCommand).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('processed');
    if (outcomes[0]!.kind === 'processed') {
      expect(outcomes[0]!.result.status).toBe(PROCESS_STATUS.Committed);
    }
    expect(dispatcher.activeCount).toBe(0); // transient cleared (教訓5.2 / 5.8).
  });

  it('a zero-move CLICK on a vertex is discarded WITHOUT confirming (no ghost edit/undo)', () => {
    const { dispatcher, log, outcomes } = setup(vertexHit(asFeatureId('L'), asVertexId('v0')));
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerUp(ptr(1, 10, 10)); // same position → click (wasDrag=false)

    // The wasDrag guard drops the session: no confirm, no onReleased, no ghost undo.
    expect(outcomes).toHaveLength(0);
    expect(log).toEqual({ applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 });
    expect(dispatcher.activeCount).toBe(0);
  });

  // 受け入れ基準9 / 教訓5.24 / 5.30 — the BLOCKER regression: a 1–3px sub-threshold
  // press jitters below DRAG_THRESHOLD_PX (4), so the dispatcher / U22 treat it as a
  // CLICK. After quantization that 1–3px maps to a NON-zero world delta, so the old
  // isNoOp()/confirmRelease() world-equality guard would have committed a ghost edit
  // and pushed an undo. Honouring wasDrag in release makes U24 agree with the single
  // threshold: a sub-threshold press is a click → NO confirm, NO U13, NO undo.
  it.each([1, 2, 3])(
    'a %dpx sub-threshold press on a vertex is a click — no U13 run, no ghost undo',
    (jitter) => {
      const { dispatcher, log, outcomes } = setup(vertexHit(asFeatureId('L'), asVertexId('v0')));
      dispatcher.pointerDown(ptr(1, 10, 10));
      // A real move sample BELOW the 4px threshold (sqrt(jitter^2) < 4): the dispatcher
      // never flips dragged=true, so release carries wasDrag=false.
      dispatcher.pointerMove(ptr(1, 10 + jitter, 10));
      dispatcher.pointerUp(ptr(1, 10 + jitter, 10));

      // No confirm pipeline ran and no outcome was delivered — a click commits nothing,
      // even though the quantized world delta of `jitter`px is non-zero.
      expect(log).toEqual({ applyProposal: 0, checkTime: 0, detectSpatial: 0, makeCommand: 0 });
      expect(outcomes).toHaveLength(0);
      expect(dispatcher.activeCount).toBe(0);
    },
  );

  it('a FEATURE-BODY hit is plain U22 selection — no edit session, no confirm', () => {
    const { dispatcher, log, outcomes } = setup(featureBodyHit(asFeatureId('L')));
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 40, 40));
    dispatcher.pointerUp(ptr(1, 40, 40));
    expect(outcomes).toHaveLength(0);
    expect(log.applyProposal).toBe(0);
  });

  it('mode change mid-drag discards the edit-session transient without confirming (教訓5.2)', () => {
    const { dispatcher, log, outcomes } = setup(vertexHit(asFeatureId('L'), asVertexId('v0')));
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 40, 40));
    dispatcher.onModeChange(); // abort — no confirm should run.
    expect(outcomes).toHaveLength(0);
    expect(log.applyProposal).toBe(0);
    expect(dispatcher.activeCount).toBe(0);
    // A later release for the now-untracked pointer is a no-op (no double confirm).
    dispatcher.pointerUp(ptr(1, 40, 40));
    expect(outcomes).toHaveLength(0);
  });
});

// 受け入れ基準2 / FR-88 — a whole-feature MOVE from a feature-body hit also reaches
// confirmRelease from the UI (the second tool the hit contract can express).
describe('edit-mode feature-body drag drives a whole-feature move (受け入れ基準2 / FR-88)', () => {
  it('press→move→release on the ACTIVE feature body runs the U13 confirm pipeline', () => {
    const { dispatcher, log, outcomes } = setup(featureBodyHit(asFeatureId('L')), {
      featureMoveAllowed: () => true, // host: this body belongs to the active feature.
    });
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 40, 40)); // a real move (crosses threshold)
    dispatcher.pointerUp(ptr(1, 40, 40));

    expect(log.applyProposal).toBe(1);
    expect(log.makeCommand).toBe(1);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.kind).toBe('processed');
    expect(dispatcher.activeCount).toBe(0);
  });

  it('a body hit that is NOT feature-move-allowed stays plain U22 selection (no confirm)', () => {
    const { dispatcher, log, outcomes } = setup(featureBodyHit(asFeatureId('L')), {
      featureMoveAllowed: () => false,
    });
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 40, 40));
    dispatcher.pointerUp(ptr(1, 40, 40));
    expect(outcomes).toHaveLength(0);
    expect(log.applyProposal).toBe(0);
  });

  it('a sub-threshold click on the active feature body commits nothing (wasDrag guard)', () => {
    const { dispatcher, log, outcomes } = setup(featureBodyHit(asFeatureId('L')), {
      featureMoveAllowed: () => true,
    });
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 12, 10)); // 2px < threshold → click
    dispatcher.pointerUp(ptr(1, 12, 10));
    expect(outcomes).toHaveLength(0);
    expect(log.applyProposal).toBe(0);
  });
});

// 受け入れ基準6 / 12 — the slide / snap LIGHT PATH is driven from update(), not only
// from the pure unit tests: a live drag constrains the preview against near edges
// (constrainSlide) and carries a screen-proximity snap candidate (decideSnap) into
// the session, so a surviving snap can become a share pair at confirm.
describe('edit-mode drag runs the slide/snap light path through update() (受け入れ基準6 / 12)', () => {
  function neighboursSetup(neighbours: SlideSnapNeighbours) {
    const captured: { snap: ReturnType<typeof Object> | null } = { snap: null };
    const { dispatcher, log, outcomes } = setup(
      vertexHit(asFeatureId('L'), asVertexId('v0')),
      {
        worldToScreen: (w) => ({ x: w.lon, y: w.lat }),
        snapDistancePx: () => 50,
        neighboursAt: () => neighbours,
        // Capture the live session snap at confirm time via buildSnapshot.
        buildSnapshot: (session) => {
          captured.snap = session.snap;
          return buildSnapshot({ feature: FEATURE, vertices: [] });
        },
      },
    );
    return { dispatcher, log, outcomes, captured };
  }

  it('a near vertex within the snap distance becomes the live snap carried to confirm', () => {
    const target = asVertexId('shared');
    const { dispatcher, captured, outcomes } = neighboursSetup({
      edges: [],
      candidates: [],
      // The release point is (41,41) in world (1:1 screenToWorld); place a candidate
      // a few px away so it is within the 50px snap distance.
      snapCandidates: [{ vertexId: target, position: { lon: 43, lat: 43 } }],
    });
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 41, 41)); // real drag, near the candidate
    dispatcher.pointerUp(ptr(1, 41, 41));

    expect(outcomes).toHaveLength(1); // a real drag → confirm ran.
    // The snap candidate computed in update() survived into the confirmed session.
    expect(captured.snap).not.toBeNull();
    expect((captured.snap as { vertexId: unknown }).vertexId).toBe(target);
  });

  it('no near candidate leaves the session snap null (no spurious share)', () => {
    const { dispatcher, captured, outcomes } = neighboursSetup({
      edges: [],
      candidates: [],
      snapCandidates: [], // nothing near this frame
    });
    dispatcher.pointerDown(ptr(1, 10, 10));
    dispatcher.pointerMove(ptr(1, 41, 41));
    dispatcher.pointerUp(ptr(1, 41, 41));
    expect(outcomes).toHaveLength(1);
    expect(captured.snap).toBeNull();
  });
});
