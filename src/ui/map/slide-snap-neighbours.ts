// U40↔U24↔U10 wiring — the per-frame near-candidate query (`neighboursAt`) that
// feeds the live edit-session's slide / snap LIGHT PATH (受け入れ基準6 / 12, 診断
// HB3-20 / 教訓 5.7「ロジックがあっても UI から呼ばれず機能しない」).
//
// WHY THIS FILE EXISTS:
// `createEditSessionPort` already runs constrainSlide (排他) + decideSnap (滑り),
// and the release path already promotes a surviving snap to a share pair via
// `decideSharePairAtRelease` (built into `buildEditSnapshot`). But the App.tsx
// composition root INTENTIONALLY omitted the three deps those paths need
// (`neighboursAt` / `worldToScreen` / `snapDistancePx`), so the adapter fell back
// to a preview-only move: a dragged vertex tunnelled straight through a neighbour
// terminal and never snapped to / shared an adjacent boundary vertex. The slide /
// snap rules were live in the domain and unit-tested, yet UNREACHABLE from the UI
// (the exact 教訓 5.7 shape the whole HB3 round is about).
//
// This module owns the ONE rule that turns the LIVE committed domain (resolved at
// the current time) into the {@link SlideSnapNeighbours} for one drag frame:
//   - edges       — boundary edges of OTHER terminal features near the preview, for
//                    constrainSlide's collision detection (FR-28).
//   - candidates  — those terminals' polygons, for the point-in-polygon containment
//                    guard at t=0 / endpoints (FR-28 / FR-89).
//   - snapCandidates — every committed vertex of OTHER features near the preview, for
//                    decideSnap's screen-proximity share-vertex判定 (FR-31).
//   - containment — when the dragged vertex is a HOLE / ENCLAVE vertex of its OWN
//                    feature, the parent territory it must stay inside (FR-89).
//
// WHAT COUNTS AS AN OBSTACLE (HB4-2 / D56): only geometry that STAYS PUT this frame.
// Excluding the dragged FEATURE is not enough — under FR-30 a vertex is SHARED BY ID,
// so a neighbouring feature that references the dragged vertex deforms along with the
// drag. Its incident edges are not walls, and its committed outline is stale the moment
// the drag starts; fed to `constrainSlide` they made the vertex slide along its OWN
// (shared) boundary line — the user-reported 自辺に滑る defect. The rule is therefore
// per-VERTEX and keyed on IDENTITY, not on feature id and not on coordinates (two
// distinct vertices may sit at the same position and genuinely stay put — FR-28 must
// still slide there — and a coordinate can be ±360° from its stored representative).
// A deforming neighbour is NOT dropped wholesale: every edge of it that does NOT move
// stays a wall, so the stationary parts keep guarding FR-28. What it does lose is its
// point-in-polygon CANDIDATE polygon — neither its stale committed outline nor its
// preview outline can answer "is the dragged vertex inside?", because the dragged vertex
// IS one of that outline's vertices (see the candidate assembly below).
//
// It NARROWS via U10's RBush ({@link SpatialIndex}) so a 5,000-terminal project never
// scans every feature per frame (教訓 5.3 / 5.4): a query rectangle around the preview
// (widened by the snap distance in world units + a margin) selects the near terminals;
// only those are turned into edges / candidates / snap candidates.
//
// PURE / TESTABLE: no React, no store, no renderer import. The caller passes the live
// root + time + the snap world-margin (derived from the screen snap distance via the
// live camera). The SAME live-lookup helpers the hit-test / draw / snapshot use resolve
// the geometry, so what slides == what is drawn == what is committed (単一真実源, 教訓 5.29).

import { moveDraggedVertexSet, movingVertexIds as movingVertexIdsOf } from '../../domain/editing';
import type {
  BoundaryEdge,
  CandidateTerminal,
  DragSession,
  ParentContainment,
  SnapCandidate,
} from '../../domain/editing';
import type { SlideSnapNeighbours } from './edit-session-adapter';
import type { WorldCoordinate } from '../../domain/coordinate';
import type { DomainProject } from '../../domain/persistence/index';
import type { TimePoint } from '../../domain/time/time-point';
import type { Feature, LeafFeature } from '../../domain/feature';
import { FEATURE_KIND } from '../../domain/feature';
import type { GeoPolygon, GeoRing } from '../../domain/geometry/types';
import { shortestLonDeltaDeg, LONGITUDE_PERIOD } from '../../domain/geo/index';
import { RING_KIND, type Ring } from '../../domain/ring';
import type { RingId, VertexId } from '../../domain/ids';
import { getVertex, type VertexStore } from '../../domain/vertex';
import { quantizeCoordinate } from '../../domain/geometry/quantize';
import { leafShapePieces, resolveShapePieces } from '../../domain/hierarchy/resolve-shape';
import { multiPolygonBBox, type BBox } from '../../domain/spatial/bbox';
import { SpatialIndex, type IndexEntry } from '../../domain/spatial/rtree';
import { complete, completeEquals, type CompleteTimePoint } from '../../domain/time/time-point';
import { featuresAt, verticesAt } from '../live-lookup';

