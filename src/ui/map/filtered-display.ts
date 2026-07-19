// UI layer (map): the SHARED FR-113 display-filter resolution — one computation
// feeds the draw path, the live hit-test, and (through the drawn set) search
// (教訓 5.29 単一真実源 = 単一 COMPUTATION, 教訓 5.7 部分結線禁止).
//
// WHY THIS FILE EXISTS:
// FR-113 (visibility.ts `resolveFeatureDisplay`) decides, per feature, a single
// display verdict `{ visible, opacity, emphasized }`. The rule of that unit is that
// draw, hit-test and search share the SAME verdict so there is never a「描かれている
// のに選択/検索できない」/「消したのに掴める」対概念矛盾. This module is the ONE place
// the verdict is evaluated for a frame: it takes the shared {@link DisplayResolution}
// the renderer and hit-test already share (display-resolution-cache) plus the session
// {@link FilterState}, and returns the per-feature verdict map + the visible-id set.
// Both consumers read THIS, so the母集合 can never drift.
//
// COMPOSITION WITH FR-42 (ユーザー裁定): the resolution's drawn AREA set
// (`resolved.shapes`) is ALREADY the FR-42 aggregation result (global depth N rolled
// the hierarchy up). FR-113 applies ON TOP of that set — a depth filter M, kind
// toggles, per-feature hide, opacity — to the features FR-42 chose to draw. So a
// leaf folded into an aggregate by FR-42 is never independently un-hidden by FR-113
// (the aggregate is the drawn feature and carries its own depth). Points / lines have
// no rollup and are filtered directly.
//
// ZERO-OVERHEAD DEFAULT (perf 鉄則): the DEFAULT FilterState (全表示・不透明度1.0・
// 強調なし) is INERT — {@link isFilterInert}. On an inert filter this returns `null`
// and NEVER calls `resolveFeatureDisplay` nor the O(n) derived-depth pass, so a frame
// with no active filter pays nothing (722地物・cold 127ms を退行させない). The derived
// depth pass runs ONLY when a depth axis (threshold / emphasized) is actually active
// — otherwise depth is never consulted, so it is not computed (教訓 5.30 二重計算回避:
// FR-42 already ran derivedDepths internally, but only a depth-active filter needs it).
//
// PURITY: reads the resolution + filter, returns fresh collections; mutates nothing.
// A tiny bounded process-local LRU memo (same (resolution, filter) identity ⇒ same
// value) keeps the draw + hit paths of one frame from evaluating the verdict twice.

import { FEATURE_KIND } from '../../domain/feature';
import { derivedDepths, isDepthUndefined } from '../../domain/hierarchy';
import type { Forest } from '../../domain/hierarchy/forest';
import type { FeatureId } from '../../domain/ids';
import {
  isFilterInert,
  resolveFeatureDisplay,
  type FeatureDisplayMeta,
  type FilterState,
  type ResolvedFeatureDisplay,
} from '../discovery/index';

import type { DisplayResolution } from './display-resolution-cache';

// Derived-depth (U08) memo, keyed by the immutable `Forest` reference. `derivedDepths`
// is O(n); a `Forest` is a pure function of the (root, time) generation and is shared by
// the display-resolution cache, so the SAME reference recurs across frames / consumers.
// Memoizing by that reference lets the FR-113 depth axis (computeFilteredDisplay) AND the
// raw-leaf targetability check (isFeatureVisibleUnderFilter) share ONE depth pass per
// generation (教訓 5.30 二重計算回避). A WeakMap GC's the entry with its forest.
const depthsByForest = new WeakMap<Forest, ReadonlyMap<FeatureId, number>>();

/** The derived-depth map for `forest`, memoized by forest identity (shared, see above). */
function depthsFor(forest: Forest): ReadonlyMap<FeatureId, number> {
  const cached = depthsByForest.get(forest);
  if (cached !== undefined) return cached;
  const depths = derivedDepths(forest);
  depthsByForest.set(forest, depths);
  return depths;
}

/** A feature's FR-113 depth: its derived depth, or `null` when undefined/cyclic/absent. */
function depthOf(forest: Forest, id: FeatureId): number | null {
  const d = depthsFor(forest).get(id);
  return d === undefined || isDepthUndefined(d) ? null : d;
}

