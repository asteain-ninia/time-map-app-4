// FR-87 / FR-88 頂点削除 — the pure PLAN builder tests. These assert the wiring rule
// that turns a live vertex selection into ONE undo unit (or a below-threshold TIME-
// SLICE feature deletion) WITHOUT re-implementing any delete threshold — those are
// deleteVertex's (covered in edit-ops). We drive buildVertexDeletePlan over a REAL
// domain project (applyAddProposal) so featureByIdAt resolves at the anchor time.

import { describe, expect, it } from 'vitest';

import {
  buildVertexDeletePlan,
  ringIdForVertexInFeature,
  runEditDelete,
  type VertexDeleteContext,
  type EditDeletePorts,
  type EditDeleteSelection,
} from './vertex-delete';
import { applyAddProposal } from '../domain/editing/apply-proposal';
import type { DomainProject } from '../domain/persistence/index';
import { timePointYear, type TimePoint } from '../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  FEATURE_KIND,
  type Feature,
} from '../domain/feature';
import { createShape, createTerritoryRing, createHoleRing } from '../domain/ring';
import { createVertex, type Vertex } from '../domain/vertex';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../domain/ids';
import type { NextTargetPreference } from '../domain/selection/index';
import { createGeoParams } from '../domain/geo/geo-params';
import { createLiveEditBinding } from './consistency-binding';
import { createEditProposal, PROCESS_STATUS } from '../domain/consistency/index';
import { createHistory, execute } from '../domain/command/history';
import { featuresAt } from './live-lookup';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T: TimePoint = timePointYear(1000);

function emptyProject(): DomainProject {
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

/** Seed ONE feature (+ its vertices) into a fresh project at time T. */
function projectWith(feature: Feature, vertices: readonly Vertex[]): DomainProject {
  return applyAddProposal(emptyProject(), {
    featureId: feature.id,
    anchorTime: T,
    snapshot: { feature, vertices, sharedCandidateIds: new Map() },
  });
}

function ctxFor(project: DomainProject): VertexDeleteContext {
  return { getRoot: () => project, getTime: () => T };
}

function vset(...ids: string[]): ReadonlySet<VertexId> {
  return new Set(ids.map((s) => asVertexId(s)));
}

// --- test fixtures ------------------------------------------------------------

/** A point feature at (0,0). */
function pointFixture(): { feature: Feature; vertices: Vertex[] } {
  const v = createVertex(asVertexId('pv'), { lon: 0, lat: 0 });
  const feature = createPointFeature(asFeatureId('P'), createBasicAttributes('P', 0, 0), color, v.id);
  return { feature, vertices: [v] };
}

/** A line with `n` vertices along the equator. */
function lineFixture(n: number): { feature: Feature; vertices: Vertex[] } {
  const vertices = Array.from({ length: n }, (_, i) =>
    createVertex(asVertexId(`lv-${i}`), { lon: i, lat: 0 }),
  );
  const feature = createLineFeature(
    asFeatureId('L'),
    createBasicAttributes('L', 0, 0),
    color,
    vertices.map((v) => v.id),
  );
  return { feature, vertices };
}

/** A leaf whose territory ring has `n` vertices (a square-ish polygon). */
function leafFixture(n: number): { feature: Feature; vertices: Vertex[] } {
  const vertices = Array.from({ length: n }, (_, i) =>
    createVertex(asVertexId(`gv-${i}`), { lon: Math.cos((i / n) * 2 * Math.PI), lat: Math.sin((i / n) * 2 * Math.PI) }),
  );
  const ring = createTerritoryRing(asRingId('r0'), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId('G'),
    createBasicAttributes('G', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

// --- ringIdForVertexInFeature ------------------------------------------------

describe('ringIdForVertexInFeature', () => {
  it('resolves the FIRST ring on the feature instance that cites the vertex (leaf)', () => {
    const outer = Array.from({ length: 6 }, (_, i) => asVertexId(`o-${i}`));
    const hole = Array.from({ length: 4 }, (_, i) => asVertexId(`h-${i}`));
    const feature = createLeafFeature(
      asFeatureId('G'),
      createBasicAttributes('G', 0, 0),
      color,
      createShape([
        createTerritoryRing(asRingId('rT'), outer),
        createHoleRing(asRingId('rH'), hole, asRingId('rT')),
      ]),
    );
    expect(ringIdForVertexInFeature(feature, asVertexId('o-2'))).toBe(asRingId('rT'));
    expect(ringIdForVertexInFeature(feature, asVertexId('h-1'))).toBe(asRingId('rH'));
  });

  it('returns undefined for a point / line feature (ring is irrelevant)', () => {
    const { feature: line } = lineFixture(3);
    const { feature: point } = pointFixture();
    expect(ringIdForVertexInFeature(line, asVertexId('lv-0'))).toBeUndefined();
    expect(ringIdForVertexInFeature(point, asVertexId('pv'))).toBeUndefined();
  });
});

// --- point delete → point information deleted (FR-88) -------------------------

describe('buildVertexDeletePlan — point', () => {
  it('deleting a point vertex plans a TIME-SLICE feature deletion (deletedFeatureId snapshot)', () => {
    const { feature, vertices } = pointFixture();
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('pv'),
    });
    expect(plan).not.toBeNull();
    expect(plan?.kind).toBe('delete-feature');
    expect(plan?.snapshot.deletedFeatureId).toBe(feature.id);
    expect(plan?.snapshot.feature).toBeUndefined();
  });
});

// --- line vertex delete: survive (>=2 remain) / delete (<2) -------------------

describe('buildVertexDeletePlan — line', () => {
  it('deleting one vertex of a 3-vertex line SURVIVES with the vertex removed', () => {
    const { feature, vertices } = lineFixture(3);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-1'),
    });
    expect(plan?.kind).toBe('survive');
    if (plan?.kind !== 'survive') throw new Error('expected survive');
    expect(plan.snapshot.feature?.kind).toBe(FEATURE_KIND.Line);
    const after = plan.snapshot.feature;
    if (after?.kind !== FEATURE_KIND.Line) throw new Error('expected line');
    expect(after.vertexIds).toEqual([asVertexId('lv-0'), asVertexId('lv-2')]);
  });

  it('deleting a vertex that leaves <2 points plans a TIME-SLICE line deletion', () => {
    const { feature, vertices } = lineFixture(2);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-0'),
    });
    expect(plan?.kind).toBe('delete-feature');
    expect(plan?.snapshot.deletedFeatureId).toBe(feature.id);
  });
});

