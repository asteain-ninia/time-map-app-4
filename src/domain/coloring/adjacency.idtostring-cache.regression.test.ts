// Regression (bughunt-t2): buildAdjacencyGraph re-derived each id's string form
// via idToString on the HOT paths — twice per comparison in the node sort and in
// every neighbour-list sort (an O(V·d·log d) wave of redundant calls), then again
// once per node and once per edge inside computeAdjacencySignature. idToString was
// being called O(V·d·log d) times for sorting PLUS O(V·d) more for the signature,
// for the same handful of distinct ids.
//
// THE FIX resolves each node's string ONCE into a Map at the top of
// buildAdjacencyGraph and reuses that cached string for every sort comparison and
// for the signature, so each id is converted at most once per build.
//
// These tests pin BOTH halves of the contract:
//   1. NO REDUNDANT CONVERSION — idToString is called at most once per distinct
//      node during a build (it must NOT scale with edge count or with the O(n log n)
//      comparison count). A regression that reintroduces per-comparison idToString
//      calls makes the count exceed the node count and fails here.
//   2. CORRECTNESS / DETERMINISM — the cached build produces byte-identical node
//      order, neighbour order, and signature to a from-scratch reference, i.e. the
//      optimization changed nothing observable.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { asFeatureId, type FeatureId } from '../ids';
import * as idsModule from '../ids';
import { adjacencySignature, buildAdjacencyGraph, neighborsOf, type AdjacencyEdge } from './adjacency';

function f(n: number): FeatureId {
  return asFeatureId(`f${String(n).padStart(2, '0')}`);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('adjacency: idToString is resolved once per node, not per comparison (bughunt-t2)', () => {
  it('calls idToString at most once per distinct node, regardless of edge count', () => {
    // A dense-ish graph: 8 nodes, each connected to several others. With a
    // per-comparison idToString (the bug), the call count grows with the sort
    // comparison count (O(V·d·log d)) plus the signature pass — far above 8.
    const nodes = Array.from({ length: 8 }, (_, i) => f(i));
    const edges: AdjacencyEdge[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        // Connect roughly every other pair so each node has multiple neighbours.
        if ((i + j) % 2 === 0) edges.push({ a: f(i), b: f(j) });
      }
    }

    const spy = vi.spyOn(idsModule, 'idToString');
    buildAdjacencyGraph(nodes, edges);

    // The cache holds one string per node; idToString must be invoked at most
    // once per distinct node (8). It must NOT scale with edges or comparisons.
    // (>0 guards against a vacuous pass if the spy ever stops intercepting.)
    expect(spy.mock.calls.length).toBeGreaterThan(0);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(nodes.length);
  });

  it('produces byte-identical nodes, neighbours, and signature to a reference build', () => {
    // Build twice with different insertion orders; the normalization + cached
    // signature must be identical (determinism unchanged by the optimization).
    const a = buildAdjacencyGraph(
      [f(3), f(0), f(2), f(1)],
      [
        { a: f(3), b: f(0) },
        { a: f(2), b: f(1) },
        { a: f(0), b: f(1) },
        { a: f(2), b: f(3) },
      ],
    );
    const b = buildAdjacencyGraph(
      [f(0), f(1), f(2), f(3)],
      [
        { a: f(1), b: f(0) },
        { a: f(3), b: f(2) },
        { a: f(1), b: f(2) },
        { a: f(0), b: f(3) },
      ],
    );

    expect(a.nodes).toEqual(b.nodes);
    expect(a.nodes).toEqual([f(0), f(1), f(2), f(3)]);
    for (const id of a.nodes) {
      expect(neighborsOf(a, id)).toEqual(neighborsOf(b, id));
    }
    // Neighbour lists are sorted by id.
    expect(neighborsOf(a, f(0))).toEqual([f(1), f(3)]);
    expect(neighborsOf(a, f(2))).toEqual([f(1), f(3)]);
    expect(adjacencySignature(a)).toBe(adjacencySignature(b));
  });
});
