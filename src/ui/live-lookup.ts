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
import type { GeoMultiPolygon } from '../domain/geometry/types';
import { multiPolygonBBox, type BBox } from '../domain/spatial/bbox';
import { SpatialIndex, type IndexEntry } from '../domain/spatial/rtree';

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

// ===========================================================================
// BROAD-PHASE SPATIAL INDEX for `leafAtPoint` (S3d — 個別 leaf 照会の高速化)
// ===========================================================================
//
// WHY (実測: 実データ full で leafAtPoint ≈21ms/呼び出し、99,314 頂点): the knife /
// merge / reparent / drill / ring-edit `featureAtPoint` ports all call `leafAtPoint`
// on every target-selection click AND (tool hover追従) on pointer-move. Un-indexed it
// is O(全頂点) per call: it `resolveLeafShape`s EVERY leaf (allocating all 99,314 ring
// coordinates) and ray-casts point-in-polygon over EVERY resolved ring, three times
// (the canonical click plus its ±360° replicas). A single click is within budget; a
// hover stream at 60fps is not.
//
// The fix mirrors the pointer hit-test's broad phase (S3c, live-hit-test.ts): an RBush
// (U10 `SpatialIndex`) over each leaf's WORLD-space bbox lets a query test only the
// handful of leaves whose bbox is near the click, then run the EXACT same
// `pointInPolygon` test on the SAME pre-resolved shape — so the returned FeatureId is
// byte-identical to the full scan (the index only skips leaves the exact test would
// have rejected anyway).
//
// LIFECYCLE (task: live-lookup 既存の (root,time) メモ化と同じ世代キーに相乗り): the
// index is a pure function of `(root identity, time value)` — the SAME key the
// `featuresAt` / `verticesAt` memos already use — so it rides on the identical
// `createLookupMemo` (a root-swap = any committed edit, or a time change, misses and
// rebuilds; a repeat call at the same generation HITS). It is built LAZILY on the first
// `leafAtPoint` of a generation and each build reuses the memoized `featuresAt` /
// `verticesAt` results, so `resolveLeafShape` is run ONCE per generation (not once per
// leaf per pointer event). This is a DIFFERENT set from the S3c `HitIndex`, which
// indexes the DISPLAY-resolved (集約/実形状/省略) draw set keyed by `DisplayResolution`;
// `leafAtPoint` scans the RAW leaf bodies regardless of display-control (HB3-16), so it
// needs its own leaf-body index. The shared PARTS — the bbox computation
// (`multiPolygonBBox`) and the RBush wrapper (`SpatialIndex`) — are the SAME domain-layer
// single source both indexes use (no HitIndex 二重実装), so the only leaf-specific piece
// is the fixed ±360° probe enumeration below (which the raw scan already fixed at three
// turns — `leafAtPoint` has no camera, unlike the S3c wrap enumeration).
//
// WRAP 単一真実源: candidate enumeration probes the index at the SAME three ±360° replica
// longitudes the exact test does (canonical + one turn each side). A probe that lands
// inside a leaf polygon is within that polygon's bbox ⊆ the leaf's bbox, so no reachable
// leaf is ever dropped (描画 ⊇ ヒット); the exact test then decides.

/**
 * One indexed leaf body: its id, PRE-RESOLVED shape (the `resolveLeafShape` output the
 * exact test runs `pointInPolygon` on — computed ONCE at build, not per query), and its
 * position in the filtered-leaf scan order. Candidates are iterated in `order` so a
 * containment TIE resolves to the SAME leaf the full scan's later-wins keeps (最前面
 * タイブレーク — a later leaf drawn on top wins).
 */
interface IndexedLeaf {
  readonly featureId: FeatureId;
  readonly shape: GeoMultiPolygon;
  readonly order: number;
}

/** The per-(root, time) broad-phase index over the raw leaf bodies. */
interface LeafHitIndex {
  readonly index: SpatialIndex<IndexedLeaf>;
}

/**
 * Tiny relative/absolute widening of the leaf broad-phase query box so a probe that the
 * EXACT `pointInPolygon` accepts is never pruned by float rounding in the bbox↔predicate
 * round-trip. It only over-includes; the exact test still decides the hit.
 */
const LEAF_BROAD_PHASE_EPS = 1e-9;

/** Build the leaf-body index for `(root, time)` — one `resolveLeafShape` sweep + bboxes. */
function buildLeafHitIndex(root: DomainProject, time: TimePoint): LeafHitIndex {
  const vertices = verticesAt(root, time);
  const entries: IndexEntry<IndexedLeaf>[] = [];
  // `order` mirrors `leafAtPoint`'s iteration index over the FILTERED leaves: it advances
  // for every leaf (even one whose shape is unresolvable / empty and thus not inserted, so
  // both are skipped exactly as the scan skips them) so the relative order of the INDEXED
  // leaves matches the scan's later-wins order.
  let order = 0;
  for (const f of featuresAt(root, time)) {
    if (f.kind !== FEATURE_KIND.Leaf) continue;
    const shape = resolveLeafShape(f.shape, vertices);
    if (shape !== undefined) {
      const box = multiPolygonBBox(shape);
      if (box !== undefined) {
        entries.push({
          ref: { featureId: f.id, shape, order },
          minX: box.minX,
          minY: box.minY,
          maxX: box.maxX,
          maxY: box.maxY,
        });
      }
    }
    order += 1;
  }
  return { index: new SpatialIndex<IndexedLeaf>().bulkLoad(entries) };
}

