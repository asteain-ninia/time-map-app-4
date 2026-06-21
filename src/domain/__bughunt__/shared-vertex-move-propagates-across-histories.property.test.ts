// Bug-hunt regression — focus: moving a SHARED vertex updates only ONE history's
// snapshot store; another history that cites the same VertexId keeps the stale
// coordinate and can win the load-time consistency concat (last-write-wins).
//
// THE BUG (high severity, area=editing/persistence):
//   apply-proposal.ts `applyEditProposal` merged the moved vertex bodies ONLY into
//   the snapshot store of the history that contains the touched feature. A NEIGHBOUR
//   feature living in its OWN history can cite the SAME VertexId at the same time (a
//   shared boundary vertex). That neighbour history kept the OLD coordinate, so:
//     (a) the boundary visibly tore (the neighbour stayed at the old spot), and
//     (b) consistency.ts `checkTimeSlice` concatenates ALL effective histories'
//         vertices into one `createVertexStore`, where last-write-wins could let the
//         STALE coordinate override the moved one — the move appeared to partially
//         revert, and the same-id divergence was never reported.
//
// THE FIX (two halves, one indivisible proposal + a new detector):
//   1. applyEditProposal now propagates the moved bodies into EVERY effective
//      history's snapshot that cites a moved VertexId (applyMovedVerticesToHistories),
//      so same-id coordinates never diverge after a shared-vertex move.
//   2. consistency.ts gained a VertexCoordinateDivergence check that flags a same-time
//      same-VertexId coordinate disagreement BEFORE the concat collapses it, and
//      repair.ts gained a ReconcileVertexCoordinate option that re-joins them.
//
// These tests would FAIL on the pre-fix code (history B kept the old coord; the
// concat surfaced it; nothing was reported). Run ONLY this file:
//   npx vitest run src/domain/__bughunt__/shared-vertex-move-propagates-across-histories.property.test.ts

import { describe, expect, it } from 'vitest';

import { applyAddProposal, applyEditProposal } from '../editing/apply-proposal';
import { createEditProposal } from '../consistency/types';
import { getCalendar } from '../time/calendar';
import { timePointYear } from '../time/time-point';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createLeafFeature, type LeafFeature } from '../feature';
import { createShape, createTerritoryRing } from '../ring';
import { createVertex, getVertex, type Vertex } from '../vertex';
import { asFeatureId, asRingId, asVertexId, type VertexId } from '../ids';
import { coordinatesEqual } from '../coordinate';
import type { AddSnapshot } from '../add/proposal';
import type { FeatureSnapshot } from '../editing/edit-flow';
import type { DomainProject } from '../persistence/serialize';
import { resolveAt } from '../anchor-series';
import {
  checkConsistency,
  INCONSISTENCY,
} from '../persistence/consistency';
import {
  applyRepairChecked,
  repairOptionsFor,
  REPAIR_OPTION,
} from '../persistence/repair';
import { createGeoParams } from '../geo/geo-params';

const calendar = getCalendar('gregorian');
const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const YEAR = 0;
const SHARED: VertexId = asVertexId('sv-shared');

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

/**
 * A triangle leaf whose ring cites the SHARED vertex id as its first vertex (so two
 * such leaves, added as separate histories, share one boundary vertex id).
 */
function sharedTriangle(idRaw: string, privA: string, privB: string, baseLon: number): {
  feature: LeafFeature;
  vertices: Vertex[];
} {
  const shared = createVertex(SHARED, { lon: 0, lat: 0 });
  const a = createVertex(asVertexId(privA), { lon: baseLon + 1, lat: 0 });
  const b = createVertex(asVertexId(privB), { lon: baseLon + 1, lat: 1 });
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), [shared.id, a.id, b.id]);
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes('F', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices: [shared, a, b] };
}

function seedAdd(root: DomainProject, leaf: ReturnType<typeof sharedTriangle>, year: number): DomainProject {
  const proposal = createEditProposal(leaf.feature.id, timePointYear(year), {
    feature: leaf.feature,
    vertices: leaf.vertices,
    sharedCandidateIds: new Map(),
  } satisfies AddSnapshot);
  return applyAddProposal(root, proposal);
}

/** The coordinate the SHARED vertex resolves to in a given history's effective snapshot. */
function sharedCoordIn(project: DomainProject, featureId: string, year: number) {
  const history = project.histories.find((h) => h.featureId === asFeatureId(featureId));
  if (history === undefined) return undefined;
  const res = resolveAt(history.series, timePointYear(year), calendar);
  if (res.kind !== 'present') return undefined;
  return getVertex(res.entry.anchor.snapshot.vertices, SHARED)?.coordinate;
}

