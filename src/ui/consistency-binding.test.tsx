// U44 — live consistency binding tests: the add binding runs the REAL U13
// pipeline over the live domain root (commit on no conflict, ConflictsPending on
// terminal overlap), reads the root at process-start, and the committed command
// swaps state. This closes the namespace-vs-default gap the prior type骨格 left:
// it asserts applyProposal / detectSpatial / makeCommand actually execute.

import { describe, expect, it } from 'vitest';

import {
  createLiveAddBinding,
  createLiveKnifeBinding,
  type DomainRoot,
} from './consistency-binding';
import {
  createEditProposal,
  PROCESS_STATUS,
  REJECTION_KIND,
} from '../domain/consistency/index';
import { applyAddProposal } from '../domain/editing/apply-proposal';
import type { SplitSnapshot } from '../domain/knife/index';
import { timePointYear } from '../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../domain/feature';
import { createShape, createTerritoryRing } from '../domain/ring';
import { createVertex, type Vertex } from '../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';
import { createGeoParams } from '../domain/geo/geo-params';
import type { AddSnapshot } from '../domain/add/index';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function emptyProject(): DomainRoot {
  return {
    histories: [],
    settings: {
      calendarId: 'gregorian',
      geo: createGeoParams(40000, 0.0034),
      gridSpacingDeg: 10,
      snapDistancePx: 50,
      autoColorDefault: true,
    },
    baseMap: { source: 's', meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 } },
  };
}

