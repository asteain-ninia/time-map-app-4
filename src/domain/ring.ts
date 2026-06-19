// Ring discriminated union (territory / hole) and the leaf feature's shape.
//
// A ring describes a closed path by an *ordered array of vertex IDs* (FR-20),
// never by embedding vertex instances — sharing is by ID reference (tech
// policy R6). The discriminant is the literal `kind` field, so a `switch` over
// rings is exhaustiveness-checked via `assertNever`.
//
// Hierarchy: rings form a forest via `parentRingId`. The territory -> hole ->
// territory -> ... alternation cannot be fully captured by the type system, so
// it is partly typed and partly a runtime invariant:
//   - A hole ring *must* reference a parent (a hole can never be outermost):
//     `parentRingId` is REQUIRED on HoleRing. Constructing a parentless hole is
//     a compile error.
//   - A territory ring's parent is OPTIONAL: a top-level territory has none; a
//     territory nested inside a hole (an enclave) references that hole.
//   - The full alternation (parent of a hole is a territory, parent of a nested
//     territory is a hole) is enforced at runtime by `isAlternationValid`.

import { assertNever } from './assert-never';
import type { RingId, VertexId } from './ids';

export const RING_KIND = {
  Territory: 'territory',
  Hole: 'hole',
} as const;

export type RingKind = (typeof RING_KIND)[keyof typeof RING_KIND];

/** Outer boundary of a (sub)area. May be top-level (no parent) or an enclave. */
export interface TerritoryRing {
  readonly kind: typeof RING_KIND.Territory;
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  /** Absent => outermost (top-level). Present => enclave inside a hole. */
  readonly parentRingId?: RingId;
}

/** A hole punched into a territory. Always has a parent (never outermost). */
export interface HoleRing {
  readonly kind: typeof RING_KIND.Hole;
  readonly id: RingId;
  readonly vertexIds: readonly VertexId[];
  /** REQUIRED: a hole can never be the outermost ring. */
  readonly parentRingId: RingId;
}

export type Ring = TerritoryRing | HoleRing;

// --- Constructors -----------------------------------------------------------

export function createTerritoryRing(
  id: RingId,
  vertexIds: readonly VertexId[],
  parentRingId?: RingId,
): TerritoryRing {
  // exactOptionalPropertyTypes: only set the key when a parent is given.
  return parentRingId === undefined
    ? { kind: RING_KIND.Territory, id, vertexIds }
    : { kind: RING_KIND.Territory, id, vertexIds, parentRingId };
}

export function createHoleRing(
  id: RingId,
  vertexIds: readonly VertexId[],
  parentRingId: RingId,
): HoleRing {
  return { kind: RING_KIND.Hole, id, vertexIds, parentRingId };
}

// --- Shape (what a leaf feature owns) ---------------------------------------
//
// A shape is the set of rings making up a leaf feature's area: territory rings
// (with optional enclaves) and hole rings. Hierarchy is carried by each ring's
// parentRingId, not by nesting, so the structure stays flat and plain-mappable.

export interface Shape {
  readonly rings: readonly Ring[];
}

export function createShape(rings: readonly Ring[] = []): Shape {
  return { rings };
}

/** Lesson 5.18: emptiness is decided by length, not by a falsy short-circuit. */
export function isShapeEmpty(shape: Shape): boolean {
  return shape.rings.length === 0;
}

// --- withXxx for rings (every attribute covered) ----------------------------

export function withTerritoryRingVertexIds(
  ring: TerritoryRing,
  vertexIds: readonly VertexId[],
): TerritoryRing {
  return ring.parentRingId === undefined
    ? { kind: RING_KIND.Territory, id: ring.id, vertexIds }
    : { kind: RING_KIND.Territory, id: ring.id, vertexIds, parentRingId: ring.parentRingId };
}

export function withTerritoryRingParent(
  ring: TerritoryRing,
  parentRingId: RingId | undefined,
): TerritoryRing {
  return parentRingId === undefined
    ? { kind: RING_KIND.Territory, id: ring.id, vertexIds: ring.vertexIds }
    : { kind: RING_KIND.Territory, id: ring.id, vertexIds: ring.vertexIds, parentRingId };
}

export function withHoleRingVertexIds(
  ring: HoleRing,
  vertexIds: readonly VertexId[],
): HoleRing {
  return { kind: RING_KIND.Hole, id: ring.id, vertexIds, parentRingId: ring.parentRingId };
}

export function withHoleRingParent(ring: HoleRing, parentRingId: RingId): HoleRing {
  return { kind: RING_KIND.Hole, id: ring.id, vertexIds: ring.vertexIds, parentRingId };
}

// --- Runtime alternation invariant ------------------------------------------

/** True iff this ring is top-level (a territory with no parent). */
export function isTopLevelRing(ring: Ring): boolean {
  switch (ring.kind) {
    case RING_KIND.Territory:
      return ring.parentRingId === undefined;
    case RING_KIND.Hole:
      // A hole always has a parent, so it is never top-level.
      return false;
    default:
      return assertNever(ring);
  }
}

/**
 * Runtime invariant for the territory -> hole -> territory -> ... alternation
 * that the type system cannot fully express:
 *   - every hole's parent exists and is a territory ring;
 *   - every non-top-level territory's parent exists and is a hole ring;
 *   - top-level rings are territories (holes are never outermost).
 *
 * Returns true iff the alternation holds for every ring in the shape.
 */
export function isAlternationValid(shape: Shape): boolean {
  const byId = new Map<RingId, Ring>();
  for (const ring of shape.rings) {
    byId.set(ring.id, ring);
  }

  for (const ring of shape.rings) {
    switch (ring.kind) {
      case RING_KIND.Territory: {
        if (ring.parentRingId === undefined) {
          break; // top-level territory: valid.
        }
        const parent = byId.get(ring.parentRingId);
        // A nested territory (enclave) must sit inside a hole.
        if (parent === undefined || parent.kind !== RING_KIND.Hole) {
          return false;
        }
        break;
      }
      case RING_KIND.Hole: {
        const parent = byId.get(ring.parentRingId);
        // A hole must sit inside a territory.
        if (parent === undefined || parent.kind !== RING_KIND.Territory) {
          return false;
        }
        break;
      }
      default:
        return assertNever(ring);
    }
  }
  return true;
}
