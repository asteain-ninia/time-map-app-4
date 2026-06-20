import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import { buildAdjacencyGraph, adjacencySignature, type AdjacencyEdge } from './adjacency';
import { assignColorIndices, findColorConflicts, maxColorIndex } from './four-color';

function f(n: number): FeatureId {
  return asFeatureId(`f${String(n).padStart(2, '0')}`);
}

function graphOf(nodeCount: number, edges: ReadonlyArray<[number, number]>) {
  const nodes: FeatureId[] = [];
  for (let i = 0; i < nodeCount; i += 1) nodes.push(f(i));
  const adjEdges: AdjacencyEdge[] = edges.map(([a, b]) => ({ a: f(a), b: f(b) }));
  return buildAdjacencyGraph(nodes, adjEdges);
}

function allNodes(nodeCount: number): ReadonlySet<FeatureId> {
  const s = new Set<FeatureId>();
  for (let i = 0; i < nodeCount; i += 1) s.add(f(i));
  return s;
}

describe('four-color: adjacent nodes never share a color index (受け入れ基準2)', () => {
  it('a triangle uses three distinct indices', () => {
    const g = graphOf(3, [[0, 1], [1, 2], [0, 2]]);
    const a = assignColorIndices(g, allNodes(3));
    expect(findColorConflicts(g, a)).toHaveLength(0);
    expect(new Set(a.values()).size).toBe(3);
  });

  it('non-adjacent nodes MAY share a color index (色数を無駄にしない)', () => {
    // f0-f1 adjacent, f2 isolated. Greedy gives f0=0, f1=1, f2=0.
    const g = graphOf(3, [[0, 1]]);
    const a = assignColorIndices(g, allNodes(3));
    expect(a.get(f(0))).toBe(0);
    expect(a.get(f(2))).toBe(0);
    expect(findColorConflicts(g, a)).toHaveLength(0);
  });
});

describe('four-color: degenerate (>4 mutual) graphs still conflict-free (FR-101)', () => {
  it('a 6-clique forces 6 indices, no conflict (派生色で充当)', () => {
    const edges: Array<[number, number]> = [];
    for (let i = 0; i < 6; i += 1) {
      for (let j = i + 1; j < 6; j += 1) edges.push([i, j]);
    }
    const g = graphOf(6, edges);
    const a = assignColorIndices(g, allNodes(6));
    expect(findColorConflicts(g, a)).toHaveLength(0);
    expect(maxColorIndex(a)).toBe(5);
  });
});

describe('four-color: determinism (受け入れ基準2)', () => {
  it('same graph + same colorable set -> identical assignment', () => {
    const g = graphOf(5, [[0, 1], [1, 2], [2, 3], [3, 4], [4, 0], [0, 2]]);
    const a1 = assignColorIndices(g, allNodes(5));
    const a2 = assignColorIndices(g, allNodes(5));
    expect([...a1.entries()]).toEqual([...a2.entries()]);
  });

  it('insertion order of edges does not change the result (signature stable)', () => {
    const g1 = graphOf(4, [[0, 1], [1, 2], [2, 3]]);
    const g2 = graphOf(4, [[2, 3], [1, 2], [0, 1]]);
    expect(adjacencySignature(g1)).toBe(adjacencySignature(g2));
    const a1 = assignColorIndices(g1, allNodes(4));
    const a2 = assignColorIndices(g2, allNodes(4));
    expect([...a1.entries()]).toEqual([...a2.entries()]);
  });
});

describe('four-color: only colorable nodes get an index (auto/manual境界)', () => {
  it('manual (non-colorable) nodes are excluded from the assignment', () => {
    const g = graphOf(3, [[0, 1], [1, 2]]);
    const colorable = new Set<FeatureId>([f(0), f(2)]); // f1 is manual
    const a = assignColorIndices(g, colorable);
    expect(a.has(f(1))).toBe(false);
    expect(a.has(f(0))).toBe(true);
    expect(a.has(f(2))).toBe(true);
    // f0 and f2 are NOT adjacent to each other, so they may share index 0.
    expect(a.get(f(0))).toBe(0);
    expect(a.get(f(2))).toBe(0);
  });

  it('auto/auto adjacency is still avoided even with a manual node between', () => {
    // f0-f1 adjacent, both auto. f1-f2 adjacent, f2 manual. f0,f1 must differ.
    const g = graphOf(3, [[0, 1], [1, 2]]);
    const colorable = new Set<FeatureId>([f(0), f(1)]);
    const a = assignColorIndices(g, colorable);
    expect(a.get(f(0))).not.toBe(a.get(f(1)));
  });
});
