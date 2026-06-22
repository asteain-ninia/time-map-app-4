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
// It NARROWS via U10's RBush ({@link SpatialIndex}) so a 5,000-terminal project never
// scans every feature per frame (教訓 5.3 / 5.4): a query rectangle around the preview
// (widened by the snap distance in world units + a margin) selects the near terminals;
// only those are turned into edges / candidates / snap candidates.
//
// PURE / TESTABLE: no React, no store, no renderer import. The caller passes the live
// root + time + the snap world-margin (derived from the screen snap distance via the
// live camera). The SAME live-lookup helpers the hit-test / draw / snapshot use resolve
// the geometry, so what slides == what is drawn == what is committed (単一真実源, 教訓 5.29).

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
import { RING_KIND, type Ring } from '../../domain/ring';
import type { RingId } from '../../domain/ids';
import { getVertex, type VertexStore } from '../../domain/vertex';
import { resolveLeafShape } from '../../domain/hierarchy/resolve-shape';
import { multiPolygonBBox, type BBox } from '../../domain/spatial/bbox';
import { SpatialIndex, type IndexEntry } from '../../domain/spatial/rtree';
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

/** A single edge of a resolved polygon ring, keyed for slide-boundary identity. */
function ringEdges(
  featureId: string,
  ringTag: string,
  ring: GeoRing,
): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  const n = ring.length;
  if (n < 2) return edges; // a ring needs ≥2 vertices to have an edge.
  for (let i = 0; i < n; i += 1) {
    const a = ring[i]!;
    const b = ring[(i + 1) % n]!; // implicitly closed (first vertex not repeated).
    edges.push({ featureId, edgeKey: `${ringTag}:${i}`, a, b });
  }
  return edges;
}

/** Every boundary edge of a resolved polygon (outer + holes), keyed per ring. */
function polygonEdges(featureId: string, polyIndex: number, polygon: GeoPolygon): BoundaryEdge[] {
  const edges: BoundaryEdge[] = [];
  for (let r = 0; r < polygon.length; r += 1) {
    const ring = polygon[r]!;
    edges.push(...ringEdges(featureId, `p${polyIndex}r${r}`, ring));
  }
  return edges;
}

/**
 * The resolved polygon pieces of a leaf feature at the current time, or [] when it
 * cannot be resolved (a point / line / unresolvable shape contributes no slide /
 * containment geometry — 教訓 5.18 absence is the empty value, never a throw).
 */
function resolvedPolygons(feature: Feature, store: VertexStore): readonly GeoPolygon[] {
  if (feature.kind !== FEATURE_KIND.Leaf) return [];
  const mp = resolveLeafShape(feature.shape, store);
  return mp ?? [];
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
  const polygon: GeoPolygon = [parentRing];
  return {
    featureId: feature.id,
    polygon,
    edges: ringEdges(feature.id, `parent:${parentRingId}`, parentRing),
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
  return (preview, session): SlideSnapNeighbours => {
    const root = ctx.getRoot();
    const time = ctx.getTime();
    const store = verticesAt(root, time);
    const draggedFeatureId = session.target.featureId;
    const features = featuresAt(root, time);

    // The dragged feature itself (for the hole/enclave containment constraint).
    const draggedFeature = features.find((f) => f.id === draggedFeatureId);

    // Build a U10 RBush over the OTHER terminal LEAF features' resolved shapes. A
    // feature is a slide/snap obstacle only if it owns area; points / lines carry no
    // boundary to slide along (they still offer snap vertices — handled below). The
    // dragged feature is excluded so it never collides with / snaps to itself.
    interface NearTerminal {
      readonly featureId: string;
      readonly polygons: readonly GeoPolygon[];
    }
    const index = new SpatialIndex<NearTerminal>();
    const entries: IndexEntry<NearTerminal>[] = [];
    for (const f of features) {
      if (f.id === draggedFeatureId) continue;
      if (f.kind !== FEATURE_KIND.Leaf) continue;
      const polygons = resolvedPolygons(f, store);
      if (polygons.length === 0) continue;
      const box = multiPolygonBBox(polygons);
      if (box === undefined) continue;
      const near: NearTerminal = { featureId: f.id, polygons };
      entries.push({ ref: near, minX: box.minX, minY: box.minY, maxX: box.maxX, maxY: box.maxY });
    }
    if (entries.length > 0) index.bulkLoad(entries);

    // The query rectangle: a point around the preview, widened by the snap world
    // margin (so a vertex within the screen snap distance but outside the terminal
    // bbox is still considered) plus a small epsilon so a coincident point still hits.
    const rawMargin = ctx.snapWorldMargin();
    const margin = Number.isFinite(rawMargin) && rawMargin > 0 ? rawMargin : 0;
    const queryBox: BBox = {
      minX: preview.lon - margin,
      minY: preview.lat - margin,
      maxX: preview.lon + margin,
      maxY: preview.lat + margin,
    };

    const edges: BoundaryEdge[] = [];
    const candidates: CandidateTerminal[] = [];
    const snapCandidates: SnapCandidate[] = [];

    const nearHits = entries.length > 0 ? index.search(queryBox) : [];
    const nearFeatureIds = new Set<string>();
    for (const hit of nearHits) {
      const near = hit.ref;
      nearFeatureIds.add(near.featureId);
      for (let p = 0; p < near.polygons.length; p += 1) {
        const polygon = near.polygons[p]!;
        edges.push(...polygonEdges(near.featureId, p, polygon));
        candidates.push({ featureId: near.featureId, polygon });
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
    if (draggedFeature !== undefined && draggedFeature.kind === FEATURE_KIND.Leaf) {
      containment = containmentFor(draggedFeature, ringId, store);
    }

    return containment === undefined
      ? { edges, candidates, snapCandidates }
      : { edges, candidates, snapCandidates, containment };
  };
}

/**
 * True iff `p` is within `margin` (world units, as a square — matching the query
 * rectangle) of `centre`. A zero margin keeps only an exactly-coincident point;
 * the actual snap proximity is decided in SCREEN space by decideSnap, so this is a
 * conservative pre-filter, never the snap rule.
 */
function withinMargin(p: WorldCoordinate, centre: WorldCoordinate, margin: number): boolean {
  return Math.abs(p.lon - centre.lon) <= margin && Math.abs(p.lat - centre.lat) <= margin;
}
