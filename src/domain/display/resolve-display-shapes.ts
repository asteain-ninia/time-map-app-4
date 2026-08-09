// U34 → U08 → U19 shape-resolution adapter (受け入れ基準5, 教訓5.29 / 5.1 / 5.33).
//
// THE CONTRACT SEAM. U34's `buildDisplayDecisions` only SELECTS, per feature, a
// verdict and (when Aggregate) the roll-up target feature whose 集約形状 should be
// drawn. It never carries geometry. Left there, that selection is a dead output:
// the consumer (U19 / feature-layer) would have to re-derive which feature to
// round to and re-resolve its shape on its own, and the two judgements could
// drift (the very ドリフト 教訓5.29 forbids — 描画/ヒットテスト/ラベル の形状が
// U34 の丸め判定 と食い違う).
//
// This module closes that gap with ONE rule: for every drawable Aggregate
// decision, the geometry is `resolveFeatureArea(forest, store, rollUpTargetId)` —
// U08's SINGLE derived-shape resolution (下位領域の和). For a drawable Real
// decision the geometry is that feature's OWN resolved area (still through the
// same `resolveFeatureArea`, so leaf own-shape and aggregate union flow through
// ONE source). Omitted decisions produce nothing (受け入れ基準1: 省略は描画指示に
// 現れない). The result is the exact `GeoMultiPolygon` U19 fills / hit-tests /
// labels, so "U34 が選んだ丸め先" と "U19 が描く形状" は同一由来で固定される。
//
// We never union or invent geometry here (spec §やらないこと) — `resolveFeatureArea`
// is the only geometry source, and 飛び地（複数片）は片落とししない (教訓5.1) because
// we hand the resolution's `area` through verbatim, never collapsing pieces.
//
// PURITY (受け入れ基準6): reads forest + decisions + vertex store, returns a fresh
// list, mutates nothing.

import { FEATURE_KIND, type Feature, type LeafFeature } from '../feature';
import { alignMultiPolygon } from '../geo/seam';
import type { GeoMultiPolygon } from '../geometry/types';
import { resolveFeatureArea, type ShapeResolutionFailure } from '../hierarchy/resolve-shape';
import { descendantIds, type Forest } from '../hierarchy/forest';
import type { FeatureId, VertexId } from '../ids';
import { getVertex, type Vertex, type VertexStore } from '../vertex';

import {
  DISPLAY_VERDICT,
  type DisplayDecision,
  type DisplayDecisionMap,
} from './depth-focus';

/**
 * One resolved drawable: a display decision joined to the geometry U19 must use.
 * `geometrySourceId` records WHICH feature's U08 resolution produced `shape`:
 *   - Aggregate → the `rollUpTargetId` U34 chose (the feature it rounded to);
 *   - Real      → the feature itself (its own resolved area).
 * That id is the single proof that 描画形状 と U34 の丸め判定 are the same source
 * (教訓5.29). `shape` is whatever `resolveFeatureArea` returned, pieces intact.
 */
export interface ResolvedDisplayShape {
  readonly featureId: FeatureId;
  readonly verdict: typeof DISPLAY_VERDICT.Real | typeof DISPLAY_VERDICT.Aggregate;
  /** The feature whose U08 resolution produced `shape` (roll-up target / self). */
  readonly geometrySourceId: FeatureId;
  /**
   * The SINGLE U08-resolved geometry, all pieces kept (教訓5.1), with every ring
   * longitude-UNWRAPPED into a continuous run (U05 `unwrapRing`) so a seam-crossing
   * area draws / hit-tests the short way, never the false ~358° span (see
   * `unwrapShape`; parity with the line path in committed-features.ts).
   */
  readonly shape: GeoMultiPolygon;
  readonly emphasized: boolean;
}

/**
 * A decision whose U08 resolution failed (missing vertex / missing child /
 * rejected union). Surfaced as data, never thrown (教訓5.26), so the caller can
 * decide whether to skip the feature or report it; the drawable list simply omits
 * a feature whose geometry could not be resolved.
 */
