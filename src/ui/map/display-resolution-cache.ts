// UI layer (map): the SHARED display-resolution memo — one computation feeds both
// the draw path and the live hit-test path (教訓 5.29 単一真実源, bughunt2 perf).
//
// WHY THIS FILE EXISTS:
// `committed-features.buildCommittedFeatures` (the renderer's per-frame draw input)
// and `live-hit-test.liveHitTestAt` / `drawnAreaAt` (every pointerdown + every knife
// click) BOTH resolve the IDENTICAL display-area set from scratch:
//
//   featuresAt(root, time) + verticesAt(root, time)
//     → filter area features → buildForest(areaFeatures)
//     → resolveDisplayControl(forest, store, displayControl)
//
// That is the entire U34 hierarchy/display pipeline. With no shared cache, a frame
// that just drew (committed-features) and then receives a pointerdown (live-hit-test)
// re-runs the WHOLE resolution a SECOND time, and a knife click runs it a THIRD time
// independently — even though every input is byte-identical. On a large hierarchy
// this adds avoidable latency to the press→select path (which also flushes a redraw
// synchronously first).
//
// 「描画と同じ単一真実源」(教訓 5.29) should be a single COMPUTATION, not two/three
// recomputations per interaction. This module memoizes the resolved bundle keyed by
// the IDENTITY of its three immutable inputs — `(root, time, displayControl)` — all
// of which are swapped wholesale in the U16 store (never mutated in place), so an
// identity match is a value match. The committed-features draw and the hit-test then
// share the SAME resolved arrays for a frame, so the pipeline runs ONCE per
// (domain, time, displayControl) generation instead of once per consumer.
//
// CORRECTNESS = NO BEHAVIOUR CHANGE: the bundle is exactly what each call computed
// before (same `featuresAt` / `verticesAt` / `buildForest` / `resolveDisplayControl`
// outputs, in the same order). The presentation mapping (style / label / selected,
// which also depends on `selectedId`) stays in committed-features — only the shared,
// selection-independent resolution is cached. A cache MISS recomputes identically,
// so a caller that passes a fresh `displayControl` object (e.g. the live-hit-test
// DEFAULT fallback constant, or a unit test) simply pays the full cost as before.
//
// PURITY: the cached bundle is built from pure helpers; inputs are never mutated.
// The module holds a tiny bounded memo (process-local), which is a pure-function
// memo (same key ⇒ same value), not a second truth source.

import {
  FEATURE_KIND,
  isDrawableLineVertexCount,
  type Feature,
} from '../../domain/feature';
import type { FeatureId, VertexId } from '../../domain/ids';
import { buildForest, type Forest } from '../../domain/hierarchy/forest';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import { getVertex, type VertexStore } from '../../domain/vertex';
import {
  DISPLAY_VERDICT,
  createDisplayShapeCache,
  type DisplayShapeCache,
  type ResolvedDisplayShapes,
} from '../../domain/display';
import {
  resolveDisplayControl,
  type DisplayControlInput,
} from '../../render/display-pipeline';

import { featuresAt, verticesAt } from '../live-lookup';

/**
 * The resolved per-frame bundle shared by the draw path and the hit-test path. Every
 * field is exactly what the two callers each derived independently before this memo —
 * computed ONCE here and reused.
 */
