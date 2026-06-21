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

import { FEATURE_KIND, type Feature } from '../../domain/feature';
import { buildForest, type Forest } from '../../domain/hierarchy/forest';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import type { VertexStore } from '../../domain/vertex';
import type { ResolvedDisplayShapes } from '../../domain/display';
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
  /** The vertex store effective at `time` (U09), the SAME `verticesAt` both paths used. */
  readonly vertices: VertexStore;
  /** The forest over the AREA features (leaf + aggregate) — what `buildForest` builds. */
  readonly forest: Forest;
  /** The U34/U08-resolved display shapes (verdict + geometry) for `displayControl`. */
  readonly resolved: ResolvedDisplayShapes;
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
  const forest = buildForest(areaFeatures);
  const resolved = resolveDisplayControl(forest, vertices, control);
  return { features, vertices, forest, resolved };
}

/**
 * Drop every memoized bundle. The memo keys on input IDENTITY, so a stale entry can
 * never be served while the store holds new references — this exists ONLY for test
 * isolation (a test that asserts the un-cached recomputation count must start clean).
 */
export function clearDisplayResolutionCache(): void {
  cache.length = 0;
}
