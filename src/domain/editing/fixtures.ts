// U24 test fixtures — minimal builders for features / vertices / coordinates so
// the tests read as "input state → operation → expected" (NFR 5.8). Kept tiny and
// local to the editing unit's tests; not part of the public API.

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import { createShape, createTerritoryRing, createHoleRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';

export const fid = (s: string): FeatureId => asFeatureId(s);
export const vid = (s: string): VertexId => asVertexId(s);
export const rid = (s: string): RingId => asRingId(s);
export const coord = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

const ATTRS = createBasicAttributes('test', 0, 100);
const COLOR = createColorInfo(true, '#111', '#222', '#333');

export function store(...pairs: ReadonlyArray<[string, number, number]>): VertexStore {
  return createVertexStore(pairs.map(([id, lon, lat]) => createVertex(vid(id), coord(lon, lat))));
}

export function point(id: string, vertexId: string): PointFeature {
  return createPointFeature(fid(id), ATTRS, COLOR, vid(vertexId));
}

export function line(id: string, vertexIds: readonly string[]): LineFeature {
  return createLineFeature(fid(id), ATTRS, COLOR, vertexIds.map(vid));
}

export function territory(id: string, vertexIds: readonly string[], parent?: string): Ring {
  return parent === undefined
    ? createTerritoryRing(rid(id), vertexIds.map(vid))
    : createTerritoryRing(rid(id), vertexIds.map(vid), rid(parent));
}

export function hole(id: string, vertexIds: readonly string[], parent: string): Ring {
  return createHoleRing(rid(id), vertexIds.map(vid), rid(parent));
}

export function leaf(id: string, rings: readonly Ring[]): LeafFeature {
  return createLeafFeature(fid(id), ATTRS, COLOR, createShape(rings));
}