/** The live domain context the neighbour query resolves against (read fresh per frame). */
export interface NeighboursContext {
  /** The current committed domain root (single truth source, 技術方針 2.3). */
  readonly getRoot: () => DomainProject;
  /** The current timeline time the geometry resolves at (FR-57). */
  readonly getTime: () => TimePoint;
  /**
   * The snap proximity radius EXPRESSED IN WORLD UNITS at the current zoom — used
   * ONLY to widen the candidate query rectangle so a vertex just outside the bbox
   * but within the (screen) snap distance is still a candidate. The actual snap
   * decision stays SCREEN-space (decideSnap, FR-31); this is a conservative
   * pre-filter margin, never the snap rule itself. Non-finite / negative ⇒ no
   * extra margin.
   */
  readonly snapWorldMargin: () => number;
}

/**
 * The vertex ids that MOVE WITH the current drag frame (HB4-2 / D56).
 *
 * A boundary that is dragged along with the gesture is NOT a static obstacle, so it
 * must never be offered to `constrainSlide` as one. Under FR-30 the dragged vertex is
 * SHARED BY ID with the neighbouring features that reference it, so those neighbours'
 * incident edges move too — "belongs to another feature" is therefore NOT a sufficient
 * test, and the exclusion must be per-VERTEX, keyed on identity.
 *
 * Identity, never coordinates: two distinct vertices may sit at the same position
 * (they are NOT linked and the neighbour genuinely stays put — FR-28 must still slide
 * there), and a coordinate can be ±360° away from its stored representative across the
 * seam. Only the id says "this point moves when I drag".
 */
type MovingVertexIds = ReadonlySet<string>;

/** The empty moving-set — nothing is excluded (feature-move / no dragged vertex). */
const NO_MOVING_VERTICES: MovingVertexIds = new Set<string>();

/**
 * The boundary edges of one resolved ring, keyed for slide-boundary identity, with the
 * edges INCIDENT TO A MOVING VERTEX dropped (HB4-2). `vertexIds` runs parallel to
 * `ring` (index i of both is the same vertex); when it is absent no edge can be
 * identified as moving and every edge is kept (the prior behaviour).
 *
 * `edgeKey` stays the ORIGINAL ring index, so dropping an edge never renumbers the
 * survivors — a highlight key identifies the same edge from frame to frame.
 */
function ringEdges(
  featureId: string,
  ringTag: string,
  ring: GeoRing,
  vertexIds: readonly VertexId[] | undefined,
  moving: MovingVertexIds,
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  const n = ring.length;
  if (n < 2) return edges; // a ring needs ≥2 vertices to have an edge.
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n; // implicitly closed (first vertex not repeated).
    const a = ring[i]!;
    const b = ring[j]!;
    const aId = vertexIds?.[i];
    const bId = vertexIds?.[j];
    // The edge is dragged along with the gesture ⇒ not an obstacle this frame.
    if ((aId !== undefined && moving.has(aId)) || (bId !== undefined && moving.has(bId))) {
      continue;
    }
    // NOTE: the vertex identity is consumed HERE and is deliberately NOT copied onto
    // the emitted edge. `constrainSlide`'s contract is "every edge you give me is a
    // real obstacle" — carrying an id it never reads would only invite a future reader
    // to believe that layer can tell a deforming candidate from a static one (it
    // cannot, and must not have to). Filtering is this caller's job, done right here.
    edges.push({ featureId, edgeKey: `${ringTag}:${i}`, a, b });
  }
  return edges;
}

/** Every boundary edge of a resolved polygon (outer + holes), keyed per ring. */
function polygonEdges(
  featureId: string,
  polyIndex: number,
  polygon: GeoPolygon,
  polygonVertexIds: readonly (readonly VertexId[])[] | undefined,
  moving: MovingVertexIds,
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  for (let r = 0; r < polygon.length; r += 1) {
    const ring = polygon[r]!;
    edges.push(...ringEdges(featureId, `p${polyIndex}r${r}`, ring, polygonVertexIds?.[r], moving));
  }
  return edges;
}

/**
 * The resolved polygon pieces of a leaf feature at the current time PLUS the vertex
 * ids running parallel to them, or undefined when it cannot be resolved (a point /
 * line / unresolvable shape contributes no slide / containment geometry — 教訓 5.18
 * absence is the empty value, never a throw).
 *
 * The ids come from {@link leafShapePieces} — the SAME grouping `resolveLeafShape`
 * emits its pieces from — so `vertexIds[p][r][i]` is by construction the vertex whose
 * coordinate is `polygons[p][r][i]`; no second, drift-prone grouping is derived here
 * (単一真実源 / 教訓 5.29).
 */
