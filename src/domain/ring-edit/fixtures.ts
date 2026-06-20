// U25 test fixtures — built via U06/U07 factories (教訓 5.39: construct real
// values, never literals that merely satisfy the type). Tiny + local to the
// ring-edit tests; not part of the public API.

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import { createLeafFeature, type LeafFeature } from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type RingId, type VertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, setVertex, type Vertex, type VertexStore } from '../vertex';

export const fid = (s: string): FeatureId => asFeatureId(s);
export const vid = (s: string): VertexId => asVertexId(s);
export const rid = (s: string): RingId => asRingId(s);
export const coord = (lon: number, lat: number): WorldCoordinate => createCoordinate(lon, lat);

const ATTRS = createBasicAttributes('テスト面', 0, 100);
const COLOR = createColorInfo(true, '#111', '#222', '#333');

export function store(...pairs: ReadonlyArray<readonly [string, number, number]>): VertexStore {
  return createVertexStore(pairs.map(([id, lon, lat]) => createVertex(vid(id), coord(lon, lat))));
}

export function addVertices(
  base: VertexStore,
  ...pairs: ReadonlyArray<readonly [string, number, number]>
): VertexStore {
  let next = base;
  for (const [id, lon, lat] of pairs) next = setVertex(next, createVertex(vid(id), coord(lon, lat)));
  return next;
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

/**
 * A single big square territory T0 (0,0)-(100,100), with 4 corner vertices.
 * Solid everywhere inside; nothing else. Used for hole-vs-enclave detection.
 */
export function squareLeaf(): { feature: LeafFeature; vertices: VertexStore } {
  const vertices = store(
    ['a', 0, 0],
    ['b', 100, 0],
    ['c', 100, 100],
    ['d', 0, 100],
  );
  const feature = leaf('F', [territory('T0', ['a', 'b', 'c', 'd'])]);
  return { feature, vertices };
}

/**
 * A square territory T0 with a square hole H0 (40,40)-(60,60) punched in its
 * middle. The fill is solid inside T0 except inside H0. Used to verify a click
 * inside the hole classifies as enclave, and a click in the solid as hole.
 */
export function squareWithHoleLeaf(): { feature: LeafFeature; vertices: VertexStore } {
  const vertices = store(
    ['a', 0, 0],
    ['b', 100, 0],
    ['c', 100, 100],
    ['d', 0, 100],
    ['h0', 40, 40],
    ['h1', 60, 40],
    ['h2', 60, 60],
    ['h3', 40, 60],
  );
  const feature = leaf('F', [
    territory('T0', ['a', 'b', 'c', 'd']),
    hole('H0', ['h0', 'h1', 'h2', 'h3'], 'T0'),
  ]);
  return { feature, vertices };
}

/** Deterministic id ports seeded from a counter (so tests assert minted ids). */
export function idPorts(prefix = 'g'): {
  nextRingId: () => RingId;
  nextVertexId: () => VertexId;
  minted: () => readonly string[];
} {
  let n = 0;
  const minted: string[] = [];
  return {
    nextRingId: () => {
      const id = `${prefix}-r${n++}`;
      minted.push(id);
      return rid(id);
    },
    nextVertexId: () => {
      const id = `${prefix}-v${n++}`;
      minted.push(id);
      return vid(id);
    },
    minted: () => minted.slice(),
  };
}

export type { Vertex };
