import { describe, expect, it } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import {
  buildAdjacencyGraph,
  neighborsOf,
  adjacencySignature,
  type AdjacencyEdge,
} from './adjacency';

function f(n: number): FeatureId {
  return asFeatureId(`f${String(n).padStart(2, '0')}`);
}

describe('adjacency: normalization', () => {
  it('sorts nodes and neighbour lists by id', () => {
    const nodes = [f(2), f(0), f(1)];
    const edges: AdjacencyEdge[] = [
      { a: f(2), b: f(0) },
      { a: f(1), b: f(0) },
    ];
    const g = buildAdjacencyGraph(nodes, edges);
    expect(g.nodes).toEqual([f(0), f(1), f(2)]);
    expect(neighborsOf(g, f(0))).toEqual([f(1), f(2)]);
  });

  it('drops self-edges and edges referencing unknown nodes', () => {
    const g = buildAdjacencyGraph(
      [f(0), f(1)],
      [
        { a: f(0), b: f(0) }, // self
        { a: f(0), b: f(9) }, // unknown node
        { a: f(0), b: f(1) }, // kept
      ],
    );
    expect(neighborsOf(g, f(0))).toEqual([f(1)]);
  });

  it('treats duplicate edges idempotently', () => {
    const g = buildAdjacencyGraph(
      [f(0), f(1)],
      [
        { a: f(0), b: f(1) },
        { a: f(1), b: f(0) },
        { a: f(0), b: f(1) },
      ],
    );
    expect(neighborsOf(g, f(0))).toEqual([f(1)]);
    expect(neighborsOf(g, f(1))).toEqual([f(0)]);
  });
});

describe('adjacency: signature (result-state key for the recolor trigger)', () => {
  it('is identical regardless of edge insertion order', () => {
    const g1 = buildAdjacencyGraph([f(0), f(1), f(2)], [
      { a: f(0), b: f(1) },
      { a: f(1), b: f(2) },
    ]);
    const g2 = buildAdjacencyGraph([f(2), f(1), f(0)], [
      { a: f(2), b: f(1) },
      { a: f(1), b: f(0) },
    ]);
    expect(adjacencySignature(g1)).toBe(adjacencySignature(g2));
  });

  it('differs when a shared boundary is added or removed', () => {
    const before = buildAdjacencyGraph([f(0), f(1)], []);
    const after = buildAdjacencyGraph([f(0), f(1)], [{ a: f(0), b: f(1) }]);
    expect(adjacencySignature(before)).not.toBe(adjacencySignature(after));
  });

  it('differs when a node is added (面の分割で新規面が出現)', () => {
    const before = buildAdjacencyGraph([f(0)], []);
    const after = buildAdjacencyGraph([f(0), f(1)], []);
    expect(adjacencySignature(before)).not.toBe(adjacencySignature(after));
  });
});

describe('adjacency: signature is cached on the graph at build time (bughunt3)', () => {
  it('exposes the precomputed signature as a stable readonly field', () => {
    const g = buildAdjacencyGraph([f(0), f(1), f(2)], [
      { a: f(0), b: f(1) },
      { a: f(1), b: f(2) },
    ]);
    // The cached field equals what the reader returns, every time, by identity
    // of value (no recomputation drift).
    expect(g.signature).toBe(adjacencySignature(g));
    expect(adjacencySignature(g)).toBe(adjacencySignature(g));
  });

  it('adjacencySignature reads the cached field and never re-sorts the edge set', () => {
    // Regression: shouldRecolor used to call adjacencySignature twice, each
    // allocating an array + .sort() (O(E·log E)). The signature is now computed
    // ONCE in buildAdjacencyGraph; adjacencySignature must read that cached
    // value, not recompute it. We assert this by reading from a graph whose
    // neighbors map cannot be re-walked into the same string unless the cache is
    // used: we freeze a sentinel into .signature and confirm the reader returns
    // it verbatim regardless of the (matching) edge data.
    const built = buildAdjacencyGraph([f(0), f(1)], [{ a: f(0), b: f(1) }]);
    const sentinel = 'SENTINEL-CACHED-SIGNATURE';
    const spoofed = { ...built, signature: sentinel };
    expect(adjacencySignature(spoofed)).toBe(sentinel);
  });

  it('precomputed signatures match graphs with equal nodes+edges across builds', () => {
    const a = buildAdjacencyGraph([f(0), f(1), f(2)], [
      { a: f(0), b: f(1) },
      { a: f(1), b: f(2) },
    ]);
    const b = buildAdjacencyGraph([f(2), f(0), f(1)], [
      { a: f(2), b: f(1) },
      { a: f(0), b: f(1) },
    ]);
    // Same result state -> same cached signature -> recolor trigger says false.
    expect(a.signature).toBe(b.signature);
  });
});