function resolveTerminalGeometry(
  feature: Feature,
  store: VertexStore,
): { polygons: readonly GeoPolygon[]; vertexIds: readonly (readonly (readonly VertexId[])[])[]; ownedVertexIds: ReadonlySet<string> } | undefined {
  if (feature.kind !== FEATURE_KIND.Leaf) return undefined;
  const pieces = leafShapePieces(feature.shape);
  if (pieces === undefined) return undefined;
  // Resolve FROM the grouping we already have — calling `resolveLeafShape` here would
  // run `leafShapePieces` a second time over every leaf (HB4-2 review #4).
  const polygons = resolveShapePieces(pieces, store);
  if (polygons === undefined) return undefined;
  const vertexIds = pieces.map((piece) => piece.map((ring) => ring.vertexIds));
  const ownedVertexIds = new Set<string>();
  for (const piece of pieces) {
    for (const ring of piece) {
      for (const vid of ring.vertexIds) ownedVertexIds.add(vid);
    }
  }
  return { polygons, vertexIds, ownedVertexIds };
}

/**
 * Where each MOVING vertex sits THIS FRAME, keyed by id (FR-80). Built by the SAME
 * `moveDraggedVertexSet` the live preview store and the release snapshot use, so the
 * shape the constraint is computed against is byte-for-byte the shape that is drawn and
 * committed (単一真実源, 教訓 5.29/5.30).
 */
type MovingPositions = ReadonlyMap<string, WorldCoordinate>;

/**
 * A ring set rebuilt AT THE PREVIEW: its resolved rings with every MOVING vertex
 * replaced by ITS OWN position this frame (HB4-2 / FR-80).
 *
 * PER-VERTEX, NEVER "all moving vertices → the primary's preview" (FR-80 fix-forward):
 * with a multi-vertex selection the parent ring can carry SEVERAL moving vertices (a
 * rectangle select routinely grabs both hole and territory vertices of one leaf), and
 * substituting the primary's preview for each of them collapsed them onto ONE point —
 * a self-intersecting / degenerate parent polygon that is not the shape the drag
 * actually produces. `constrainSlide` then classified the dragged point against a
 * fiction: either no crossing was found and the drag froze at the press point (the
 * `pos = start` fallback), or a companion was let out of the real parent region
 * (FR-89 violation). The positions therefore come from {@link MovingPositions}.
 *
 * USED ONLY for the INVERSE {@link ParentContainment} region — the parent ring the
 * dragged hole/enclave vertex must stay INSIDE. When the parent ring itself references
 * a moving vertex (診断 H3), the parent boundary deforms with the drag, so the wall
 * the vertex must stay within is the parent's NEW loop, not its stale committed one.
 *
 * It is deliberately NOT used to build {@link CandidateTerminal} polygons any more — see
 * the candidate assembly in {@link createNeighboursQuery} for why a deforming neighbour
 * contributes NO containment polygon at all (HB4-2 review #1/#2).
 *
 * The PRIMARY's position in that map MUST already be on the world quantization grid:
 * {@link constrainSlide} quantizes its target before every point-in-polygon test, so a
 * raw (sub-grid) preview spliced into the ring puts the polygon's own vertex up to half
 * a grid cell away from the point being classified, and the exact-arithmetic predicate
 * then answers Inside / Outside where the true answer is Boundary (HB4-2 review #1).
 * One grid, one truth. (Companions are never the classified point, so they only need to
 * be where the commit will put them.)
 *
 * Each substituted point is expressed in the RING's ±360° longitude frame (nearest
 * branch to the coordinate it replaces), so a neighbour stored on the far side of the
 * antimeridian keeps a coherent outline instead of being torn 360° apart (R3).
 *
 * Returns the input polygon by reference when nothing moved (no allocation per frame
 * for the overwhelmingly common case of a ring that references no moving vertex).
 */
function previewPolygon(
  polygon: GeoPolygon,
  polygonVertexIds: readonly (readonly VertexId[])[] | undefined,
  movingPositions: MovingPositions,
): GeoPolygon {
  if (polygonVertexIds === undefined || movingPositions.size === 0) return polygon;
  let anyChanged = false;
  const rings: GeoRing[] = [];
  for (let r = 0; r < polygon.length; r += 1) {
    const ring = polygon[r]!;
    const ids = polygonVertexIds[r];
    if (ids === undefined) {
      rings.push(ring);
      continue;
    }
    let ringChanged = false;
    const next: WorldCoordinate[] = [];
    for (let i = 0; i < ring.length; i += 1) {
      const at = ring[i]!;
      const id = ids[i];
      const movedTo = id === undefined ? undefined : movingPositions.get(id);
      if (movedTo !== undefined) {
        next.push(alignedToBranch(movedTo, at));
        ringChanged = true;
      } else {
        next.push(at);
      }
    }
    rings.push(ringChanged ? next : ring);
    anyChanged = anyChanged || ringChanged;
  }
  return anyChanged ? rings : polygon;
}