// --- leaf ring vertex delete: survive (>=3) / ring removed (<3) / feature gone -

describe('buildVertexDeletePlan — leaf', () => {
  it('deleting a vertex from a 4-vertex ring SURVIVES (ring drops to 3, still >=3)', () => {
    const { feature, vertices } = leafFixture(4);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('gv-0'),
    });
    expect(plan?.kind).toBe('survive');
    if (plan?.kind !== 'survive') throw new Error('expected survive');
    const after = plan.snapshot.feature;
    if (after?.kind !== FEATURE_KIND.Leaf) throw new Error('expected leaf');
    const remaining = after.shape.rings.flatMap((r) => r.vertexIds);
    expect(remaining).not.toContain(asVertexId('gv-0'));
    expect(remaining.length).toBe(3);
  });

  it('deleting a vertex that drops the ONLY territory ring below 3 deletes the leaf (U07 → time-slice)', () => {
    const { feature, vertices } = leafFixture(3);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('gv-0'),
    });
    expect(plan?.kind).toBe('delete-feature');
    expect(plan?.snapshot.deletedFeatureId).toBe(feature.id);
  });
});

// --- multi-vertex: ONE undo unit (folded snapshot) ---------------------------

describe('buildVertexDeletePlan — multi-vertex', () => {
  it('deleting TWO vertices of a 5-vertex line folds into ONE survive snapshot', () => {
    const { feature, vertices } = lineFixture(5);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-1', 'lv-3'),
    });
    expect(plan?.kind).toBe('survive');
    if (plan?.kind !== 'survive') throw new Error('expected survive');
    const after = plan.snapshot.feature;
    if (after?.kind !== FEATURE_KIND.Line) throw new Error('expected line');
    expect(after.vertexIds).toEqual([asVertexId('lv-0'), asVertexId('lv-2'), asVertexId('lv-4')]);
  });

  it('a multi-delete that crosses the <2 threshold mid-chain short-circuits to ONE deletedFeatureId', () => {
    // 3-vertex line, delete two → remaining <2 → delete-feature (still one plan).
    const { feature, vertices } = lineFixture(3);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-0', 'lv-1'),
    });
    expect(plan?.kind).toBe('delete-feature');
    expect(plan?.snapshot.deletedFeatureId).toBe(feature.id);
  });
});

// --- no-op guards (教訓 5.24 no ghost entry) ---------------------------------

