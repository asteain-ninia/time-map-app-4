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
    createBasicAttributes(idRaw, 0, 0),
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

  it('converts an unexpected applyProposal throw into a Rejected internal-error result', () => {
    // A split whose inheritor history EXISTS but is ABSENT at the (earlier)
    // anchor time drives applySplitProposal down applyPastEdit's insert branch,
    // where effectiveInheritorFeature THROWS (only reachable from stale time
    // selection on real data). The live seam must surface that as the documented
    // internal-error Rejected result rather than letting the throw escape into the
    // controller's save() before its discriminated-result switch (error-path
    // honesty — useAddTool.ts has no try/catch around startProcess).
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
      expect(result.kind).toBe(REJECTION_KIND.Internal);
      expect(result.detail).toContain('inheritor feature not found');
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