/**
 * The position of every vertex that MOVES this frame, by the SAME rule the preview store
 * and the release snapshot apply (`moveDraggedVertexSet`): the primary at `previewOnGrid`,
 * each companion at its own committed position plus the primary's displacement (FR-80
 * 同一ベクトル). One implementation of the move, consumed everywhere (教訓 5.29/5.30).
 *
 * A gesture with NO resolvable primary body — an EDGE-ADD, whose reserved vertex is not
 * in the committed store yet — still previews that one id at `previewOnGrid`, which is
 * exactly the pre-FR-80 behaviour (and it names no committed ring, so it substitutes
 * nothing). A feature-move names no moving vertex at all: the empty map.
 */
function movingPositionsFor(
  session: DragSession,
  store: VertexStore,
  previewOnGrid: WorldCoordinate,
): MovingPositions {
  const primary = session.draggedVertexId;
  if (primary === undefined) return EMPTY_MOVING_POSITIONS;
  const moved = moveDraggedVertexSet(primary, session.companionVertexIds, store, previewOnGrid);
  if (moved === undefined) return new Map([[primary as string, previewOnGrid]]);
  const out = new Map<string, WorldCoordinate>();
  for (const v of moved) out.set(v.id, v.coordinate);
  return out;
}

const EMPTY_MOVING_POSITIONS: MovingPositions = new Map<string, WorldCoordinate>();

/**
 * `p` expressed in the ±360° longitude branch NEAREST to `ref`. A drag frame moves a
 * vertex by a tiny delta, so the nearest branch is always the intended one; this keeps
 * a substituted preview on the same branch as the ring it is spliced into (R3 seam).
 */
function alignedToBranch(p: WorldCoordinate, ref: WorldCoordinate): WorldCoordinate {
  const k = Math.round((ref.lon - p.lon) / LONGITUDE_PERIOD);
  return k === 0 ? p : { lon: p.lon + k * LONGITUDE_PERIOD, lat: p.lat };
}

/** The world-coordinate vertices a feature owns (point / line / leaf rings), with ids. */
function featureSnapCandidates(feature: Feature, store: VertexStore): SnapCandidate[] {
  const out: SnapCandidate[] = [];
  if (feature.kind === FEATURE_KIND.Point) {
    const v = getVertex(store, feature.vertexId);
    if (v !== undefined) out.push({ vertexId: v.id, position: v.coordinate });
    return out;
  }
  if (feature.kind === FEATURE_KIND.Line) {
    for (const vid of feature.vertexIds) {
      const v = getVertex(store, vid);
      if (v !== undefined) out.push({ vertexId: v.id, position: v.coordinate });
    }
    return out;
  }
  // Aggregate carries no shape / vertices of its own (its area derives from
  // children, which are separate features handled in their own iteration).
  if (feature.kind !== FEATURE_KIND.Leaf) return out;
  // Leaf: every ring vertex (territory + hole + enclave). De-dup by id so a vertex
  // shared between rings is offered once.
  const seen = new Set<string>();
  for (const ring of feature.shape.rings) {
    for (const vid of ring.vertexIds) {
      if (seen.has(vid as unknown as string)) continue;
      seen.add(vid as unknown as string);
      const v = getVertex(store, vid);
      if (v !== undefined) out.push({ vertexId: v.id, position: v.coordinate });
    }
  }
  return out;
}

/**
 * Build the {@link ParentContainment} for a HOLE / ENCLAVE vertex of the dragged
 * LEAF feature (受け入れ基準6 第4項 / FR-89), or undefined when the dragged vertex
 * is a plain outer-territory / point / line vertex (nothing extra to keep it inside).
 *
 * The rule (mirrors the slide containment semantics): a vertex on a HOLE ring must
 * stay inside the territory the hole is punched into; a vertex on an ENCLAVE
 * territory ring (a territory nested inside a hole) must stay inside that hole's
 * solid region. We resolve the PARENT ring's own loop to a polygon (outer = parent
 * ring; the parent's own inner holes are NOT carved out here — the constraint only
 * needs the immediate parent boundary the vertex must not cross) and supply its
 * edges for the tangential slide highlight.
 */