describe('buildVertexDeletePlan — no-op', () => {
  it('empty vertex set → null', () => {
    const { feature, vertices } = lineFixture(3);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: new Set(),
    });
    expect(plan).toBeNull();
  });

  it('owner feature absent at the current time → null', () => {
    const { feature, vertices } = lineFixture(3);
    const project = projectWith(feature, vertices);
    // The feature is seeded at year 1000; a time BEFORE its first anchor start is
    // `absent` (existence has not begun — anchor-series), so the owner is unresolved.
    const missingTime: TimePoint = timePointYear(500);
    const plan = buildVertexDeletePlan(
      { getRoot: () => project, getTime: () => missingTime },
      { ownerFeatureId: feature.id, vertexIds: vset('lv-0') },
    );
    expect(plan).toBeNull();
  });

  it('a stale selected vertex id not on the feature → null (no ghost)', () => {
    const { feature, vertices } = lineFixture(3);
    const plan = buildVertexDeletePlan(ctxFor(projectWith(feature, vertices)), {
      ownerFeatureId: feature.id,
      vertexIds: vset('does-not-exist'),
    });
    expect(plan).toBeNull();
  });
});

// --- end-to-end: the plan actually commits through the REAL U13 pipeline ------
// This proves the FR-88 完了時整合性維持プロセス runs (the SAME createLiveEditBinding the
// App handler uses) and the commit is ONE undo unit — the wiring the pure plan test
// cannot see. It mirrors App.tsx's recordCommand seam (execute over a history) exactly.

describe('buildVertexDeletePlan → live edit binding commit (FR-88 integrity + 1 undo unit)', () => {
  it('a survive line vertex delete commits ONE undo unit and drops the vertex at the time', () => {
    const { feature, vertices } = lineFixture(4);
    const project = projectWith(feature, vertices);
    const binding = createLiveEditBinding({ getRoot: () => project });

    const plan = buildVertexDeletePlan(ctxFor(project), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-1'),
    });
    if (plan?.kind !== 'survive') throw new Error('expected survive');

    const proposal = createEditProposal(plan.featureId, T, plan.snapshot);
    const result = binding.startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) throw new Error('not committed');

    // Record as the App does: execute the ONE command over a fresh history.
    const history = createHistory(project);
    const step = execute(history, result.command);
    // Exactly ONE undo unit.
    expect(step.history.undoStack.length).toBe(1);

    // At the anchor time the feature survives with the vertex removed.
    const after = featuresAt(step.history.state, T).find((f) => f.id === feature.id);
    if (after?.kind !== FEATURE_KIND.Line) throw new Error('expected surviving line');
    expect(after.vertexIds).toEqual([asVertexId('lv-0'), asVertexId('lv-2'), asVertexId('lv-3')]);
  });

  it('a below-threshold delete is a TIME-SLICE removal (feature absent at the anchor time)', () => {
    const { feature, vertices } = lineFixture(2);
    const project = projectWith(feature, vertices);
    const binding = createLiveEditBinding({ getRoot: () => project });

    const plan = buildVertexDeletePlan(ctxFor(project), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-0'),
    });
    if (plan?.kind !== 'delete-feature') throw new Error('expected delete-feature');

    const proposal = createEditProposal(plan.featureId, T, plan.snapshot);
    const result = binding.startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) throw new Error('not committed');

    const history = createHistory(project);
    const step = execute(history, result.command);
    expect(step.history.undoStack.length).toBe(1); // ONE undo unit.

    // The feature is gone at the anchor time (time-slice removal, NOT all-anchor).
    const after = featuresAt(step.history.state, T).find((f) => f.id === feature.id);
    expect(after).toBeUndefined();
  });

  it('multi-vertex survive commits ONE undo unit (both vertices removed atomically)', () => {
    const { feature, vertices } = lineFixture(5);
    const project = projectWith(feature, vertices);
    const binding = createLiveEditBinding({ getRoot: () => project });

    const plan = buildVertexDeletePlan(ctxFor(project), {
      ownerFeatureId: feature.id,
      vertexIds: vset('lv-1', 'lv-3'),
    });
    if (plan?.kind !== 'survive') throw new Error('expected survive');

    const proposal = createEditProposal(plan.featureId, T, plan.snapshot);
    const result = binding.startProcess(proposal);
    if (result.status !== PROCESS_STATUS.Committed) throw new Error('not committed');

    const history = createHistory(project);
    const step = execute(history, result.command);
    expect(step.history.undoStack.length).toBe(1); // ONE undo unit for BOTH deletes.

    const after = featuresAt(step.history.state, T).find((f) => f.id === feature.id);
    if (after?.kind !== FEATURE_KIND.Line) throw new Error('expected surviving line');
    expect(after.vertexIds).toEqual([asVertexId('lv-0'), asVertexId('lv-2'), asVertexId('lv-4')]);
  });
});

