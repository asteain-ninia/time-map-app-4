// Shared test fixtures for U27 drill tests (not production code).

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type AggregateFeature,
  type LeafFeature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';
import type { DrillIdPorts } from './proposal';

export const ATTRS = createBasicAttributes('test', 0, 100);
export const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');

export const fid = (s: string): FeatureId => asFeatureId(s);

/** Fresh, deterministic id ports for a single test (counter resets per call). */
export function freshIdPorts(): DrillIdPorts {
  let n = 0;
  return {
    nextFeatureId: () => asFeatureId(`drill-f-${n++}`),
    nextVertexId: () => asVertexId(`drill-v-${n++}`),
    nextRingId: () => asRingId(`drill-r-${n++}`),
  };
}

/** Build a leaf feature with a single territory ring from coordinates. */
export function squareLeaf(
  featureId: string,
  coords: readonly WorldCoordinate[],
  optional: { parentId?: FeatureId } = {},
): { feature: LeafFeature; store: VertexStore } {
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  coords.forEach((coord, i) => {
    const vid = asVertexId(`${featureId}-v${i}`);
    vertices.push(createVertex(vid, coord));
    vertexIds.push(vid);
  });
  const ring: Ring = createTerritoryRing(asRingId(`${featureId}-r0`), vertexIds);
  const feature = createLeafFeature(
    asFeatureId(featureId),
    ATTRS,
    COLOR,
    createShape([ring]),
    optional,
  );
  return { feature, store: createVertexStore(vertices) };
}

/** A [0,10]² square leaf (single territory ring), optionally with a parent. */
export function unitSquare(featureId = 'sq', optional: { parentId?: FeatureId } = {}) {
  return squareLeaf(
    featureId,
    [
      createCoordinate(0, 0),
      createCoordinate(10, 0),
      createCoordinate(10, 10),
      createCoordinate(0, 10),
    ],
    optional,
  );
}

/** A central [3,7]² region fully inside the unit square (a clean interior hole). */
export function centralRegion(): WorldCoordinate[] {
  return [
    createCoordinate(3, 3),
    createCoordinate(7, 3),
    createCoordinate(7, 7),
    createCoordinate(3, 7),
  ];
}

/** A region that escapes the unit square (crosses the right外周境界). */
export function escapingRegion(): WorldCoordinate[] {
  return [
    createCoordinate(7, 3),
    createCoordinate(13, 3),
    createCoordinate(13, 7),
    createCoordinate(7, 7),
  ];
}

/**
 * A self-intersecting (bow-tie) quad: edges (0→1) and (2→3) cross. Used to assert
 * the自己交差 rejection (受け入れ6).
 */
export function bowTieRegion(): WorldCoordinate[] {
  return [
    createCoordinate(3, 3),
    createCoordinate(7, 7),
    createCoordinate(7, 3),
    createCoordinate(3, 7),
  ];
}

/** An aggregate feature (no shape) — used to assert 集約は穴あけ不可 (FR-35 / 受け入れ7). */
export function aggregate(featureId = 'agg'): AggregateFeature {
  return createAggregateFeature(asFeatureId(featureId), ATTRS, COLOR, [fid('child')]);
}
