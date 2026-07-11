// UI/map — featureBoundsAt tests (HB5-3): resolve a feature's world bbox at a time.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../../domain/attributes';
import {
  createAggregateFeature,
  createLineFeature,
  createLeafFeature,
  createPointFeature,
  type AggregateFeature,
  type LeafFeature,
} from '../../domain/feature';
import { createShape, createTerritoryRing } from '../../domain/ring';
import { createVertex, type Vertex } from '../../domain/vertex';
import { asFeatureId, asRingId, asVertexId } from '../../domain/ids';
import { createGeoParams } from '../../domain/geo/geo-params';
import { applyAddProposal } from '../../domain/editing/apply-proposal';
import { createEditProposal } from '../../domain/consistency/index';
import type { AddSnapshot } from '../../domain/add/index';
import type { DomainProject } from '../../domain/persistence/index';
import { timePointYear } from '../../domain/time/time-point';

import { clearLiveLookupCache } from '../live-lookup';
import { featureBoundsAt } from './feature-bounds';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');
const T = timePointYear(1000);

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

function addFeature(
  root: DomainProject,
  feature: LeafFeature | AggregateFeature | ReturnType<typeof createPointFeature> | ReturnType<typeof createLineFeature>,
  vertices: Vertex[],
): DomainProject {
  const snapshot: AddSnapshot = { feature, vertices, sharedCandidateIds: new Map() };
  return applyAddProposal(root, createEditProposal(feature.id, T, snapshot));
}

/** A square leaf with corners offset from (0,0), side `side`. */
function squareLeaf(
  idRaw: string,
  lonOffset = 0,
  latOffset = 0,
  side = 2,
): { feature: LeafFeature; vertices: Vertex[] } {
  const corners = [
    [0, 0],
    [side, 0],
    [side, side],
    [0, side],
  ];
  const vertices = corners.map((c, i) =>
    createVertex(asVertexId(`${idRaw}-v${i}`), {
      lon: c[0]! + lonOffset,
      lat: c[1]! + latOffset,
    }),
  );
  const ring = createTerritoryRing(asRingId(`r-${idRaw}`), vertices.map((v) => v.id));
  const feature = createLeafFeature(
    asFeatureId(idRaw),
    createBasicAttributes(idRaw, 1000, 1100),
    color,
    createShape([ring]),
  );
  return { feature, vertices };
}

