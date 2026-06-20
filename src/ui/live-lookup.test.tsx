// UI — live-lookup unit tests: the single live domain-lookup rule shared by the
// U13 consistency binding and the U26 knife domain-lookup ports. Asserts that the
// feature / vertex resolution at the current time, the leaf hit-test, and the leaf
// shape resolution match the committed root (no二重真実源, 教訓 5.29).

import { describe, expect, it } from 'vitest';

import {
  featuresAt,
  verticesAt,
  featureByIdAt,
  leafAtPoint,
  leafShapeAt,
} from './live-lookup';
import type { DomainRoot } from './consistency-binding';
import { applyAddProposal } from '../domain/editing/apply-proposal';
import { createEditProposal } from '../domain/consistency/index';
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

/** A 2×2 square leaf at the given lon/lat offset. */
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

function snapshotOf(feature: LeafFeature, vertices: Vertex[]): AddSnapshot {
  return { feature, vertices, sharedCandidateIds: new Map() };
}

/** Commit one leaf at the given time and return the new root. */
function withLeaf(
  root: DomainRoot,
  leaf: { feature: LeafFeature; vertices: Vertex[] },
  year: number,
): DomainRoot {
  return applyAddProposal(
    root,
    createEditProposal(leaf.feature.id, timePointYear(year), snapshotOf(leaf.feature, leaf.vertices)),
  );
}

describe('live-lookup', () => {
  it('featuresAt / verticesAt resolve the committed feature at the anchor time', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);

    const features = featuresAt(root, timePointYear(1000));
    expect(features.map((f) => f.id)).toContain(a.feature.id);

    const vertices = verticesAt(root, timePointYear(1000));
    expect(vertices.byId.size).toBe(4);

    // Before the anchor exists nothing resolves (absent).
    expect(featuresAt(root, timePointYear(500))).toHaveLength(0);
  });

  it('featureByIdAt finds the feature by id, undefined when absent', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);
    expect(featureByIdAt(root, timePointYear(1000), a.feature.id)?.id).toBe(a.feature.id);
    expect(featureByIdAt(root, timePointYear(1000), asFeatureId('nope'))).toBeUndefined();
    expect(featureByIdAt(root, timePointYear(500), a.feature.id)).toBeUndefined();
  });

  it('leafAtPoint hits the leaf containing a world point and misses outside', () => {
    const a = squareLeaf('f-a', 'va', 0, 0); // covers [0,2]×[0,2]
    const b = squareLeaf('f-b', 'vb', 10, 10); // covers [10,12]×[10,12]
    let root = withLeaf(emptyProject(), a, 1000);
    root = withLeaf(root, b, 1000);

    // A point strictly inside A → A.
    expect(leafAtPoint(root, timePointYear(1000), { lon: 1, lat: 1 })).toBe(a.feature.id);
    // A point strictly inside B → B.
    expect(leafAtPoint(root, timePointYear(1000), { lon: 11, lat: 11 })).toBe(b.feature.id);
    // A point in empty space → null.
    expect(leafAtPoint(root, timePointYear(1000), { lon: 5, lat: 5 })).toBeNull();
    // A point inside A but at a time the feature is absent → null.
    expect(leafAtPoint(root, timePointYear(500), { lon: 1, lat: 1 })).toBeNull();
  });

  it('leafShapeAt returns the resolved multipolygon of the leaf, undefined when absent', () => {
    const a = squareLeaf('f-a', 'va', 0, 0);
    const root = withLeaf(emptyProject(), a, 1000);
    const shape = leafShapeAt(root, timePointYear(1000), a.feature.id);
    expect(shape).toBeDefined();
    expect(shape!.length).toBeGreaterThan(0);
    expect(leafShapeAt(root, timePointYear(500), a.feature.id)).toBeUndefined();
    expect(leafShapeAt(root, timePointYear(1000), asFeatureId('nope'))).toBeUndefined();
  });
});