function containmentFor(
  feature: LeafFeature,
  ringId: RingId | undefined,
  store: VertexStore,
  moving: MovingVertexIds,
  movingPositions: MovingPositions,
): ParentContainment | undefined {
  if (ringId === undefined) return undefined;
  const rings = feature.shape.rings;
  const dragged = rings.find((r) => r.id === ringId);
  if (dragged === undefined) return undefined;
  // A dragged OUTER territory ring (no parent) has no containment constraint.
  if (dragged.kind === RING_KIND.Territory && dragged.parentRingId === undefined) {
    return undefined;
  }
  const parentRingId = dragged.parentRingId;
  if (parentRingId === undefined) return undefined;
  const parent = rings.find((r: Ring) => r.id === parentRingId);
  if (parent === undefined) return undefined;
  const parentRing = ringCoordinates(parent, store);
  if (parentRing === undefined || parentRing.length < 3) return undefined;
  // HB4-2 (診断 H3, the literal 自辺 case): when the PARENT ring itself references a
  // vertex that moves — a hole ring that touches the territory it is punched into, or
  // (FR-80) a companion of the grabbed vertex sitting on the parent ring — the parent
  // boundary moves with the drag too. Apply the identical per-vertex rule as for other
  // terminals: incident parent edges are not obstacles, and the parent outline is taken
  // at its PREVIEW shape (each moving vertex at ITS OWN new position), not its stale
  // committed one and not collapsed onto the primary.
  const parentIds: readonly (readonly VertexId[])[] = [parent.vertexIds];
  const polygon = previewPolygon([parentRing], parentIds, movingPositions);
  return {
    featureId: feature.id,
    polygon,
    edges: ringEdges(feature.id, `parent:${parentRingId}`, polygon[0]!, parent.vertexIds, moving),
  };
}

/** Resolve a ring's vertex ids to a world-coordinate loop, or undefined if any missing. */
function ringCoordinates(ring: Ring, store: VertexStore): GeoRing | undefined {
  const coords: WorldCoordinate[] = [];
  for (const vid of ring.vertexIds) {
    const v = getVertex(store, vid);
    if (v === undefined) return undefined; // 片落とし禁止 — no partial ring (教訓 5.1).
    coords.push(v.coordinate);
  }
  return coords;
}

/**
 * One indexed terminal: a LEAF feature's id + its resolved polygon pieces. Built
 * over EVERY leaf terminal (not just the non-dragged ones) so the index is a pure
 * function of (root, time) and can be memoized across a drag's frames; the dragged
 * feature is skipped when COLLECTING hits, not when building (so the same index
 * serves any dragged feature at the same root/time — bughunt4 #3).
 */
interface NearTerminal {
  readonly featureId: string;
  readonly polygons: readonly GeoPolygon[];
  /**
   * Parallel to {@link polygons}: `vertexIds[p][r][i]` is the identity of the vertex at
   * `polygons[p][r][i]`. Carried so the per-frame query can tell a STATIC boundary from
   * one that moves with the drag (HB4-2) — coordinates cannot (診断 H5 / R3 seam).
   */
  readonly vertexIds: readonly (readonly (readonly VertexId[])[])[];
  /** Every vertex id this terminal's rings reference — a cheap "does this drag deform me?". */
  readonly ownedVertexIds: ReadonlySet<string>;
}

/** The (root, time)-derived part of the query that is stable across a drag's frames. */
interface NeighboursBuild {
  readonly store: VertexStore;
  readonly features: readonly Feature[];
  readonly index: SpatialIndex<NearTerminal>;
  readonly entries: readonly IndexEntry<NearTerminal>[];
}

/**
 * Build the {@link NeighboursBuild} for a (root, time): the live vertex store, the
 * resolved feature list, and a U10 RBush over EVERY leaf terminal's resolved
 * polygons. Pure in (root, time) — exactly the inputs `featuresAt` / `verticesAt`
 * read, so memoizing on them is complete and never stale.
 */
function buildNeighbours(root: DomainProject, time: TimePoint): NeighboursBuild {
  const store = verticesAt(root, time);
  const features = featuresAt(root, time);
  const index = new SpatialIndex<NearTerminal>();
  const entries: IndexEntry<NearTerminal>[] = [];
  for (const f of features) {
    if (f.kind !== FEATURE_KIND.Leaf) continue;
    const geometry = resolveTerminalGeometry(f, store);
    if (geometry === undefined) continue;
    const { polygons, vertexIds, ownedVertexIds } = geometry;
    if (polygons.length === 0) continue;
    const box = multiPolygonBBox(polygons);
    if (box === undefined) continue;
    const near: NearTerminal = { featureId: f.id, polygons, vertexIds, ownedVertexIds };
    entries.push({ ref: near, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY });
  }
  if (entries.length > 0) index.bulkLoad(entries);
  return { store, features, index, entries };
}

