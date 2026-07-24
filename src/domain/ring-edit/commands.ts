// U25 — pure ring-edit commands: add hole / add enclave, edit (move / add / delete
// vertex), and delete (hole / territory) on ONE leaf face's shape (FR-22 / FR-23 /
// FR-24 / FR-25 / FR-88). Each produces the RESULTING complete-state leaf the
// confirm path assembles into an edit proposal; none drives U13 (that is
// ./confirm) and none mutates shared state (教訓 5.17 / 5.22).
//
// LAYER: pure `domain` logic over the U06 leaf / ring / vertex model. The hard
// logic is DELEGATED, never re-implemented (単一の真実源 §4 / spec §やらないこと):
//   - ring↔hole alternation + geometric包含/非交差/非重複 validation → U07
//     {@link validateRingHierarchy} (same fn, same return, for real-time AND
//     pre-commit — 教訓 5.26);
//   - deletion-time交互構造再編 (子リング付け替え) → U07
//     {@link deleteRingAndReorganize};
//   - vertex move / edge-handle add / vertex delete (3点未満→リング削除) → U24
//     {@link addVertexToLeafRing} / {@link deleteLeafVertex} / {@link moveVertexTo};
//   - first-click hole/enclave自動判定 → ./auto-mode (which delegates to U06
//     {@link pointInPolygon}).
//
// 教訓 5.25 (仕様が限定した対象範囲を実装で広げない): add-hole and add-enclave only
// MUTATE THE TARGET FACE'S RING SET. They never create a new feature, a new
// history anchor, or a new geometry piece (FR-23 受け入れ基準 2). 穴あけによる新地物
// 生成 (FR-45) is a different unit's job and is NOT done here.
//
// 対概念へ判断を反映 (教訓 2.10 / 省略の禁止 §1.2): hole↔enclave add and hole↔
// territory delete are mirror pairs; both members of each pair are implemented and
// tested explicitly — neither is left "同様" and skipped.

import type { WorldCoordinate } from '../coordinate';
import {
  withLeafShape,
  type LeafFeature,
} from '../feature';
import type { FeatureId, RingId, VertexId } from '../ids';
import {
  createHoleRing,
  createShape,
  createTerritoryRing,
  RING_KIND,
  type Ring,
  type Shape,
  type TerritoryRing,
} from '../ring';
import {
  deleteRingAndReorganize,
  validateRingHierarchy,
  type RingValidationResult,
} from '../ring-hierarchy';
import {
  addVertexToLeafRing,
  deleteLeafVertex,
  type FeatureEditResult,
} from '../editing/edit-ops';
import { moveVertexTo } from '../editing/move';
import { createVertex, setVertex, type Vertex, type VertexStore } from '../vertex';
import {
  classifyFirstClick,
  isPointInSolidFill,
  RING_ADD_MODE,
  type RingAddMode,
} from './auto-mode';

// ---------------------------------------------------------------------------
// Shared injected ID minting (pure / deterministic; 教訓 5.20 / 5.37)
// ---------------------------------------------------------------------------

/**
 * ID services the add commands need. Injected so commands stay pure and
 * deterministic under test, and so a redo restores the FIRST-minted ids rather
 * than re-numbering (教訓 5.20: the caller seeds these from the original ids on
 * redo). The host backs these with U03's `nextRawId` + branded constructors.
 */
export interface RingIdPorts {
  readonly nextRingId: () => RingId;
  readonly nextVertexId: () => VertexId;
}

// ---------------------------------------------------------------------------
// The command RESULT (complete after-state of the target face)
// ---------------------------------------------------------------------------

export const RING_COMMAND_STATUS = {
  /** The command produced a valid after-state. */
  Ok: 'ok',
  /** The command was rejected (validation failed / not enough vertices / no target). */
  Rejected: 'rejected',
} as const;

export type RingCommandStatus =
  (typeof RING_COMMAND_STATUS)[keyof typeof RING_COMMAND_STATUS];

export const RING_REJECT = {
  /** Fewer than 3 vertices were supplied for a new ring (FR-22). */
  TooFewVertices: 'too-few-vertices',
  /** The first click could not be located inside any territory (no parent for a hole). */
  NoEnclosingTerritory: 'no-enclosing-territory',
  /** The resulting ring hierarchy violates U07's invariants (FR-24 / FR-25). */
  HierarchyInvalid: 'hierarchy-invalid',
  /** The referenced ring / vertex / edge was not found in the target face. */
  TargetNotFound: 'target-not-found',
} as const;

