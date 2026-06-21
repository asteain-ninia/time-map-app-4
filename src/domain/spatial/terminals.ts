// U10 adapter — turn an evaluated forest state into the TerminalShape list the
// exclusion detector consumes. This is the seam between U08 (terminal/aggregate
// distinction + shape resolution) and U10's pure detection (spec §依存 / §層境界
// 教訓5.33).
//
// A feature is a terminal for exclusion purposes when it OWNS a shape and has no
// sub-regions — i.e. a childless LEAF. An aggregate (any feature with children)
// is excluded entirely (FR-27 / 教訓5.25): it is never added to the list, so it
// can never appear in an overlap pair. Points and lines carry no area and are
// not exclusion targets either (FR-29) — `resolveFeatureArea` returns an empty
// area for them, which `extractTerminalShapes` drops.
//
// Pure: reads the forest + vertex store, returns a fresh list, mutates nothing.

import type { Feature, LeafFeature } from '../feature';
import { FEATURE_KIND } from '../feature';
import { getVertex, type Vertex, type VertexStore } from '../vertex';
import type { FeatureId, VertexId } from '../ids';
import type { GeoMultiPolygon } from '../geometry/types';
import { directChildIds, type Forest } from '../hierarchy/forest';
import { resolveFeatureArea } from '../hierarchy/resolve-shape';
import { isMultiPolygonEmpty } from '../geometry/types';
import type { TerminalShape } from './overlap';

/**
 * Extract the exclusion-relevant terminal shapes from an evaluated forest.
 *
 * For every feature with NO children (a terminal by the result-state rule, 教訓
 * 5.6) we resolve its own area via U08; features with children are aggregates
 * and are skipped (FR-27). A terminal whose resolved area is empty (a point, a
 * line, or a shapeless/failed resolution) contributes no exclusion shape and is
 * omitted — it cannot overlap anything.
 *
 * A failed shape resolution (missing vertex / rejected union) is skipped rather
 * than thrown: exclusion detection answers "which terminals overlap?", and an
 * unresolvable terminal has no decidable area to test. Callers that need to
 * surface resolution failures should run U08 validation separately (单一責務).
 *
 * Hot-path note (bughunt3): the consistency orchestrator rebuilds this list on
 * EVERY edit confirm. At the spec's 5,000-terminal scale a from-scratch run does
 * 5,000 full ring→vertex resolutions per commit even though a single edit touches
 * 1–2 features. Pass a {@link TerminalShapeCache} (see {@link createTerminalShapeCache})
 * to make the run INCREMENTAL: an untouched terminal reuses its prior resolved
 * shape and skips the O(R×V) resolution entirely. The cache is correctness-safe
 * because features and vertices are IMMUTABLE value objects with structural
 * sharing — an edit produces a NEW object only for the entities it touches, so a
 * terminal whose feature object AND every referenced vertex object are reference-
 * identical to the cached snapshot is provably unchanged.
 */
export function extractTerminalShapes(
  forest: Forest,
  store: VertexStore,
  cache?: TerminalShapeCache,
): TerminalShape[] {
  const out: TerminalShape[] = [];
  const nextEntries = cache !== undefined ? new Map<FeatureId, CacheEntry>() : undefined;
  for (const [id, feature] of forest.byId) {
    if (directChildIds(forest, id).length > 0) continue; // aggregate: excluded.

    // Cache fast path: an untouched terminal (same feature object + same vertex
    // objects for every referenced vertex id) reuses its prior resolved shape and
    // skips the full ring→vertex resolution (and any union) entirely.
    if (cache !== undefined && nextEntries !== undefined) {
      const prior = cache.entries.get(id);
      if (prior !== undefined && cacheEntryStillValid(prior, feature, store)) {
        nextEntries.set(id, prior);
        if (prior.shape !== undefined) out.push({ id, shape: prior.shape });
        continue;
      }
    }

    const resolution = resolveFeatureArea(forest, store, id);
    if (cache !== undefined && nextEntries !== undefined) {
      // Record this resolution against the inputs it was derived from, so a later
      // run can detect an untouched terminal by reference identity. `shape` is
      // undefined for a terminal that contributed nothing (unresolvable / empty),
      // so a re-run still skips it without re-resolving.
      const refs = referencedVertexSnapshot(feature, store);
      if (resolution.status === 'ok' && !isMultiPolygonEmpty(resolution.area)) {
        nextEntries.set(id, { feature, vertexRefs: refs, shape: resolution.area });
        out.push({ id, shape: resolution.area });
      } else {
        nextEntries.set(id, { feature, vertexRefs: refs, shape: undefined });
      }
      continue;
    }

    if (resolution.status !== 'ok') continue; // unresolvable: no decidable area.
    if (isMultiPolygonEmpty(resolution.area)) continue; // point/line/empty: no area.
    out.push({ id, shape: resolution.area });
  }
  if (cache !== undefined && nextEntries !== undefined) {
    // Swap in the rebuilt entry map: terminals that vanished from the forest drop
    // out (no stale shapes retained), survivors keep their (reused or fresh) entry.
    cache.entries = nextEntries;
  }
  return out;
}

