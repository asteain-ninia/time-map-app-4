// Shared test fixtures for U26 knife tests (not production code).

import { createBasicAttributes, createColorInfo } from '../attributes';
import { createCoordinate, type WorldCoordinate } from '../coordinate';
import {
  createAggregateFeature,
  createLeafFeature,
  type AggregateFeature,
  type LeafFeature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId, type VertexId } from '../ids';
import { createHoleRing, createShape, createTerritoryRing, type Ring } from '../ring';
import { createVertex, createVertexStore, type Vertex, type VertexStore } from '../vertex';

export const ATTRS = createBasicAttributes('test', 0, 100);
export const COLOR = createColorInfo(true, '#fff', '#0f0', '#000');

export const fid = (s: string): FeatureId => asFeatureId(s);

let counter = 0;
export function freshIdPorts() {
  return {
    nextFeatureId: () => asFeatureId(`f-${counter++}`),
    nextVertexId: () => asVertexId(`nv-${counter++}`),
    nextRingId: () => asRingId(`nr-${counter++}`),
  };
}

/** Build a leaf feature with a single territory ring from coordinates. */
export function squareLeaf(
  featureId: string,
  coords: readonly WorldCoordinate[],
  vertexPrefix = featureId,
): { feature: LeafFeature; store: VertexStore } {
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  coords.forEach((coord, i) => {
    const vid = asVertexId(`${vertexPrefix}-v${i}`);
    vertices.push(createVertex(vid, coord));
    vertexIds.push(vid);
  });
  const ring: Ring = createTerritoryRing(asRingId(`${featureId}-r0`), vertexIds);
  const feature = createLeafFeature(asFeatureId(featureId), ATTRS, COLOR, createShape([ring]));
  return { feature, store: createVertexStore(vertices) };
}

/** A unit square [0,10]² leaf. */
export function unitSquare(featureId = 'sq') {
  return squareLeaf(featureId, [
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(0, 10),
  ]);
}

/** A square leaf with a central square hole (territory + hole). */
export function squareWithHole(featureId = 'wh'): {
  feature: LeafFeature;
  store: VertexStore;
} {
  const outerIds = [
    asVertexId(`${featureId}-o0`),
    asVertexId(`${featureId}-o1`),
    asVertexId(`${featureId}-o2`),
    asVertexId(`${featureId}-o3`),
  ];
  const outerCoords = [
    createCoordinate(0, 0),
    createCoordinate(10, 0),
    createCoordinate(10, 10),
    createCoordinate(0, 10),
  ];
  const holeIds = [
    asVertexId(`${featureId}-h0`),
    asVertexId(`${featureId}-h1`),
    asVertexId(`${featureId}-h2`),
    asVertexId(`${featureId}-h3`),
  ];
  const holeCoords = [
    createCoordinate(3, 3),
    createCoordinate(7, 3),
    createCoordinate(7, 7),
    createCoordinate(3, 7),
  ];
  const vertices: Vertex[] = [];
  outerIds.forEach((id, i) => vertices.push(createVertex(id, outerCoords[i]!)));
  holeIds.forEach((id, i) => vertices.push(createVertex(id, holeCoords[i]!)));
  const territory = createTerritoryRing(asRingId(`${featureId}-rt`), outerIds);
  const hole = createHoleRing(asRingId(`${featureId}-rh`), holeIds, territory.id);
  const feature = createLeafFeature(
    asFeatureId(featureId),
    ATTRS,
    COLOR,
    createShape([territory, hole]),
  );
  return { feature, store: createVertexStore(vertices) };
}

/**
 * A [0,20]² square leaf whose interior holds, on the LEFT half, a hole [3,9]×[3,9]
 * with an enclave territory [4,8]×[4,8] nested INSIDE that hole, and on the RIGHT
 * half a second, separate untouched hole [12,16]×[4,8]. Used to exercise FR-91:
 * a vertical cut at x=6 crosses the left hole + enclave, while the right hole is
 * left untouched.
 *
 * Rings: outer territory, left hole, enclave territory (parent = left hole),
 * right hole. (territory → hole → territory alternation, plus a sibling hole.)
 */