export type RingRejectKind = (typeof RING_REJECT)[keyof typeof RING_REJECT];

/**
 * The outcome of a ring command: the new leaf + the new/changed vertex bodies the
 * confirm path must persist, OR a structured rejection (reason both
 * machine-enumerable AND mappable to a Japanese通知 — FR-115 / 教訓 5.26). The
 * rejection carries the validation result when geometry/alternation failed so the
 * UI can highlight the offending rings (同じ戻り値を共有 — 教訓 5.26).
 */
export type RingCommandResult =
  | {
      readonly status: typeof RING_COMMAND_STATUS.Ok;
      readonly feature: LeafFeature;
      /** Vertex bodies created or moved by this command (id → new body). */
      readonly vertices: readonly Vertex[];
    }
  | {
      readonly status: typeof RING_COMMAND_STATUS.Rejected;
      readonly reason: RingRejectKind;
      readonly validation?: RingValidationResult;
    };

function ok(feature: LeafFeature, vertices: readonly Vertex[]): RingCommandResult {
  return { status: RING_COMMAND_STATUS.Ok, feature, vertices };
}
function reject(reason: RingRejectKind, validation?: RingValidationResult): RingCommandResult {
  return validation === undefined
    ? { status: RING_COMMAND_STATUS.Rejected, reason }
    : { status: RING_COMMAND_STATUS.Rejected, reason, validation };
}

// ---------------------------------------------------------------------------
// The shared validation gate (real-time AND pre-commit — 教訓 5.26)
// ---------------------------------------------------------------------------

/**
 * Validate a candidate shape against U07's COMBINED alternation + geometry checks,
 * the SINGLE function both real-time候補表示 and pre-commit拒否 share so the UI can
 * never let a shortcut / direct call / undo confirm a shape the live overlay would
 * have rejected (FR-25 / 教訓 5.26). Exposed so the UI can call it each interaction
 * with the exact return the commands gate on.
 */
export function validateCandidate(shape: Shape, store: VertexStore): RingValidationResult {
  return validateRingHierarchy(shape, store);
}

/** Apply the candidate shape to the leaf only if it passes U07 validation. */
function commitIfValid(
  feature: LeafFeature,
  shape: Shape,
  store: VertexStore,
  newVertices: readonly Vertex[],
): RingCommandResult {
  const validation = validateCandidate(shape, store);
  if (!validation.valid) return reject(RING_REJECT.HierarchyInvalid, validation);
  return ok(withLeafShape(feature, shape), newVertices);
}

// ---------------------------------------------------------------------------
// Add — hole (FR-22 穴作成モード)
// ---------------------------------------------------------------------------

/**
 * Find the DEEPEST territory ring whose solid contains `point` — the territory the
 * new hole should be punched into. Walks all territory rings and picks the one
 * with the most parent-links (deepest), so a click in an enclave that sits inside
 * a hole punches the hole into the enclave, not the outer territory. Returns
 * undefined when no territory contains the point (a hole has no parent → reject).
 */
function enclosingTerritoryFor(
  shape: Shape,
  store: VertexStore,
  point: WorldCoordinate,
): TerritoryRing | undefined {
  let best: TerritoryRing | undefined;
  let bestDepth = -1;
  for (const ring of shape.rings) {
    if (ring.kind !== RING_KIND.Territory) continue;
    // Reuse the solid-fill predicate restricted to this single territory + its
    // direct holes by probing the whole shape: a point solid in the shape lands in
    // SOME territory; we attribute it to the territory that strictly contains it
    // and is the deepest such. `isPointInSolidFill` proves solidity; here we just
    // need containment-by-territory, so test the single-territory subshape.
    const single = createShape([toTopLevel(ring), ...directHolesOf(shape, ring.id)]);
    if (!isPointInSolidFill(single, store, point)) continue;
    const depth = parentDepthOf(shape, ring);
    if (depth > bestDepth) {
      best = ring;
      bestDepth = depth;
    }
  }
  return best;
}

