// U24 — vertex / edge handle model (FR-87).
//
// Given a selected feature's evaluated shape, compute the structured data the
// render layer and hit-test consume: one VERTEX handle per vertex (the target of
// "move" / "delete") and one EDGE handle per edge midpoint (the target of "add a
// new vertex"). Each handle carries WORLD coordinates + a kind + its origin
// (which ring / which vertex id / which edge endpoints) so the caller can map a
// hit back to a structural element (受け入れ基準1).
//
// LAYER: pure `domain` logic. This unit supplies world coordinates and kinds
// only; the on-screen constant-size rendering (FR-17, world→screen) is the render
// layer's job (spec §スコープ「ハンドルの画面上一定サイズ表示はワールド→スクリーン
// 変換の責務」). We never compute screen coordinates here.
//
// Origin model: a handle's origin identifies the structural element it came from.
//   - point feature: one vertex handle (no edges → no edge handles).
//   - line feature: a vertex handle per vertex; an edge handle per consecutive
//     pair (an open path: n vertices → n-1 edges, NOT closed).
//   - leaf feature: per RING (territory / hole / enclave) a vertex handle per
//     vertex and an edge handle per edge of the implicitly-CLOSED ring (last→first
//     edge included), so hole rings and enclave rings each get their own handles
//     (受け入れ基準1「穴リング・飛び地リングの各辺にもエッジハンドルが出る」).

import type { WorldCoordinate } from '../coordinate';
import { getVertex, type VertexStore } from '../vertex';
import type { FeatureId, RingId, VertexId } from '../ids';
import {
  FEATURE_KIND,
  type Feature,
  type LeafFeature,
  type LineFeature,
  type PointFeature,
} from '../feature';
import { RING_KIND, type Ring } from '../ring';

export const HANDLE_KIND = {
  /** A vertex handle: move / delete target (FR-87). */
  Vertex: 'vertex',
  /** An edge-midpoint handle: add-a-new-vertex target (FR-87). */
  Edge: 'edge',
} as const;

export type HandleKind = (typeof HANDLE_KIND)[keyof typeof HANDLE_KIND];

/**
 * Where a vertex handle came from: the owning feature, the ring it belongs to
 * (absent for a point / line — they have no ring), and the vertex id. The world
 * coordinate is the vertex's evaluated position.
 */
export interface VertexHandle {
  readonly kind: typeof HANDLE_KIND.Vertex;
  readonly featureId: FeatureId;
  /** The ring the vertex belongs to (leaf only); absent for point / line. */
  readonly ringId?: RingId;
  readonly vertexId: VertexId;
  readonly position: WorldCoordinate;
}

/**
 * Where an edge handle came from: the owning feature, ring (leaf only), and the
 * two endpoint vertex ids of the edge. The world coordinate is the edge midpoint;
 * dragging it inserts a new vertex between `startVertexId` and `endVertexId`.
 */
export interface EdgeHandle {
  readonly kind: typeof HANDLE_KIND.Edge;
  readonly featureId: FeatureId;
  readonly ringId?: RingId;
  readonly startVertexId: VertexId;
  readonly endVertexId: VertexId;
  readonly midpoint: WorldCoordinate;
}

/** The structured handle set for a selected feature (the render layer reads it). */
export interface EditHandles {
  readonly vertices: readonly VertexHandle[];
  readonly edges: readonly EdgeHandle[];
}

/** The empty handle set (a feature with no resolvable vertices). 教訓5.18. */
export const EMPTY_HANDLES: EditHandles = { vertices: [], edges: [] };

function midpoint(a: WorldCoordinate, b: WorldCoordinate): WorldCoordinate {
  return { lon: (a.lon + b.lon) / 2, lat: (a.lat + b.lat) / 2 };
}

function vertexHandle(
  featureId: FeatureId,
  vertexId: VertexId,
  position: WorldCoordinate,
  ringId?: RingId,
): VertexHandle {
  return ringId === undefined
    ? { kind: HANDLE_KIND.Vertex, featureId, vertexId, position }
    : { kind: HANDLE_KIND.Vertex, featureId, ringId, vertexId, position };
}

