// U33 recolor trigger: decide whether to RE-COLOR by comparing the RESULT STATE
// (the adjacency graph), never the call path (FR-101 / 教訓 5.6).
//
// The spec is explicit: re-color ONLY when the adjacency relation changed —
// shared-boundary 成立/解消, 面の分割, 面の結合 — and NEVER on time-move or a plain
// vertex move that leaves shared boundaries unchanged. Crucially, this decision
// must not be gated on "which command called us" (教訓 5.6): 分割/結合/共有頂点化
// /共有解除/編集確定 all flow through ONE judgment — does the adjacency signature
// differ from before? — so every path that changes adjacency triggers a recolor
// and every path that does not, does not. (教訓 5.25: we do NOT broaden the trigger
// to "color looks stale" cases like time-move.)
//
// PURITY (受け入れ基準6): pure comparison, no mutation, deterministic.

import { type AdjacencyGraph } from './adjacency';

/**
 * Whether the adjacency relation changed between the previous and current graph.
 * This is the SINGLE result-state predicate the recolor decision turns on. A
 * time-move (the feature set switches to another time's already-colored state)
 * or a vertex move that does not add/remove a shared boundary produces the SAME
 * signature -> false -> no recolor. A 分割/結合/共有境界成立/解消 changes the
 * signature -> true -> recolor (教訓 5.6 全経路網羅).
 */
export function adjacencyChanged(
  previous: AdjacencyGraph,
  current: AdjacencyGraph,
): boolean {
  // Compare the signatures computed ONCE at build time (cached on the graph),
  // not recomputed per call — building the signature is O(E·log E); this
  // comparison is O(signature length). See AdjacencyGraph.signature.
  return previous.signature !== current.signature;
}

/**
 * The result-state recolor decision. Recolor iff the adjacency relation changed.
 * This deliberately takes no "operation kind" / "called from split" flag (教訓
 * 5.6): the decision is determined ENTIRELY by the before/after adjacency.
 */
export function shouldRecolor(
  previous: AdjacencyGraph,
  current: AdjacencyGraph,
): boolean {
  return adjacencyChanged(previous, current);
}
