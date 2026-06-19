// Vertex value object + vertex store (tech policy R6).
//
// A vertex is an immutable value object holding its own ID and world
// coordinate. Sharing between rings / lines is expressed purely by referencing
// the same VertexId — never by embedding duplicate vertex instances (spec:
// "頂点インスタンスをリング／線形へ直接埋め込む実装をしない"). The actual
// vertex bodies live in a single VertexStore (VertexId -> Vertex), so a shared
// vertex resolves to exactly one body and dragging it moves every referrer
// (groundwork for shared-vertex linking in a later unit).
//
// Equality is by attribute value (ID and coordinate), per lesson 5.17.

import { coordinatesEqual, type WorldCoordinate } from './coordinate';
import type { VertexId } from './ids';

export interface Vertex {
  readonly id: VertexId;
  readonly coordinate: WorldCoordinate;
}

export function createVertex(id: VertexId, coordinate: WorldCoordinate): Vertex {
  return { id, coordinate };
}

/** Attribute-value equality: same ID and same coordinate. */
export function verticesEqual(a: Vertex, b: Vertex): boolean {
  return a.id === b.id && coordinatesEqual(a.coordinate, b.coordinate);
}

// --- withXxx (every attribute covered: id, coordinate) ----------------------

export function withVertexId(vertex: Vertex, id: VertexId): Vertex {
  return { id, coordinate: vertex.coordinate };
}

export function withVertexCoordinate(
  vertex: Vertex,
  coordinate: WorldCoordinate,
): Vertex {
  return { id: vertex.id, coordinate };
}

// --- Vertex store -----------------------------------------------------------
//
// Immutable map from VertexId to Vertex. Read/write helpers return a new store
// rather than mutating in place. Spatial-index integration and proximity snap
// are explicitly out of scope for this unit; this is the minimal pure store.

export interface VertexStore {
  readonly byId: ReadonlyMap<VertexId, Vertex>;
}

export function createVertexStore(vertices: readonly Vertex[] = []): VertexStore {
  const byId = new Map<VertexId, Vertex>();
  for (const v of vertices) {
    byId.set(v.id, v);
  }
  return { byId };
}

/**
 * Resolve a vertex by ID. Returns `undefined` if absent (the caller must
 * handle the missing case rather than assuming presence — consistent with the
 * `noUncheckedIndexedAccess` discipline for array access).
 */
export function getVertex(store: VertexStore, id: VertexId): Vertex | undefined {
  return store.byId.get(id);
}

export function hasVertex(store: VertexStore, id: VertexId): boolean {
  return store.byId.has(id);
}

/** Insert or replace a vertex, returning a new store. */
export function setVertex(store: VertexStore, vertex: Vertex): VertexStore {
  const byId = new Map(store.byId);
  byId.set(vertex.id, vertex);
  return { byId };
}

/** Remove a vertex by ID, returning a new store. */
export function removeVertex(store: VertexStore, id: VertexId): VertexStore {
  if (!store.byId.has(id)) {
    return store;
  }
  const byId = new Map(store.byId);
  byId.delete(id);
  return { byId };
}
