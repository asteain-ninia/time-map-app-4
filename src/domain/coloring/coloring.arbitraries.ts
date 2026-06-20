// fast-check generators for adjacency graphs (受け入れ基準2 のプロパティテスト基盤).
//
// Produces arbitrary undirected graphs over a small set of feature ids: a node
// list plus a random subset of the possible edges. Both PLANAR-ish and dense
// (degenerate, non-planar) graphs are generated so the "base colors run out ->
// deterministic derived color, still no conflict" path is exercised.

import fc from 'fast-check';

import { asFeatureId, type FeatureId } from '../ids';
import { type AdjacencyEdge, buildAdjacencyGraph, type AdjacencyGraph } from './adjacency';

/** A node id like `f00`, `f01`, ... so sort order is stable & readable. */
export function featureIdArb(maxNodes: number): fc.Arbitrary<FeatureId> {
  return fc
    .integer({ min: 0, max: maxNodes - 1 })
    .map((n) => asFeatureId(`f${String(n).padStart(2, '0')}`));
}

export interface GraphSpec {
  readonly graph: AdjacencyGraph;
  readonly nodeIds: readonly FeatureId[];
}

/**
 * An arbitrary adjacency graph with `nodeCount` nodes and a random subset of all
 * possible undirected edges (edge probability controlled to occasionally produce
 * dense graphs that exceed four base colors).
 */
export function adjacencyGraphArb(maxNodes = 8): fc.Arbitrary<GraphSpec> {
  return fc.integer({ min: 1, max: maxNodes }).chain((nodeCount) => {
    const nodeIds: FeatureId[] = [];
    for (let i = 0; i < nodeCount; i += 1) {
      nodeIds.push(asFeatureId(`f${String(i).padStart(2, '0')}`));
    }
    const possibleEdges: Array<[number, number]> = [];
    for (let i = 0; i < nodeCount; i += 1) {
      for (let j = i + 1; j < nodeCount; j += 1) {
        possibleEdges.push([i, j]);
      }
    }
    return fc
      .array(fc.boolean(), { minLength: possibleEdges.length, maxLength: possibleEdges.length })
      .map((flags) => {
        const edges: AdjacencyEdge[] = [];
        possibleEdges.forEach(([i, j], k) => {
          if (flags[k] === true) {
            const a = nodeIds[i];
            const b = nodeIds[j];
            if (a !== undefined && b !== undefined) edges.push({ a, b });
          }
        });
        return { graph: buildAdjacencyGraph(nodeIds, edges), nodeIds };
      });
  });
}

/** An arbitrary subset of the graph's nodes to mark auto-color-enabled. */
export function colorableSubsetArb(spec: GraphSpec): fc.Arbitrary<ReadonlySet<FeatureId>> {
  return fc
    .array(fc.boolean(), {
      minLength: spec.nodeIds.length,
      maxLength: spec.nodeIds.length,
    })
    .map((flags) => {
      const set = new Set<FeatureId>();
      spec.nodeIds.forEach((id, i) => {
        if (flags[i] === true) set.add(id);
      });
      return set;
    });
}
