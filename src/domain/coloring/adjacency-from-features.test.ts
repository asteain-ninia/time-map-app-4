// U33 adjacency-from-features tests (FR-101): the neighbour graph handed to the
// four-color assignment is derived by SHARED-VERTEX co-citation, scoped to a
// single hierarchy layer (同一階層). These fix the contract that:
//   - two leaves are adjacent IFF a VertexId is cited by both of their rings,
//   - only leaves are nodes (point / line / aggregate are excluded),
//   - a leaf's own two rings citing one vertex is NOT a self-edge,
//   - cross-layer co-citation (aggregate child vs top-level leaf, FR-37 直轄領)
//     does NOT create an edge, and
//   - a split's uncut neighbour stays adjacent to the bordering piece, which
//     hinges on transferSharing repointing EVERY citation of a re-minted id.

import { describe, expect, it } from 'vitest';

import { createBasicAttributes, createColorInfo } from '../attributes';
import {
  createAggregateFeature,
  createLeafFeature,
  createLineFeature,
  createPointFeature,
  referencedVertexIds,
  type Feature,
  type LeafFeature,
} from '../feature';
import { asFeatureId, asRingId, asVertexId, type FeatureId } from '../ids';
import { createShape, createTerritoryRing, type Ring } from '../ring';
import {
  buildReverseIndex,
  createSharedVertexState,
  transferSharing,
  type ContainerEntry,
  type VertexRemap,
} from '../shared-vertex';
import { createVertex, createVertexStore, type VertexStore } from '../vertex';

import { neighborsOf } from './adjacency';
import { buildAdjacencyFromLeaves } from './adjacency-from-features';

const color = createColorInfo(true, '#90caf9', '#ffb300', '#0d47a1');

/** A single-ring leaf citing `vids`, optionally parented (its hierarchy layer). */
function leaf(id: string, vids: string[], parentId?: string): LeafFeature {
  const ring = createTerritoryRing(asRingId(`r-${id}`), vids.map((v) => asVertexId(v)));
  return createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 0),
    color,
    createShape([ring]),
    parentId !== undefined ? { parentId: asFeatureId(parentId) } : {},
  );
}

/** A multi-ring leaf (rings cited in order) for the self-edge case. */
function multiRingLeaf(id: string, rings: string[][]): LeafFeature {
  const built: Ring[] = rings.map((vids, i) =>
    createTerritoryRing(asRingId(`r-${id}-${i}`), vids.map((v) => asVertexId(v))),
  );
  return createLeafFeature(
    asFeatureId(id),
    createBasicAttributes(id, 0, 0),
    color,
    createShape(built),
  );
}

/** A vertex store covering every id any of `features` references (coords irrelevant). */
function verticesForLeaves(features: readonly Feature[]): VertexStore {
  const ids = new Set<string>();
  for (const f of features) {
    for (const v of referencedVertexIds(f)) ids.add(v as unknown as string);
  }
  return createVertexStore(
    [...ids].map((id, i) => createVertex(asVertexId(id), { lon: i, lat: 0 })),
  );
}

function fid(id: string): FeatureId {
  return asFeatureId(id);
}

/** Undirected neighbour test over the built graph. */
function adjacent(features: readonly Feature[], a: string, b: string): boolean {
  const g = buildAdjacencyFromLeaves(features, verticesForLeaves(features));
  return neighborsOf(g, fid(a)).includes(fid(b));
}

