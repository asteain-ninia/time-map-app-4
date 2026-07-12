// U33 adjacency derivation from features (FR-101): build the neighbour graph the
// four-color assignment consumes by SHARED-VERTEX co-citation, scoped to a single
// hierarchy layer (同一階層).
//
// SINGLE SOURCE OF "WHO SHARES A VERTEX" (教訓 5.29): the co-citation is derived
// through the shared-vertex reverse index (`buildReverseIndex`, shared-vertex §4.1
// "THE single derivation"), the SAME derivation the sharing / linked-move /
// unshare / continuity paths use — not a second bespoke ring walk that could drift
// from it. Two leaves are neighbours iff some VertexId is cited by BOTH of their
// rings. SpatialIndex / HitIndex are deliberately NOT used here: those are bbox
// broad-phase for point / overlap hit-testing, not topological adjacency.
//
// SAME-LAYER RULE (FR-101 / FR-37 直轄領): `featuresAt` unions a top-level leaf
// with an aggregate's CHILD leaves — and FR-37 (a 形状持ち末端 gaining children)
// now creates exactly such shape-bearing children. A child leaf that shares a
// coincident boundary vertex with a top-level leaf must NOT constrain it: they are
// different layers. Edges are therefore raised ONLY between leaves with the SAME
// parentId (undefined parentId == the top-level layer). Every leaf is still a
// node, so each layer is an independent component the greedy colorer colours on
// its own (a disconnected graph is coloured per-component).
//
// PURITY (受け入れ基準6): pure, deterministic; normalization (sorted nodes /
// neighbours / signature) is delegated to `buildAdjacencyGraph`.

import { FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import type { FeatureId } from '../ids';
import {
  buildReverseIndex,
  createSharedVertexState,
  type ContainerEntry,
} from '../shared-vertex';
import type { VertexStore } from '../vertex';
import {
  buildAdjacencyGraph,
  type AdjacencyEdge,
  type AdjacencyGraph,
} from './adjacency';

function isLeaf(feature: Feature): feature is LeafFeature {
  return feature.kind === FEATURE_KIND.Leaf;
}

/**
 * Build the same-layer shared-vertex adjacency graph for the leaf features
 * effective at a time. Nodes = every leaf id; edges = pairs of SAME-layer leaves
 * that co-cite a VertexId (a shared boundary). `vertices` pairs the leaf rings'
 * vertexId lists with their coordinate store to form the {@link createSharedVertexState}
 * value `buildReverseIndex` consumes (the reverse index reads the containers, not
 * the coordinates, so the co-citation is purely id-based).
 */
export function buildAdjacencyFromLeaves(
  features: readonly Feature[],
  vertices: VertexStore,
): AdjacencyGraph {
  const leaves = features.filter(isLeaf);
  const nodes: FeatureId[] = leaves.map((leaf) => leaf.id);

  // parentId per leaf (undefined => the top-level layer) — the same-layer edge gate.
  const layerOf = new Map<FeatureId, FeatureId | undefined>();
  const containers: ContainerEntry[] = [];
  for (const leaf of leaves) {
    layerOf.set(leaf.id, leaf.parentId);
    for (const ring of leaf.shape.rings) {
      containers.push({
        container: { kind: 'ring', featureId: leaf.id, ringId: ring.id },
        vertexIds: ring.vertexIds,
      });
    }
  }

  const reverseIndex = buildReverseIndex(createSharedVertexState(vertices, containers));
  const sameLayer = (a: FeatureId, b: FeatureId): boolean => layerOf.get(a) === layerOf.get(b);

  const edges: AdjacencyEdge[] = [];
  for (const refs of reverseIndex.values()) {
    // The DISTINCT leaf ids citing this vertex (a leaf may cite it from several
    // rings — dedupe so its own re-citation never becomes a self-edge / phantom).
    const owners: FeatureId[] = [];
    const seen = new Set<FeatureId>();
    for (const ref of refs) {
      const owner = ref.container.featureId;
      if (seen.has(owner)) continue;
      seen.add(owner);
      owners.push(owner);
    }
    if (owners.length < 2) continue;
    // Every SAME-layer pair among the co-citing leaves gets an undirected edge;
    // buildAdjacencyGraph normalizes (sorts, dedupes, drops any self-edge).
    for (let i = 0; i < owners.length; i += 1) {
      for (let j = i + 1; j < owners.length; j += 1) {
        const a = owners[i];
        const b = owners[j];
        if (a === undefined || b === undefined) continue; // noUncheckedIndexedAccess
        if (sameLayer(a, b)) edges.push({ a, b });
      }
    }
  }

  return buildAdjacencyGraph(nodes, edges);
}