const leafIndexMemo = createLookupMemo(buildLeafHitIndex);

/**
 * TEST-ONLY toggle: force `leafAtPoint` to bypass the broad-phase index and run the full
 * linear scan, so a property test can assert the indexed and un-indexed paths return
 * byte-identical results for the SAME inputs (索引ありなしで返り値一致). Never toggled in
 * production. Reset via `setLeafIndexEnabledForTest(true)`.
 */
let leafIndexEnabled = true;
export function setLeafIndexEnabledForTest(enabled: boolean): void {
  leafIndexEnabled = enabled;
}

/**
 * The SINGLE leaf-body containment rule shared by the full scan and the index-narrowed
 * path (教訓 5.30 単一判定): the leaf is hit iff ANY of the ±360° `probes` lands strictly
 * inside ANY of its polygon pieces (穴透過 honoured by `pointInPolygon`; a point on / in a
 * hole is not a hit). Extracted verbatim from the previous inline loop so the two paths
 * cannot drift.
 */
function leafBodyContains(
  shape: GeoMultiPolygon,
  probes: readonly WorldCoordinate[],
): boolean {
  return shape.some((polygon) =>
    probes.some((p) => pointInPolygon(p, polygon) === POINT_LOCATION.Inside),
  );
}

/**
 * The leaf candidates whose bbox contains one of the ±360° `point` replicas — a
 * conservative SUPERSET of the leaves the full scan would test-and-hit, returned in
 * scan (`order`) order so the later-wins tie-break is byte-identical. A probe with a
 * non-finite longitude/latitude contributes no box (its `pointInPolygon` is never
 * Inside either, so the full scan finds nothing there — consistent).
 */
function leafCandidates(hitIndex: LeafHitIndex, point: WorldCoordinate): IndexedLeaf[] {
  const eps = LEAF_BROAD_PHASE_EPS;
  const lat = point.lat;
  // The SAME three ±360° probe longitudes `leafAtPoint`'s exact test uses.
  const probeLons = [point.lon, point.lon + 360, point.lon - 360];
  const seen = new Set<number>();
  const out: IndexedLeaf[] = [];
  for (const lon of probeLons) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const box: BBox = { minX: lon - eps, maxX: lon + eps, minY: lat - eps, maxY: lat + eps };
    for (const entry of hitIndex.index.search(box)) {
      const ref = entry.ref;
      if (!seen.has(ref.order)) {
        seen.add(ref.order);
        out.push(ref);
      }
    }
  }
  out.sort((a, b) => a.order - b.order);
  return out;
}

/** The un-indexed full scan — the EXACT previous `leafAtPoint` body, kept for the
 * index-bypass test toggle and as the fallback that the indexed path must equal. */
function leafAtPointFullScan(
  root: DomainProject,
  time: TimePoint,
  probes: readonly WorldCoordinate[],
): FeatureId | null {
  const vertices = verticesAt(root, time);
  const leaves: LeafFeature[] = featuresAt(root, time).filter(
    (f): f is LeafFeature => f.kind === FEATURE_KIND.Leaf,
  );
  let hit: FeatureId | null = null;
  for (const leaf of leaves) {
    const shape = resolveLeafShape(leaf.shape, vertices);
    if (shape === undefined) continue;
    if (leafBodyContains(shape, probes)) hit = leaf.id; // a later leaf on top wins
  }
  return hit;
}

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
  leafIndexMemo.clear();
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
  // The index-bypass path (test toggle) is the verbatim previous full scan.
  if (!leafIndexEnabled) return leafAtPointFullScan(root, time, probes);

  // Broad phase: the leaves whose bbox is near one of the ±360° probes (a SUPERSET of
  // the true hits, in scan order), memoized once per (root, time) generation. The exact
  // per-candidate test below runs the SAME `leafBodyContains` on the SAME pre-resolved
  // shape as the full scan, in the SAME order, so the returned id is byte-identical
  // (索引ありなしで返り値一致). Every skipped leaf is provably a miss (its bbox contains no
  // probe, so no probe can be inside its polygons), and later candidates still win.
  const hitIndex = leafIndexMemo.lookup(root, time);
  let hit: FeatureId | null = null;
  for (const cand of leafCandidates(hitIndex, point)) {
    if (leafBodyContains(cand.shape, probes)) hit = cand.featureId; // later leaf on top wins
  }
  return hit;
}

/**
 * The resolved multipolygon shape of the leaf `featureId` at `time`, for the knife /
 * merge / reparent target emphasis (the knife / merge / reparent `resolveLeafShape`
 * ports — each tool resolves ITS OWN target through this one function), or undefined
 * when it is absent / not a leaf.
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
