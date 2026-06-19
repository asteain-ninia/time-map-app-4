// U14 — shared test fixtures + fast-check generators for the persistence unit.
//
// 教訓5.39: fixtures are built by INSTANTIATING the real domain factories, never
// by hand-writing literals that "satisfy the type". R7: generators are derived
// from the domain invariants and reused across the property tests. Consumed only
// by *.test.ts (imports fast-check, a devDependency) — never by production code.

import fc from 'fast-check';

import { createAnchor, createAnchorSnapshot } from '../anchor';
import { createAnchorEntry, normalizeSeries } from '../anchor-series';
import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type Feature,
} from '../feature';
import { createGeoParams } from '../geo/geo-params';
import { asAnchorId, asFeatureId, asRingId, asVertexId } from '../ids';
import { createShape, createTerritoryRing, createHoleRing } from '../ring';
import { getCalendar } from '../time/calendar';
import { timePointYear, timePointYearMonthDay } from '../time/time-point';
import { createVertex, createVertexStore } from '../vertex';
import type {
  BaseMapReference,
  DomainProject,
  FeatureHistory,
  ProjectSettings,
} from './serialize';

export const CAL = getCalendar('gregorian');

const COLOR = createColorInfo(true, '#102030', '#405060', '#708090');

/** A square territory ring (4 vertices) placed at (ox, oy) with the given size. */
export function squareVertices(prefix: string, ox: number, oy: number, size: number) {
  return [
    createVertex(asVertexId(`${prefix}-0`), createCoordinate(ox, oy)),
    createVertex(asVertexId(`${prefix}-1`), createCoordinate(ox + size, oy)),
    createVertex(asVertexId(`${prefix}-2`), createCoordinate(ox + size, oy + size)),
    createVertex(asVertexId(`${prefix}-3`), createCoordinate(ox, oy + size)),
  ];
}

/** A leaf feature whose single territory ring is a square at (ox, oy). */
export function squareLeaf(id: string, name: string, ox: number, oy: number, size = 10) {
  const verts = squareVertices(id, ox, oy, size);
  const ring = createTerritoryRing(
    asRingId(`${id}-r`),
    verts.map((v) => v.id),
  );
  const feature = createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 100),
    COLOR,
    createShape([ring]),
  );
  return { feature, vertices: verts };
}

/** A point feature referencing one vertex. */
export function pointFeature(id: string, name: string, lon: number, lat: number) {
  const v = createVertex(asVertexId(`${id}-v`), createCoordinate(lon, lat));
  const feature = createPointFeature(
    asFeatureId(id),
    createBasicAttributes(name, 0, 50),
    COLOR,
    v.id,
    { kindLabel: '都市' },
  );
  return { feature, vertex: v };
}

/** A line feature referencing two vertices. */
export function lineFeature(id: string, name: string) {
  const a = createVertex(asVertexId(`${id}-a`), createCoordinate(0, 0));
  const b = createVertex(asVertexId(`${id}-b`), createCoordinate(5, 5));
  const feature = createLineFeature(
    asFeatureId(id),
    createBasicAttributes(name, -50, 0),
    COLOR,
    [a.id, b.id],
  );
  return { feature, vertices: [a, b] };
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  calendarId: 'gregorian',
  geo: createGeoParams(40000, 0.0034),
  gridSpacingDeg: 10,
  snapDistancePx: 50,
  autoColorDefault: true,
};

export const DEFAULT_BASEMAP: BaseMapReference = {
  source: '@preset/equirectangular-world',
  meta: { lonWest: -180, lonEast: 180, latNorth: 90, latSouth: -90 },
};

/** Wrap a snapshot's features + vertices into a single-anchor history at year. */
export function singleAnchorHistory(
  featureId: string,
  features: readonly Feature[],
  vertices: ReturnType<typeof createVertexStore>,
  startYear = 0,
): FeatureHistory {
  const anchor = createAnchor(
    asAnchorId(`${featureId}-anc`),
    createAnchorSnapshot(features, vertices),
  );
  return {
    featureId: asFeatureId(featureId),
    series: normalizeSeries([createAnchorEntry(anchor, timePointYear(startYear), null)], CAL),
  };
}

/**
 * A complete, FULLY VALID project that exercises every persisted element: a
 * point (with kindLabel), a line, two non-overlapping leaves, an aggregate
 * parent over the two leaves, a leaf with a hole + enclave, multi-anchor series,
 * year-month-day times, settings, and a base-map ref.
 */
