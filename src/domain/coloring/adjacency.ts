// U33 adjacency graph: the INPUT to four-color assignment and the basis of the
// recolor trigger. The graph says, for a set of area features at the selected
// time, which pairs share a boundary within the SAME layer (同一階層) — the
// "neighbour" relation (FR-101).
//
// This unit does NOT compute adjacency (共有境界の算出は依存ユニット U10 / U11 の
// 責務 — spec §やらないこと). It consumes a graph handed in from that boundary and
// gives it a stable, deterministic shape (sorted nodes, normalized undirected
// edges) so the colorer is fully determined by its input (教訓 5.19 決定性).
//
// PURITY: building / diffing the graph never mutates inputs and is deterministic.

import type { FeatureId } from '../ids';
import { idToString } from '../ids';

/** An undirected edge between two distinct feature ids (a shared boundary). */
export interface AdjacencyEdge {
  readonly a: FeatureId;
  readonly b: FeatureId;
}

/**
 * A normalized, deterministic adjacency graph: a sorted node list plus an
 * adjacency map (node -> sorted neighbour list). Self-edges are dropped and each
 * undirected pair appears once per direction in the map. Built via
 * {@link buildAdjacencyGraph}; never constructed ad hoc so the normalization is
 * single-sourced.
 */
export interface AdjacencyGraph {
  /** All nodes, sorted by id (the stable processing order — 教訓 5.19). */
  readonly nodes: readonly FeatureId[];
  /** node id -> its neighbours, sorted by id. */
  readonly neighbors: ReadonlyMap<FeatureId, readonly FeatureId[]>;
  /**
   * The canonical, comparable signature of this graph's nodes + undirected edge
   * set, computed ONCE at build time (see {@link computeAdjacencySignature}).
   * The recolor trigger compares two of these already-computed strings instead
   * of re-sorting/re-joining the edge set on every {@link shouldRecolor} call.
   */
  readonly signature: string;
}

/**
 * Compare two ids by their already-resolved string forms. The sort comparators
 * inside {@link buildAdjacencyGraph} precompute each id's string ONCE (into
 * `idStr`) and reuse it for every comparison and for the signature — instead of
 * re-deriving the string via {@link idToString} twice per comparison (an
 * O(V·d·log d) wave of redundant calls) and again per edge/node in
 * {@link computeAdjacencySignature}. Determinism is unchanged: this is the same
 * lexicographic string ordering used before, just over cached strings.
 */
function compareStr(sa: string, sb: string): number {
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Build a normalized adjacency graph from a node set and an edge list. Nodes and
 * every neighbour list are sorted by id; self-edges (a===b) and duplicate edges
 * are ignored; an edge referencing a node not in `nodes` is also ignored (the
 * graph is closed over the given node set). Pure — inputs are not mutated.
 */
export function buildAdjacencyGraph(
  nodes: Iterable<FeatureId>,
  edges: Iterable<AdjacencyEdge>,
): AdjacencyGraph {
  const nodeSet = new Set<FeatureId>(nodes);
  const adj = new Map<FeatureId, Set<FeatureId>>();
  for (const id of nodeSet) {
    adj.set(id, new Set<FeatureId>());
  }
  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    if (!nodeSet.has(edge.a) || !nodeSet.has(edge.b)) continue;
    adj.get(edge.a)?.add(edge.b);
    adj.get(edge.b)?.add(edge.a);
  }
  // Resolve each id's string form ONCE and reuse it for every sort comparison
  // and for the signature, instead of calling idToString twice per comparison
  // and again per edge/node in computeAdjacencySignature.
  const idStr = new Map<FeatureId, string>();
  for (const id of nodeSet) {
    idStr.set(id, idToString(id));
  }
  const strOf = (id: FeatureId): string => idStr.get(id) ?? idToString(id);
  const sortedNodes = [...nodeSet].sort((a, b) => compareStr(strOf(a), strOf(b)));
  const neighbors = new Map<FeatureId, readonly FeatureId[]>();
  for (const id of sortedNodes) {
    const set = adj.get(id) ?? new Set<FeatureId>();
    neighbors.set(id, [...set].sort((a, b) => compareStr(strOf(a), strOf(b))));
  }
  const signature = computeAdjacencySignature(sortedNodes, neighbors, strOf);
  return { nodes: sortedNodes, neighbors, signature };
}

/** The neighbours of a node (empty array if the node is absent). */
export function neighborsOf(graph: AdjacencyGraph, id: FeatureId): readonly FeatureId[] {
  return graph.neighbors.get(id) ?? [];
}

/**
 * Compute the canonical signature from already-normalized graph data. Called
 * ONCE by {@link buildAdjacencyGraph}; the result is cached on the graph as
 * {@link AdjacencyGraph.signature}. Two graphs with the same nodes + same shared
 * boundaries produce the same string, regardless of insertion order — the
 * result-state key the recolor trigger turns on (教訓 5.6).
 */
function computeAdjacencySignature(
  nodes: readonly FeatureId[],
  neighbors: ReadonlyMap<FeatureId, readonly FeatureId[]>,
  strOf: (id: FeatureId) => string = idToString,
): string {
  const edges: string[] = [];
  for (const id of nodes) {
    const sid = strOf(id);
    for (const n of neighbors.get(id) ?? []) {
      const sn = strOf(n);
      // Each undirected edge once, in (min,max) order.
      if (sid < sn) edges.push(`${sid}|${sn}`);
    }
  }
  edges.sort();
  // Include isolated nodes so adding a node with no edges still differs.
  const nodeSig = nodes.map(strOf).join(',');
  return `N:${nodeSig};E:${edges.join(';')}`;
}

/**
 * The canonical, comparable signature of the graph's nodes + UNDIRECTED edge
 * set. Computed once at build time and cached on the graph (教訓 5.6: detect
 * change by RESULT STATE, not call path); this reader returns that cached value
 * in O(1) so repeated recolor decisions never re-sort the edge set.
 */
export function adjacencySignature(graph: AdjacencyGraph): string {
  return graph.signature;
}