export interface ResolvedDisplayFailure {
  readonly featureId: FeatureId;
  readonly geometrySourceId: FeatureId;
  readonly reason: ShapeResolutionFailure;
}

/** The outcome of resolving every drawable decision (受け入れ基準5). */
export interface ResolvedDisplayShapes {
  /** Drawable features with their U08-resolved geometry, in decision order. */
  readonly shapes: readonly ResolvedDisplayShape[];
  /** Drawable features whose U08 resolution failed (omitted from `shapes`). */
  readonly failures: readonly ResolvedDisplayFailure[];
}

/**
 * The feature whose U08 derived shape backs a decision: the roll-up target for an
 * Aggregate (the feature U34 rounded to), or the feature itself for a Real. This
 * is the ONE place the "which feature's geometry" question is answered, so U19 can
 * never pick a different source than U34 selected (教訓5.29 規約固定).
 */
export function geometrySourceFor(decision: DisplayDecision): FeatureId {
  return decision.verdict === DISPLAY_VERDICT.Aggregate
    ? decision.rollUpTargetId ?? decision.featureId
    : decision.featureId;
}

/**
 * Longitude-unwrap every ring of a resolved area into a CONTINUOUS run (U05's
 * `unwrapRing`, which delegates to U04's single ±360° turn-counting source).
 *
 * WHY (seam parity with the LINE path — HB-14 / FR-07 / 技術方針 R3 単一真実源):
 * a feature straddling the antimeridian is stored with FOLDED representatives
 * (e.g. lon 179 next to lon -179). U03's `WorldCoordinate` is a continuous scalar
 * that may already lie outside [-180,180) but is NOT guaranteed to be unwrapped.
 * U08's `resolveFeatureArea` resolves rings from RAW vertex coordinates with zero
 * seam handling, so a seam-crossing ring can come back with a ~358° longitude
 * span. The render layer's continuous-longitude contract (feature-layer +
 * canvas2d-renderer `primitiveLonSpan`, and the hit-test `multiPolygonLonSpan`)
 * then tiles ±360° wrap replicas off that FALSE span — painting / hit-testing the
 * polygon "the long way round" across the whole map. The LINE path already guards
 * exactly this case via `unwrapLonSequence` (committed-features.ts); the AREA path
 * did not. Unwrapping here — the ONE node both the renderer
 * (committed-features → buildDisplayAreas) and the hit-test
 * (live-hit-test → drawnAreas) consume — closes the asymmetry at a single source,
 * so draw and hit-test stay byte-for-byte consistent (教訓5.29). Per-ring unwrap
 * keeps each contiguous ring continuous without merging pieces (教訓5.1 飛び地保持).
 * The union math upstream is untouched (it still operates on raw representatives);
 * we only make the FINAL drawn/hit geometry continuous, exactly as the line path
 * unwraps its final points.
 *
 * PER-POLYGON ALIGNMENT (audit root cause A — H4 / M7 / M11 / L11): a plain
 * independent per-ring unwrap anchors EACH ring to its OWN first vertex, so a
 * seam-crossing outer ring and a hole (or enclave) whose vertex list starts on the
 * opposite seam side land ~360° apart even though they coincide geometrically — the
 * hole then punches at a false position one world-turn away and 穴透過 breaks, the
 * renderer/hit-test tile off a ~358° span, and the label centroid drifts. We funnel
 * through {@link alignMultiPolygon} (the single cross-ring alignment source of
 * truth) so every ring of a polygon piece is unwrapped AND shifted onto its own
 * outer ring's common world turn. 飛び地は片落とししない (教訓5.1): pieces are kept
 * intact; each PIECE is anchored to ITS OWN outer ring (alignMultiPolygon uses the
 * first piece's outer as the default reference, so we align per polygon piece to
 * keep disjoint enclaves on their own natural branch rather than forcing them onto
 * one global turn).
 */