export interface DisplayResolution {
  /** Every feature effective at `time` (U09), the SAME `featuresAt` both paths used. */
  readonly features: readonly Feature[];
  /**
   * The AREA features (leaf + aggregate) filtered out of `features` — the EXACT list
   * `buildForest` was built from. Exposed so the draw path's presentation mapping
   * (committed-features `buildAreas`) reuses this filter instead of re-running the same
   * O(n) scan over `features` a second time per generation (bughunt3).
   */
  readonly areaFeatures: readonly Feature[];
  /**
   * `areaFeatures` indexed by `FeatureId`, for the draw path's by-id presentation lookup
   * (committed-features `buildAreas` resolves each resolved shape's `featureId` back to its
   * source feature for style / label). This map is SELECTION-INDEPENDENT — it depends only
   * on `(root, time, displayControl)` — so building it ONCE here and reusing it lets a
   * selection toggle (which misses the selection-keyed output memo and re-runs the draw
   * presentation) skip re-allocating an O(n) Map over all area features every toggle
   * (bughunt3). Built once per resolution generation, shared read-only with the draw path.
   */
  readonly areaFeaturesById: ReadonlyMap<FeatureId, Feature>;
  /** The vertex store effective at `time` (U09), the SAME `verticesAt` both paths used. */
  readonly vertices: VertexStore;
  /** The forest over the AREA features (leaf + aggregate) — what `buildForest` builds. */
  readonly forest: Forest;
  /** The U34/U08-resolved display shapes (verdict + geometry) for `displayControl`. */
  readonly resolved: ResolvedDisplayShapes;
  /**
   * The set of feature ids that expose their OWN grabbable vertices THIS frame —
   * area features drawn with their own real shape (verdict Real) plus every point /
   * line (always drawn directly). An aggregate-displayed area (verdict Aggregate)
   * draws derived geometry with no grabbable own vertices, and an omitted leaf is not
   * drawn at all, so neither is included (Codex #2: 非表示頂点は拾わない).
   *
   * SELECTION-INDEPENDENT: depends only on `(root, time, displayControl)`. Built ONCE
   * per resolution generation so the live hit-test does not rebuild it on every
   * pointer event (bughunt3 — see {@link owners}).
   */
  readonly grabbable: ReadonlySet<FeatureId>;
  /**
   * Every grabbable vertex's OWNING feature (`point.vertexId` / `line.vertexIds` /
   * leaf ring `vertexIds`), restricted to features in {@link grabbable} — the first
   * owner of a shared vertex wins. This is the EXACT map the live hit-test's
   * vertex-proximity step iterates.
   *
   * WHY IT LIVES HERE (bughunt3 — O(n·v) Map rebuild per pointer event): the map is a
   * pure function of `(features, grabbable, vertices)`, all of which are themselves
   * pure functions of `(root, time, displayControl)`. Built inside `liveHitTestAt` it
   * was rebuilt from scratch on EVERY pointer event (a map with 5000 leaves × 100
   * vertices = 500,000 Map insertions per event, before the proximity test even
   * began). Computing it ONCE per resolution generation — the SAME memo the renderer
   * and hit-test already share — makes a pointer-move over an unchanged domain a cache
   * HIT with zero re-insertions (教訓 5.29 単一真実源 = 単一 COMPUTATION).
   */
  readonly owners: ReadonlyMap<VertexId, FeatureId>;
}

/** One memo entry: the three identity keys plus the resolved bundle they produced. */
interface CacheEntry {
  readonly root: DomainProject;
  readonly time: TimePoint;
  readonly control: DisplayControlInput;
  readonly value: DisplayResolution;
}

// A tiny bounded LRU. Size 2 is enough to absorb the only realistic alternation —
// the live store's CURRENT (root, time, displayControl) generation served to both the
// renderer and the hit-test, occasionally interleaved with a transient/default control
// (the hit-test fallback, a unit test) — without ever growing unbounded. A larger
// cache is unnecessary: stale generations are never queried again (the store swaps the
// references forward), so they would only retain memory.
const CACHE_CAPACITY = 2;
const cache: CacheEntry[] = [];

// The INCREMENTAL geometry-resolution cache (bughunt3), held across pipeline runs and
// passed into `resolveDisplayControl` below. The (root, time, control)-keyed memo above
// only short-circuits when ALL THREE references match; a slider tick swaps `control` to
// a NEW object and MISSES it, so `computeDisplayResolution` re-runs the U34/U08 pipeline.
// Without this geometry cache that re-run would re-derive EVERY drawable aggregate's
// 集約形状 — a full bottom-up boolean union from the leaves — even though `forest` /
// `vertices` are byte-identical. This cache lets each such re-run reuse the prior run's
// resolved geometry by reference identity of the subtree (feature + vertex objects),
// skipping the union entirely; only nodes whose geometry actually changed re-resolve.
// It is a pure-function memo (same inputs ⇒ same value), so it never changes the result.
const geometryCache: DisplayShapeCache = createDisplayShapeCache();

