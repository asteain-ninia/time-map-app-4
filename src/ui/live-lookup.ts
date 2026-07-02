// UI layer — live domain-lookup helpers over the committed DomainProject root.
//
// WHY THIS FILE EXISTS (single truth source, 教訓 5.29):
// Several composition-root seams need "the features / vertices effective at the
// current time" and "which leaf is under this world point" computed against the
// LIVE domain root: the U13 consistency binding (spatial detection /
// resolution write-back) and the U26 knife domain-lookup ports
// (resolveFeature / resolveStore / featureAtPoint). Computing those in two
// places would create a二重真実源 that could drift (e.g. the binding resolves a
// feature the hit-test cannot find). This module owns the rule ONCE; both seams
// import it. It is pure (no React, no store) — callers pass the root + time.

import { resolveAt } from '../domain/anchor-series';
import type { Feature, LeafFeature } from '../domain/feature';
import { FEATURE_KIND } from '../domain/feature';
import type { FeatureId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import { getCalendar, type Calendar } from '../domain/time/calendar';
import {
  complete,
  completeEquals,
  type CompleteTimePoint,
  type TimePoint,
} from '../domain/time/time-point';
import { createVertexStore, type Vertex, type VertexStore } from '../domain/vertex';
import { resolveLeafShape } from '../domain/hierarchy/resolve-shape';
import { alignMultiPolygon } from '../domain/geo/seam';
import { pointInPolygon, POINT_LOCATION } from '../domain/geometry/predicates';
import type { WorldCoordinate } from '../domain/coordinate';

/** The active calendar (gregorian — matches the rest of the composite). */
const calendar: Calendar = getCalendar('gregorian');

// --- (root, time) resolution memo (第13波 Fix A — HIGH perf) -----------------
//
// WHY (教訓 5.29 单一真实源 = 单一 COMPUTATION): this module IS the single
// resolution source for「その時刻に効いている地物 / 頂点」— the renderer, the
// hit-test, the U13 binding, the knife/merge/reparent ports, AND (through the
// injected existence port) the U22 time-change re-validation all funnel here.
//
// A single time-change tick (`setCurrentTime`) re-validates the selection by
// calling the existence port ONCE per selected vertex plus once per selected
// feature — K calls — and every one funnels through `featuresAt` / `verticesAt`.
// Un-memoized, each of those K calls re-`resolveAt`-ed EVERY history and rebuilt
// an O(V_total) `VertexStore` Map only to answer a single `.has()`, then threw it
// away: `setCurrentTime` cost O(K·V_total) per tick and froze scrub / playback at
// the NFR-5.2 scale (≈5000 features → V_total≈6500; K=300 measured ≈272ms/tick,
// past the 100ms playback budget).
//
// The fix keys the resolution by (root IDENTITY, time VALUE) — the SAME keying
// `slide-snap-neighbours`'s per-drag memo already uses. The K repeat calls of one
// tick collapse into ONE build (O(K + V_total)), and every consumer at that
// (root, time) generation shares the SAME `Feature[]` / `VertexStore` instance.
//
// CORRECTNESS — never stale:
//   • `root` is the committed `DomainProject` reference. U16 swaps a NEW root
//     object on ANY edit (immutable value objects + structural sharing), so a
//     reference change invalidates the memo and the next call rebuilds against
//     the edited domain.
//   • `time` is compared by VALUE (`complete` + `completeEquals`): the same
//     resolved year/month/day resolves the same snapshot via `resolveAt`, and a
//     fresh-but-value-equal `TimePoint` (setCurrentTime allocates one each tick)
//     still HITS. A granularity/date change is a value change and rebuilds.
// So a HIT is only ever served when `resolveAt` would have produced the identical
// result — a pure-function memo, not a second truth source.
//
// READ-ONLY SHARING: the shared results are treated as read-only by every caller
// (verified by grep — all iterate / `.some` / `.find` / `.filter` / `.map` / build
// a NEW Map / call the pure `getVertex`/`hasVertex` lookups; none mutate). The
// `VertexStore` is itself immutable (every write helper returns a new store), and
// `Feature`s are immutable value objects. Sharing one instance is therefore safe.
//
// A tiny bounded LRU (capacity 2, mirroring `display-resolution-cache`): the live
// store holds ONE current (root, time) generation queried by every consumer, with
// at most an occasional interleave (a test / a transient second time). Stale
// generations are never re-queried (the store swaps forward), so a larger cache
// would only retain memory.
const LOOKUP_CACHE_CAPACITY = 2;

interface LookupEntry<T> {
  readonly root: DomainProject;
  readonly time: CompleteTimePoint;
  readonly value: T;
}

/**
 * A bounded (root-identity, time-value) LRU over a pure resolver. On a HIT the
 * SAME instance is returned (so a tick's K repeat calls share one build); on a
 * MISS the resolver runs and the result is memoized. Not stale: a root reference
 * swap or a time value change misses and rebuilds (see the module note above).
 */
function createLookupMemo<T>(
  resolve: (root: DomainProject, time: TimePoint) => T,
): {
  lookup: (root: DomainProject, time: TimePoint) => T;
  clear: () => void;
} {
  const cache: LookupEntry<T>[] = [];
  return {
    lookup(root, time) {
      const completed = complete(time);
      for (let i = 0; i < cache.length; i += 1) {
        const entry = cache[i]!;
        if (entry.root === root && completeEquals(entry.time, completed)) {
          // Promote to most-recently-used so the live generation is last evicted.
          if (i !== cache.length - 1) {
            cache.splice(i, 1);
            cache.push(entry);
          }
          return entry.value;
        }
      }
      const value = resolve(root, time);
      cache.push({ root, time: completed, value });
      if (cache.length > LOOKUP_CACHE_CAPACITY) cache.shift();
      return value;
    },
    clear() {
      cache.length = 0;
    },
  };
}

/** The UN-cached feature resolution — the pure body wrapped by the memo below. */
function resolveFeaturesAt(root: DomainProject, time: TimePoint): Feature[] {
  const out: Feature[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const f of resolution.entry.anchor.snapshot.features) out.push(f);
  }
  return out;
}