describe('featureBoundsAt (HB5-3)', () => {
  it('returns the bbox of a leaf shape at the time', () => {
    clearLiveLookupCache();
    const leaf = squareLeaf('leaf', 3, 5, 2); // corners (3,5)..(5,7)
    const root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    const bounds = featureBoundsAt(root, T, leaf.feature.id);
    expect(bounds).not.toBeNull();
    expect(bounds!.minLon).toBeCloseTo(3, 9);
    expect(bounds!.maxLon).toBeCloseTo(5, 9);
    expect(bounds!.minLat).toBeCloseTo(5, 9);
    expect(bounds!.maxLat).toBeCloseTo(7, 9);
  });

  it('returns a zero-span bbox for a point feature (its vertex)', () => {
    clearLiveLookupCache();
    const v = createVertex(asVertexId('pv'), { lon: 12, lat: -3 });
    const point = createPointFeature(
      asFeatureId('pt'),
      createBasicAttributes('pt', 1000, 1100),
      color,
      v.id,
    );
    const root = addFeature(emptyProject(), point, [v]);
    const bounds = featureBoundsAt(root, T, point.id);
    expect(bounds).toEqual({ minLon: 12, maxLon: 12, minLat: -3, maxLat: -3 });
  });

  it('returns the bbox over a line feature vertices', () => {
    clearLiveLookupCache();
    const v0 = createVertex(asVertexId('lv0'), { lon: -4, lat: 1 });
    const v1 = createVertex(asVertexId('lv1'), { lon: 6, lat: 9 });
    const line = createLineFeature(
      asFeatureId('ln'),
      createBasicAttributes('ln', 1000, 1100),
      color,
      [v0.id, v1.id],
    );
    const root = addFeature(emptyProject(), line, [v0, v1]);
    const bounds = featureBoundsAt(root, T, line.id);
    expect(bounds).toEqual({ minLon: -4, maxLon: 6, minLat: 1, maxLat: 9 });
  });

  it('returns null for a feature absent at the time', () => {
    clearLiveLookupCache();
    const leaf = squareLeaf('leaf');
    const root = addFeature(emptyProject(), leaf.feature, leaf.vertices);
    expect(featureBoundsAt(root, T, asFeatureId('nope'))).toBeNull();
  });

  it('frames an antimeridian-straddling leaf the SHORT way (continuous lon span < 180)', () => {
    clearLiveLookupCache();
    // A square whose east edge is stored folded to -175 (= 185). leafShapeAt aligns it
    // to a continuous run so the bbox is the short (~10°) way, not a ~350° band.
    const vertices = [
      createVertex(asVertexId('w-v0'), { lon: 175, lat: 0 }),
      createVertex(asVertexId('w-v1'), { lon: -175, lat: 0 }),
      createVertex(asVertexId('w-v2'), { lon: -175, lat: 2 }),
      createVertex(asVertexId('w-v3'), { lon: 175, lat: 2 }),
    ];
    const ring = createTerritoryRing(asRingId('r-wrap'), vertices.map((v) => v.id));
    const feature = createLeafFeature(
      asFeatureId('wrap'),
      createBasicAttributes('wrap', 1000, 1100),
      color,
      createShape([ring]),
    );
    const root = addFeature(emptyProject(), feature, vertices);
    const bounds = featureBoundsAt(root, T, feature.id);
    expect(bounds).not.toBeNull();
    const span = bounds!.maxLon - bounds!.minLon;
    expect(span).toBeGreaterThan(0);
    expect(span).toBeLessThan(180); // short way, NOT the ~350° folded span
    // The center sits near the seam (±180), the natural short-way framing.
    const center = (bounds!.minLon + bounds!.maxLon) / 2;
    expect(Math.abs(Math.abs(center) - 180)).toBeLessThan(20);
  });

  it('returns the child-union bbox for an aggregate parent', () => {
    clearLiveLookupCache();
    const a = squareLeaf('ca', 0, 0, 2); // [0,2]×[0,2]
    const b = squareLeaf('cb', 2, 0, 2); // [2,4]×[0,2]
    const childA: LeafFeature = { ...a.feature, parentId: asFeatureId('agg') };
    const childB: LeafFeature = { ...b.feature, parentId: asFeatureId('agg') };
    const aggregate = createAggregateFeature(
      asFeatureId('agg'),
      createBasicAttributes('agg', 1000, 1100),
      color,
      [childA.id, childB.id],
    );
    let root = addFeature(emptyProject(), childA, a.vertices);
    root = addFeature(root, childB, b.vertices);
    root = addFeature(root, aggregate, []);
    const bounds = featureBoundsAt(root, T, aggregate.id);
    expect(bounds).not.toBeNull();
    // Union spans both children: [0,4]×[0,2].
    expect(bounds!.minLon).toBeCloseTo(0, 6);
    expect(bounds!.maxLon).toBeCloseTo(4, 6);
    expect(bounds!.minLat).toBeCloseTo(0, 6);
    expect(bounds!.maxLat).toBeCloseTo(2, 6);
  });

  it('returns null for a childless aggregate (empty derived shape)', () => {
    clearLiveLookupCache();
    const aggregate = createAggregateFeature(
      asFeatureId('agg-empty'),
      createBasicAttributes('empty', 1000, 1100),
      color,
      [],
    );
    const root = addFeature(emptyProject(), aggregate, []);
    expect(featureBoundsAt(root, T, aggregate.id)).toBeNull();
  });
});
