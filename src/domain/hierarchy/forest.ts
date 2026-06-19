// U08 forest model + cycle-safe traversal (domain layer, pure).
//
// The parent/child relation over面情報 is read as a FOREST: every feature has at
// most one parent (`parentId`); multiple roots are allowed (FR-34). This module
// is the SINGLE source of truth for:
//   - parent -> children (direct sub-regions) and child -> parent lookups,
//   - leaf vs aggregate classification by RESULT STATE (下位領域を持つか, 教訓5.6),
//   - the cycle-safe traversal helper that EVERY recursive walk routes through
//     (visited set, 教訓5.28) so cyclic / broken data returns a finite result.
//
// Nothing here mutates its inputs; everything is derived from the plain feature
// set passed in. We never add a new domain type (spec §依存: U03 の型を入力に取る).

import type { AggregateFeature, Feature } from '../feature';
import { FEATURE_KIND } from '../feature';
import type { FeatureId } from '../ids';

/**
 * An indexed, read-only view of a feature set as a forest. Built once from a
 * feature list; all U08 queries take this so the parent/child maps are computed
 * a single time (O(n)) and reused (避: O(n²) 退化, 受け入れ基準6).
 */
export interface Forest {
  /** featureId -> feature. */
  readonly byId: ReadonlyMap<FeatureId, Feature>;
  /** parentId -> direct child ids, in input order. */
  readonly childrenOf: ReadonlyMap<FeatureId, readonly FeatureId[]>;
  /** The features that have no (resolvable) parent — the forest roots. */
  readonly rootIds: readonly FeatureId[];
  /** Input order of every feature id (stable iteration). */
  readonly orderedIds: readonly FeatureId[];
}

/**
 * Build the forest view from a feature set.
 *
 * Parent links are taken from each feature's `parentId`. A `parentId` that does
 * not resolve to a present feature is treated as "no parent" for root detection
 * (it is a separate broken-link concern reported by validation, not a reason to
 * crash here). Children are derived solely from parent links so the relation is
 * consistent regardless of any (ignored) aggregate `childIds` drift —単一真実源.
 */
export function buildForest(features: readonly Feature[]): Forest {
  const byId = new Map<FeatureId, Feature>();
  const orderedIds: FeatureId[] = [];
  for (const f of features) {
    byId.set(f.id, f);
    orderedIds.push(f.id);
  }

  const childrenOf = new Map<FeatureId, FeatureId[]>();
  const rootIds: FeatureId[] = [];
  for (const id of orderedIds) {
    const f = byId.get(id);
    if (f === undefined) continue;
    const parentId = f.parentId;
    if (parentId !== undefined && byId.has(parentId)) {
      const bucket = childrenOf.get(parentId);
      if (bucket === undefined) {
        childrenOf.set(parentId, [id]);
      } else {
        bucket.push(id);
      }
    } else {
      // No parent, or a dangling parent link: a root for traversal purposes.
      rootIds.push(id);
    }
  }

  return { byId, childrenOf, rootIds, orderedIds };
}

/** Direct sub-regions (children) of a feature, in input order. Empty if none. */
export function directChildIds(forest: Forest, id: FeatureId): readonly FeatureId[] {
  return forest.childrenOf.get(id) ?? [];
}

/**
 * RESULT-STATE classification (教訓5.6): a feature is an AGGREGATE iff it has at
 * least one direct child in the parent relation, otherwise a LEAF — independent
 * of its declared `kind`. The discriminant `kind` is the structural type; this
 * predicate is the hierarchy-derived role used for the形状=和 check.
 */
export function hasChildren(forest: Forest, id: FeatureId): boolean {
  return directChildIds(forest, id).length > 0;
}

export const HIERARCHY_ROLE = {
  /** No sub-regions: a terminal feature that owns its own shape. */
  Leaf: 'leaf',
  /** Has sub-regions: an aggregate whose shape is the union of children. */
  Aggregate: 'aggregate',
} as const;

export type HierarchyRole = (typeof HIERARCHY_ROLE)[keyof typeof HIERARCHY_ROLE];

/** Role from result state (下位領域の有無), NOT from the declared `kind`. */
export function hierarchyRole(forest: Forest, id: FeatureId): HierarchyRole {
  return hasChildren(forest, id) ? HIERARCHY_ROLE.Aggregate : HIERARCHY_ROLE.Leaf;
}

// --- cycle-safe parent-chain walk (教訓5.28) --------------------------------

/**
 * Outcome of walking the parent chain upward from a feature to its root.
 * Either a clean ascent (`cyclic: false`) reaching a root after `length` hops,
 * or a cycle detection (`cyclic: true`) listing the ids on the cycle.
 *
 * The walk ALWAYS terminates: a `visited` set blocks re-entry, so even
 * self-parenting (A→A) or a multi-node cycle (A→B→A) yields a finite result.
 */
export type ParentWalk =
  | { readonly cyclic: false; readonly chain: readonly FeatureId[]; readonly rootId: FeatureId }
  | { readonly cyclic: true; readonly cycle: readonly FeatureId[] };

/**
 * Walk from `startId` up through `parentId` links until a root (no resolvable
 * parent) is reached, or a cycle is found. `chain` is the ordered list of ids
 * visited starting at `startId` and ending at the root (inclusive).
 */
export function walkToRoot(forest: Forest, startId: FeatureId): ParentWalk {
  const visited = new Set<FeatureId>();
  const chain: FeatureId[] = [];
  let current: FeatureId | undefined = startId;

  while (current !== undefined) {
    if (visited.has(current)) {
      // Re-entry: the chain from the first occurrence of `current` is the cycle.
      const from = chain.indexOf(current);
      const cycle = from >= 0 ? chain.slice(from) : [current];
      return { cyclic: true, cycle };
    }
    visited.add(current);
    chain.push(current);

    const f: Feature | undefined = forest.byId.get(current);
    const parentId: FeatureId | undefined = f?.parentId;
    if (parentId === undefined || !forest.byId.has(parentId)) {
      // Root reached (no parent, or a dangling parent link).
      return { cyclic: false, chain, rootId: current };
    }
    current = parentId;
  }

  // Unreachable in practice (startId is always defined); satisfy the type.
  return { cyclic: false, chain: [startId], rootId: startId };
}

/**
 * Enumerate ALL descendants of `id` (its sub-tree, excluding `id` itself) in a
 * cycle-safe, depth-first manner. A `visited` set blocks re-entry so broken
 * data (a child that is also an ancestor) cannot loop forever (教訓5.28). Order
 * is deterministic (input order at each level).
 */
export function descendantIds(forest: Forest, id: FeatureId): FeatureId[] {
  const out: FeatureId[] = [];
  const visited = new Set<FeatureId>([id]);
  const stack: FeatureId[] = [...directChildIds(forest, id)];
  // Process children left-to-right; push in reverse so pop yields input order.
  stack.reverse();

  while (stack.length > 0) {
    const next = stack.pop();
    if (next === undefined) continue;
    if (visited.has(next)) continue;
    visited.add(next);
    out.push(next);
    const kids = directChildIds(forest, next);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const k = kids[i];
      if (k !== undefined && !visited.has(k)) stack.push(k);
    }
  }
  return out;
}

/** Narrow a feature to the aggregate variant by declared `kind` (helper). */
export function asAggregate(feature: Feature): AggregateFeature | undefined {
  return feature.kind === FEATURE_KIND.Aggregate ? feature : undefined;
}