/** The UN-cached vertex-store resolution — the pure body wrapped by the memo below. */
function resolveVerticesAt(root: DomainProject, time: TimePoint): VertexStore {
  const all: Vertex[] = [];
  for (const history of root.histories) {
    const resolution = resolveAt(history.series, time, calendar);
    if (resolution.kind !== 'present') continue;
    for (const v of resolution.entry.anchor.snapshot.vertices.byId.values()) all.push(v);
  }
  return createVertexStore(all);
}

const featuresMemo = createLookupMemo(resolveFeaturesAt);
const verticesMemo = createLookupMemo(resolveVerticesAt);

/**
 * Every feature effective at `time` across all histories (U09 resolveAt). The
 * union of each present anchor's snapshot features.
 *
 * Memoized by (root identity, time value): a repeated call at the same generation
 * returns the SAME array instance (see the module note — collapses a tick's K
 * existence-port calls into one build; never stale). The result is READ-ONLY.
 */
export function featuresAt(root: DomainProject, time: TimePoint): Feature[] {
  return featuresMemo.lookup(root, time);
}

/**
 * The vertex store effective at `time` (union of every present anchor's store).
 *
 * Memoized by (root identity, time value): a repeated call at the same generation
 * returns the SAME `VertexStore` instance (see the module note). The store is
 * immutable, so sharing it is safe; the result is READ-ONLY.
 */
export function verticesAt(root: DomainProject, time: TimePoint): VertexStore {
  return verticesMemo.lookup(root, time);
}

/**
 * Drop the (root, time) resolution memos. The memo keys on input IDENTITY / VALUE,
 * so a stale entry can never be served while the live store holds a new root — this
 * exists ONLY for test isolation (a test that asserts build-vs-hit reference
 * behaviour must start from a clean slate).
 */
export function clearLiveLookupCache(): void {
  featuresMemo.clear();
  verticesMemo.clear();
}

/**
 * Resolve a single feature by id at `time` (the knife `resolveFeature` port).
 * Returns `undefined` when no feature with that id is effective at the time.
 */
export function featureByIdAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): Feature | undefined {
  return featuresAt(root, time).find((f) => f.id === featureId);
}