/**
 * A single-slot memo of {@link buildNeighbours} keyed by (root, time). Reused across
 * the many pointermove frames of ONE drag (root + time are stable then); a root
 * REFERENCE change (any committed edit swaps a new root object) or a time VALUE
 * change rebuilds. The cache holds one entry — a drag never interleaves two domains.
 */
function createNeighboursBuildMemo(): (root: DomainProject, time: TimePoint) => NeighboursBuild {
  let cachedRoot: DomainProject | undefined;
  let cachedTime: CompleteTimePoint | undefined;
  let cached: NeighboursBuild | undefined;
  return (root, time) => {
    const completed = complete(time);
    if (
      cached !== undefined &&
      cachedRoot === root &&
      cachedTime !== undefined &&
      completeEquals(cachedTime, completed)
    ) {
      return cached;
    }
    cached = buildNeighbours(root, time);
    cachedRoot = root;
    cachedTime = completed;
    return cached;
  };
}

/**
 * Create the per-frame {@link SlideSnapNeighbours} query for the live edit session.
 * Returns a `neighboursAt(preview, session)` the adapter calls each move when a
 * single vertex is being dragged.
 *
 * Each call resolves the LIVE committed domain at the current time, builds a U10
 * RBush over the OTHER terminal features (the dragged feature is never its own
 * slide / snap candidate), queries it with a rectangle around the preview widened
 * by the snap world margin, and turns the near terminals into edges / candidates /
 * snapCandidates — plus the containment constraint for a hole/enclave dragged vertex.
 */