/** Identity match across all three immutable keys (a value match, since none mutate). */
function matches(
  entry: CacheEntry,
  root: DomainProject,
  time: TimePoint,
  control: DisplayControlInput,
): boolean {
  return entry.root === root && entry.time === time && entry.control === control;
}

/**
 * The resolved display bundle for `(root, time, control)`, computed ONCE and shared
 * between the renderer (`committed-features`) and the live hit-test
 * (`live-hit-test`). On an identity HIT the cached bundle is returned verbatim; on a
 * MISS the full pipeline runs (identical to the previous inline computation) and the
 * result is memoized (LRU, capacity {@link CACHE_CAPACITY}).
 *
 * The three keys are matched by IDENTITY. They are all swapped wholesale by the U16
 * store (`domain` / `currentTime` / `displayControl`), never mutated in place, so an
 * identity match is a value match. A caller that constructs a fresh `control` object
 * each call (e.g. the hit-test DEFAULT fallback or a test) simply always misses and
 * pays the full cost — never a stale or wrong result.
 */
export function resolveDisplayFor(
  root: DomainProject,
  time: TimePoint,
  control: DisplayControlInput,
): DisplayResolution {
  for (let i = 0; i < cache.length; i += 1) {
    const entry = cache[i]!;
    if (matches(entry, root, time, control)) {
      // Promote to most-recently-used (move to the end) so the live generation, hit
      // most often, is the last to be evicted.
      if (i !== cache.length - 1) {
        cache.splice(i, 1);
        cache.push(entry);
      }
      return entry.value;
    }
  }

  const value = computeDisplayResolution(root, time, control);
  cache.push({ root, time, control, value });
  if (cache.length > CACHE_CAPACITY) cache.shift();
  return value;
}

/**
 * Run the full pipeline for `(root, time, control)` — the EXACT computation
 * `committed-features` and `live-hit-test` each ran inline before the memo. Exposed
 * for tests that want the un-cached result; production code goes through
 * {@link resolveDisplayFor}.
 */
export function computeDisplayResolution(
  root: DomainProject,
  time: TimePoint,
  control: DisplayControlInput,
): DisplayResolution {
  const features = featuresAt(root, time);
  const vertices = verticesAt(root, time);
  const areaFeatures = features.filter(
    (f) => f.kind === FEATURE_KIND.Leaf || f.kind === FEATURE_KIND.Aggregate,
  );
  const areaFeaturesById = new Map<FeatureId, Feature>(
    areaFeatures.map((f) => [f.id, f]),
  );
  const forest = buildForest(areaFeatures);
  // The incremental geometry cache makes a control-only re-run (slider tick) reuse the
  // prior run's union geometry by subtree reference identity instead of re-deriving the
  // whole tree from the leaves (bughunt3). Correctness-safe: it is a pure-function memo.
  const resolved = resolveDisplayControl(forest, vertices, control, geometryCache);
  const grabbable = buildGrabbable(features, resolved);
  const owners = vertexOwners(features, grabbable, vertices);
  return {
    features,
    areaFeatures,
    areaFeaturesById,
    vertices,
    forest,
    resolved,
    grabbable,
    owners,
  };
}

/**
 * Which features expose their OWN grabbable vertices this frame: area features drawn
 * with their own real shape (verdict Real) plus every point / line (always drawn
 * directly). An aggregate-displayed area (verdict Aggregate) draws derived geometry
 * with no grabbable own vertices, and an omitted leaf is not drawn at all — so neither
 * contributes a vertex (Codex #2: 非表示頂点は拾わない). This is the EXACT set the live
 * hit-test built inline before bughunt3 moved it here (no behaviour change).
 */
function buildGrabbable(
  features: readonly Feature[],
  resolved: ResolvedDisplayShapes,
): ReadonlySet<FeatureId> {
  const grabbable = new Set<FeatureId>();
  for (const area of resolved.shapes) {
    if (area.verdict === DISPLAY_VERDICT.Real) grabbable.add(area.featureId);
  }
  for (const f of features) {
    if (f.kind === FEATURE_KIND.Point || f.kind === FEATURE_KIND.Line) {
      grabbable.add(f.id);
    }
  }
  return grabbable;
}