describe('buildAdjacencyFromLeaves — shared-vertex co-citation (FR-101)', () => {
  it('joins two leaves that cite a shared VertexId', () => {
    const a = leaf('A', ['a1', 's1', 's2', 'a4']);
    const b = leaf('B', ['s1', 'b2', 'b3', 's2']); // s1, s2 shared with A
    const g = buildAdjacencyFromLeaves([a, b], verticesForLeaves([a, b]));
    expect(g.nodes).toEqual([fid('A'), fid('B')]);
    expect(neighborsOf(g, fid('A'))).toEqual([fid('B')]);
    expect(neighborsOf(g, fid('B'))).toEqual([fid('A')]);
  });

  it('leaves no edge when no VertexId is shared', () => {
    const a = leaf('A', ['a1', 'a2', 'a3', 'a4']);
    const b = leaf('B', ['b1', 'b2', 'b3', 'b4']);
    const g = buildAdjacencyFromLeaves([a, b], verticesForLeaves([a, b]));
    expect(neighborsOf(g, fid('A'))).toEqual([]);
    expect(neighborsOf(g, fid('B'))).toEqual([]);
  });

  it('makes a tri-point (3 leaves sharing ONE vertex) a complete graph', () => {
    // A three-country corner: one vertex `t` cited by A, B and C.
    const a = leaf('A', ['a1', 'a2', 't']);
    const b = leaf('B', ['b1', 't', 'b3']);
    const c = leaf('C', ['t', 'c2', 'c3']);
    const g = buildAdjacencyFromLeaves([a, b, c], verticesForLeaves([a, b, c]));
    expect(neighborsOf(g, fid('A'))).toEqual([fid('B'), fid('C')]);
    expect(neighborsOf(g, fid('B'))).toEqual([fid('A'), fid('C')]);
    expect(neighborsOf(g, fid('C'))).toEqual([fid('A'), fid('B')]);
  });

  it('excludes point / line / aggregate features from the node set', () => {
    const l = leaf('L', ['s1', 's2', 'l3']);
    const point = createPointFeature(
      fid('P'),
      createBasicAttributes('P', 0, 0),
      color,
      asVertexId('s1'), // same coordinate id as a leaf ring vertex
    );
    const line = createLineFeature(
      fid('N'),
      createBasicAttributes('N', 0, 0),
      color,
      [asVertexId('s1'), asVertexId('s2')], // cites the leaf's vertices
    );
    const agg = createAggregateFeature(
      fid('G'),
      createBasicAttributes('G', 0, 0),
      color,
      [fid('L')],
    );
    const g = buildAdjacencyFromLeaves([l, point, line, agg], verticesForLeaves([l, point, line]));
    // Only the leaf is a node; the point/line sharing its vertices raise no edge.
    expect(g.nodes).toEqual([fid('L')]);
    expect(neighborsOf(g, fid('L'))).toEqual([]);
  });

  it('does not create a self-edge when one leaf cites a vertex in two of its rings', () => {
    const solo = multiRingLeaf('A', [
      ['a1', 'a2', 'shared'],
      ['shared', 'a4', 'a5'],
    ]);
    const g = buildAdjacencyFromLeaves([solo], verticesForLeaves([solo]));
    expect(g.nodes).toEqual([fid('A')]);
    expect(neighborsOf(g, fid('A'))).toEqual([]);
  });
});

describe('buildAdjacencyFromLeaves — same-layer (同一階層) scoping (FR-101 / FR-37)', () => {
  it('does NOT join an aggregate child leaf and a top-level leaf that share a vertex', () => {
    // FR-37 直轄領: an aggregate G owns a shape-bearing child leaf `child`; a
    // top-level leaf `top` shares a boundary vertex with it. Different layers →
    // no edge, so the cross-layer co-citation never constrains the colorer.
    const top = leaf('TOP', ['t1', 'x', 't3']); // top-level (no parent)
    const child = leaf('CHILD', ['x', 'c2', 'c3'], 'G'); // child of aggregate G
    expect(adjacent([top, child], 'TOP', 'CHILD')).toBe(false);
  });

  it('joins two sibling child leaves of the same aggregate that share a vertex', () => {
    const s1 = leaf('S1', ['p', 'q', 's1a'], 'G');
    const s2 = leaf('S2', ['p', 'q', 's2a'], 'G'); // same parent G, shares p,q
    expect(adjacent([s1, s2], 'S1', 'S2')).toBe(true);
  });
});

// --- split A|B|C: non-cut neighbour adjacency + transferSharing id repoint ----
//
// A|B|C in a row: A shares its right border (p1,p2) with B's left; B shares its
// right border (q1,q2) with C's left. Splitting B down the middle mints a cut
// seam (s1,s2) shared by the two pieces, while each piece KEEPS the original
// border ids on its uncut side. The neighbour A must stay adjacent to the piece
// bordering it (B1), and C to B2 — never to the far piece.

