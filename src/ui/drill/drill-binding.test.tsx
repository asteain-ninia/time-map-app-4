// U27 — live drill binding end-to-end (FR-45 / FR-94): the REAL createLiveDrillBinding
// runs the U13 pipeline over a live domain root, applyDrillProposal materialises the
// holed original + new feature, and the committed command records BOTH as ONE undo unit.
// This is the domain-commit half of the drill integration (the UI half lives in
// DrillToolController.test.tsx); together they prove the FR-45 path reaches Committed.

import { describe, expect, it } from 'vitest';

import { createLiveDrillBinding, type DomainRoot } from '../consistency-binding';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { featuresAt } from '../live-lookup';
import { PROCESS_STATUS } from '../../domain/consistency/index';
import { drillRegion, toEditProposal } from '../../domain/drill/index';
import { timePointYear } from '../../domain/time/time-point';
import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import { createLeafFeature, type LeafFeature } from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, createVertexStore, type Vertex } from '../../domain/vertex';
import { createCoordinate } from '../../domain/coordinate';
import { createGeoParams } from '../../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import type { AddSnapshot } from '../../domain/add/index';

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

/** A solid [0,20]² territory leaf + its store. */
function targetLeaf(): { feature: LeafFeature; vertices: Vertex[] } {
  const outer = [
    createCoordinate(0, 0),
    createCoordinate(20, 0),
    createCoordinate(20, 20),
    createCoordinate(0, 20),
  ];
  const vids = outer.map((_, i) => asVertexId(`ov-${i}`));
  const vertices = outer.map((c, i) => createVertex(vids[i]!, c));
  const ring = createTerritoryRing(asRingId('tr-0'), vids);
  const feature = createLeafFeature(
    asFeatureId('leaf'),
    createBasicAttributes('target', 0, 0),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

function addSnapshot(feature: LeafFeature, vertices: Vertex[]): AddSnapshot {
  return { feature, vertices, sharedCandidateIds: new Map() };
}

let counter = 0;
const ids = {
  nextFeatureId: () => asFeatureId(`nf-${counter++}`),
  nextRingId: () => asRingId(`nr-${counter++}`),
  nextVertexId: () => asVertexId(`nv-${counter++}`),
};

describe('createLiveDrillBinding — a contained drill commits: new feature born + original holed', () => {
  it('drillRegion → toEditProposal → binding.startProcess commits, creating the new feature as ONE undo unit', () => {
    const target = targetLeaf();
    const root: DomainRoot = applyAddProposal(emptyProject(), {
      featureId: target.feature.id,
      anchorTime: timePointYear(1000),
      snapshot: addSnapshot(target.feature, target.vertices),
    });
    expect(root.histories).toHaveLength(1);

    // Assemble the drill proposal for an inner triangle region fully inside [0,20]².
    const drilled = drillRegion({
      target: target.feature,
      store: createVertexStore(target.vertices),
      region: [createCoordinate(5, 5), createCoordinate(15, 5), createCoordinate(10, 15)],
      editBaseTime: timePointYear(1000),
      newProperties: {
        attributes: createBasicAttributes('carved', 0, 0),
        color,
      },
      ids,
    });
    expect(drilled.status).toBe('drilled');
    if (drilled.status !== 'drilled') return;
    const newFeatureId = drilled.newFeatureId;
    expect(newFeatureId).not.toBe(target.feature.id);

    const binding = createLiveDrillBinding({
      getRoot: () => root,
      nextVertexId: ids.nextVertexId,
      nextRingId: ids.nextRingId,
    });

    const proposal = toEditProposal(drilled.proposal, drilled.anchorTime);
    const result = binding.startProcess(proposal);
    expect(result.status).toBe(PROCESS_STATUS.Committed);
    if (result.status !== PROCESS_STATUS.Committed) return;

    // The committed command's forward result: the new feature is `created` (finding5 —
    // it is born inside applyProposal, not in touchedFeatureIds) and the original末端
    // `survived` (its identity continues; FR-45 同一性保持).
    const forward = result.command.execute(root).result;
    expect(forward.created.has(newFeatureId)).toBe(true);
    expect(forward.survived.has(target.feature.id)).toBe(true);
    expect(forward.created.has(target.feature.id)).toBe(false);

    // The swapped state carries BOTH features effective at the anchor time — the drill
    // increased the feature count by exactly 1 (対概念分離; 受け入れ基準3).
    const before = featuresAt(root, timePointYear(1000)).length;
    const after = featuresAt(result.state, timePointYear(1000));
    expect(after.length).toBe(before + 1);
    expect(after.some((f) => f.id === newFeatureId)).toBe(true);
    expect(after.some((f) => f.id === target.feature.id)).toBe(true);

    // Undo (ONE unit) removes the new feature; the original survives (教訓 5.23 symmetric).
    const undo = result.command.undo(result.state).result;
    expect(undo.deleted.has(newFeatureId)).toBe(true);
    expect(undo.survived.has(target.feature.id)).toBe(true);
    const undone = result.command.undo(result.state).state;
    expect(featuresAt(undone, timePointYear(1000)).some((f) => f.id === newFeatureId)).toBe(false);
  });
});