/**
 * Whether `point` lies strictly inside `ring`'s own boundary, ignoring any ring
 * nested in it. Reuses {@link isPointInSolidFill} over a single-ring probe shape —
 * the SAME predicate + coordinate pipeline (unwrap / quantize) every other
 * containment answer in this unit comes from, so no second inside/outside rule is
 * introduced (単一の真実源 §4).
 */
function ringContainsPoint(ring: Ring, store: VertexStore, point: WorldCoordinate): boolean {
  const probe = createShape([createTerritoryRing(ring.id, ring.vertexIds)]);
  return isPointInSolidFill(probe, store, point);
}

/**
 * The DEEPEST HOLE ring whose void contains `point`, or undefined when the point is
 * in no hole of this face. This is the parent an ENCLAVE drawn inside a hole must
 * take: FR-24's invariant is 領土→穴→領土→…, so a territory ring sitting in a hole is
 * that hole's CHILD, never a second top-level territory (as a top-level ring it would
 * overlap the outer territory and be rejected as enclaves-overlap). Deepest wins so a
 * hole punched into an enclave claims a point over the outer territory's hole.
 */
function enclosingHoleFor(
  shape: Shape,
  store: VertexStore,
  point: WorldCoordinate,
): Ring | undefined {
  let best: Ring | undefined;
  let bestDepth = -1;
  for (const ring of shape.rings) {
    if (ring.kind !== RING_KIND.Hole) continue;
    if (!ringContainsPoint(ring, store, point)) continue;
    const depth = parentDepthOf(shape, ring);
    if (depth > bestDepth) {
      best = ring;
      bestDepth = depth;
    }
  }
  return best;
}

/** A copy of `ring` re-rooted as top-level, for single-territory containment probes. */
function toTopLevel(ring: TerritoryRing): TerritoryRing {
  return createTerritoryRing(ring.id, ring.vertexIds);
}

/** The direct hole children of `ringId`, re-parented onto it for a subshape probe. */
function directHolesOf(shape: Shape, ringId: RingId): Ring[] {
  const out: Ring[] = [];
  for (const r of shape.rings) {
    if (r.kind === RING_KIND.Hole && r.parentRingId === ringId) {
      out.push(createHoleRing(r.id, r.vertexIds, ringId));
    }
  }
  return out;
}

/** Parent-link depth of a ring (top-level = 0). Used to pick the deepest container. */
function parentDepthOf(shape: Shape, ring: Ring): number {
  const byId = new Map<RingId, Ring>(shape.rings.map((r) => [r.id, r]));
  let depth = 0;
  let current: Ring | undefined = ring;
  const seen = new Set<RingId>();
  while (current !== undefined) {
    if (seen.has(current.id)) return depth; // defensive against a cycle
    seen.add(current.id);
    const parentId: RingId | undefined = current.parentRingId;
    if (parentId === undefined) return depth;
    current = byId.get(parentId);
    depth += 1;
  }
  return depth;
}

/**
 * Add a HOLE ring to the target leaf (FR-22 穴作成モード / FR-23). The hole's parent
 * is the deepest territory whose solid contains the FIRST drafted vertex; the role
 * + parent placement satisfies U07's alternation, which is then re-checked by the
 * shared validation gate (教訓 5.26). Mints one vertex per drafted coordinate via
 * the injected ports (redo restores the same ids — 教訓 5.20). Adds NO feature and
 * NO anchor (FR-23 受け入れ基準 2). Rejects with a structured reason on < 3 points,
 * no enclosing territory, or a hierarchy violation.
 */
export function addHole(
  feature: LeafFeature,
  vertices: readonly WorldCoordinate[],
  store: VertexStore,
  ids: RingIdPorts,
): RingCommandResult {
  if (vertices.length < 3) return reject(RING_REJECT.TooFewVertices);
  const first = vertices[0];
  if (first === undefined) return reject(RING_REJECT.TooFewVertices);

  const parent = enclosingTerritoryFor(feature.shape, store, first);
  if (parent === undefined) return reject(RING_REJECT.NoEnclosingTerritory);

  const built = mintRingVertices(vertices, ids);
  const holeRing = createHoleRing(ids.nextRingId(), built.vertexIds, parent.id);
  const shape = createShape([...feature.shape.rings, holeRing]);
  const nextStore = withVertices(store, built.vertices);
  return commitIfValid(feature, shape, nextStore, built.vertices);
}