export function createNeighboursQuery(
  ctx: NeighboursContext,
): (preview: WorldCoordinate, session: DragSession) => SlideSnapNeighbours {
  // PER-DRAG MEMO (bughunt4 #3): the snap/slide light path calls this closure once
  // per pointermove frame of a drag, and the (root, time)-derived part — the live
  // vertex store, the resolved feature list, AND the U10 RBush over every OTHER
  // terminal's resolved polygons — is IDENTICAL across all those frames (the
  // committed domain + timeline time are stable while a single drag is in flight;
  // only the dragged PREVIEW moves). Rebuilding it each frame re-resolved every
  // leaf's shape and re-bulk-loaded the whole index → O(n) per frame at the 5,000
  // 規模. We hold the build in the closure scope and reuse it while (root, time) are
  // unchanged. CORRECTNESS: `root` is the committed `DomainProject` reference — U16
  // swaps a NEW root object on ANY edit (immutable value objects + structural
  // sharing), so a reference change after an edit invalidates the memo and the next
  // frame rebuilds against the edited domain (never a stale index). `time` is
  // compared by VALUE (the same complete year/month/day resolves the same snapshot
  // via resolveAt), so a timeline move also rebuilds. Both inputs are exactly what
  // `featuresAt` / `verticesAt` read, so keying on them is complete.
  const memo = createNeighboursBuildMemo();

  return (preview, session): SlideSnapNeighbours => {
    const root = ctx.getRoot();
    const time = ctx.getTime();
    const { store, features, index, entries } = memo(root, time);
    const draggedFeatureId = session.target.featureId;

    // The dragged feature itself (for the hole/enclave containment constraint).
    const draggedFeature = features.find((f) => f.id === draggedFeatureId);

    // HB4-2 / D56 — the vertices that MOVE this frame. `draggedVertexId` is the single
    // place the session already decided this (vertex-move ⇒ the moved vertex; edge-add
    // ⇒ the id reserved for the vertex the gesture mints, which no committed ring
    // references yet, so it filters nothing; feature-move ⇒ undefined and this whole
    // path is not taken by the adapter). Sharing (FR-30) needs NO re-derivation: a
    // shared vertex IS the same id in every ring that references it, so the one id
    // already names every feature that moves with it (教訓 5.30 — never derive an
    // established relation a second time). A Set so multi-select (FR-80) can widen this
    // later without touching any of the rules below.
    //
    // SCOPE — EDGE-ADD IS OUTSIDE D56 (HB4-2 review #5; pre-existing behaviour, not a
    // regression of this fix): `newVertexId` names a vertex no COMMITTED ring references
    // yet, so this set filters nothing for an edge-add. Pulling a new vertex out of an
    // edge SHARED with a neighbour (FR-30) therefore leaves the neighbour's coincident
    // edge a static obstacle — geometrically defensible (the new vertex is inserted only
    // into the dragged feature's own ring, so the neighbour genuinely does stay put), but
    // it does mean an edge-add always begins ON an obstacle edge and so always takes the
    // t=0 existing-contact path. Deforming the neighbour instead would require inserting
    // the reserved id into the NEIGHBOUR's ring too — a share decision owned by the
    // confirm path, not by this per-frame query. When FR-80 widens this Set, widen it
    // with COMMITTED vertex ids; edge-add needs its own explicit decision rather than
    // falling out of this one.
    //
    // FR-80 (now): the widening is `movingVertexIdsOf`, and it honours that scope note —
    // companions come from the U22 selection set, which holds only DRAWN, COMMITTED
    // vertices, and an edge-add's reserved id can never acquire companions (only a
    // VertexMove target carries them). So every id added here really does name geometry
    // that deforms this frame, which is precisely the licence to stop treating its
    // incident edges as walls.
    const movingVertexIds: MovingVertexIds = movingVertexIdsOf(session);

    // The query rectangle: a point around the preview, widened by the snap world
    // margin (so a vertex within the screen snap distance but outside the terminal
    // bbox is still considered). RBush's search bounds are INCLUSIVE, so a margin of 0
    // still returns a feature whose bbox touches the preview point — no epsilon needed.
    // SEAM (±360°, R3): a neighbour stored on the FAR side of the antimeridian (e.g.
    // preview at 179.5°, neighbour at −179.5°, actually 1° apart) has a bbox the single
    // preview-frame rectangle would miss, so we probe the query in each ±360° longitude
    // frame (the SAME wrap-probe leafAtPoint uses) and de-duplicate by feature — what
    // slides / snaps then agrees with what the user sees across the seam (単一真実源 5.29).
    const rawMargin = ctx.snapWorldMargin();
    const margin = Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : 0;
    const queryBoxAt = (lon: number): BBox => ({
      minX: lon - margin,
      minY: preview.lat - margin,
      maxX: lon + margin,
      maxY: preview.lat + margin,
    });

    const edges: BoundaryEdge[] = [];
    const candidates: CandidateTerminal[] = [];
    const snapCandidates: SnapCandidate[] = [];

    const nearHits: IndexEntry<NearTerminal>[] = [];
    if (entries.length > 0) {
      const seenNear = new Set<string>();
      for (const lon of [preview.lon, preview.lon + LONGITUDE_PERIOD, preview.lon - LONGITUDE_PERIOD]) {
        for (const hit of index.search(queryBoxAt(lon))) {
          // The memoized index holds EVERY terminal (so it is a pure function of
          // (root, time) and reusable across drags); skip the dragged feature here so
          // it is never its own slide / snap candidate — identical to the prior
          // build-time exclusion (bughunt4 #3).
          if (hit.ref.featureId === draggedFeatureId) continue;
          if (seenNear.has(hit.ref.featureId)) continue;
          seenNear.add(hit.ref.featureId);
          nearHits.push(hit);
        }
      }
    }
    const nearFeatureIds = new Set<string>();
    for (const hit of nearHits) {
      const near = hit.ref;
      nearFeatureIds.add(near.featureId);
      // HB4-2: a neighbour that references a MOVING vertex (FR-30 sharing) is not a
      // static obstacle — it deforms with the drag. Its INCIDENT edges are dropped;
      // every other edge of it stays a wall, so FR-28 still holds against the parts
      // that genuinely stay put.
      const deforms = referencesAny(near.ownedVertexIds, movingVertexIds);
      const moving = deforms ? movingVertexIds : NO_MOVING_VERTICES;
      for (let p = 0; p < near.polygons.length; p += 1) {
        const raw = near.polygons[p]!;
        const ids = near.vertexIds[p];
        edges.push(...polygonEdges(near.featureId, p, raw, ids, moving));
        // CANDIDATE POLYGON = the point-in-polygon containment guard. A piece that
        // DEFORMS this frame must supply NONE (HB4-2 review #1/#2/#3), per PIECE so a
        // multi-polygon neighbour keeps guarding with the pieces that do not move:
        //
        //  - its COMMITTED outline is stale the instant the drag starts (the whole
        //    point of D56), and
        //  - its PREVIEW outline answers nothing: the dragged vertex IS a vertex of it,
        //    so "is the dragged point inside?" is the tautology "Boundary" — except the
        //    predicate is exact-arithmetic while `constrainSlide` quantizes its target,
        //    so a sub-grid preview made it answer *Inside* and manufactured a slide
        //    along an unrelated stationary edge (review #1, ~40% of off-grid targets), and
        //  - `constrainSlide` also tests `start` — the PREVIOUS-FRAME position, pinned at
        //    the press point for the whole gesture (drag-session: `updateDrag` never
        //    advances `start`) — against these polygons. A rebuilt outline can strictly
        //    contain that old point, firing the EXISTING-CONTACT (t=0) branch and
        //    clamping the vertex to a stationary edge for the REST of the drag (review #2),
        //    and it breaks the documented `constrainSlide` precondition "start is always
        //    outside", whose `pos = start` fallback then freezes the drag entirely (review #3).
        //
        // Dropping the piece costs nothing that `edges` does not already cover: a
        // deforming neighbour is only ever penetrated through an edge that does NOT
        // move, and those are exactly the edges still in `edges` (see the FR-28
        // regression that drags the shared vertex across the neighbour's far side).
        // The single invariant this restores: EVERY candidate polygon is STATIC
        // committed geometry, so `start` is outside all of them by the FR-28 invariant
        // the committed domain already satisfies.
        if (pieceReferencesMoving(ids, moving)) continue;
        candidates.push({ featureId: near.featureId, polygon: raw });
      }
    }

    // Snap candidates: vertices of OTHER features (terminals AND points/lines) whose
    // owner is near the preview. We narrow to features that the bbox query selected
    // (areas) PLUS point/line features whose own vertex is within the margin — so a
    // point/line vertex can also be a share target without scanning every vertex.
    for (const f of features) {
      if (f.id === draggedFeatureId) continue;
      if (f.kind === FEATURE_KIND.Leaf) {
        if (!nearFeatureIds.has(f.id)) continue; // only near terminals contribute vertices.
        for (const c of featureSnapCandidates(f, store)) {
          if (withinMargin(c.position, preview, margin)) snapCandidates.push(c);
        }
        continue;
      }
      // Point / line: include vertices within the margin of the preview.
      for (const c of featureSnapCandidates(f, store)) {
        if (withinMargin(c.position, preview, margin)) snapCandidates.push(c);
      }
    }

    // Hole / enclave containment for the dragged vertex (FR-89), when applicable.
    // `ringId` is only present on a vertex-move / edge-add target (not feature-move);
    // read it through the discriminant so the union stays type-safe.
    const ringId =
      'ringId' in session.target ? session.target.ringId : undefined;
    let containment: ParentContainment | undefined;
    // `ringId === undefined` (point / line / feature-move) can never produce a
    // containment — checking it here as well keeps the per-frame `movingPositionsFor`
    // allocation off the common non-leaf path (containmentFor's own guard is unchanged).
    if (
      ringId !== undefined &&
      draggedFeature !== undefined &&
      draggedFeature.kind === FEATURE_KIND.Leaf
    ) {
      // ON THE GRID (HB4-2 review #1): the preview spliced into the parent ring must be
      // the SAME value `constrainSlide` will classify against it, and `constrainSlide`
      // quantizes its target first. Feeding the raw sub-grid preview here put the
      // polygon's own vertex up to 5e-8 off the point being tested, so the exact
      // predicate answered Outside where the truth is Boundary — and the containment
      // pass, having correctly dropped the incident parent edges, then found no crossing
      // to slide along and pinned the vertex at the press point for the whole gesture.
      // 単一真実源: one quantization grid, applied at both ends of the comparison.
      containment = containmentFor(
        draggedFeature,
        ringId,
        store,
        movingVertexIds,
        movingPositionsFor(session, store, quantizeCoordinate(preview)),
      );
    }

    return containment === undefined
      ? { edges, candidates, snapCandidates }
      : { edges, candidates, snapCandidates, containment };
  };
}