function edgeHandle(
  featureId: FeatureId,
  startVertexId: VertexId,
  endVertexId: VertexId,
  mid: WorldCoordinate,
  ringId?: RingId,
): EdgeHandle {
  return ringId === undefined
    ? { kind: HANDLE_KIND.Edge, featureId, startVertexId, endVertexId, midpoint: mid }
    : { kind: HANDLE_KIND.Edge, featureId, ringId, startVertexId, endVertexId, midpoint: mid };
}

// --- per-variant computation ------------------------------------------------

function pointHandles(feature: PointFeature, store: VertexStore): EditHandles {
  const v = getVertex(store, feature.vertexId);
  if (v === undefined) return EMPTY_HANDLES;
  return { vertices: [vertexHandle(feature.id, feature.vertexId, v.coordinate)], edges: [] };
}

function lineHandles(feature: LineFeature, store: VertexStore): EditHandles {
  const vertices: VertexHandle[] = [];
  const edges: EdgeHandle[] = [];
  const ids = feature.vertexIds;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id === undefined) continue;
    const v = getVertex(store, id);
    if (v === undefined) continue;
    vertices.push(vertexHandle(feature.id, id, v.coordinate));
    // Open path: an edge to the NEXT vertex only (no wrap-around closing edge).
    if (i + 1 < ids.length) {
      const nextId = ids[i + 1];
      if (nextId === undefined) continue;
      const next = getVertex(store, nextId);
      if (next === undefined) continue;
      edges.push(edgeHandle(feature.id, id, nextId, midpoint(v.coordinate, next.coordinate)));
    }
  }
  return { vertices, edges };
}

function ringHandles(
  featureId: FeatureId,
  ring: Ring,
  store: VertexStore,
  out: { vertices: VertexHandle[]; edges: EdgeHandle[] },
): void {
  const ids = ring.vertexIds;
  const n = ids.length;
  for (let i = 0; i < n; i += 1) {
    const id = ids[i];
    if (id === undefined) continue;
    const v = getVertex(store, id);
    if (v === undefined) continue;
    out.vertices.push(vertexHandle(featureId, id, v.coordinate, ring.id));
    // Closed ring: edge to the next vertex with wrap-around (last → first).
    const nextId = ids[(i + 1) % n];
    if (nextId === undefined) continue;
    const next = getVertex(store, nextId);
    if (next === undefined) continue;
    out.edges.push(
      edgeHandle(featureId, id, nextId, midpoint(v.coordinate, next.coordinate), ring.id),
    );
  }
}

function leafHandles(feature: LeafFeature, store: VertexStore): EditHandles {
  const out = { vertices: [] as VertexHandle[], edges: [] as EdgeHandle[] };
  for (const ring of feature.shape.rings) {
    // Every ring — territory, hole AND enclave — gets handles (受け入れ基準1).
    if (ring.kind !== RING_KIND.Territory && ring.kind !== RING_KIND.Hole) continue;
    ringHandles(feature.id, ring, store, out);
  }
  return { vertices: out.vertices, edges: out.edges };
}

/**
 * Compute the handle set for a feature against its evaluated vertex store. An
 * aggregate feature has no own shape (FR-35) → no handles. 受け入れ基準1.
 */
export function computeHandles(feature: Feature, store: VertexStore): EditHandles {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return pointHandles(feature, store);
    case FEATURE_KIND.Line:
      return lineHandles(feature, store);
    case FEATURE_KIND.Leaf:
      return leafHandles(feature, store);
    case FEATURE_KIND.Aggregate:
      // Aggregates carry no shape of their own; nothing to edit directly (FR-35 /
      // 教訓5.25: do not widen handle computation to derived union shapes).
      return EMPTY_HANDLES;
    default:
      return EMPTY_HANDLES;
  }
}