export function squareWithHoleEnclave(featureId = 'whe'): {
  feature: LeafFeature;
  store: VertexStore;
} {
  const mk = (suffix: string, coords: readonly WorldCoordinate[]) => {
    const ids = coords.map((_, i) => asVertexId(`${featureId}-${suffix}${i}`));
    return { ids, coords };
  };
  const outer = mk('o', [
    createCoordinate(0, 0),
    createCoordinate(20, 0),
    createCoordinate(20, 20),
    createCoordinate(0, 20),
  ]);
  const leftHole = mk('lh', [
    createCoordinate(3, 3),
    createCoordinate(9, 3),
    createCoordinate(9, 9),
    createCoordinate(3, 9),
  ]);
  const enclave = mk('en', [
    createCoordinate(4, 4),
    createCoordinate(8, 4),
    createCoordinate(8, 8),
    createCoordinate(4, 8),
  ]);
  const rightHole = mk('rh', [
    createCoordinate(12, 4),
    createCoordinate(16, 4),
    createCoordinate(16, 8),
    createCoordinate(12, 8),
  ]);

  const vertices: Vertex[] = [];
  for (const part of [outer, leftHole, enclave, rightHole]) {
    part.ids.forEach((id, i) => vertices.push(createVertex(id, part.coords[i]!)));
  }

  const tOuter = createTerritoryRing(asRingId(`${featureId}-rt`), outer.ids);
  const rLeftHole = createHoleRing(asRingId(`${featureId}-rlh`), leftHole.ids, tOuter.id);
  const tEnclave = createTerritoryRing(asRingId(`${featureId}-ren`), enclave.ids, rLeftHole.id);
  const rRightHole = createHoleRing(asRingId(`${featureId}-rrh`), rightHole.ids, tOuter.id);

  const feature = createLeafFeature(
    asFeatureId(featureId),
    ATTRS,
    COLOR,
    createShape([tOuter, rLeftHole, tEnclave, rRightHole]),
  );
  return { feature, store: createVertexStore(vertices) };
}

/**
 * Two leaf squares sharing the edge from (10,0) to (10,10): the left leaf
 * [0,10]² and the right leaf [10,20]×[0,10] cite the SAME two vertex ids for the
 * shared edge (FR-30/FR-95 sharing by ID reference). Returned with the shared
 * vertex ids so a test can build the U11 container vertexId lists.
 */
export function sharedEdgePair(): {
  left: LeafFeature;
  right: LeafFeature;
  store: VertexStore;
  sharedTop: VertexId;
  sharedBottom: VertexId;
} {
  const sharedBottom = asVertexId('shared-b'); // (10,0)
  const sharedTop = asVertexId('shared-t'); // (10,10)
  const l0 = asVertexId('l0'); // (0,0)
  const l3 = asVertexId('l3'); // (0,10)
  const r1 = asVertexId('r1'); // (20,0)
  const r2 = asVertexId('r2'); // (20,10)

  const vertices: Vertex[] = [
    createVertex(l0, createCoordinate(0, 0)),
    createVertex(sharedBottom, createCoordinate(10, 0)),
    createVertex(sharedTop, createCoordinate(10, 10)),
    createVertex(l3, createCoordinate(0, 10)),
    createVertex(r1, createCoordinate(20, 0)),
    createVertex(r2, createCoordinate(20, 10)),
  ];

  // Left ring: (0,0) (10,0) (10,10) (0,10) — edge sharedBottom→sharedTop at i=1.
  const leftRing = createTerritoryRing(asRingId('left-r0'), [l0, sharedBottom, sharedTop, l3]);
  const left = createLeafFeature(asFeatureId('left'), ATTRS, COLOR, createShape([leftRing]));
  // Right ring: (10,0) (20,0) (20,10) (10,10) — edge sharedTop→sharedBottom at i=3.
  const rightRing = createTerritoryRing(asRingId('right-r0'), [sharedBottom, r1, r2, sharedTop]);
  const right = createLeafFeature(asFeatureId('right'), ATTRS, COLOR, createShape([rightRing]));

  return { left, right, store: createVertexStore(vertices), sharedTop, sharedBottom };
}

/** An aggregate feature (no shape) — used to assert集約は分割不可 (FR-44). */
export function aggregate(featureId = 'agg'): AggregateFeature {
  return createAggregateFeature(asFeatureId(featureId), ATTRS, COLOR, [fid('child')]);
}