/**
 * True iff `p` is within `margin` (world units, as a square — matching the query
 * rectangle) of `centre`, measuring LONGITUDE as the SHORTEST wrapped delta so the
 * ±180° seam is handled: a point at −179.5° is 1° from 179.5°, not 359° (R3 /
 * 単一真実源 5.29 — the bare lon difference wrongly excluded seam-adjacent snap
 * candidates). A zero margin keeps only an exactly-coincident point; the actual snap
 * proximity is decided in SCREEN space by decideSnap, so this is a conservative
 * pre-filter, never the snap rule.
 */
/** True iff any id in `moving` appears in `owned` (iterating the smaller set). */
function referencesAny(owned: ReadonlySet<string>, moving: MovingVertexIds): boolean {
  if (moving.size === 0 || owned.size === 0) return false;
  for (const id of moving) {
    if (owned.has(id)) return true;
  }
  return false;
}

/**
 * True iff ONE polygon piece (outer + its holes) references a vertex that moves this
 * frame — i.e. this piece DEFORMS and its outline therefore cannot serve as a static
 * point-in-polygon obstacle (HB4-2). Judged per PIECE, not per feature, so a
 * multi-polygon neighbour whose OTHER pieces stay put keeps guarding with those.
 */
function pieceReferencesMoving(
  polygonVertexIds: readonly (readonly VertexId[])[] | undefined,
  moving: MovingVertexIds,
): boolean {
  if (polygonVertexIds === undefined || moving.size === 0) return false;
  for (const ids of polygonVertexIds) {
    for (const id of ids) {
      if (moving.has(id)) return true;
    }
  }
  return false;
}

function withinMargin(p: WorldCoordinate, centre: WorldCoordinate, margin: number): boolean {
  return (
    Math.abs(shortestLonDeltaDeg(p.lon, centre.lon)) <= margin &&
    Math.abs(p.lat - centre.lat) <= margin
  );
}
