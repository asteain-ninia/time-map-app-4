// U33 four-color (greedy) assignment: deterministic graph coloring (FR-101).
//
// Given an adjacency graph and the SET OF COLORABLE NODES (auto-color-enabled
// features), assign each colorable node a color INDEX so that no two adjacent
// colorable nodes share an index. Processing order is the graph's stable id
// order (教訓 5.19), so the same graph + same colorable set always yields the same
// assignment (受け入れ基準2 決定性). Each node takes the LOWEST index not used by an
// already-colored adjacent node — classic greedy coloring. When the palette base
// colors run out the index simply grows; the palette's deterministic expansion
// (`colorAtIndex`) supplies a derived color, so "四色で足りない縮退ケース" is
// handled by higher indices, never by a non-deterministic fallback (spec §配色).
//
// NEIGHBOUR HANDLING ACROSS THE auto/manual BOUNDARY (FR-101 規約):
// a neighbour that is NOT colorable (auto-color disabled, manual color) does not
// receive an index here. Its FIXED color is, however, an index-space constraint
// only insofar as it maps to a base-color index — but manual colors are arbitrary
// and may not be palette colors, so we adopt the CONSISTENT rule stated in the
// spec: auto-color回避 is guaranteed AMONG auto-color targets (受け入れ基準2). Manual
// neighbours are recorded as `pinned` so a caller can additionally avoid their
// concrete colors at the color-resolution step; the index assignment itself only
// guarantees auto/auto separation.
//
// PURITY (受け入れ基準6): pure, deterministic, inputs unmutated.

import type { FeatureId } from '../ids';
import { type AdjacencyGraph, neighborsOf } from './adjacency';

/** A deterministic color-index assignment: colorable node -> color index (>=0). */
export type ColorIndexAssignment = ReadonlyMap<FeatureId, number>;

/**
 * Greedy four-color-style assignment over the colorable subset of `graph`.
 *
 * @param graph        the normalized adjacency graph (stable id order).
 * @param colorable    the set of nodes to assign indices to (auto-color targets).
 *                     Nodes outside this set get NO index (manual / not present).
 * @returns a map from each colorable node to its color index.
 */
export function assignColorIndices(
  graph: AdjacencyGraph,
  colorable: ReadonlySet<FeatureId>,
): ColorIndexAssignment {
  const assignment = new Map<FeatureId, number>();
  // Process in the graph's stable node order (教訓 5.19 決定性).
  for (const id of graph.nodes) {
    if (!colorable.has(id)) continue;
    const used = new Set<number>();
    for (const neighbor of neighborsOf(graph, id)) {
      // Only already-assigned colorable neighbours constrain us. Because we
      // process in a fixed order, this yields a deterministic result.
      const idx = assignment.get(neighbor);
      if (idx !== undefined) used.add(idx);
    }
    let index = 0;
    while (used.has(index)) index += 1;
    assignment.set(id, index);
  }
  return assignment;
}

/**
 * Verify a color-index assignment is a proper coloring of the colorable subset:
 * no two adjacent colorable nodes share an index. Returns the list of violating
 * undirected pairs (empty == proper). Used by tests (受け入れ基準2 隣接同色ゼロ).
 */
export function findColorConflicts(
  graph: AdjacencyGraph,
  assignment: ColorIndexAssignment,
): ReadonlyArray<readonly [FeatureId, FeatureId]> {
  const conflicts: Array<readonly [FeatureId, FeatureId]> = [];
  for (const id of graph.nodes) {
    const ai = assignment.get(id);
    if (ai === undefined) continue;
    for (const neighbor of neighborsOf(graph, id)) {
      // Each undirected pair once.
      if (!(id < neighbor)) continue;
      const bi = assignment.get(neighbor);
      if (bi === undefined) continue;
      if (ai === bi) conflicts.push([id, neighbor]);
    }
  }
  return conflicts;
}

/** The highest color index used by an assignment (-1 if empty). */
export function maxColorIndex(assignment: ColorIndexAssignment): number {
  let max = -1;
  for (const idx of assignment.values()) {
    if (idx > max) max = idx;
  }
  return max;
}