/**
 * Hit-test a world point against the LEAF features effective at `time`, returning
 * the id of the topmost leaf whose resolved shape contains the point, else null
 * (the knife `featureAtPoint` port). Only leaf features are split targets
 * (FR-44 / 教訓 5.25), so aggregates / points / lines are skipped here — the
 * geometry path never sees a non-leaf. The domain `pointInPolygon` predicate is
 * the single containment rule (穴透過 honoured); a point on a hole edge or inside
 * a hole is NOT a hit.
 *
 * Iteration order: later histories win on overlap (drawn-on-top wins), matching
 * the paint order; a tie is rare because terminal overlaps are conflicts.
 */
export function leafAtPoint(
  root: DomainProject,
  time: TimePoint,
  point: WorldCoordinate,
): FeatureId | null {
  const vertices = verticesAt(root, time);
  const leaves: LeafFeature[] = featuresAt(root, time).filter(
    (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf,
  );
  // The renderer draws each polygon at its canonical longitude AND at ±360°
  // replicas (a polygon spanning the antimeridian, e.g. 179..181, is shown wrapped
  // as a −179.5 replica). The hit-test must agree with what the user sees, so we
  // probe the click point in each ±360° longitude frame as well as the canonical
  // one. Testing the POINT at ±360 (rather than re-wrapping every polygon) covers
  // every replica with the same containment rule (穴透過 honoured). 単一真実源.
  const probes: WorldCoordinate[] = [
    point,
    { lon: point.lon + 360, lat: point.lat },
    { lon: point.lon - 360, lat: point.lat },
  ];
  let hit: FeatureId | null = null;
  for (const leaf of leaves) {
    const shape = resolveLeafShape(leaf.shape, vertices);
    if (shape === undefined) continue;
    const inside = shape.some((polygon) =>
      probes.some((p) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside),
    );
    if (inside) hit = leaf.id; // keep scanning; a later leaf on top wins
  }
  return hit;
}

/**
 * The resolved multipolygon shape of the leaf `featureId` at `time`, for the knife /
 * merge / reparent target emphasis (App.tsx `useKnifeTargetShape`, the merge /
 * reparent `resolveLeafShape` props), or undefined when it is absent / not a leaf.
 *
 * SEAM CONTINUITY (bughunt #12 Fix B — 単一真実源, 技術方針 R3): `resolveLeafShape`
 * returns RAW stored representatives, so a leaf straddling the antimeridian comes back
 * with FOLDED longitudes (e.g. a ring [170, -170, -170, 170]). The renderer's
 * `primitiveLonSpan` then measures a naive ~340° span for that emphasis `shape`
 * primitive and tiles it as a near-full-width (~358°) band across the whole map — a
 * drift from the CONFIRMED area, whose display path (resolve-display-shapes'
 * `unwrapShape`) already funnels each polygon piece through `alignMultiPolygon` to make
 * every ring a CONTINUOUS run. We pass the resolved shape through the SAME per-piece
 * alignment here so all three tools' target emphasis is a continuous short-way run that
 * matches the committed geometry exactly (same align source). A non-seam
 * (single-branch) leaf is unchanged: the closed unwrap is the identity and the anchor
 * adds 0 turns, so the common case is byte-for-byte as before. `leafAtPoint` above is
 * unaffected — it already probes the click point at ±360° replicas.
 *
 * Per-PIECE alignment (parity with `unwrapShape`): each polygon piece is aligned to its
 * OWN outer ring's branch so a disjoint enclave keeps its natural branch and 飛び地は
 * 片落とししない (教訓 5.1) — pieces are neither merged nor dropped.
 */
export function leafShapeAt(
  root: DomainProject,
  time: TimePoint,
  featureId: FeatureId,
): ReturnType<typeof resolveLeafShape> {
  const feature = featureByIdAt(root, time, featureId);
  if (feature === undefined || feature.kind !== FEATURE_KIND.Leaf) return undefined;
  const resolved = resolveLeafShape(feature.shape, verticesAt(root, time));
  if (resolved === undefined) return undefined;
  // Continuous-longitude align each piece independently (the display path's rule):
  // its outer ring is the reference for its own holes, while a separate enclave keeps
  // its own natural branch (no false global merge).
  return resolved.map((polygon) => alignMultiPolygon([polygon])[0]!);
}