/**
 * The resolved FR-113 verdicts for one frame's drawn candidates. `displayById` maps
 * EVERY drawn candidate (each `resolved.shapes` area — leaf or aggregate — plus every
 * point / line feature) to its verdict; `visibleIds` is the subset whose `visible` is
 * true — the母集合 the hit-test and search restrict to.
 */
export interface FilteredDisplay {
  /** Per-candidate verdict (visible / opacity / emphasized), keyed by feature id. */
  readonly displayById: ReadonlyMap<FeatureId, ResolvedFeatureDisplay>;
  /** The visible feature ids (the draw / hit / search母集合). */
  readonly visibleIds: ReadonlySet<FeatureId>;
}

/** One memo entry: the two identity keys + the verdicts they produced (null = inert). */
interface CacheEntry {
  readonly resolution: DisplayResolution;
  readonly filter: FilterState;
  readonly value: FilteredDisplay | null;
}

// A tiny bounded LRU keyed by (resolution, filter) IDENTITY. Capacity 4 absorbs the
// only realistic alternation for one generation — the live (resolution, filter) pair
// shared by the draw path AND the hit-test, plus a transient (a slider drag mid-frame,
// a unit test). Both keys are swapped wholesale by the store / memo (never mutated), so
// an identity match is a value match; a stale generation is never queried again.
const CACHE_CAPACITY = 4;
const cache: CacheEntry[] = [];

/**
 * The FR-113 verdicts for `(resolution, filter)`, computed ONCE and shared by the draw
 * path (committed-features) and the live hit-test. Returns `null` when the filter is
 * INERT (the caller then takes its un-filtered fast path — zero overhead). On an
 * identity HIT the cached value is returned verbatim; on a MISS the verdicts are
 * computed and memoized (LRU).
 */
export function resolveFilteredDisplay(
  resolution: DisplayResolution,
  filter: FilterState,
): FilteredDisplay | null {
  for (let i = 0; i < cache.length; i += 1) {
    const entry = cache[i]!;
    if (entry.resolution === resolution && entry.filter === filter) {
      // Promote to most-recently-used (the live pair, hit by both draw + hit-test).
      if (i !== cache.length - 1) {
        cache.splice(i, 1);
        cache.push(entry);
      }
      return entry.value;
    }
  }
  const value = computeFilteredDisplay(resolution, filter);
  cache.push({ resolution, filter, value });
  if (cache.length > CACHE_CAPACITY) cache.shift();
  return value;
}

/**
 * Evaluate the FR-113 verdict for every drawn candidate of `resolution` under
 * `filter` — the EXACT computation {@link resolveFilteredDisplay} memoizes. Returns
 * `null` on an inert filter (complete short-circuit — no per-feature resolution). The
 * derived-depth pass runs ONLY when a depth axis is active (see the module note).
 * Exposed for tests that want the un-cached result.
 */