/** A unit square leaf at the given lon/lat offset. */
function squareLeaf(
  idRaw: string,
  vPrefix: string,
  ox: number,
  oy: number,
  name = idRaw,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [2, 0],
    [2, 2],
    [0, 2],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${vPrefix}-${i}`), { lon: c[0]! + ox, lat: c[1]! + oy }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(name, 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function addSnapshot(feature: LeafFeature, vertices: Vertex[]): AddSnapshot {
  return { feature, vertices, sharedCandidateIds: new Map() };
}

describe('createLiveAddBinding', () => {
  it('commits a non-overlapping add and the command swaps state', () => {
    let root = emptyProject();
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('vx'),
      nextRingId: () => asRingId('rx'),
    });

    const { feature, vertices } = squareLeaf('f-1', 'v1', 0, 0);
    const proposal = createEditProposal(feature.id, timePointYear(1000), addSnapshot(feature, vertices));

    const result = binding.startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;
    expect(result.state.histories).toHaveLength(1);
    // The single composite command replays to the committed state.
    const outcome = result.command.execute(root);
    expect(outcome.state.histories).toHaveLength(1);
    // Simulate the store write so a subsequent add sees the live root.
    root = result.state;

    // A second non-overlapping add also commits and accumulates.
    const b = squareLeaf('f-2', 'v2', 10, 10);
    const r2 = binding.startProcess(
      createEditProposal(b.feature.id, timePointYear(1000), addSnapshot(b.feature, b.vertices)),
    );
    expect(r2.status).toBe(PROCESS_STATUS.Committed);
    if (r2.status === PROCESS_STATUS.Committed) {
      expect(r2.state.histories).toHaveLength(2);
    }
  });

  it('returns ConflictsPending when the add overlaps an existing terminal', () => {
    // Seed a committed feature, then add an overlapping one at the same time.
    let root = emptyProject();
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('vx'),
      nextRingId: () => asRingId('rx'),
    });
    const a = squareLeaf('f-a', 'va', 0, 0);
    const first = binding.startProcess(
      createEditProposal(a.feature.id, timePointYear(1000), addSnapshot(a.feature, a.vertices)),
    );
    expect(first.status).toBe(PROCESS_STATUS.Committed);
    if (first.status === PROCESS_STATUS.Committed) root = first.state;

    // Overlapping square (shares positive area with f-a).
    const b = squareLeaf('f-b', 'vb', 1, 1);
    const second = binding.startProcess(
      createEditProposal(b.feature.id, timePointYear(1000), addSnapshot(b.feature, b.vertices)),
    );
    expect(second.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (second.status === PROCESS_STATUS.ConflictsPending) {
      expect(second.conflicts.length).toBeGreaterThan(0);
    }
  });

  // REGRESSION (bughunt R2): the conflict modal showed BLANK feature labels —
  // the priority radios read "優先: " and the overlap row read "／" with no
  // identifier — for UNNAMED faces (the default: the add form commits an empty
  // name). Root cause: displayNamesAt used `byId.get(id) ?? String(id)`, and the
  // `??` only fires when the id is ABSENT; a present-but-empty name ('') returned
  // '' and never fell back. The conflict's displayName MUST carry an identifier
  // (the feature id, mirroring 地物一覧's name→id rule) so FR-63 priority
  // selection is disambiguatable. This drives the REAL U13 pipeline.
  it('conflict display names fall back to the feature id when the name is EMPTY (FR-62)', () => {
    let root = emptyProject();
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('vx'),
      nextRingId: () => asRingId('rx'),
    });
    // Two overlapping squares, BOTH with an empty name (unnamed faces default).
    const a = squareLeaf('f-a', 'va', 0, 0, '');
    const first = binding.startProcess(
      createEditProposal(a.feature.id, timePointYear(1000), addSnapshot(a.feature, a.vertices)),
    );
    expect(first.status).toBe(PROCESS_STATUS.Committed);
    if (first.status === PROCESS_STATUS.Committed) root = first.state;

    const b = squareLeaf('f-b', 'vb', 1, 1, '');
    const second = binding.startProcess(
      createEditProposal(b.feature.id, timePointYear(1000), addSnapshot(b.feature, b.vertices)),
    );
    expect(second.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (second.status !== PROCESS_STATUS.ConflictsPending) return;
    const conflict = second.conflicts[0]!;
    // Neither side renders blank: both carry the feature id as the fallback label.
    expect(conflict.a.displayName.trim().length).toBeGreaterThan(0);
    expect(conflict.b.displayName.trim().length).toBeGreaterThan(0);
    expect([conflict.a.displayName, conflict.b.displayName].sort()).toEqual(
      ['f-a', 'f-b'].sort(),
    );
  });

  it('rejects a split whose inheritor is not effective at the anchor time as a TIME violation', () => {
    // A split whose inheritor history EXISTS but is ABSENT at the (earlier) anchor
    // time used to drive applySplitProposal into a throw ('inheritor feature not
    // found') that the live seam surfaced as a generic Internal error. The U09
    // checkTime gate now verifies the inheritor IS effective at the anchor time and
    // returns a typed TIME violation, so the user sees a time-domain reason rather
    // than a generic internal error (Codex U44 error-path true-positive).
    const inheritor = squareLeaf('f-inh', 'vi', 0, 0);
    const root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(inheritor.feature, inheritor.vertices),
    });

    const binding = createLiveKnifeBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('vx'),
      nextRingId: () => asRingId('rx'),
    });

    const newSide = squareLeaf('f-new', 'vn', 20, 20);
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: newSide.feature.shape,
      newFeature: newSide.feature,
      vertices: [...inheritor.vertices, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSide.feature.id],
    };
    // anchorTime 500 < the inheritor's first anchor (1000) → absent at base time.
    const proposal = createEditProposal(inheritor.feature.id, timePointYear(500), snapshot);

    const result = binding.startProcess(proposal);

    expect(result.status).toBe(PROCESS_STATUS.Rejected);
    if (result.status === PROCESS_STATUS.Rejected) {
      expect(result.kind).toBe(REJECTION_KIND.TimeViolation);
    }
  });

  it('rejects an invalid anchor time (U09 temporal check executes)', () => {
    const root = emptyProject();
    const binding = createLiveAddBinding({ getRoot: () => root });
    const { feature, vertices } = squareLeaf('f-1', 'v1', 0, 0);
    // A non-integer year is an invalid TimePoint (U02 validate).
    const badTime = { granularity: 'year', year: 1.5 } as const;
    const result = binding.startProcess(
      createEditProposal(feature.id, badTime, addSnapshot(feature, vertices)),
    );
    expect(result.status).toBe(PROCESS_STATUS.Rejected);
  });
});

describe('applyResolutionsFor (U35 proposal-bound adapter)', () => {
  it('commits an overlapping add once a priority/adjust policy is supplied', () => {
    // Seed f-a, then propose an OVERLAPPING f-b → ConflictsPending; resolving with
    // f-a priority / f-b adjust must commit (U06 trims f-b, U10 re-detects clean).
    let root = emptyProject();
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: (() => {
        let n = 0;
        return () => asVertexId(`rv-${(n += 1)}`);
      })(),
      nextRingId: (() => {
        let n = 0;
        return () => asRingId(`rr-${(n += 1)}`);
      })(),
    });
    const a = squareLeaf('f-a', 'va', 0, 0); // [0,2]×[0,2]
    const first = binding.startProcess(
      createEditProposal(a.feature.id, timePointYear(1000), addSnapshot(a.feature, a.vertices)),
    );
    if (first.status === PROCESS_STATUS.Committed) root = first.state;

    const b = squareLeaf('f-b', 'vb', 1, 1); // overlaps f-a
    const proposal = createEditProposal(
      b.feature.id,
      timePointYear(1000),
      addSnapshot(b.feature, b.vertices),
    );
    const pending = binding.startProcess(proposal);
    expect(pending.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (pending.status !== PROCESS_STATUS.ConflictsPending) return;

    const conflict = pending.conflicts[0]!;
    const apply = binding.applyResolutionsFor(proposal);
    const committed = apply([
      {
        conflictId: conflict.id,
        priorityFeatureId: a.feature.id,
        adjustFeatureId: b.feature.id,
      },
    ]);
    expect(committed.status).toBe(PROCESS_STATUS.Committed);
    if (committed.status === PROCESS_STATUS.Committed) {
      // Both features survive (f-b trimmed, not deleted).
      const result = committed.command.execute(root).result;
      expect(result.created.has(b.feature.id)).toBe(true);
      expect(result.survived.has(a.feature.id)).toBe(true);
    }
  });

  it('returns conflicts-pending again when no policy is supplied (部分確定の禁止)', () => {
    let root = emptyProject();
    const binding = createLiveAddBinding({ getRoot: () => root });
    const a = squareLeaf('f-a', 'va', 0, 0);
    const first = binding.startProcess(
      createEditProposal(a.feature.id, timePointYear(1000), addSnapshot(a.feature, a.vertices)),
    );
    if (first.status === PROCESS_STATUS.Committed) root = first.state;
    const b = squareLeaf('f-b', 'vb', 1, 1);
    const proposal = createEditProposal(
      b.feature.id,
      timePointYear(1000),
      addSnapshot(b.feature, b.vertices),
    );
    binding.startProcess(proposal);
    const again = binding.applyResolutionsFor(proposal)([]);
    expect(again.status).toBe(PROCESS_STATUS.ConflictsPending);
  });

  it('ACCUMULATES policies across successive apply calls (re-競合 stopping property)', () => {
    // Stopping-property regression: U13 re-runs the WHOLE pipeline from the live
    // baseline on every apply, so a SECOND apply that carries only the new round's
    // policy used to forget the first round's choice — re-detecting the original
    // conflict and oscillating forever. The proposal-bound adapter must remember
    // each chosen policy by conflict id and pass the CUMULATIVE set every call.
    //
    // Seed two non-overlapping leaves f-a [0,2]² and f-b [10,12]²; then propose a
    // wide new leaf f-n that overlaps BOTH → two simultaneous conflicts. Supplying
    // ONE policy at a time across two apply calls must converge to Committed.
    let root = emptyProject();
    let n = 0;
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId(`rv-${(n += 1)}`),
      nextRingId: () => asRingId(`rr-${(n += 1)}`),
    });

    const a = squareLeaf('f-a', 'va', 0, 0); // [0,2]×[0,2]
    const ra = binding.startProcess(
      createEditProposal(a.feature.id, timePointYear(1000), addSnapshot(a.feature, a.vertices)),
    );
    if (ra.status === PROCESS_STATUS.Committed) root = ra.state;
    const b = squareLeaf('f-b', 'vb', 10, 0); // [10,12]×[0,2]
    const rb = binding.startProcess(
      createEditProposal(b.feature.id, timePointYear(1000), addSnapshot(b.feature, b.vertices)),
    );
    if (rb.status === PROCESS_STATUS.Committed) root = rb.state;

    // A wide new leaf spanning x∈[1,11], y∈[0,2] overlaps BOTH f-a and f-b.
    const nVerts = [
      [1, 0],
      [11, 0],
      [11, 2],
      [1, 2],
    ].map((c, i) => createVertex(asVertexId(`vn-${i}`), { lon: c[0]!, lat: c[1]! }));
    const nRing = createTerritoryRing(asRingId('r-f-n'), nVerts.map((v) => v.id));
    const nFeature = createLeafFeature(
      asFeatureId('f-n'),
      createBasicAttributes('f-n', 0, 0),
      color,
      createShape([nRing]),
    );
    const proposal = createEditProposal(
      nFeature.id,
      timePointYear(1000),
      addSnapshot(nFeature, nVerts),
    );

    const pending = binding.startProcess(proposal);
    expect(pending.status).toBe(PROCESS_STATUS.ConflictsPending);
    if (pending.status !== PROCESS_STATUS.ConflictsPending) return;
    expect(pending.conflicts.length).toBe(2);

    const apply = binding.applyResolutionsFor(proposal);
    const [c1, c2] = pending.conflicts;

    // f-n is always the adjust side; the OTHER participant keeps priority.
    const policyFor = (conflict: (typeof pending.conflicts)[number]) => {
      const priorityFeatureId =
        conflict.a.featureId === nFeature.id ? conflict.b.featureId : conflict.a.featureId;
      return { conflictId: conflict.id, priorityFeatureId, adjustFeatureId: nFeature.id };
    };

    // Round 1: resolve ONLY the first conflict. Still pending (the OTHER conflict
    // has no policy yet).
    const round1 = apply([policyFor(c1!)]);
    expect(round1.status).toBe(PROCESS_STATUS.ConflictsPending);

    // Round 2: send ONLY the second conflict's policy. Without accumulation the
    // first conflict would re-appear and this would stay pending forever; WITH
    // accumulation the adapter re-sends round 1's policy too, so it commits.
    const round2 = apply([policyFor(c2!)]);
    expect(round2.status).toBe(PROCESS_STATUS.Committed);
  });
});

describe('createLiveKnifeBinding — a clean axis-aligned split commits without conflict', () => {
  it('a real assembled split of a seeded leaf commits (no seam-overlap conflict)', async () => {
    const { unitSquare, freshIdPorts, ATTRS, COLOR } = await import('../domain/knife/fixtures');
    const { createOpenKnifeLine } = await import('../domain/knife/knife-line');
    const { executeSplit } = await import('../domain/knife/split-geometry');
    const {
      assembleSplitProposal,
      createInheritanceChoice,
      toSplitSnapshot,
      toEditProposal,
      INHERITANCE_SIDE,
    } = await import('../domain/knife/proposal');
    const { createCoordinate } = await import('../domain/coordinate');

    const { feature, store } = unitSquare('sq'); // [0,10]² leaf
    let root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: feature.id,
      anchorTime: timePointYear(1000),
      snapshot: {
        feature,
        vertices: [...store.byId.values()],
        sharedCandidateIds: new Map(),
      },
    });

    // A clean vertical cut at x=4 (outside→outside) bisects the square.
    const line = createOpenKnifeLine([createCoordinate(4, -5), createCoordinate(4, 15)]);
    const result = executeSplit(feature, store, line);
    expect(result).toBeDefined();
    if (!result) return;
    const split = assembleSplitProposal({
      target: feature,
      store: store.byId,
      result,
      choice: createInheritanceChoice(INHERITANCE_SIDE.A),
      nonInherited: { attributes: ATTRS, color: COLOR },
      ids: freshIdPorts(),
    });
    const edit = toEditProposal(split, timePointYear(1000));
    void toSplitSnapshot(split);

    const binding = createLiveKnifeBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('kvx'),
      nextRingId: () => asRingId('krx'),
    });
    const outcome = binding.startProcess(edit);
    // The two halves share the cut edge (zero-area contact), so U10 detects NO
    // positive-area overlap → the split commits directly (FR-26 / 教訓 5.30).
    expect(outcome.status).toBe(PROCESS_STATUS.Committed);
    if (outcome.status === PROCESS_STATUS.Committed) {
      root = outcome.state;
      const cmdResult = outcome.command.execute(root).result;
      expect(cmdResult.created.has(split.newFeature.id)).toBe(true);
      expect(cmdResult.survived.has(feature.id)).toBe(true);
    }
  });
});

describe('makeCommand finding5 — split created set includes the new feature', () => {
  it('a committing split records BOTH the inheritor (survived) and the new feature (created)', () => {
    // Seed the inheritor leaf at year 1000.
    const inheritor = squareLeaf('f-inh', 'vi', 0, 0); // [0,2]×[0,2]
    let root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: inheritor.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(inheritor.feature, inheritor.vertices),
    });

    const binding = createLiveKnifeBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId('kvx'),
      nextRingId: () => asRingId('krx'),
    });

    // Inheritor keeps a sub-square; the non-inherited new feature is a DISJOINT
    // square so U10 finds no residual overlap and the split commits cleanly.
    const inheritorSub = squareLeaf('ignored-a', 'isa', 0, 0); // [0,2]×[0,2] (subset shape carrier)
    const newSide = squareLeaf('f-new', 'vn', 10, 10); // disjoint [10,12]×[10,12]
    const snapshot: SplitSnapshot = {
      inheritorFeatureId: inheritor.feature.id,
      inheritorShape: inheritorSub.feature.shape,
      newFeature: newSide.feature,
      vertices: [...inheritor.vertices, ...newSide.vertices],
      vertexRemap: new Map(),
      sharedEdgeCuts: [],
      touchedFeatureIds: [inheritor.feature.id, newSide.feature.id],
    };
    const proposal = createEditProposal(inheritor.feature.id, timePointYear(1000), snapshot);
    const result = binding.startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    const cmdResult = result.command.execute(root).result;
    // finding5: the new non-inherited feature is in `created` even though the
    // orchestrator's touched set keys only on proposal.featureId (the inheritor).
    expect(cmdResult.created.has(newSide.feature.id)).toBe(true);
    // The inheritor pre-existed, so it survived (not created).
    expect(cmdResult.survived.has(inheritor.feature.id)).toBe(true);
    expect(cmdResult.created.has(inheritor.feature.id)).toBe(false);
    // The undo (backward) deletes the created new feature.
    const undoResult = result.command.undo(result.state).result;
    expect(undoResult.deleted.has(newSide.feature.id)).toBe(true);

    root = result.state;
  });
});

// REGRESSION (bughunt: 実アプリで頂点/地物のドラッグ編集が PointerDispatcher に未結線 —
// confirmRelease 到達不能, 教訓5.7). The pure U24 adapter + the new live EDIT binding
// must, when assembled exactly as App.tsx assembles them, turn a real edit-mode vertex
// drag — routed through the PointerDispatcher — into a COMMITTED geometry change. Before
// the fix the dispatcher had no `editSession`, so a drag reached only U22 selection
// (which excludes a drag) and the committed shape never changed (repro: 頂点をドラッグ
// しても形状が変化しない). This drives the WHOLE wired path and asserts the move lands.
describe('wired edit-session: an edit-mode vertex drag commits a real geometry change (教訓5.7)', () => {
  it('dragging a committed leaf vertex through the dispatcher moves it in the committed state', async () => {
    const { PointerDispatcher } = await import('./map/PointerDispatcher');
    const { POINTER_BUTTON } = await import('./map/dispatch');
    const { createEditSessionPort } = await import('./map/edit-session-adapter');
    const { buildEditSnapshot, ringIdForLeafVertex } = await import('./map/edit-session-snapshot');
    const { createLiveEditBinding } = await import('./consistency-binding');
    const { RELEASE_OUTCOME } = await import('../domain/editing/index');
    const { NO_MODIFIERS } = await import('./map/ports');
    const { vertexHit } = await import('../domain/selection');
    const { verticesAt, featureByIdAt } = await import('./live-lookup');
    const { resolveLeafShape } = await import('../domain/hierarchy/resolve-shape');
    const { EDIT_MODE } = await import('./state/session');

    // Seed one committed leaf at year 1000 (the live root the binding reads).
    const seed = squareLeaf('f-1', 'v1', 0, 0); // corners (0,0)(2,0)(2,2)(0,2)
    let root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: seed.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(seed.feature, seed.vertices),
    });
    const time = timePointYear(1000);
    const draggedVertexId = seed.vertices[0]!.id; // the (0,0) corner

    // 1:1 screen↔world so a screen drag is a world drag of the same magnitude.
    const screenToWorld = (p: { x: number; y: number }) => ({ lon: p.x, lat: p.y });

    const editBinding = createLiveEditBinding({ getRoot: () => root });
    const ctx = { getRoot: () => root, getTime: () => time };
    let lastOutcomeKind = '';
    const editSession = createEditSessionPort<DomainRoot>({
      screenToWorld,
      ringIdForVertex: (hit) => ringIdForLeafVertex(ctx, hit.featureId, hit.vertexId),
      featureMoveAllowed: () => false,
      anchorTime: () => time,
      currentState: () => root,
      ports: editBinding.ports,
      buildSnapshot: (session) => buildEditSnapshot(ctx, session),
      onReleased: (outcome) => {
        lastOutcomeKind = outcome.kind;
        if (outcome.kind !== RELEASE_OUTCOME.Processed) return;
        if (outcome.result.status !== PROCESS_STATUS.Committed) return;
        // Mimic the store write App's recordCommit performs (single write path).
        root = outcome.result.command.execute(root).state;
      },
    });

    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      camera: {
        read: () => ({
          camera: { centerLon: 0, centerLat: 0, zoom: 1 },
          viewport: { widthCss: 800, heightCss: 600, devicePixelRatio: 1 },
        }),
        write: () => {},
      },
      // The hit-test resolves the dragged corner vertex (vertex-first priority).
      hitTester: { hitTest: () => vertexHit(seed.feature.id, draggedVertexId) },
      selection: { start: () => {}, move: () => {}, end: () => {}, cancel: () => {} },
      editSession,
      add: { press: () => {} },
      contextMenu: { request: () => {} },
    });

    // The committed (0,0) corner before the drag (sanity: the seed is in place).
    expect(verticesAt(root, time).byId.get(draggedVertexId)!.coordinate).toEqual({
      lon: 0,
      lat: 0,
    });

    // Press on the corner, drag it well past the 4px threshold to (5,5), release.
    const ptr = (x: number, y: number) => ({
      pointerId: 1,
      x,
      y,
      button: POINTER_BUTTON.Left,
      modifiers: NO_MODIFIERS,
    });
    dispatcher.pointerDown(ptr(0, 0));
    dispatcher.pointerMove({ ...ptr(5, 5), button: POINTER_BUTTON.Left });
    dispatcher.pointerUp(ptr(5, 5));

    // THE proof: the confirm trigger ran AND the committed geometry actually moved
    // (was unreachable before the dispatcher was given an editSession).
    expect(lastOutcomeKind).toBe(RELEASE_OUTCOME.Processed);
    const movedVertex = verticesAt(root, time).byId.get(draggedVertexId);
    expect(movedVertex).toBeDefined();
    expect(movedVertex!.coordinate).toEqual({ lon: 5, lat: 5 });
    // The leaf's resolved shape reflects the moved corner (single truth source).
    const leaf = featureByIdAt(root, time, seed.feature.id)!;
    expect(leaf.kind).toBe('leaf');
    if (leaf.kind === 'leaf') {
      const after = resolveLeafShape(leaf.shape, verticesAt(root, time))!;
      expect(after[0]![0]).toContainEqual({ lon: 5, lat: 5 });
    }
  });

  it('a zero-move click on a vertex commits nothing (no ghost edit — wasDrag guard)', async () => {
    const { PointerDispatcher } = await import('./map/PointerDispatcher');
    const { POINTER_BUTTON } = await import('./map/dispatch');
    const { createEditSessionPort } = await import('./map/edit-session-adapter');
    const { buildEditSnapshot } = await import('./map/edit-session-snapshot');
    const { createLiveEditBinding } = await import('./consistency-binding');
    const { NO_MODIFIERS } = await import('./map/ports');
    const { vertexHit } = await import('../domain/selection');
    const { EDIT_MODE } = await import('./state/session');

    const seed = squareLeaf('f-1', 'v1', 0, 0);
    // `root` is never reassigned here: a click must NOT trigger a commit, so the
    // onReleased write path (which would reassign in a real drag) is never reached.
    const root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: seed.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(seed.feature, seed.vertices),
    });
    const time = timePointYear(1000);
    const editBinding = createLiveEditBinding({ getRoot: () => root });
    const ctx = { getRoot: () => root, getTime: () => time };
    let outcomes = 0;
    const editSession = createEditSessionPort<DomainRoot>({
      screenToWorld: (p) => ({ lon: p.x, lat: p.y }),
      anchorTime: () => time,
      currentState: () => root,
      ports: editBinding.ports,
      buildSnapshot: (session) => buildEditSnapshot(ctx, session),
      // A click should never reach this (the wasDrag guard discards it). If it did,
      // this counter would catch the ghost edit / ghost undo (受け入れ基準9 / 教訓5.24).
      onReleased: () => {
        outcomes += 1;
      },
    });
    const dispatcher = new PointerDispatcher({
      getMode: () => EDIT_MODE.Edit,
      camera: {
        read: () => ({
          camera: { centerLon: 0, centerLat: 0, zoom: 1 },
          viewport: { widthCss: 800, heightCss: 600, devicePixelRatio: 1 },
        }),
        write: () => {},
      },
      hitTester: { hitTest: () => vertexHit(seed.feature.id, seed.vertices[0]!.id) },
      selection: { start: () => {}, move: () => {}, end: () => {}, cancel: () => {} },
      editSession,
      add: { press: () => {} },
      contextMenu: { request: () => {} },
    });
    const ptr = (x: number, y: number) => ({
      pointerId: 1,
      x,
      y,
      button: POINTER_BUTTON.Left,
      modifiers: NO_MODIFIERS,
    });
    dispatcher.pointerDown(ptr(0, 0));
    dispatcher.pointerUp(ptr(0, 0)); // same position → click, not a drag

    expect(outcomes).toBe(0); // no confirm, no commit, no ghost undo.
    // The committed corner is untouched (no ghost geometry edit on a click).
    const { verticesAt } = await import('./live-lookup');
    expect(verticesAt(root, time).byId.get(seed.vertices[0]!.id)!.coordinate).toEqual({
      lon: 0,
      lat: 0,
    });
  });
});

// REGRESSION (bughunt: tool switch mid-edit-drag did not abort the in-flight edit —
// the drag still committed on release). App.tsx subscribed only to `mode` and called
// dispatcher.onModeChange() (→ abortAll) when `mode` changed. A TOOL switch
// (store.setActiveTool) runs the SAME reset契約 — it wipes the selection context — but
// leaves `mode` untouched, so the abort never fired: an edit session begun in Edit mode
// survived a mid-drag toolbar switch and PointerDispatcher.pointerUp still ran
// editSession.release → confirmRelease → recordCommit, landing a stray commit whose
// selection context was already cleared (violates 教訓5.2 全経路で破棄 / 受け入れ基準6).
// The fix tracks prevActiveTool alongside prevMode in the App subscription and aborts on
// EITHER change. This drives the REAL store + REAL dispatcher assembled as App wires them.
describe('tool switch mid-drag aborts the in-flight edit (no stray commit — 教訓5.2 / 受け入れ基準6)', () => {
  it('switching the active tool during an edit-drag discards the session so release commits NOTHING', async () => {
    const { PointerDispatcher } = await import('./map/PointerDispatcher');
    const { POINTER_BUTTON } = await import('./map/dispatch');
    const { createEditSessionPort } = await import('./map/edit-session-adapter');
    const { buildEditSnapshot, ringIdForLeafVertex } = await import(
      './map/edit-session-snapshot'
    );
    const { createLiveEditBinding } = await import('./consistency-binding');
    const { RELEASE_OUTCOME } = await import('../domain/editing/index');
    const { NO_MODIFIERS } = await import('./map/ports');
    const { vertexHit } = await import('../domain/selection');
    const { verticesAt } = await import('./live-lookup');
    const { createSessionStore } = await import('./state/store');
    const { EDIT_MODE, asToolId } = await import('./state/session');

    // Seed one committed leaf at year 1000 (the live root the binding reads).
    const seed = squareLeaf('f-1', 'v1', 0, 0); // corners (0,0)(2,0)(2,2)(0,2)
    const root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: seed.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(seed.feature, seed.vertices),
    });
    const time = timePointYear(1000);
    const draggedVertexId = seed.vertices[0]!.id; // the (0,0) corner

    // Live store, started in Edit mode (as a vertex edit-drag requires).
    const store = createSessionStore<DomainRoot>({
      initialDomain: root,
      initial: { mode: EDIT_MODE.Edit, activeTool: asToolId('edit.vertex') },
    });

    const screenToWorld = (p: { x: number; y: number }) => ({ lon: p.x, lat: p.y });
    const editBinding = createLiveEditBinding({ getRoot: () => store.getState().domain });
    const ctx = { getRoot: () => store.getState().domain, getTime: () => time };
    let releaseOutcomes = 0;
    const editSession = createEditSessionPort<DomainRoot>({
      screenToWorld,
      ringIdForVertex: (hit) => ringIdForLeafVertex(ctx, hit.featureId, hit.vertexId),
      featureMoveAllowed: () => false,
      anchorTime: () => time,
      currentState: () => store.getState().domain,
      ports: editBinding.ports,
      buildSnapshot: (session) => buildEditSnapshot(ctx, session),
      // If this fires, a commit straddled the tool switch — exactly the bug.
      onReleased: (outcome) => {
        if (outcome.kind === RELEASE_OUTCOME.Processed) releaseOutcomes += 1;
      },
    });

    const dispatcher = new PointerDispatcher({
      getMode: () => store.getState().mode,
      camera: {
        read: () => ({
          camera: { centerLon: 0, centerLat: 0, zoom: 1 },
          viewport: { widthCss: 800, heightCss: 600, devicePixelRatio: 1 },
        }),
        write: () => {},
      },
      hitTester: { hitTest: () => vertexHit(seed.feature.id, draggedVertexId) },
      selection: { start: () => {}, move: () => {}, end: () => {}, cancel: () => {} },
      editSession,
      add: { press: () => {} },
      contextMenu: { request: () => {} },
    });

    // Wire the SAME subscription App.tsx installs: abort the dispatcher's transient on
    // a mode OR active-tool change (the fix — pre-fix this watched `mode` alone).
    let prevMode = store.getState().mode;
    let prevActiveTool = store.getState().activeTool;
    const unsubscribe = store.subscribe((s) => {
      if (s.mode === prevMode && s.activeTool === prevActiveTool) return;
      prevMode = s.mode;
      prevActiveTool = s.activeTool;
      dispatcher.onModeChange();
    });

    const ptr = (x: number, y: number) => ({
      pointerId: 1,
      x,
      y,
      button: POINTER_BUTTON.Left,
      modifiers: NO_MODIFIERS,
    });

    // 1) Begin a real vertex drag: press the corner, move past the 4px threshold.
    dispatcher.pointerDown(ptr(0, 0));
    dispatcher.pointerMove({ ...ptr(5, 5), button: POINTER_BUTTON.Left });

    // 2) Switch the active tool mid-drag (a separate DOM pointer, e.g. the toolbar).
    //    This runs the reset契約 and — via the subscription — must abort the session.
    store.getState().setActiveTool(asToolId('edit.knife'));

    // 3) Release the ORIGINAL pointer over the map.
    dispatcher.pointerUp(ptr(5, 5));

    // The session was aborted by the tool switch: NO confirm/commit ever ran.
    expect(releaseOutcomes).toBe(0);
    // The committed geometry is untouched — the (0,0) corner never moved.
    expect(verticesAt(store.getState().domain, time).byId.get(draggedVertexId)!.coordinate).toEqual(
      { lon: 0, lat: 0 },
    );

    unsubscribe();
  });
});

describe('applyEditProposal (U44 — FeatureSnapshot in-place anchor rewrite / deletion)', () => {
  it('a deletion snapshot removes the feature from the committed state', async () => {
    const { applyEditProposal } = await import('../domain/editing/apply-proposal');
    const { buildSnapshot } = await import('../domain/editing/edit-flow');
    const { getCalendar } = await import('../domain/time/calendar');
    const { featureByIdAt } = await import('./live-lookup');

    const seed = squareLeaf('f-del', 'vd', 0, 0);
    const root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: seed.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(seed.feature, seed.vertices),
    });
    const time = timePointYear(1000);
    expect(featureByIdAt(root, time, seed.feature.id)).toBeDefined();

    const deleted = applyEditProposal(
      root,
      createEditProposal(
        seed.feature.id,
        time,
        buildSnapshot({ vertices: [], deletedFeatureId: seed.feature.id }),
      ),
      getCalendar('gregorian'),
    );
    // The feature is gone AND the original root is unmutated (purity).
    expect(featureByIdAt(deleted, time, seed.feature.id)).toBeUndefined();
    expect(featureByIdAt(root, time, seed.feature.id)).toBeDefined();
  });
});