// --- runEditDelete: the single-funnel routing (Delete key / menu / 右クリック) --
// Covers the branch selection + selection cleanup the plan test cannot see. We spy
// on the injected host ports; startProcess uses the REAL binding for Committed and a
// hand-built result for Rejected / ConflictsPending.

interface Spy {
  readonly recordCommit: { count: number; last?: unknown };
  readonly deletedAllAnchors: FeatureId[];
  readonly cleared: FeatureId[];
  conflicts: number;
  /** The (preference, clearVertexOwner) the LAST openConflict was called with. */
  lastConflict?: {
    preference?: NextTargetPreference;
    clearVertexOwner?: FeatureId;
  };
}

function makePorts(
  project: DomainProject,
  overrides: Partial<EditDeletePorts<DomainProject>> = {},
): { ports: EditDeletePorts<DomainProject>; spy: Spy } {
  const binding = createLiveEditBinding({ getRoot: () => project });
  const spy: Spy = { recordCommit: { count: 0 }, deletedAllAnchors: [], cleared: [], conflicts: 0 };
  const ports: EditDeletePorts<DomainProject> = {
    getRoot: () => project,
    getTime: () => T,
    startProcess: (proposal) => binding.startProcess(proposal),
    applyResolutionsFor: (proposal) => binding.applyResolutionsFor(proposal),
    recordCommit: (_result, preference) => {
      spy.recordCommit.count += 1;
      spy.recordCommit.last = preference;
    },
    openConflict: (_result, _apply, preference, clearVertexOwner) => {
      spy.conflicts += 1;
      spy.lastConflict = {
        ...(preference !== undefined ? { preference } : {}),
        ...(clearVertexOwner !== undefined ? { clearVertexOwner } : {}),
      };
    },
    clearVertexSelection: (fid) => spy.cleared.push(fid),
    deleteFeatureAllAnchors: (fid) => spy.deletedAllAnchors.push(fid),
    ...overrides,
  };
  return { ports, spy };
}

function sel(overrides: Partial<EditDeleteSelection>): EditDeleteSelection {
  return { activeFeature: null, vertexOwner: null, vertexIds: new Set(), ...overrides };
}