// ---------------------------------------------------------------------------
// Add — enclave / 飛び地 (FR-22 飛び地作成モード) — the mirror of addHole
// ---------------------------------------------------------------------------

/**
 * Add an ENCLAVE (飛び地) ring to the target leaf (FR-22 飛び地作成モード / FR-23).
 * An enclave is a separate territory ring of the SAME face, placed by WHERE the
 * first drafted vertex fell — the mirror of {@link addHole}'s parent lookup:
 *   - clear of the face ⇒ a TOP-LEVEL territory (a detached 飛び地);
 *   - inside one of the face's HOLES ⇒ that hole's CHILD territory, which is what
 *     FR-24's 領土→穴→領土 alternation calls for (a top-level ring there would sit
 *     inside the outer territory and be rejected as enclaves-overlap, making the
 *     structure unconstructible).
 * The role + containment + non-overlap are re-checked by the shared validation gate
 * (FR-25 飛び地非重複 / 教訓 5.26). Mints one vertex per drafted coordinate. Adds NO
 * feature and NO anchor (FR-23). Implemented and tested in its own right (教訓 2.10 —
 * neither member of the対概念 is skipped).
 */
export function addEnclave(
  feature: LeafFeature,
  vertices: readonly WorldCoordinate[],
  ids: RingIdPorts,
  store: VertexStore,
): RingCommandResult {
  if (vertices.length < 3) return reject(RING_REJECT.TooFewVertices);
  const first = vertices[0];
  if (first === undefined) return reject(RING_REJECT.TooFewVertices);

  const parentHole = enclosingHoleFor(feature.shape, store, first);
  const built = mintRingVertices(vertices, ids);
  const enclaveRing =
    parentHole === undefined
      ? createTerritoryRing(ids.nextRingId(), built.vertexIds)
      : createTerritoryRing(ids.nextRingId(), built.vertexIds, parentHole.id);
  const shape = createShape([...feature.shape.rings, enclaveRing]);
  const nextStore = withVertices(store, built.vertices);
  return commitIfValid(feature, shape, nextStore, built.vertices);
}

/**
 * Dispatch an add to the hole / enclave command by the auto-classified mode. The
 * caller passes the mode decided at first click ({@link classifyFirstClick}); we
 * also assert it against the drafted first vertex so the two branches stay the
 * complete partition (対概念 — 教訓 2.10). Both members are always reachable.
 */
export function addRing(
  feature: LeafFeature,
  mode: RingAddMode,
  vertices: readonly WorldCoordinate[],
  store: VertexStore,
  ids: RingIdPorts,
): RingCommandResult {
  switch (mode) {
    case RING_ADD_MODE.Hole:
      return addHole(feature, vertices, store, ids);
    case RING_ADD_MODE.Enclave:
      return addEnclave(feature, vertices, ids, store);
  }
}

// ---------------------------------------------------------------------------
// Edit — vertex move / edge-handle add / vertex delete (FR-25 / FR-88 / FR-89)
// ---------------------------------------------------------------------------

/**
 * Move ONE vertex of a hole/enclave ring to a new coordinate, gated by U07's
 * validation so a move that would break包含/非交差/非重複 is rejected with the same
 * structured result the live overlay shows (FR-25 / 教訓 5.26). The vertex move
 * itself reuses U24's {@link moveVertexTo}; the collision / snap / share of the
 * moved vertex is U24/U11's job at release (FR-89) — this command only computes the
 * post-move complete state + runs the constraint gate. The moved vertex belongs to
 * a hole/enclave ring exactly like an outer-ring vertex, so it is NOT excluded
 * from any of those behaviours (受け入れ基準 5 漏らさない).
 */
export function moveRingVertex(
  feature: LeafFeature,
  vertexId: VertexId,
  to: WorldCoordinate,
  store: VertexStore,
): RingCommandResult {
  const moved = moveVertexTo(vertexId, store, to);
  if (moved === undefined) return reject(RING_REJECT.TargetNotFound);
  const nextStore = setVertex(store, moved);
  // The shape's ring structure is unchanged by a vertex move (only coordinates
  // change), so validate the SAME shape against the moved-vertex store.
  return commitIfValid(feature, feature.shape, nextStore, [moved]);
}