function unwrapShape(shape: GeoMultiPolygon): GeoMultiPolygon {
  // Align each polygon piece independently: a piece's outer ring is the reference
  // for its own holes, so a hole sharing the outer's turn is correct, while a
  // separate enclave piece keeps its own natural branch (no false global merge).
  return shape.map((polygon) => alignMultiPolygon([polygon])[0]!);
}

// --- incremental geometry-resolution cache (bughunt3) -----------------------
//
// WHY THIS EXISTS: `resolveDisplayShapes` runs once per display-pipeline call, and
// for every drawable AGGREGATE it asks U08's `resolveFeatureArea` for that node's
// 集約形状 — a full explicit-stack post-order boolean UNION of every descendant's
// resolved area, leaves first. That union work is the dominant cost of a deep,
// wide hierarchy (the spec's 5,000-object scale, nested 10 levels). The shared
// display-resolution memo (ui/map/display-resolution-cache.ts) only short-circuits
// when (root, time, displayControl) are ALL reference-identical, so a single slider
// tick — which swaps `displayControl` to a NEW object while `forest` / vertices are
// byte-identical — misses that memo and re-derives the ENTIRE union tree from the
// leaves, even though not one polygon changed (bughunt3 finding).
//
// THE FIX (the SAME proven pattern as spatial/terminals.ts): hold ONE cache across
// pipeline runs and key each resolved geometry by its `geometrySourceId`. A cached
// entry is reused iff every input that feeds that node's U08 resolution is
// reference-identical to when it was resolved:
//   - the exact ORDERED set of subtree feature ids (so a structural edit — a child
//     added / removed / re-parented — invalidates: the union has different operands);
//   - the exact feature OBJECT for the source and every descendant (an edit to any
//     leaf's shape produces a NEW feature object → reference change → re-resolve);
//   - the exact vertex OBJECT for every vertex any of those features reference (a
//     moved vertex is a new object → re-resolve).
// This is correctness-safe for the identical reason the terminal cache is: features
// and vertices are IMMUTABLE value objects with structural sharing (U16 swaps a new
// object ONLY for what an edit touched), so reference identity of the whole subtree
// snapshot is a proof the resolved geometry is unchanged. A slider tick (forest /
// vertices untouched) becomes O(drawable) hash lookups with ZERO boolean-union work
// instead of a full bottom-up re-union. A real geometry / structure edit is an
// identity miss and re-resolves identically, so the result is never stale.

/**
 * One cached geometry resolution: the inputs (by reference identity) the resolved
 * `shape` was derived from. `shape` is the UNWRAPPED `GeoMultiPolygon` ready to hand
 * to U19 (so a hit reuses the final drawn geometry, not just the raw union), or a
 * `failure` reason when the source could not be resolved (re-used so a re-run does
 * not re-attempt a known-failing resolution).
 */
interface GeometryCacheEntry {
  /** Source feature object + every descendant feature object, by id. */
  readonly featureRefs: ReadonlyMap<FeatureId, Feature>;
  /** Every vertex object any of those features reference, by id. */
  readonly vertexRefs: ReadonlyMap<VertexId, Vertex>;
  /** The unwrapped resolved geometry, or undefined when resolution failed. */
  readonly shape: GeoMultiPolygon | undefined;
  /** The failure reason when `shape` is undefined (surfaced as data, 教訓5.26). */
  readonly failure: ShapeResolutionFailure | undefined;
}