function borderLeaf(id: string, left: [string, string], right: [string, string]): LeafFeature {
  // A quad citing its left pair (top,bottom) then its right pair (top,bottom).
  return leaf(id, [left[0], right[0], right[1], left[1]]);
}

describe('buildAdjacencyFromLeaves — split A|B|C non-cut neighbour (critique MED #5)', () => {
  it('detects A-B and B-C before the split, and A-B1 / B1-B2 / B2-C after', () => {
    const A = borderLeaf('A', ['aL1', 'aL2'], ['p1', 'p2']);
    const B = borderLeaf('B', ['p1', 'p2'], ['q1', 'q2']);
    const C = borderLeaf('C', ['q1', 'q2'], ['cR1', 'cR2']);
    const before = [A, B, C];
    expect(adjacent(before, 'A', 'B')).toBe(true);
    expect(adjacent(before, 'B', 'C')).toBe(true);
    expect(adjacent(before, 'A', 'C')).toBe(false);

    // Split B into B1 (keeps p1,p2 on its left) | B2 (keeps q1,q2 on its right),
    // sharing a fresh cut seam s1,s2. A and C are untouched (keep their ids).
    const B1 = borderLeaf('B1', ['p1', 'p2'], ['s1', 's2']);
    const B2 = borderLeaf('B2', ['s1', 's2'], ['q1', 'q2']);
    const after = [A, B1, B2, C];
    expect(adjacent(after, 'A', 'B1')).toBe(true); // uncut neighbour still detected
    expect(adjacent(after, 'B1', 'B2')).toBe(true); // the two pieces
    expect(adjacent(after, 'B2', 'C')).toBe(true); // uncut neighbour still detected
    expect(adjacent(after, 'A', 'B2')).toBe(false); // never the far piece
    expect(adjacent(after, 'B1', 'C')).toBe(false);
  });

  it('transferSharing repoints EVERY citation of a re-minted border id (neighbour + piece)', () => {
    // If a structural op re-mints the A|B shared border (p1->p1n, p2->p2n),
    // transferSharing must repoint BOTH A's and B's citations, or the two adjacent
    // auto-color features would silently drift to distinct ids → same colour bug.
    const A = borderLeaf('A', ['aL1', 'aL2'], ['p1', 'p2']);
    const B = borderLeaf('B', ['p1', 'p2'], ['q1', 'q2']);
    const containers: ContainerEntry[] = [A, B].flatMap((f) =>
      f.shape.rings.map((ring) => ({
        container: { kind: 'ring' as const, featureId: f.id, ringId: ring.id as unknown as string },
        vertexIds: ring.vertexIds,
      })),
    );
    const state = createSharedVertexState(verticesForLeaves([A, B]), containers);
    const remap: VertexRemap = new Map([
      [asVertexId('p1'), asVertexId('p1n')],
      [asVertexId('p2'), asVertexId('p2n')],
    ]);
    const next = transferSharing(state, remap);
    const idx = buildReverseIndex(next);
    const ownersOf = (v: string): Set<string> => {
      const owners = new Set<string>();
      for (const ref of idx.get(asVertexId(v)) ?? []) {
        owners.add(ref.container.featureId as unknown as string);
      }
      return owners;
    };
    // The new ids are co-cited by BOTH A and B; the old ids are gone entirely.
    expect(ownersOf('p1n')).toEqual(new Set(['A', 'B']));
    expect(ownersOf('p2n')).toEqual(new Set(['A', 'B']));
    expect(ownersOf('p1').size).toBe(0);
    expect(ownersOf('p2').size).toBe(0);

    // Rebuild the leaves from the repointed containers → adjacency survives.
    const rebuilt: LeafFeature[] = [A, B].map((f) => {
      const ring = next.containers.get(`ring:${f.id}:${f.shape.rings[0]!.id}`)!;
      return leaf(f.id as unknown as string, ring.vertexIds.map((v) => v as unknown as string));
    });
    expect(adjacent(rebuilt, 'A', 'B')).toBe(true);
  });
});