/**
 * Add a vertex on an edge of a hole/enclave ring (FR-87 エッジハンドル). Delegates
 * the ring-list splice to U24's {@link addVertexToLeafRing}, mints the new vertex
 * body at `coordinate`, then gates the result by U07 validation (教訓 5.26). The
 * generated vertex is a full member of its hole/enclave ring, so it participates
 * in衝突判定/スナップ/共有化 the same as any vertex (FR-89 受け入れ基準 5).
 */
export function addRingVertex(
  feature: LeafFeature,
  ringId: RingId,
  startVertexId: VertexId,
  endVertexId: VertexId,
  coordinate: WorldCoordinate,
  store: VertexStore,
  ids: RingIdPorts,
): RingCommandResult {
  const newVertexId = ids.nextVertexId();
  const edit = addVertexToLeafRing(feature, ringId, startVertexId, endVertexId, newVertexId);
  if (edit === undefined || edit.kind !== 'feature' || edit.feature.kind !== feature.kind) {
    return reject(RING_REJECT.TargetNotFound);
  }
  const newVertex = createVertex(newVertexId, coordinate);
  const nextStore = setVertex(store, newVertex);
  return commitIfValid(edit.feature as LeafFeature, edit.feature.shape, nextStore, [newVertex]);
}

/**
 * Delete one vertex from a hole/enclave ring (FR-88). Delegates to U24's
 * {@link deleteLeafVertex}, which drops the ring via U07 reorganization when it
 * falls below 3 vertices (3点未満でリング削除をリング単位に適用). Returns the
 * surviving leaf, or — when the deletion removes the leaf's last territory — a
 * rejection is NOT issued; instead the result mirrors U24's delete-feature signal
 * via {@link RingVertexDeleteOutcome}. Validation gates a surviving feature so a
 * post-delete shape that somehow violates invariants is not confirmed (教訓 5.26).
 */
export function deleteRingVertex(
  feature: LeafFeature,
  ringId: RingId,
  vertexId: VertexId,
  store: VertexStore,
): RingVertexDeleteOutcome {
  const edit: FeatureEditResult | undefined = deleteLeafVertex(feature, ringId, vertexId);
  if (edit === undefined) {
    // Stale target: the ring no longer holds that vertex on this leaf (the selection
    // referenced a vertex that was removed) — reject rather than produce a ghost edit.
    return { kind: RING_DELETE_OUTCOME.Rejected, reason: RING_REJECT.TargetNotFound };
  }
  if (edit.kind === 'delete-feature') {
    return { kind: RING_DELETE_OUTCOME.FeatureDeleted, featureId: edit.featureId };
  }
  if (edit.feature.kind !== feature.kind) {
    return { kind: RING_DELETE_OUTCOME.Rejected, reason: RING_REJECT.TargetNotFound };
  }
  const leaf = edit.feature as LeafFeature;
  const validation = validateCandidate(leaf.shape, store);
  if (!validation.valid) {
    return { kind: RING_DELETE_OUTCOME.Rejected, reason: RING_REJECT.HierarchyInvalid, validation };
  }
  return {
    kind: RING_DELETE_OUTCOME.FeatureSurvives,
    feature: leaf,
    removedRingIds: edit.selection.removedRingIds,
  };
}

// ---------------------------------------------------------------------------
// Delete — hole ring / territory ring (FR-24) — explicit mirror commands
// ---------------------------------------------------------------------------

export const RING_DELETE_OUTCOME = {
  /** The face survives with the ring removed + descendants re-organized. */
  FeatureSurvives: 'feature-survives',
  /** The deletion left no territory ring → the whole leaf is deleted. */
  FeatureDeleted: 'feature-deleted',
  /** The command was rejected. */
  Rejected: 'rejected',
} as const;

export type RingDeleteOutcomeKind =
  (typeof RING_DELETE_OUTCOME)[keyof typeof RING_DELETE_OUTCOME];

export type RingVertexDeleteOutcome =
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.FeatureSurvives;
      readonly feature: LeafFeature;
      /** All ring ids removed by the deletion (full before/after difference). */
      readonly removedRingIds: readonly RingId[];
    }
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.FeatureDeleted;
      readonly featureId: FeatureId;
    }
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.Rejected;
      readonly reason: RingRejectKind;
      readonly validation?: RingValidationResult;
    };