export function richValidProject(): DomainProject {
  // Two disjoint leaves under an aggregate parent.
  const a = squareLeaf('leaf-a', 'A国', 0, 0);
  const b = squareLeaf('leaf-b', 'B国', 20, 0);
  const aggregate = createAggregateFeature(
    asFeatureId('agg-1'),
    createBasicAttributes('連邦', 0, 100),
    COLOR,
    [asFeatureId('leaf-a'), asFeatureId('leaf-b')],
  );
  // Re-parent the two leaves under the aggregate.
  const aChild = { ...a.feature, parentId: asFeatureId('agg-1') } as Feature;
  const bChild = { ...b.feature, parentId: asFeatureId('agg-1') } as Feature;

  const pt = pointFeature('pt-1', '首都', 50, 30);
  const ln = lineFeature('ln-1', '街道');

  const aggVerts = createVertexStore([...a.vertices, ...b.vertices]);
  const aggFeatures: Feature[] = [aChild, bChild, aggregate];

  // Aggregate history with two anchors (year, then year-month-day).
  const anchor1 = createAnchor(
    asAnchorId('agg-1-anc-0'),
    createAnchorSnapshot(aggFeatures, aggVerts),
  );
  const anchor2 = createAnchor(
    asAnchorId('agg-1-anc-1'),
    createAnchorSnapshot(aggFeatures, aggVerts),
  );
  const aggHistory: FeatureHistory = {
    featureId: asFeatureId('agg-1'),
    series: normalizeSeries(
      [
        createAnchorEntry(anchor1, timePointYear(0), timePointYear(50)),
        createAnchorEntry(anchor2, timePointYearMonthDay(50, 6, 15), null),
      ],
      CAL,
    ),
  };

  // Leaf with a hole + an enclave inside the hole.
  const holed = holedLeafHistory();

  return {
    histories: [
      aggHistory,
      singleAnchorHistory('pt-1', [pt.feature], createVertexStore([pt.vertex])),
      singleAnchorHistory('ln-1', [ln.feature], createVertexStore(ln.vertices)),
      holed,
    ],
    settings: DEFAULT_SETTINGS,
    baseMap: DEFAULT_BASEMAP,
  };
}

/** A leaf whose shape has a territory ring, a hole ring, and an enclave ring. */
export function holedLeafHistory(): FeatureHistory {
  // Placed far from the aggregate's leaves / point / line so the combined
  // time-slice has no spatial overlap (this is a CLEAN fixture).
  const outer = squareVertices('hl-outer', 100, 0, 30);
  const hole = squareVertices('hl-hole', 110, 10, 10);
  const enclave = squareVertices('hl-enc', 112, 12, 4);

  const outerRing = createTerritoryRing(
    asRingId('hl-r-outer'),
    outer.map((v) => v.id),
  );
  const holeRing = createHoleRing(
    asRingId('hl-r-hole'),
    hole.map((v) => v.id),
    asRingId('hl-r-outer'),
  );
  const enclaveRing = createTerritoryRing(
    asRingId('hl-r-enc'),
    enclave.map((v) => v.id),
    asRingId('hl-r-hole'),
  );
  const feature = createLeafFeature(
    asFeatureId('hl-1'),
    createBasicAttributes('穴あき国', 0, 100),
    COLOR,
    createShape([outerRing, holeRing, enclaveRing]),
  );
  const verts = createVertexStore([...outer, ...hole, ...enclave]);
  return singleAnchorHistory('hl-1', [feature], verts);
}

// --- fast-check generators (R7) ---------------------------------------------

/** Generate a simple valid project: N disjoint square leaves, each its own history. */
export function projectArb(): fc.Arbitrary<DomainProject> {
  return fc
    .integer({ min: 1, max: 4 })
    .map((n) => {
      const histories: FeatureHistory[] = [];
      for (let i = 0; i < n; i += 1) {
        const leaf = squareLeaf(`p-leaf-${i}`, `地物${i}`, i * 40, 0, 10);
        histories.push(
          singleAnchorHistory(
            `p-leaf-${i}`,
            [leaf.feature],
            createVertexStore(leaf.vertices),
            i * 10,
          ),
        );
      }
      return {
        histories,
        settings: DEFAULT_SETTINGS,
        baseMap: DEFAULT_BASEMAP,
      } satisfies DomainProject;
    });
}