export function computeFilteredDisplay(
  resolution: DisplayResolution,
  filter: FilterState,
): FilteredDisplay | null {
  if (isFilterInert(filter)) return null;

  const { features, areaFeaturesById, forest, resolved } = resolution;

  // Derived depth (U08) is the SAME single source FR-42 already used; compute it here
  // ONLY when a depth axis is active — an inert-on-depth filter never consults meta.depth
  // (visibility.passesDepth / isEmphasized short-circuit on null thresholds), so we do
  // not pay the O(n) pass otherwise (教訓 5.30 過剰計算の戒め). Shared, forest-keyed memo.
  const needDepth =
    filter.depthThreshold !== null || filter.emphasizedDepth !== null;
  const areaDepth = (id: FeatureId): number | null =>
    needDepth ? depthOf(forest, id) : null;

  const displayById = new Map<FeatureId, ResolvedFeatureDisplay>();
  const visibleIds = new Set<FeatureId>();

  // Areas: the FR-42-aggregated DRAWN shapes (leaf OR aggregate). The kind axis of both
  // is 面情報 (kindAxisOf(leaf|aggregate)=area); the depth is the drawn feature's OWN
  // derived depth. presentAtTime is true — every drawn shape derives from featuresAt.
  for (const shape of resolved.shapes) {
    const source = areaFeaturesById.get(shape.featureId);
    // A resolved shape always has a source area feature; fall back to Leaf (still area
    // axis) defensively so a missing lookup never crashes the frame (教訓 5.18).
    const kind = source !== undefined ? source.kind : FEATURE_KIND.Leaf;
    const meta: FeatureDisplayMeta = {
      id: shape.featureId,
      kind,
      depth: areaDepth(shape.featureId),
    };
    const verdict = resolveFeatureDisplay(filter, meta, true);
    displayById.set(shape.featureId, verdict);
    if (verdict.visible) visibleIds.add(shape.featureId);
  }

  // Points / lines: drawn directly (no hierarchy rollup, no area → depth axis N/A).
  for (const feature of features) {
    if (feature.kind !== FEATURE_KIND.Point && feature.kind !== FEATURE_KIND.Line) {
      continue;
    }
    const meta: FeatureDisplayMeta = {
      id: feature.id,
      kind: feature.kind,
      depth: null,
    };
    const verdict = resolveFeatureDisplay(filter, meta, true);
    displayById.set(feature.id, verdict);
    if (verdict.visible) visibleIds.add(feature.id);
  }

  return { displayById, visibleIds };
}

/**
 * Whether `featureId` is FR-113-VISIBLE — the single verdict every SIDE-PATH that
 * acquires or retains a feature (tool target 取得 F1, selection heal F2, sidebar 一覧 F3)
 * gates on, so「非表示の地物は描画・当たり・検索・一覧・ツール取得・選択のすべてから一貫して
 * 消える」holds (Codex 整合性ギャップ, 教訓 5.29 単一解決).
 *
 * It layers FR-113 on the RAW feature, INDEPENDENT of FR-42 aggregation:
 *   - a feature that IS drawn (point / line / verdict-Real area) reuses the SAME
 *     {@link resolveFilteredDisplay} verdict the renderer / hit-test read (no drift);
 *   - a feature NOT in the drawn母集合 — an FR-42 aggregation-OMITTED leaf — is judged on
 *     its OWN kind + derived depth via the SAME `resolveFeatureDisplay`, so 種別オフ /
 *     個別非表示 / 深度フィルタ hide it while an aggregated-but-not-FR-113-hidden leaf STAYS
 *     visible-for-tools (raw-leaf semantics preserved: merge/reparent/ring/drill must still
 *     target a child inside an aggregate at N=0 — HB3-16 — as long as it is not FR-113 hidden).
 *
 * Inert filter ⇒ always visible (zero overhead). A feature absent from the current
 * generation ⇒ not visible (教訓 5.18 明示的空).
 */
export function isFeatureVisibleUnderFilter(
  resolution: DisplayResolution,
  filter: FilterState,
  featureId: FeatureId,
): boolean {
  if (isFilterInert(filter)) return true;
  // Drawn feature → reuse its verdict (the single judgment shared with draw / hit).
  const filtered = resolveFilteredDisplay(resolution, filter);
  if (filtered !== null) {
    const drawn = filtered.displayById.get(featureId);
    if (drawn !== undefined) return drawn.visible;
  }
  // Not drawn (aggregation-omitted leaf) → evaluate FR-113 on the RAW feature.
  const feature =
    resolution.areaFeaturesById.get(featureId) ??
    resolution.features.find((f) => f.id === featureId);
  if (feature === undefined) return false;
  const needDepth =
    filter.depthThreshold !== null || filter.emphasizedDepth !== null;
  const depth = needDepth ? depthOf(resolution.forest, featureId) : null;
  return resolveFeatureDisplay(
    filter,
    { id: featureId, kind: feature.kind, depth },
    true,
  ).visible;
}

/**
 * Drop every memoized verdict set. The memo keys on input IDENTITY, so a stale entry
 * can never be served while the store holds new references — this exists ONLY for test
 * isolation (a test that asserts un-cached recomputation must start clean).
 */
export function clearFilteredDisplayCache(): void {
  cache.length = 0;
}