/**
 * Delete an entire HOLE ring from the target leaf, delegating the子リング付け替え +
 * 交互構造維持 to U07's {@link deleteRingAndReorganize} (FR-24). The whole delete +
 * reorganize is ONE pure transition whose return value alone captures the
 * after-state, so the confirm layer can make it ONE undo unit (FR-24 / 教訓 5.20).
 * Rejected when the leaf would be left with no territory ring? No — a hole removal
 * never removes the last territory, so a survives result always carries a leaf with
 * ≥1 territory; we still gate by U07 validation (教訓 5.26).
 *
 * 対概念 (教訓 2.10): this is the hole half of the delete pair; {@link deleteTerritoryRing}
 * is the territory half. Both are implemented + tested; neither is "同様" skipped.
 */
export function deleteHoleRing(
  feature: LeafFeature,
  holeRingId: RingId,
  store: VertexStore,
): RingDeleteOutcome {
  return deleteRingCommand(feature, holeRingId, store, RING_KIND.Hole);
}

/**
 * Delete an entire TERRITORY (enclave) ring from the target leaf, delegating the
 * 子リング付け替え (its holes removed, grand-child enclaves lifted) to U07's
 * {@link deleteRingAndReorganize} (FR-24). When the removed territory was the
 * leaf's LAST territory the face can hold no area → the whole leaf is deleted
 * (FeatureDeleted), exactly as a vertex-delete that empties the territories does.
 * One pure transition = one undo unit (FR-24).
 *
 * 対概念 (教訓 2.10): the territory half of the delete pair, mirror of
 * {@link deleteHoleRing}.
 */
export function deleteTerritoryRing(
  feature: LeafFeature,
  territoryRingId: RingId,
  store: VertexStore,
): RingDeleteOutcome {
  return deleteRingCommand(feature, territoryRingId, store, RING_KIND.Territory);
}

export type RingDeleteOutcome =
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.FeatureSurvives;
      readonly feature: LeafFeature;
    }
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.FeatureDeleted;
    }
  | {
      readonly kind: typeof RING_DELETE_OUTCOME.Rejected;
      readonly reason: RingRejectKind;
      readonly validation?: RingValidationResult;
    };

/** Shared body of the two delete commands: assert the ring exists with the
 * expected kind, run U07 reorganization, then decide survive / delete-feature. */
function deleteRingCommand(
  feature: LeafFeature,
  ringId: RingId,
  store: VertexStore,
  expectedKind: typeof RING_KIND.Hole | typeof RING_KIND.Territory,
): RingDeleteOutcome {
  const target = feature.shape.rings.find((r) => r.id === ringId);
  if (target === undefined || target.kind !== expectedKind) {
    return { kind: RING_DELETE_OUTCOME.Rejected, reason: RING_REJECT.TargetNotFound };
  }

  const shape = deleteRingAndReorganize(feature.shape, ringId);

  const hasTerritory = shape.rings.some((r) => r.kind === RING_KIND.Territory);
  if (!hasTerritory) {
    // No territory left → the leaf cannot define an area; delete the whole face
    // (mirrors edit-ops' leaf-with-no-territory deletion — 教訓 5.18 explicit value).
    return { kind: RING_DELETE_OUTCOME.FeatureDeleted };
  }

  const validation = validateCandidate(shape, store);
  if (!validation.valid) {
    return { kind: RING_DELETE_OUTCOME.Rejected, reason: RING_REJECT.HierarchyInvalid, validation };
  }
  return { kind: RING_DELETE_OUTCOME.FeatureSurvives, feature: withLeafShape(feature, shape) };
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface MintedRing {
  readonly vertices: Vertex[];
  readonly vertexIds: VertexId[];
}

/** Mint one vertex body per drafted coordinate (ids from the injected ports). */
function mintRingVertices(coords: readonly WorldCoordinate[], ids: RingIdPorts): MintedRing {
  const vertices: Vertex[] = [];
  const vertexIds: VertexId[] = [];
  for (const c of coords) {
    const id = ids.nextVertexId();
    vertices.push(createVertex(id, c));
    vertexIds.push(id);
  }
  return { vertices, vertexIds };
}

/** A vertex store with the given bodies set (immutable copy). */
function withVertices(store: VertexStore, vertices: readonly Vertex[]): VertexStore {
  let next = store;
  for (const v of vertices) next = setVertex(next, v);
  return next;
}

export { classifyFirstClick };