/**
 * An incremental cache for {@link resolveDisplayShapes}. Hold ONE instance across
 * display-pipeline runs (e.g. on the shared display-resolution memo) and pass it on
 * every call: a drawable whose source feature, whole subtree structure, and every
 * referenced vertex are reference-identical to the prior run reuses its resolved
 * (and seam-unwrapped) geometry and skips the U08 boolean-union entirely. Mutated in
 * place by `resolveDisplayShapes`; never share one across unrelated domains.
 *
 * WHOLE-CACHE FAST PATH (bughunt3 — the snapshot walk itself was not cached): the
 * per-entry validity check rebuilds each source's full subtree snapshot via
 * `descendantIds` (an O(subtree) DFS) PLUS a fresh vertex scan, just to compare it by
 * reference. On a slider tick — where the U16 store swaps only `displayControl` and
 * hands the SAME `forest` / `store` objects (both pure functions of the unchanged
 * domain+time) to the pipeline — that meant every cache HIT still paid an O(k·n)
 * re-walk of every aggregate's subtree even though not one input changed, negating
 * much of the union-skip benefit. We therefore record the `forest` and `store` the
 * entries were resolved against: when the next run hands back the IDENTICAL pair, the
 * entire input space of every entry is provably unchanged (forest/store are derived
 * purely from immutable feature/vertex value objects), so every carried-over entry is
 * valid with ZERO per-entry snapshot work. Only when `forest` / `store` actually
 * differ do we fall back to the per-source subtree-snapshot validation.
 */
export interface DisplayShapeCache {
  entries: Map<FeatureId, GeometryCacheEntry>;
  /** The `forest` the current `entries` were resolved against (whole-cache fast path). */
  forest: Forest | undefined;
  /** The `store` the current `entries` were resolved against (whole-cache fast path). */
  store: VertexStore | undefined;
}

/**
 * Upper bound on retained geometry entries. Entries are cheap references to already
 * -resolved shapes; the cap exists only so a long session with many distinct roll-up
 * targets cannot grow the map without limit. Well above any real project's area count.
 */
export const GEOMETRY_CACHE_CAPACITY = 4096;

/** Create an empty {@link DisplayShapeCache}. */
export function createDisplayShapeCache(): DisplayShapeCache {
  return { entries: new Map(), forest: undefined, store: undefined };
}

/** The vertex objects a leaf references through its shape rings (by id). */
function collectLeafVertexRefs(
  feature: Feature,
  store: VertexStore,
  into: Map<VertexId, Vertex>,
): void {
  if (feature.kind !== FEATURE_KIND.Leaf) return;
  for (const ring of (feature as LeafFeature).shape.rings) {
    for (const vid of ring.vertexIds) {
      const vertex = getVertex(store, vid);
      // A missing vertex is recorded as absent; validity re-checks the same store,
      // so an unresolvable source stays unresolvable unless the vertex appears.
      if (vertex !== undefined) into.set(vid, vertex);
    }
  }
}

/**
 * Snapshot every input `geometrySourceId`'s U08 resolution depends on, by reference:
 * the source feature + all its descendants (the union operands), and every vertex
 * those features reference. Returns undefined when the source itself is absent from
 * the forest (a stale roll-up target — the caller falls back to a fresh resolution
 * which will surface the MissingChild failure).
 */
function snapshotInputs(
  forest: Forest,
  store: VertexStore,
  geometrySourceId: FeatureId,
): { featureRefs: Map<FeatureId, Feature>; vertexRefs: Map<VertexId, Vertex> } | undefined {
  const source = forest.byId.get(geometrySourceId);
  if (source === undefined) return undefined;
  const featureRefs = new Map<FeatureId, Feature>();
  const vertexRefs = new Map<VertexId, Vertex>();
  featureRefs.set(geometrySourceId, source);
  collectLeafVertexRefs(source, store, vertexRefs);
  // descendantIds is cycle-safe (教訓5.28): a broken/cyclic subtree yields a finite
  // id set, matching exactly the nodes resolveFeatureArea's visited-set would touch.
  for (const id of descendantIds(forest, geometrySourceId)) {
    const f = forest.byId.get(id);
    if (f === undefined) continue;
    featureRefs.set(id, f);
    collectLeafVertexRefs(f, store, vertexRefs);
  }
  return { featureRefs, vertexRefs };
}

/**
 * Is a cached entry still valid for the current forest + store? Valid iff the
 * snapshot of subtree feature objects and referenced vertex objects is reference-
 * identical to the cached one (same size, same object per id) — i.e. nothing the
 * node's U08 resolution reads has changed. Any add / remove / re-parent / edited
 * shape / moved vertex is a reference change and fails this check.
 */