describe('moving a shared vertex propagates across every effective history (FR-59 regression)', () => {
  function twoSharingHistories(): DomainProject {
    const a = sharedTriangle('f-a', 'va-1', 'va-2', 0);
    const b = sharedTriangle('f-b', 'vb-1', 'vb-2', 5);
    return seedAdd(seedAdd(emptyProject(), a, YEAR), b, YEAR);
  }

  it('updates the shared vertex coordinate in BOTH histories, not just the edited one', () => {
    const seeded = twoSharingHistories();
    // Precondition: both histories carry the shared vertex at the OLD coordinate.
    expect(sharedCoordIn(seeded, 'f-a', YEAR)).toEqual({ lon: 0, lat: 0 });
    expect(sharedCoordIn(seeded, 'f-b', YEAR)).toEqual({ lon: 0, lat: 0 });

    // Move the SHARED vertex, editing the feature in history A only.
    const moved = createVertex(SHARED, { lon: 42, lat: 7 });
    const editedA: LeafFeature = {
      ...(seeded.histories[0]!.series.entries[0]!.anchor.snapshot.features[0] as LeafFeature),
    };
    const snapshot: FeatureSnapshot = { feature: editedA, vertices: [moved] };
    const next = applyEditProposal(
      seeded,
      createEditProposal(asFeatureId('f-a'), timePointYear(YEAR), snapshot),
      calendar,
    );

    // BOTH histories must now resolve the shared vertex to the NEW coordinate.
    expect(sharedCoordIn(next, 'f-a', YEAR)).toEqual({ lon: 42, lat: 7 });
    expect(sharedCoordIn(next, 'f-b', YEAR)).toEqual({ lon: 42, lat: 7 }); // the bug: was {0,0}.
  });

  it('leaves the result free of any same-id coordinate divergence', () => {
    const seeded = twoSharingHistories();
    const moved = createVertex(SHARED, { lon: 42, lat: 7 });
    const editedA = seeded.histories[0]!.series.entries[0]!.anchor.snapshot.features[0] as LeafFeature;
    const next = applyEditProposal(
      seeded,
      createEditProposal(asFeatureId('f-a'), timePointYear(YEAR), { feature: editedA, vertices: [moved] }),
      calendar,
    );
    const report = checkConsistency(next, calendar);
    const divergence = report.inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence).toHaveLength(0);
  });

  it('a non-shared move touches no other history (referential no-op for unrelated series)', () => {
    const seeded = twoSharingHistories();
    const historyBBefore = seeded.histories[1];
    // Move a PRIVATE vertex of A (va-1), which B does not cite.
    const movedPriv = createVertex(asVertexId('va-1'), { lon: 99, lat: 99 });
    const editedA = seeded.histories[0]!.series.entries[0]!.anchor.snapshot.features[0] as LeafFeature;
    const next = applyEditProposal(
      seeded,
      createEditProposal(asFeatureId('f-a'), timePointYear(YEAR), { feature: editedA, vertices: [movedPriv] }),
      calendar,
    );
    // History B is returned by referential identity (untouched).
    expect(next.histories[1]).toBe(historyBBefore);
    // And A's shared vertex stays put.
    expect(sharedCoordIn(next, 'f-a', YEAR)).toEqual({ lon: 0, lat: 0 });
  });
});

describe('consistency detects + repair reconciles same-id coordinate divergence (FR-106 拡張)', () => {
  // Hand-craft the BUGGY post-state: history A moved the shared vertex, history B kept
  // the stale coordinate. This is exactly what the pre-fix applyEditProposal produced.
  function divergentProject(): DomainProject {
    const a = sharedTriangle('f-a', 'va-1', 'va-2', 0);
    const b = sharedTriangle('f-b', 'vb-1', 'vb-2', 5);
    let project = seedAdd(seedAdd(emptyProject(), a, YEAR), b, YEAR);
    // Force history A's shared body to a NEW coordinate, leaving B stale.
    const newCoord = { lon: 42, lat: 7 };
    project = {
      ...project,
      histories: project.histories.map((h) =>
        h.featureId === asFeatureId('f-a')
          ? {
              featureId: h.featureId,
              series: {
                entries: h.series.entries.map((e) => {
                  const byId = new Map(e.anchor.snapshot.vertices.byId);
                  byId.set(SHARED, createVertex(SHARED, newCoord));
                  return {
                    anchor: { id: e.anchor.id, snapshot: { features: e.anchor.snapshot.features, vertices: { byId } } },
                    start: e.start,
                    end: e.end,
                  };
                }),
              },
            }
          : h,
      ),
    };
    return project;
  }

  it('flags VertexCoordinateDivergence for the shared vertex', () => {
    const report = checkConsistency(divergentProject(), calendar);
    const divergence = report.inconsistencies.filter(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    );
    expect(divergence.length).toBeGreaterThanOrEqual(1);
    expect(divergence[0]!.detail).toBe('vertex:sv-shared');
  });

  it('ReconcileVertexCoordinate is offered and resolves the divergence', () => {
    const project = divergentProject();
    const report = checkConsistency(project, calendar);
    const inc = report.inconsistencies.find(
      (i) => i.kind === INCONSISTENCY.VertexCoordinateDivergence,
    )!;
    const options = repairOptionsFor(inc);
    expect(options.map((o) => o.id)).toContain(REPAIR_OPTION.ReconcileVertexCoordinate);

    const applied = applyRepairChecked(project, inc, REPAIR_OPTION.ReconcileVertexCoordinate, calendar);
    expect(applied.resolved).toBe(true);
    // Both histories now agree on the FIRST-seen (history A is first → {42,7}) coordinate.
    const coordA = sharedCoordIn(applied.project, 'f-a', YEAR);
    const coordB = sharedCoordIn(applied.project, 'f-b', YEAR);
    expect(coordA).toBeDefined();
    expect(coordB).toBeDefined();
    expect(coordinatesEqual(coordA!, coordB!)).toBe(true);
  });
});