/**
 * Is this line actually DRAWN this frame — i.e. would the renderer paint it? Mirrors
 * committed-features (all-or-nothing + ≥2 resolved vertices) so what-is-hit ==
 * what-is-drawn: an undrawn line contributes NO grabbable vertex.
 *
 * SINGLE SOURCE (教訓 5.30): both the vertex-owner build (here) and the live hit-test's
 * line-BODY probe (`live-hit-test.ts`, which imports this) decide「描かれる線か」through
 * this ONE predicate, so the draw/hit decision cannot drift.
 *
 *   1. ALL-OR-NOTHING (bughunt 描画とヒットの不一致): committed-features drops the WHOLE
 *      line primitive when ANY vertexId is unresolved (resolvable=false). A line
 *      `[v1, missing, v2]` is NOT drawn, so none of its vertices/segments are hittable.
 *   2. MINIMUM VERTICES (bughunt 1頂点 line は描画されないのに掴める): a line needs ≥2
 *      resolved vertices to be a real polyline (FR-19). The「2頂点未満は描かない」rule is
 *      the SINGLE domain predicate `isDrawableLineVertexCount`.
 */
export function lineFullyResolved(
  vertexIds: readonly VertexId[],
  vertices: VertexStore,
): boolean {
  let resolvedCount = 0;
  for (const vid of vertexIds) {
    if (getVertex(vertices, vid) === undefined) return false;
    resolvedCount += 1;
  }
  return isDrawableLineVertexCount(resolvedCount);
}

/**
 * Collect every committed vertex's OWNING feature (`point.vertexId` / `line.vertexIds`
 * / leaf ring `vertexIds`), but ONLY for features whose ids are in `grabbable`. The
 * first owner encountered wins for a shared vertex — a shared vertex still selects A
 * real owner feature, which is all the U22 contract needs. Aggregates carry no own
 * vertices (their area is derived), so they contribute none even when present.
 *
 * A LINE is additionally all-or-nothing (`lineFullyResolved`): a partially-corrupt
 * line whose render primitive is dropped contributes NO grabbable vertices — its
 * surviving endpoints must not stay selectable while invisible (bughunt 単一真実源:
 * committed-features と同じ全頂点解決チェック).
 *
 * EXPORTED for the live hit-test's per-frame default-control fallback and for tests;
 * production frames read the already-built `owners` off {@link DisplayResolution}.
 */
export function vertexOwners(
  features: readonly Feature[],
  grabbable: ReadonlySet<FeatureId>,
  vertices: VertexStore,
): Map<VertexId, FeatureId> {
  const owners = new Map<VertexId, FeatureId>();
  const claim = (vid: VertexId, fid: FeatureId): void => {
    if (!owners.has(vid)) owners.set(vid, fid);
  };
  for (const f of features) {
    if (!grabbable.has(f.id)) continue;
    switch (f.kind) {
      case FEATURE_KIND.Point:
        claim(f.vertexId, f.id);
        break;
      case FEATURE_KIND.Line:
        // Mirror the renderer's all-or-nothing draw: a line with ANY unresolved
        // vertex is not drawn, so none of its vertices are grabbable.
        if (lineFullyResolved(f.vertexIds, vertices)) {
          for (const vid of f.vertexIds) claim(vid, f.id);
        }
        break;
      case FEATURE_KIND.Leaf:
        for (const ring of f.shape.rings) {
          for (const vid of ring.vertexIds) claim(vid, f.id);
        }
        break;
      default:
        // Aggregate: no own vertices.
        break;
    }
  }
  return owners;
}

/**
 * Drop every memoized bundle. The memo keys on input IDENTITY, so a stale entry can
 * never be served while the store holds new references — this exists ONLY for test
 * isolation (a test that asserts the un-cached recomputation count must start clean).
 */
export function clearDisplayResolutionCache(): void {
  cache.length = 0;
  // Also drop the incremental geometry entries so a test asserting un-cached
  // recomputation / union counts starts from a clean slate.
  geometryCache.entries = new Map();
}