function geometryEntryStillValid(
  entry: GeometryCacheEntry,
  snapshot: { featureRefs: Map<FeatureId, Feature>; vertexRefs: Map<VertexId, Vertex> },
): boolean {
  if (entry.featureRefs.size !== snapshot.featureRefs.size) return false;
  if (entry.vertexRefs.size !== snapshot.vertexRefs.size) return false;
  for (const [id, f] of snapshot.featureRefs) {
    if (entry.featureRefs.get(id) !== f) return false;
  }
  for (const [vid, v] of snapshot.vertexRefs) {
    if (entry.vertexRefs.get(vid) !== v) return false;
  }
  return true;
}

/**
 * Resolve every DRAWABLE decision's geometry through U08's single resolution.
 * Omitted decisions are dropped (受け入れ基準1). For each remaining decision the
 * geometry is `resolveFeatureArea(forest, store, geometrySourceFor(decision))` —
 * the SAME resolution that drives draw / hit-test / label downstream — and the
 * returned `area` is handed through unchanged so 複数片（飛び地）が全反映される
 * (教訓5.1). Pure: builds and returns fresh arrays; no input is mutated.
 *
 * Pass an optional {@link DisplayShapeCache} (held across pipeline runs) to make the
 * geometry resolution INCREMENTAL (bughunt3): a drawable whose source feature,
 * subtree structure, and referenced vertices are all reference-identical to the prior
 * run reuses its resolved geometry and skips the full boolean-union entirely. The
 * cache is correctness-safe (features / vertices are immutable value objects with
 * structural sharing) and produces byte-for-byte the same output as an un-cached run.
 */
