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
 * Derived depth for every feature in the forest, as a map. Each entry is
 * computed independently through the cycle-safe walk; cyclic features map to
 * {@link DEPTH_UNDEFINED}. Pure and finite even on broken input.
 */
export function derivedDepths(forest: Forest): Map<FeatureId, number> {
  const out = new Map<FeatureId, number>();
  for (const id of forest.orderedIds) {
    out.set(id, derivedDepth(forest, id));
  }
  return out;
}

/**
 * Maximum derivable depth in the forest, ignoring cyclic (undefined) features.
 * Returns 0 for an empty / all-roots forest. Each TREE may have a different max
 * depth (FR-38: 最大深度はツリーごとに異なってよい); this is the global maximum
 * over all derivable features, exposed for callers that need a single bound.
 */
export function maxDerivedDepth(forest: Forest): number {
  let max = 0;
  for (const id of forest.orderedIds) {
    const d = derivedDepth(forest, id);
    if (!isDepthUndefined(d) && d > max) max = d;
  }
  return max;
}
