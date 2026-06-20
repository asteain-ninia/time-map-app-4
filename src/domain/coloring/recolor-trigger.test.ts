import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import { buildAdjacencyGraph, type AdjacencyEdge } from './adjacency';
import { adjacencyChanged, shouldRecolor } from './recolor-trigger';

function f(n: number): FeatureId {
  return asFeatureId(`f${String(n).padStart(2, '0')}`);
}

function graphOf(nodeCount: number, edges: ReadonlyArray<[number, number]>) {
  const nodes: FeatureId[] = [];
  for (let i = 0; i < nodeCount; i += 1) nodes.push(f(i));
  const adjEdges: AdjacencyEdge[] = edges.map(([a, b]) => ({ a: f(a), b: f(b) }));
  return buildAdjacencyGraph(nodes, adjEdges);
}

describe('recolor-trigger: result-state judgment (FR-101 / 教訓 5.6)', () => {
  it('recolors when a shared boundary is established', () => {
    const before = graphOf(2, []);
    const after = graphOf(2, [[0, 1]]);
    expect(shouldRecolor(before, after)).toBe(true);
  });

  it('recolors when a shared boundary is dissolved', () => {
    const before = graphOf(2, [[0, 1]]);
    const after = graphOf(2, []);
    expect(shouldRecolor(before, after)).toBe(true);
  });

  it('recolors when a face is split (a new node + new adjacency appears)', () => {
    const before = graphOf(1, []);
    const after = graphOf(2, [[0, 1]]);
    expect(shouldRecolor(before, after)).toBe(true);
  });

  it('recolors when faces are merged (a node disappears)', () => {
    const before = graphOf(3, [[0, 1], [1, 2]]);
    const after = graphOf(2, [[0, 1]]);
    expect(shouldRecolor(before, after)).toBe(true);
  });
});

describe('recolor-trigger: NO recolor when adjacency is unchanged (教訓 5.25)', () => {
  it('time-move (same feature set, same adjacency) does not recolor', () => {
    const t1 = graphOf(3, [[0, 1], [1, 2]]);
    // a different time whose evaluated adjacency happens to be identical.
    const t2 = graphOf(3, [[1, 2], [0, 1]]);
    expect(shouldRecolor(t1, t2)).toBe(false);
    expect(adjacencyChanged(t1, t2)).toBe(false);
  });

  it('a plain vertex move that does not change shared boundaries does not recolor', () => {
    const before = graphOf(3, [[0, 1], [1, 2]]);
    const after = graphOf(3, [[0, 1], [1, 2]]); // vertices moved but adjacency same
    expect(shouldRecolor(before, after)).toBe(false);
  });
});

describe('recolor-trigger: multiple call paths converge on the same judgment (教訓 5.6)', () => {
  it('split, merge, share, unshare all reduce to "adjacency changed?"', () => {
    // Each scenario is described only by its before/after RESULT STATE — no
    // operation-kind flag is ever consulted.
    const scenarios: Array<{ before: ReturnType<typeof graphOf>; after: ReturnType<typeof graphOf>; expected: boolean }> = [
      { before: graphOf(2, []), after: graphOf(2, [[0, 1]]), expected: true }, // share
      { before: graphOf(2, [[0, 1]]), after: graphOf(2, []), expected: true }, // unshare
      { before: graphOf(1, []), after: graphOf(2, [[0, 1]]), expected: true }, // split
      { before: graphOf(3, [[0, 1], [1, 2]]), after: graphOf(2, [[0, 1]]), expected: true }, // merge
      { before: graphOf(2, [[0, 1]]), after: graphOf(2, [[0, 1]]), expected: false }, // vertex move
    ];
    for (const s of scenarios) {
      expect(shouldRecolor(s.before, s.after)).toBe(s.expected);
    }
  });
});
