// Shared test fixtures for U30 merge tests (not production code).

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type AggregateFeature,
  type Feature,
  type LeafFeature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import { createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import type { MergeIdPorts } from './proposal';

export const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');

export const fid = (s: string): FeatureId => asFeatureId(s);

/** Deterministic id ports for tests (stable, monotonic). */
export function makeIdPorts(prefix = 'm'): MergeIdPorts {
  let f = 0;
  let v = 0;
  let r = 0;
  return {
    nextFeatureId: (): FeatureId => asFeatureId(`${prefix}-f${f++}`),
    nextVertexId: (): VertexId => asVertexId(`${prefix}-v${v++}`),
    nextRingId: (): RingId => asRingId(`${prefix}-r${r++}`),
  };
}

interface LeafFixture {
  readonly feature: LeafFeature;
  readonly vertices: readonly Vertex[];
}

/** A rectangular leaf [x0,x1]×[y0,y1] with one territory ring, period [start,end]. */
export function rectLeaf(
  featureId: string,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  start = 0,
  end = 100,
  parentId?: FeatureId,
): LeafFixture {
  const coords: WorldCoordinate[] = [
    createCoordinate(x0, y0),
    createCoordinate(x1, y0),
    createCoordinate(x1, y1),
    createCoordinate(x0, y1),
  ];
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  coords.forEach((coord, i) => {
    const vid = asVertexId(`${featureId}-v${i}`);
    vertices.push(createVertex(vid, coord));
    vertexIds.push(vid);
  });
  const ring: Ring = createTerritoryRing(asRingId(`${featureId}-r0`), vertexIds);
  const attrs = createBasicAttributes(featureId, start, end);
  const optional = parentId === undefined ? {} : { parentId };
  const feature = createLeafFeature(asFeatureId(featureId), attrs, COLOR, createShape([ring]), optional);
  return { feature, vertices };
}

/** An aggregate feature (no shape). childIds are informational; parent links rule. */
export function agg(
  featureId: string,
  childIds: readonly string[] = [],
  start = 0,
  end = 100,
  parentId?: FeatureId,
): AggregateFeature {
  const attrs = createBasicAttributes(featureId, start, end);
  const optional = parentId === undefined ? {} : { parentId };
  return createAggregateFeature(
    asFeatureId(featureId),
    attrs,
    COLOR,
    childIds.map((c) => asFeatureId(c)),
    optional,
  );
}

/** Build a vertex store from a list of leaf fixtures. */
export function storeOf(...leaves: readonly LeafFixture[]): VertexStore {
  const all: Vertex[] = [];
  for (const l of leaves) all.push(...l.vertices);
  return createVertexStore(all);
}

/** Convenience: feature list from fixtures + aggregates. */
export function featuresOf(
  leaves: readonly LeafFixture[],
  aggregates: readonly AggregateFeature[] = [],
): Feature[] {
  return [...leaves.map((l) => l.feature), ...aggregates];
}