// --- incremental cache (bughunt3) -------------------------------------------

/**
 * One cached terminal resolution: the exact feature object and the exact vertex
 * objects its shape referenced when the shape was resolved. Reference identity of
 * BOTH (immutability + structural sharing) proves the resolution is still valid.
 * `shape` is undefined when the terminal contributed no exclusion shape (a point /
 * line / unresolvable / empty), so a re-run skips it without re-resolving.
 */
interface CacheEntry {
  readonly feature: Feature;
  readonly vertexRefs: ReadonlyMap<VertexId, Vertex>;
  readonly shape: GeoMultiPolygon | undefined;
}

/**
 * An incremental cache for {@link extractTerminalShapes}. Hold ONE instance across
 * edit confirms (e.g. on the consistency binding) and pass it on every call: only
 * terminals whose feature object or a referenced vertex object changed are
 * re-resolved; the rest reuse their prior shape. Mutated in place by
 * `extractTerminalShapes` (it owns the cache's lifecycle); never share one across
 * unrelated forests.
 */
export interface TerminalShapeCache {
  entries: Map<FeatureId, CacheEntry>;
}

/** Create an empty {@link TerminalShapeCache}. */
export function createTerminalShapeCache(): TerminalShapeCache {
  return { entries: new Map() };
}

/**
 * The vertex objects a leaf's shape references, captured by id at resolution time.
 * Non-leaf terminals (point/line childless aggregate) reference nothing through a
 * shape, so their snapshot is empty and validity reduces to feature identity.
 */
function referencedVertexSnapshot(feature: Feature, store: VertexStore): ReadonlyMap<VertexId, Vertex> {
  const refs = new Map<VertexId, Vertex>();
  if (feature.kind !== FEATURE_KIND.Leaf) return refs;
  for (const ring of (feature as LeafFeature).shape.rings) {
    for (const vid of ring.vertexIds) {
      const vertex = getVertex(store, vid);
      // A missing vertex is recorded as absent (not in the map); validity below
      // re-checks the same store, so an unresolvable terminal stays unresolvable
      // unless the referenced vertex appears (a real input change).
      if (vertex !== undefined) refs.set(vid, vertex);
    }
  }
  return refs;
}

/**
 * Is a cached entry still valid for the current inputs? Valid iff the feature is
 * the SAME object AND every vertex id its shape referenced still resolves to the
 * SAME vertex object (and none has appeared/disappeared). Any reference change
 * means an edit touched this terminal's geometry, so it must be re-resolved.
 */
function cacheEntryStillValid(entry: CacheEntry, feature: Feature, store: VertexStore): boolean {
  if (entry.feature !== feature) return false;
  if (feature.kind !== FEATURE_KIND.Leaf) return true; // no shape vertices to check.
  // Re-walk the shape's vertex ids against the current store; the set of ids is
  // fixed by the (identical) feature object, so we only need each id's vertex
  // object to be the cached one — a moved vertex is a new object, a removed one is
  // now undefined, both of which fail this check and force a re-resolve.
  for (const ring of (feature as LeafFeature).shape.rings) {
    for (const vid of ring.vertexIds) {
      if (getVertex(store, vid) !== entry.vertexRefs.get(vid)) return false;
    }
  }
  return true;
}
