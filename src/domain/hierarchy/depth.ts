// U08 derived hierarchy depth (FR-38, domain layer, pure).
//
// Depth is a DERIVED value: a root is depth 0, a child is parent + 1. It is
// NEVER read from the feature itself (a feature carries no depth field, and even
// a hypothetical/stored value must be ignored — spec 注意点「派生値を入力に持ち
// 込まない」). It is always recomputed from the parent chain, through the single
// cycle-safe walk helper (教訓5.28), so broken / cyclic data returns a finite
// result instead of looping forever.

import type { FeatureId } from '../ids';
import { type Forest, walkToRoot } from './forest';

/**
 * Depth of `id` = number of parent hops to its root (root = 0).
 *
 * Cycle handling: if `id` sits on a parent-chain cycle the depth is undefined
 * (no well-defined root), and we return the SAFE DEFAULT of -1 to signal "no
 * derivable depth" without throwing. Callers that care about cycles use the
 * validation API (./validate); plain depth queries stay total and finite.
 */
export function derivedDepth(forest: Forest, id: FeatureId): number {
  const walk = walkToRoot(forest, id);
  if (walk.cyclic) return DEPTH_UNDEFINED;
  // chain = [id, parent, ..., root]; hops to root = length - 1.
  return walk.chain.length - 1;
}

/** Sentinel returned by {@link derivedDepth} when `id` lies on a cycle. */
export const DEPTH_UNDEFINED = -1;

/** True iff a depth value is the cycle sentinel (no derivable depth). */
export function isDepthUndefined(depth: number): boolean {
  return depth === DEPTH_UNDEFINED;
}

/**
 * Derived depth for every feature in the forest, as a map. Cyclic features map
 * to {@link DEPTH_UNDEFINED}. Pure and finite even on broken input.
 *
 * Computed in ~O(n) via memoization: each feature's depth is parent.depth + 1,
 * resolved by a single DFS up the parent chain that MEMOIZES every depth it
 * settles on the way. Re-walking the shared upper chain for each node (the old
 * O(n·depth) ~ O(n²) behaviour on a chain-shaped forest) is avoided — once an
 * ancestor's depth is known, every descendant reuses it in O(1). A `path` set
 * detects cycles (every id on an unresolved cycle is marked undefined).
 */
export function derivedDepths(forest: Forest): Map<FeatureId, number> {
  const memo = new Map<FeatureId, number>();

  function depthOf(id: FeatureId): number {
    const cached = memo.get(id);
    if (cached !== undefined) return cached;

    // Climb to the nearest ancestor with a known (memoized) depth or a root,
    // recording the path so we can detect a cycle and fill the chain in O(len).
    const path: FeatureId[] = [];
    const onPath = new Set<FeatureId>();
    let current: FeatureId | undefined = id;
    let base = -1; // depth of the resolved anchor (root parent = -1 => root is 0).
    let cyclic = false;

    for (;;) {
      if (current === undefined) {
        base = -1; // ran off a (dangling) parent: treat as root.
        break;
      }
      const known = memo.get(current);
      if (known !== undefined) {
        base = known;
        break;
      }
      if (onPath.has(current)) {
        cyclic = true;
        break;
      }
      onPath.add(current);
      path.push(current);
      const f = forest.byId.get(current);
      const parentId = f?.parentId;
      current = parentId !== undefined && forest.byId.has(parentId) ? parentId : undefined;
    }

    if (cyclic) {
      // Every id walked from `id` to the cycle (inclusive) has no derivable depth.
      for (const p of path) memo.set(p, DEPTH_UNDEFINED);
      return DEPTH_UNDEFINED;
    }

    // Fill depths from the resolved anchor downward: the last pushed id sits just
    // above `base`, so assign increasing depths walking the path in reverse.
    let d = base + path.length;
    for (const p of path) {
      memo.set(p, d);
      d -= 1;
    }
    return memo.get(id)!;
  }

  const out = new Map<FeatureId, number>();
  for (const id of forest.orderedIds) {
    out.set(id, depthOf(id));
  }
  return out;
}

/**
 * Maximum derivable depth in the forest, ignoring cyclic (undefined) features.
 * Returns 0 for an empty / all-roots forest. Each TREE may have a different max
 * depth (FR-38: 最大深度はツリーごとに異なってよい); this is the global maximum
 * over all derivable features, exposed for callers that need a single bound.
 * Reuses the memoized {@link derivedDepths} pass (~O(n)).
 */
export function maxDerivedDepth(forest: Forest): number {
  let max = 0;
  for (const d of derivedDepths(forest).values()) {
    if (!isDepthUndefined(d) && d > max) max = d;
  }
  return max;
}