describe('runEditDelete — single-funnel routing (Delete key / menu / FR-96 右クリック)', () => {
  it('a vertex selection (survive) records ONE commit, retains the feature, and clears the vertex selection', () => {
    const { feature, vertices } = lineFixture(4);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    // A right-click Vertex hit sets exactly this selection (promoteHit) — same shape
    // as a Delete-key press with a vertex selected.
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-1') }),
      ports,
    );
    expect(spy.recordCommit.count).toBe(1);
    expect(spy.deletedAllAnchors).toEqual([]); // NOT the all-anchor path.
    // The feature stays active (preference.featureId); the deleted vertex selection is
    // cleared (every selected vertex was deleted → none survive to re-select).
    const pref = spy.recordCommit.last as { featureId: FeatureId } | undefined;
    expect(pref?.featureId).toBe(feature.id);
    expect(spy.cleared).toEqual([feature.id]);
  });

  it('a multi-vertex survive still records ONE commit and clears the vertex selection', () => {
    const { feature, vertices } = lineFixture(5);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-1', 'lv-3') }),
      ports,
    );
    expect(spy.recordCommit.count).toBe(1); // ONE undo unit for BOTH deletes.
    expect(spy.cleared).toEqual([feature.id]);
  });

  it('a below-threshold vertex delete records ONE commit with NO preference (time-slice)', () => {
    const { feature, vertices } = lineFixture(2);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-0') }),
      ports,
    );
    expect(spy.recordCommit.count).toBe(1);
    expect(spy.recordCommit.last).toBeUndefined(); // no preference: deleted id drops.
    expect(spy.deletedAllAnchors).toEqual([]); // NOT the all-anchor delete.
    expect(spy.cleared).toEqual([]);
  });

  it('NO vertex selection (only activeFeature) routes to the UNCHANGED all-anchor delete', () => {
    const { feature, vertices } = lineFixture(3);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    runEditDelete(sel({ activeFeature: feature.id }), ports);
    expect(spy.deletedAllAnchors).toEqual([feature.id]); // U31 全錨 delete preserved.
    expect(spy.recordCommit.count).toBe(0); // did NOT go through the vertex path.
  });

  it('nothing selected → no-op (no commit, no delete)', () => {
    const { feature, vertices } = lineFixture(3);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    runEditDelete(sel({}), ports);
    expect(spy.recordCommit.count).toBe(0);
    expect(spy.deletedAllAnchors).toEqual([]);
  });

  it('a stale-only vertex selection → no-op (no ghost commit, 教訓 5.24)', () => {
    const { feature, vertices } = lineFixture(3);
    const { ports, spy } = makePorts(projectWith(feature, vertices));
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('ghost') }),
      ports,
    );
    // The plan is null (nothing on the feature matched) → NO commit, and it does NOT
    // fall through to the all-anchor feature delete.
    expect(spy.recordCommit.count).toBe(0);
    expect(spy.deletedAllAnchors).toEqual([]);
  });

  it('a Rejected result keeps selection and records nothing (honest failure, not silent corruption)', () => {
    const { feature, vertices } = lineFixture(4);
    const { ports, spy } = makePorts(projectWith(feature, vertices), {
      startProcess: () => ({
        status: PROCESS_STATUS.Rejected,
        kind: 'constraint-violation',
        message: 'rejected for the test',
      }),
    });
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-1') }),
      ports,
    );
    expect(spy.recordCommit.count).toBe(0);
    expect(spy.cleared).toEqual([]);
    expect(spy.deletedAllAnchors).toEqual([]);
  });

  it('a ConflictsPending result opens the conflict modal (honest failure), no commit', () => {
    const { feature, vertices } = lineFixture(4);
    const { ports, spy } = makePorts(projectWith(feature, vertices), {
      startProcess: () => ({
        status: PROCESS_STATUS.ConflictsPending,
        conflicts: [],
        unresolvedConflictIds: ['x'],
        trialState: projectWith(feature, vertices),
      }),
    });
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-1') }),
      ports,
    );
    expect(spy.conflicts).toBe(1);
    expect(spy.recordCommit.count).toBe(0);
  });

  // bughunt5 HOLE-1: a SURVIVE vertex-delete that goes through the conflict modal must
  // carry BOTH the feature-active preference AND the vertex-owner to clear on commit —
  // reresolve cannot prune the deleted vertex ids (makeCommand reports deletion at
  // feature-history level only), so without this the host would leave a ghost vertex id
  // in the selection after the modal commit (mis-targeting a later 削除). The DIRECT
  // survive commit reconciles via clearVertexSelection; the conflict path must carry the
  // SAME instruction to onConflictCommitted.
  it('a SURVIVE conflict carries the feature preference AND the vertex-owner to clear (HOLE-1)', () => {
    const { feature, vertices } = lineFixture(4);
    const { ports, spy } = makePorts(projectWith(feature, vertices), {
      startProcess: () => ({
        status: PROCESS_STATUS.ConflictsPending,
        conflicts: [],
        unresolvedConflictIds: ['x'],
        trialState: projectWith(feature, vertices),
      }),
    });
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-1') }),
      ports,
    );
    expect(spy.lastConflict?.preference?.featureId).toBe(feature.id);
    // The owner to clear once the modal commits (the deleted vertex ids linger otherwise).
    expect(spy.lastConflict?.clearVertexOwner).toBe(feature.id);
  });

  it('a BELOW-THRESHOLD conflict carries NO preference and NO clear-owner (deleted id drops)', () => {
    // 2-vertex line, delete one → below threshold → delete-feature plan.
    const { feature, vertices } = lineFixture(2);
    const { ports, spy } = makePorts(projectWith(feature, vertices), {
      startProcess: () => ({
        status: PROCESS_STATUS.ConflictsPending,
        conflicts: [],
        unresolvedConflictIds: ['x'],
        trialState: projectWith(feature, vertices),
      }),
    });
    runEditDelete(
      sel({ activeFeature: feature.id, vertexOwner: feature.id, vertexIds: vset('lv-0') }),
      ports,
    );
    expect(spy.conflicts).toBe(1);
    expect(spy.lastConflict?.preference).toBeUndefined();
    expect(spy.lastConflict?.clearVertexOwner).toBeUndefined();
  });
});
