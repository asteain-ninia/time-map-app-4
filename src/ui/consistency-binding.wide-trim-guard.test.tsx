// 重なりの解決の削りの守り — 点の打ち直しが効かない形を、読み直しの面積の検算が確定前に断る。
// いまの実装では断りに届く形を作れないので、打ち直しを差し替える（§5.41）。

import { describe, expect, it, vi } from 'vitest';

import type { AddSnapshot } from '../domain/add/index';
import { createBasicAttributes, createColorInfo } from '../domain/attributes';
import { createEditProposal, PROCESS_STATUS } from '../domain/consistency/index';
import { createCoordinate, type WorldCoordinate } from '../domain/coordinate';
import { createLeafFeature } from '../domain/feature';
import { createGeoParams } from '../domain/geo/geo-params';
import { asFeatureId, asRingId, asVertexId } from '../domain/ids';
import { createShape, createTerritoryRing } from '../domain/ring';
import { timePointYear } from '../domain/time/time-point';
import { createVertex } from '../domain/vertex';

import { createLiveAddBinding, type DomainRoot } from './consistency-binding';

vi.mock('../domain/geo/long-edge', async (importOriginal) => {
  const real = await importOriginal<typeof import('../domain/geo/long-edge')>();
  return {
    ...real,
    restoreDroppedPoints: (mp: unknown) => mp,
    subdivideLongEdges: (mp: unknown) => mp,
    countLongEdgesInMultiPolygon: () => 0,
  };
});

const T = timePointYear(1000);
const COLOR = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

function snapshot(id: string, ring: readonly WorldCoordinate[]): AddSnapshot {
  const vertices = ring.map((q, i) => createVertex(asVertexId(`${id}-${i}`), q));
  return {
    feature: createLeafFeature(
      asFeatureId(id),
      createBasicAttributes(id, 0, 0),
      COLOR,
      createShape([createTerritoryRing(asRingId(`${id}-r`), vertices.map((v) => v.id))]),
    ),
    vertices,
    sharedCandidateIds: new Map(),
  };
}

describe('打ち直しが効かないとき', () => {
  it('削った形を書かず、確定を断る', () => {
    const c = createCoordinate;
    const south = [-180, -90, 0, 90, 179.99].map((lon) => c(lon, -90));
    const north = [179.99, 90, 0, -90, -180].map((lon) => c(lon, -60));
    let root: DomainRoot = {
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
    let n = 0;
    const binding = createLiveAddBinding({
      getRoot: () => root,
      nextVertexId: () => asVertexId(`rv-${(n += 1)}`),
      nextRingId: () => asRingId(`rr-${(n += 1)}`),
    });
    const wide = snapshot('W', [...south, ...north]);
    const seed = binding.startProcess(createEditProposal(wide.feature.id, T, wide));
    if (seed.status !== PROCESS_STATUS.Committed) throw new Error(seed.status);
    root = seed.state;

    const child = snapshot('K', [c(-1, -80), c(1, -80), c(1, -70), c(-1, -70)]);
    const proposal = createEditProposal(child.feature.id, T, child);
    const pending = binding.startProcess(proposal);
    if (pending.status !== PROCESS_STATUS.ConflictsPending) throw new Error(pending.status);
    const applied = binding.applyResolutionsFor(proposal)(
      pending.conflicts.map((k) => ({
        conflictId: k.id,
        priorityFeatureId: child.feature.id,
        adjustFeatureId: wide.feature.id,
      })),
    );
    expect(applied.status).not.toBe(PROCESS_STATUS.Committed);
  });
});