export function resolveDisplayShapes(
  forest: Forest,
  store: VertexStore,
  decisions: DisplayDecisionMap,
  cache?: DisplayShapeCache,
): ResolvedDisplayShapes {
  const shapes: ResolvedDisplayShape[] = [];
  const failures: ResolvedDisplayFailure[] = [];
  // A fresh entry map per run: a drawable that vanished this run drops out (no stale
  // geometry retained), survivors keep their reused-or-fresh entry. Note the cache is
  // keyed by geometrySourceId, so two decisions rolling up to the SAME target resolve
  // its geometry once and the second reuses the just-built entry.
  const nextEntries = cache !== undefined ? new Map<FeatureId, GeometryCacheEntry>() : undefined;
  // WHOLE-CACHE FAST PATH (bughunt3): when the prior run resolved against the IDENTICAL
  // forest + store, every input feeding every entry is provably unchanged, so a carried
  // -over entry is valid WITHOUT rebuilding its subtree snapshot (no per-entry
  // descendantIds walk). Only when forest / store differ do we validate per source.
  const inputsUnchanged =
    cache !== undefined && cache.forest === forest && cache.store === store;

  for (const [, decision] of decisions) {
    if (decision.verdict === DISPLAY_VERDICT.Omitted) continue;

    const geometrySourceId = geometrySourceFor(decision);

    if (cache !== undefined && nextEntries !== undefined) {
      // Reuse an entry already built THIS run (a shared roll-up target), else a
      // still-valid entry carried over from a prior run; otherwise resolve fresh.
      let entry = nextEntries.get(geometrySourceId);
      if (entry === undefined) {
        const prior = cache.entries.get(geometrySourceId);
        if (inputsUnchanged && prior !== undefined) {
          // forest + store are reference-identical to when `prior` was resolved, so its
          // whole subtree (feature objects) and referenced vertices are unchanged — reuse
          // it directly, skipping the snapshot DFS the validity check would otherwise run.
          entry = prior;
        } else {
          // forest or store changed (a structural / geometry edit, or a fresh cache):
          // build the subtree snapshot and validate the prior entry against it by
          // reference identity, re-resolving only on a genuine miss.
          const snapshot = snapshotInputs(forest, store, geometrySourceId);
          if (prior !== undefined && snapshot !== undefined && geometryEntryStillValid(prior, snapshot)) {
            entry = prior;
          } else {
            entry = resolveGeometryEntry(forest, store, geometrySourceId, snapshot);
          }
        }
        nextEntries.set(geometrySourceId, entry);
      }
      if (entry.shape === undefined) {
        failures.push({
          featureId: decision.featureId,
          geometrySourceId,
          reason: entry.failure!,
        });
        continue;
      }
      shapes.push({
        featureId: decision.featureId,
        verdict: decision.verdict,
        geometrySourceId,
        shape: entry.shape,
        emphasized: decision.emphasized,
      });
      continue;
    }

    const resolution = resolveFeatureArea(forest, store, geometrySourceId);
    if (resolution.status === 'failed') {
      failures.push({
        featureId: decision.featureId,
        geometrySourceId,
        reason: resolution.reason,
      });
      continue;
    }
    shapes.push({
      featureId: decision.featureId,
      verdict: decision.verdict,
      geometrySourceId,
      // Seam-unwrapped so a ring crossing the antimeridian is a CONTINUOUS run,
      // not folded representatives that span ~358° (parity with the line path —
      // see unwrapShape). 飛び地は片落とししない (教訓5.1): each ring is unwrapped
      // independently; no piece is merged or dropped.
      shape: unwrapShape(resolution.area),
      emphasized: decision.emphasized,
    });
  }

  if (cache !== undefined && nextEntries !== undefined) {
    // RETAIN entries this run did not need, up to {@link GEOMETRY_CACHE_CAPACITY}
    // (実データ由来の実測): dropping them made the EXPENSIVE aggregate unions
    // (デーレ共和国 = 63 子の和で約 2.4 秒) evaporate the moment the user raised the
    // 階層深度 slider — at depth ≥ 1 an expanded aggregate is Omitted, so its entry
    // vanished, and coming back (or moving the timeline afterwards) paid the whole
    // union again. Retention is SAFE because validity never rested on "was it used
    // last run": a carried-over entry is either covered by the whole-cache fast path
    // (identical forest+store) or re-validated per source against a fresh subtree
    // snapshot. Capacity keeps the map bounded on a long session.
    if (nextEntries.size < GEOMETRY_CACHE_CAPACITY) {
      for (const [sourceId, entry] of cache.entries) {
        if (nextEntries.size >= GEOMETRY_CACHE_CAPACITY) break;
        if (!nextEntries.has(sourceId)) nextEntries.set(sourceId, entry);
      }
    }
    cache.entries = nextEntries;
    // Record the forest + store these entries were resolved against so the NEXT run can
    // take the whole-cache fast path when it hands back the identical pair (bughunt3).
    cache.forest = forest;
    cache.store = store;
  }
  return { shapes, failures };
}

/**
 * Resolve one geometry source fresh and package it as a {@link GeometryCacheEntry}
 * (snapshot + unwrapped shape, or the failure reason). The cached `shape` is the
 * SAME `unwrapShape(resolution.area)` the un-cached path produces, so a cache HIT
 * yields byte-for-byte what the un-cached run would (no behaviour change).
 */
function resolveGeometryEntry(
  forest: Forest,
  store: VertexStore,
  geometrySourceId: FeatureId,
  snapshot: { featureRefs: Map<FeatureId, Feature>; vertexRefs: Map<VertexId, Vertex> } | undefined,
): GeometryCacheEntry {
  // A snapshot is always available when the source resolves; when it is undefined the
  // source is absent from the forest and resolveFeatureArea returns a MissingChild
  // failure, which we record with empty ref maps so a re-run re-attempts it.
  const refs = snapshot ?? { featureRefs: new Map(), vertexRefs: new Map() };
  const resolution = resolveFeatureArea(forest, store, geometrySourceId);
  if (resolution.status === 'failed') {
    return {
      featureRefs: refs.featureRefs,
      vertexRefs: refs.vertexRefs,
      shape: undefined,
      failure: resolution.reason,
    };
  }
  return {
    featureRefs: refs.featureRefs,
    vertexRefs: refs.vertexRefs,
    shape: unwrapShape(resolution.area),
    failure: undefined,
  };
}
