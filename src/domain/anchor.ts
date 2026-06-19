// History anchor (FR-54) — structural type frame only.
//
// The temporal-axis logic (ordering of anchors, overlap resolution,
// normalization) is a SEPARATE unit and is NOT implemented here. This unit
// only provides the anchor ID and the shape of the "full-state snapshot" that
// an anchor holds. Per the spec, an anchor's snapshot is composed of the
// feature types, attribute/color/shape types, and parent/child references
// defined by this unit — so the snapshot is just a plain, immutable bundle of
// those domain values plus the vertex store they reference (lesson 5.20: undo
// information must capture dependent data too, and persist as plain data).

import type { AnchorId } from './ids';
import type { Feature } from './feature';
import type { VertexStore } from './vertex';

/**
 * A complete snapshot of domain state at an anchor: every feature plus the
 * vertex store the features reference by ID. No derived values (aggregate
 * shapes, hierarchy depth) are stored — those are recomputed (FR-35 / FR-38).
 */
export interface AnchorSnapshot {
  readonly features: readonly Feature[];
  readonly vertices: VertexStore;
}

export interface Anchor {
  readonly id: AnchorId;
  readonly snapshot: AnchorSnapshot;
}

export function createAnchorSnapshot(
  features: readonly Feature[],
  vertices: VertexStore,
): AnchorSnapshot {
  return { features, vertices };
}

export function createAnchor(id: AnchorId, snapshot: AnchorSnapshot): Anchor {
  return { id, snapshot };
}
