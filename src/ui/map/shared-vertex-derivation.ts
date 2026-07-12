// UI layer (map): the SHARED shared-vertex derivation — the ONE place that turns a
// per-time feature set into the domain `SharedVertexState` inputs and the derived
// set of SHARED vertex ids (FR-30 / FR-33).
//
// WHY THIS FILE EXISTS (単一真実源, 教訓 5.29 / 5.30):
// A vertex is SHARED when ≥2 distinct shape references cite it (two features, or two
// rings of one leaf). Sharing is DERIVED, never stored (domain shared-vertex §4.1),
// so every consumer must build the domain `SharedVertexState` from the SAME resolved
// feature set + vertex store and read the shared ids off its ONE reverse index. This
// derivation was previously PRIVATE to `active-feature-handles` (the FR-30 visual
// marker path); FR-96 (右クリック「共有解除」出し分け) and FR-33 (共有解除本体) need the
// EXACT same set, so it is extracted here and both import it — a vertex the context
// menu offers 共有解除 for is exactly a vertex the marker draws distinct and the
// linked-move follows (no drift, 教訓 5.29 二重実装禁止).
//
// DEPTH-INDEPENDENCE (FR-33 出し分けの基準): the set is built from
// `resolution.features` = `featuresAt(root, time)` (display-resolution-cache.ts) — the
// FULL raw feature set effective at `time`, UNFILTERED by displayControl/depth (only
// `resolved` / `grabbable` / `owners` are depth-sensitive). So sharing is RAW /
// depth-independent: a vertex shared between a grabbable feature and a depth-collapsed
// neighbour is still reported shared. Callers MUST NOT restrict to `grabbable` — that
// would hide real sharing on depth-hidden neighbours (a regression).
//
// PURITY: builds fresh values; inputs are never mutated. The set is memoized per
// resolved-bundle identity (a WeakMap) so a drag frame that only moves vertex BODIES
// reuses the ONE derivation.

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import type { VertexId } from '../../domain/ids';
import { RING_KIND } from '../../domain/ring';
import {
  buildReverseIndex,
  createSharedVertexState,
  type ContainerEntry,
} from '../../domain/shared-vertex';
import type { VertexStore } from '../../domain/vertex';

import type { DisplayResolution } from './display-resolution-cache';

/**
 * Every ring + line-path container of `features` as domain `ContainerEntry`s (the
 * input to a `SharedVertexState`). Leaf rings (territory / hole / enclave) and line
 * paths are the only ShapeContainers; points / aggregates contribute none. A point
 * references a single vertex but has no ShapeContainer in the domain model, so a
 * point's vertex is only ever "shared" when a ring / line ALSO cites it — which is
 * exactly the domain's own notion of sharing.
 */
export function containersOf(features: readonly Feature[]): ContainerEntry[] {
  const entries: ContainerEntry[] = [];
  for (const f of features) {
    if (f.kind === FEATURE_KIND.Line) {
      entries.push({ container: { kind: 'line', featureId: f.id }, vertexIds: f.vertexIds });
    } else if (f.kind === FEATURE_KIND.Leaf) {
      for (const ring of f.shape.rings) {
        if (ring.kind !== RING_KIND.Territory && ring.kind !== RING_KIND.Hole) continue;
        entries.push({
          container: { kind: 'ring', featureId: f.id, ringId: ring.id },
          vertexIds: ring.vertexIds,
        });
      }
    }
  }
  return entries;
}

// Per-frame memo (see display-resolution-cache): the shared id set is a pure function
// of the resolved bundle identity — features + containers do not change during a drag
// (only vertex BODIES move), so it is derived ONCE per `resolveDisplayFor` generation
// and reused across frames of the same generation. Keyed on the bundle's IDENTITY (a
// WeakMap, so an evicted generation is collected).
const sharedIdCache = new WeakMap<DisplayResolution, ReadonlySet<VertexId>>();

/**
 * The set of SHARED vertex ids across ALL features of `resolution` (FR-30 / FR-33),
 * memoized by the bundle's identity. Built from the domain `SharedVertexState`
 * reverse index (the single sharing derivation), so a vertex is "shared" iff ≥2
 * distinct shape references cite it. RAW / depth-independent (see the module note):
 * uses `resolution.features` (the full per-time set), never the grabbable subset.
 */
export function sharedVertexIdsFor(resolution: DisplayResolution): ReadonlySet<VertexId> {
  const cached = sharedIdCache.get(resolution);
  if (cached !== undefined) return cached;
  const shared = sharedVertexIdsOf(resolution.vertices, resolution.features);
  sharedIdCache.set(resolution, shared);
  return shared;
}

/**
 * The un-memoized shared-vertex derivation over an explicit `(vertices, features)`
 * pair — the same computation {@link sharedVertexIdsFor} memoizes. Exposed for
 * consumers that hold the raw per-time feature set + vertex store directly (e.g. the
 * FR-33 unshare launcher builds its `SharedVertexState` from the SAME inputs, so its
 * "which vertices are shared" agrees with the menu's出し分け by construction).
 */
export function sharedVertexIdsOf(
  vertices: VertexStore,
  features: readonly Feature[],
): ReadonlySet<VertexId> {
  const state = createSharedVertexState(vertices, containersOf(features));
  const index = buildReverseIndex(state);
  const shared = new Set<VertexId>();
  for (const [vid, refs] of index) {
    if (refs.length >= 2) shared.add(vid);
  }
  return shared;
}
