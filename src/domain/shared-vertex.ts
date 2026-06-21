// U11: shared-vertex system — value-object + ID-reference sharing, group
// derivation, sharing / linked-move / unshare commands, participation
// restriction, injected result validators, continuity rules (split/merge/edge
// cut), and unshare auto-resharing suppression. (FR-30 / FR-32 / FR-33 / FR-95)
//
// LAYER: pure `domain` logic. No React / Electron / Canvas / RBush /
// polygon-clipping import — geometric result validation is DELEGATED to injected
// validators (U06/U07/U10 bind their services into the interface here; §4.4 /
// 教訓5.33). Screen-space snap proximity (FR-31) is the edit session's (U24)
// concern; this unit consumes an already-decided shape-reference pair.
//
// SINGLE SOURCE OF TRUTH (技術方針 R6 / 開発ガイド §4): vertex coordinates live
// in exactly one VertexStore; rings (面情報) and line paths (線情報) reference
// vertices by ID only. "Sharing" === one VertexId referenced by ≥2 distinct
// shape references. The shared-vertex group is NEVER a stored entity; it is
// DERIVED at runtime from the reverse index, and every consumer (sharing,
// linked move, unshare, participation restriction, continuity) uses that one
// derivation (ドリフト防止 / 教訓5.30 過少共有の戒め).

import { coordinatesEqual, type WorldCoordinate } from './coordinate';
import { quantizedEqual } from './geometry/index';
import { nextRawId, type IdGeneratorState, type TimeSource } from './id-generator';
import { asVertexId, type DomainId, type FeatureId, type VertexId } from './ids';
import {
  createVertex,
  getVertex,
  removeVertex,
  setVertex,
  withVertexCoordinate,
  type Vertex,
  type VertexStore,
} from './vertex';

// ---------------------------------------------------------------------------
// Shape reference: which (feature, ring/path, position) cites a vertex.
// ---------------------------------------------------------------------------
//
// A vertex's shape references are the (feature, ring-or-path, list position)
// sites that hold its VertexId. Two distinct sites referencing one VertexId are
// a share. The "container" identifies a single ring (by RingId) of a leaf
// feature OR the path of a line feature; it is what participation restriction
// (§4.3) keys on: "same ring" / "same line path".

/** The container of a vertex citation: one ring of a leaf, or a line's path. */
export type ShapeContainer =
  | { readonly kind: 'ring'; readonly featureId: FeatureId; readonly ringId: string }
  | { readonly kind: 'line'; readonly featureId: FeatureId };

/** A single citation of a vertex: a container plus the position in its ID list. */
export interface ShapeReference {
  readonly container: ShapeContainer;
  /** Index into the container's ordered vertexId list. */
  readonly position: number;
}

/** Stable string key identifying a container (for same-container detection). */
export function containerKey(container: ShapeContainer): string {
  return container.kind === 'ring'
    ? `ring:${container.featureId}:${container.ringId}`
    : `line:${container.featureId}`;
}

function shapeReferencesEqual(a: ShapeReference, b: ShapeReference): boolean {
  return (
    a.position === b.position && containerKey(a.container) === containerKey(b.container)
  );
}

// ---------------------------------------------------------------------------
// State the commands operate on.
// ---------------------------------------------------------------------------
//
// This unit does not own the full app state (U03 does). It operates on the two
// pieces it needs as a single immutable value: the vertex store (the one
// coordinate source) and the container vertexId lists (the form references).
// Each container is keyed by containerKey -> ordered VertexId list. Commands
// return a new SharedVertexState; the input is never mutated (教訓5.17/5.22).

export interface SharedVertexState {
  readonly vertices: VertexStore;
  /** containerKey -> the container descriptor + its ordered vertexId list. */
  readonly containers: ReadonlyMap<string, ContainerEntry>;
}

export interface ContainerEntry {
  readonly container: ShapeContainer;
  readonly vertexIds: readonly VertexId[];
}

export function createSharedVertexState(
  vertices: VertexStore,
  containers: readonly ContainerEntry[],
): SharedVertexState {
  const map = new Map<string, ContainerEntry>();
  for (const entry of containers) {
    map.set(containerKey(entry.container), entry);
  }
  return { vertices, containers: map };
}

function withContainers(
  state: SharedVertexState,
  containers: ReadonlyMap<string, ContainerEntry>,
): SharedVertexState {
  return { vertices: state.vertices, containers };
}

function withVertices(state: SharedVertexState, vertices: VertexStore): SharedVertexState {
  return { vertices, containers: state.containers };
}

// ---------------------------------------------------------------------------
// Reverse index + group derivation (THE single derivation; §4.1).
// ---------------------------------------------------------------------------

/**
 * Build the reverse index: VertexId -> every ShapeReference citing it. This is
 * the single derivation shared by sharing / move / unshare / participation /
 * continuity. Order of references follows container iteration then position
 * (deterministic).
 */
export function buildReverseIndex(
  state: SharedVertexState,
): ReadonlyMap<VertexId, readonly ShapeReference[]> {
  const index = new Map<VertexId, ShapeReference[]>();
  for (const entry of state.containers.values()) {
    for (let position = 0; position < entry.vertexIds.length; position += 1) {
      const vid = entry.vertexIds[position];
      if (vid === undefined) continue; // noUncheckedIndexedAccess discipline
      const ref: ShapeReference = { container: entry.container, position };
      const list = index.get(vid);
      if (list === undefined) index.set(vid, [ref]);
      else list.push(ref);
    }
  }
  return index;
}

/**
 * All shape references citing a vertex id (empty when the id is unreferenced).
 *
 * Each call builds the full reverse index (O(C·L) over all containers). When a
 * caller needs the references of MANY vertices of one state (e.g. a per-frame
 * move loop, or a batch share), build the index ONCE with `buildReverseIndex`
 * and pass it via `index` so the scan is not repeated per vertex (バグハント3:
 * referencesOf を頂点ごとに呼ぶと全コンテナを毎回走査する性能退行を回避).
 * Passing an index built from a DIFFERENT state is the caller's responsibility.
 */
export function referencesOf(
  state: SharedVertexState,
  vertexId: VertexId,
  index?: ReadonlyMap<VertexId, readonly ShapeReference[]>,
): readonly ShapeReference[] {
  return (index ?? buildReverseIndex(state)).get(vertexId) ?? [];
}

/**
 * A shared vertex is one cited by ≥2 distinct shape references (§4.1). Pass a
 * pre-built `index` (see `referencesOf`) to avoid rebuilding it per call.
 */
export function isSharedVertex(
  state: SharedVertexState,
  vertexId: VertexId,
  index?: ReadonlyMap<VertexId, readonly ShapeReference[]>,
): boolean {
  return referencesOf(state, vertexId, index).length >= 2;
}

/** Every vertex id that is shared (cited ≥2 times), in deterministic order. */
export function sharedVertexIds(state: SharedVertexState): readonly VertexId[] {
  const out: VertexId[] = [];
  for (const [vid, refs] of buildReverseIndex(state)) {
    if (refs.length >= 2) out.push(vid);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Participation restriction (§4.3 / FR-32).
// ---------------------------------------------------------------------------
//
// Forbidden: two vertices of the SAME ring, or two vertices of the SAME line
// path, in one shared group. Judged on the RESULTING group's set of container
// keys: a duplicate container key means two citations from the same ring/path
// (教訓5.6 結果状態で判定). NOT widened to "same feature entirely" (教訓5.25):
// distinct rings of one leaf (outer + enclave, outer + hole) may share.

export const PARTICIPATION_REJECT = {
  /** Two citations from the same ring would be in one group. */
  SameRing: 'same-ring',
  /** Two citations from the same line path would be in one group. */
  SameLinePath: 'same-line-path',
} as const;

export type ParticipationRejectKind =
  (typeof PARTICIPATION_REJECT)[keyof typeof PARTICIPATION_REJECT];

export interface ParticipationViolation {
  readonly kind: ParticipationRejectKind;
  /** The container cited more than once within the resulting group. */
  readonly containerKey: string;
}

/**
 * Check a set of shape references (the would-be merged group) for participation
 * violations: any container key appearing on ≥2 references is a same-ring /
 * same-line-path conflict. Returns one violation per offending container.
 */
export function checkParticipation(
  references: readonly ShapeReference[],
): readonly ParticipationViolation[] {
  const seen = new Map<string, ShapeContainer>();
  const offending = new Map<string, ShapeContainer>();
  for (const ref of references) {
    const key = containerKey(ref.container);
    if (seen.has(key)) offending.set(key, ref.container);
    else seen.set(key, ref.container);
  }
  const violations: ParticipationViolation[] = [];
  for (const [key, container] of offending) {
    violations.push({
      kind:
        container.kind === 'ring'
          ? PARTICIPATION_REJECT.SameRing
          : PARTICIPATION_REJECT.SameLinePath,
      containerKey: key,
    });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Result-invalid validators — injected delegation interface (§4.4 / 教訓5.33).
// ---------------------------------------------------------------------------
//
// This unit owns NO geometry of its own for the four result checks. It defines
// a validator interface "resulting state -> reasons" and binds U06/U07/U10
// services as validators. A validator that has no service yet is simply omitted;
// the unit's own tests inject stub validators. The four kinds mirror FR-32.

export const RESULT_VIOLATION = {
  /** Adjacent same-id / same-coordinate vertices form a zero-length edge (U06). */
  ZeroLengthEdge: 'zero-length-edge',
  /** A ring / line path self-intersects (U06). */
  SelfIntersection: 'self-intersection',
  /** Hole / enclave hierarchy broken (U07). */
  HierarchyBroken: 'hierarchy-broken',
  /** Two leaf-most features overlap (U10). */
  LeafOverlap: 'leaf-overlap',
} as const;

export type ResultViolationKind =
  (typeof RESULT_VIOLATION)[keyof typeof RESULT_VIOLATION];

export interface ResultViolation {
  readonly kind: ResultViolationKind;
  /** Optional offending element id for diagnostics / UI messaging. */
  readonly elementId?: DomainId;
  /** Human-readable reason (§4.4 ユーザー通知用とテスト戻り値の両方). */
  readonly message: string;
}

/**
 * A result validator inspects the would-be NEW state and returns violations
 * (empty = ok). The layer-crossing contract (教訓5.33): U06/U07/U10 implement
 * this shape; this unit only calls it. Validators are pure.
 */
export type ResultValidator = (state: SharedVertexState) => readonly ResultViolation[];

/**
 * Built-in zero-length-edge validator (the one result check this unit can do
 * from its own state without external geometry — adjacency over the container
 * vertexId lists). After a merge two adjacent positions may carry the SAME id,
 * or two distinct ids whose coordinates are quantize-equal (教訓 量子化): both
 * are zero-length edges. Rings are implicitly closed (last↔first edge checked);
 * line paths are open. This is offered as a convenience validator that callers
 * MAY include in the validator list; it does not replace U06's fuller service.
 */
export function zeroLengthEdgeValidator(state: SharedVertexState): readonly ResultViolation[] {
  const violations: ResultViolation[] = [];
  for (const entry of state.containers.values()) {
    const ids = entry.vertexIds;
    const n = ids.length;
    const closed = entry.container.kind === 'ring';
    const edgeCount = closed ? n : n - 1;
    for (let i = 0; i < edgeCount; i += 1) {
      const a = ids[i];
      const b = ids[(i + 1) % n];
      if (a === undefined || b === undefined) continue;
      if (a === b) {
        violations.push({
          kind: RESULT_VIOLATION.ZeroLengthEdge,
          elementId: a,
          message: `zero-length edge: position ${i} and ${(i + 1) % n} of ${containerKey(entry.container)} cite the same vertex`,
        });
        continue;
      }
      const va = getVertex(state.vertices, a);
      const vb = getVertex(state.vertices, b);
      if (va === undefined || vb === undefined) continue;
      if (quantizedEqual(va.coordinate, vb.coordinate)) {
        violations.push({
          kind: RESULT_VIOLATION.ZeroLengthEdge,
          elementId: a,
          message: `zero-length edge: adjacent vertices ${a} and ${b} of ${containerKey(entry.container)} are coincident after quantization`,
        });
      }
    }
  }
  return violations;
}

/** Run every validator over the candidate state, concatenating violations. */
function runValidators(
  state: SharedVertexState,
  validators: readonly ResultValidator[],
): readonly ResultViolation[] {
  const out: ResultViolation[] = [];
  for (const validator of validators) {
    for (const v of validator(state)) out.push(v);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Command result type (§4.8 / 教訓5.23 — symmetric touched set).
// ---------------------------------------------------------------------------

export const SHARED_VERTEX_OUTCOME = {
  Applied: 'applied',
  Rejected: 'rejected',
} as const;

export type SharedVertexOutcomeStatus =
  (typeof SHARED_VERTEX_OUTCOME)[keyof typeof SHARED_VERTEX_OUTCOME];

export const REJECT_REASON = {
  Participation: 'participation',
  ResultInvalid: 'result-invalid',
  /** A referenced vertex / container is absent — malformed input. */
  NotFound: 'not-found',
} as const;

export type RejectReasonKind = (typeof REJECT_REASON)[keyof typeof REJECT_REASON];

/** What a command touched, for symmetric execute/undo/redo notification. */
export interface SharedVertexChange {
  readonly touchedVertexIds: ReadonlySet<VertexId>;
  readonly touchedFeatureIds: ReadonlySet<FeatureId>;
  readonly createdVertexIds: ReadonlySet<VertexId>;
  readonly deletedVertexIds: ReadonlySet<VertexId>;
}

export type SharedVertexResult =
  | {
      readonly status: typeof SHARED_VERTEX_OUTCOME.Applied;
      readonly state: SharedVertexState;
      readonly change: SharedVertexChange;
    }
  | {
      readonly status: typeof SHARED_VERTEX_OUTCOME.Rejected;
      readonly reason: RejectReasonKind;
      readonly participation?: readonly ParticipationViolation[];
      readonly result?: readonly ResultViolation[];
      readonly message: string;
    };

function rejected(
  reason: RejectReasonKind,
  message: string,
  extra: {
    participation?: readonly ParticipationViolation[];
    result?: readonly ResultViolation[];
  } = {},
): SharedVertexResult {
  const base = {
    status: SHARED_VERTEX_OUTCOME.Rejected as typeof SHARED_VERTEX_OUTCOME.Rejected,
    reason,
    message,
  };
  if (extra.participation !== undefined && extra.result !== undefined) {
    return { ...base, participation: extra.participation, result: extra.result };
  }
  if (extra.participation !== undefined) {
    return { ...base, participation: extra.participation };
  }
  if (extra.result !== undefined) return { ...base, result: extra.result };
  return base;
}

function featureIdOf(container: ShapeContainer): FeatureId {
  return container.featureId;
}

function featureIdsOfRefs(refs: readonly ShapeReference[]): Set<FeatureId> {
  const out = new Set<FeatureId>();
  for (const ref of refs) out.add(featureIdOf(ref.container));
  return out;
}

// ---------------------------------------------------------------------------
// Helper: rewrite a vertex id in a container's list (immutable).
// ---------------------------------------------------------------------------

function replaceIdInContainer(
  entry: ContainerEntry,
  position: number,
  newId: VertexId,
): ContainerEntry {
  const next = entry.vertexIds.slice();
  next[position] = newId;
  return { container: entry.container, vertexIds: next };
}

/**
 * Replace every occurrence of `fromId` with `toId` across the containers that
 * cite `fromId`. `fromRefs` are `fromId`'s shape references taken from the
 * pre-built reverse index (バグハント3): they name exactly the containers to
 * rewrite, so the guard pass no longer scans every container with
 * `Array.includes` (O(C·L)) — only the k containers that actually reference
 * `fromId` are touched (O(k) container lookups + one `.map` each over the
 * matching rings/lines). Containers that do not cite `fromId` keep their exact
 * array reference (immutability preserved; identity stable).
 */
function repointAll(
  state: SharedVertexState,
  fromId: VertexId,
  toId: VertexId,
  fromRefs: readonly ShapeReference[],
): SharedVertexState {
  if (fromRefs.length === 0) return state;
  const next = new Map(state.containers);
  // The reverse index lists one ShapeReference PER citation, so a container that
  // cites `fromId` at several positions appears multiple times; dedupe by key so
  // each affected container is rewritten once (the `.map` handles all positions).
  const affectedKeys = new Set<string>();
  for (const ref of fromRefs) affectedKeys.add(containerKey(ref.container));
  for (const key of affectedKeys) {
    const entry = next.get(key);
    if (entry === undefined) continue; // index/state mismatch — leave as-is
    const ids = entry.vertexIds.map((id) => (id === fromId ? toId : id));
    next.set(key, { container: entry.container, vertexIds: ids });
  }
  return withContainers(state, next);
}

/**
 * Drop later duplicate citations of any id within ONE container's id list,
 * keeping the FIRST occurrence (order-preserving). Used by transferSharing to
 * collapse a same-container fold into a valid (non-self-citing) container — a
 * ring/line must never cite one vertex twice (§4.3 participation). Returns the
 * SAME array reference when nothing was dropped (so identity remaps stay no-ops).
 */
function dedupeContainerCitations(ids: readonly VertexId[]): readonly VertexId[] {
  let seen: Set<VertexId> | undefined;
  let out: VertexId[] | undefined;
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    if (id === undefined) continue; // noUncheckedIndexedAccess discipline
    if (seen === undefined) seen = new Set<VertexId>();
    if (seen.has(id)) {
      // First duplicate: materialize the deduped copy of the prefix kept so far.
      if (out === undefined) out = ids.slice(0, i) as VertexId[];
      continue;
    }
    seen.add(id);
    if (out !== undefined) out.push(id);
  }
  return out ?? ids;
}

/** True iff any container still cites `vertexId`. */
function isReferenced(state: SharedVertexState, vertexId: VertexId): boolean {
  for (const entry of state.containers.values()) {
    if (entry.vertexIds.includes(vertexId)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// §4.2 Share command.
// ---------------------------------------------------------------------------
//
// Merge two vertices into one shared vertex. `candidateId`'s every reference is
// repointed to `targetId`; the candidate body (and its whole group, since
// repointing moves ALL its citations) collapses into the target. The target's
// coordinate is the canonical truth (candidate coordinate is discarded). Then
// participation + result validation; on any violation the whole state is rolled
// back (nothing partially applied; 教訓5.22 / 受け入れ基準 5).

export interface ShareOptions {
  readonly validators?: readonly ResultValidator[];
}

export function shareVertices(
  state: SharedVertexState,
  candidateId: VertexId,
  targetId: VertexId,
  options: ShareOptions = {},
): SharedVertexResult {
  if (candidateId === targetId) {
    return rejected(REJECT_REASON.NotFound, 'cannot share a vertex with itself');
  }
  // Build the reverse index ONCE and look up both vertices from it (バグハント3):
  // referencesOf(state, …) would otherwise re-scan every container twice here.
  const index = buildReverseIndex(state);
  const candidateRefs = referencesOf(state, candidateId, index);
  const targetRefs = referencesOf(state, targetId, index);
  if (candidateRefs.length === 0 || targetRefs.length === 0) {
    return rejected(
      REJECT_REASON.NotFound,
      `share requires both vertices to be referenced (candidate=${candidateRefs.length}, target=${targetRefs.length})`,
    );
  }
  if (getVertex(state.vertices, targetId) === undefined) {
    return rejected(REJECT_REASON.NotFound, `target vertex ${targetId} not in store`);
  }

  // Resulting group = target refs + candidate refs (all repointed to target).
  const mergedRefs = [...targetRefs, ...candidateRefs];
  const participation = checkParticipation(mergedRefs);
  if (participation.length > 0) {
    return rejected(REJECT_REASON.Participation, participationMessage(participation), {
      participation,
    });
  }

  // Build candidate (NOT yet committed) state: repoint, prune orphaned candidate.
  // Pass candidateRefs (from the pre-built index) so repointAll touches only the
  // containers that actually cite the candidate (バグハント3: avoids the O(C·L)
  // Array.includes guard scan over every container).
  let next = repointAll(state, candidateId, targetId, candidateRefs);
  // After repointAll, EVERY citation of candidateId (its complete set was
  // candidateRefs) has been rewritten to targetId, so candidateId is now
  // unreferenced by construction — its body is orphaned and pruned. Deriving
  // this from candidateRefs avoids a second O(C·L) container scan (the same
  // バグハント3 pattern isReferenced would otherwise repeat over every
  // container) while staying exactly equivalent: candidateRefs came from the
  // reverse index built over `state`, and repointAll replaced all `candidateId`
  // occurrences in precisely those containers.
  if (getVertex(next.vertices, candidateId) !== undefined) {
    next = withVertices(next, removeVertex(next.vertices, candidateId));
  }

  const validators = options.validators ?? [];
  const violations = runValidators(next, validators);
  if (violations.length > 0) {
    // Roll back entirely: return the ORIGINAL state untouched.
    return rejected(REJECT_REASON.ResultInvalid, resultMessage(violations), {
      result: violations,
    });
  }

  const touchedVertexIds = new Set<VertexId>([targetId, candidateId]);
  const touchedFeatureIds = new Set<FeatureId>([
    ...featureIdsOfRefs(targetRefs),
    ...featureIdsOfRefs(candidateRefs),
  ]);
  return {
    status: SHARED_VERTEX_OUTCOME.Applied,
    state: next,
    change: {
      touchedVertexIds,
      touchedFeatureIds,
      createdVertexIds: new Set(),
      deletedVertexIds: hasVertexBody(state, candidateId) && !hasVertexBody(next, candidateId)
        ? new Set([candidateId])
        : new Set(),
    },
  };
}

function hasVertexBody(state: SharedVertexState, id: VertexId): boolean {
  return getVertex(state.vertices, id) !== undefined;
}

// ---------------------------------------------------------------------------
// §4.5 Linked move command.
// ---------------------------------------------------------------------------
//
// Move one (possibly shared) vertex by updating its single store body — every
// referrer follows automatically (ID reference). Multi-vertex / feature move is
// the same applied per id. Result validation runs at commit; on violation the
// original state is returned (no partial move).

export interface MoveSpec {
  readonly vertexId: VertexId;
  readonly coordinate: WorldCoordinate;
}

export function moveVertices(
  state: SharedVertexState,
  moves: readonly MoveSpec[],
  options: ShareOptions = {},
): SharedVertexResult {
  let nextStore = state.vertices;
  const touchedVertexIds = new Set<VertexId>();
  const touchedFeatureIds = new Set<FeatureId>();
  // Build the reverse index ONCE outside the move loop (バグハント3): a move only
  // changes vertex BODIES, never `state.containers`, so the index is invariant
  // across the loop. Calling referencesOf(state, …) per move would re-scan every
  // container on every pointer-move event — O(moves · C·L) — dominating drag CPU.
  const index = buildReverseIndex(state);
  for (const move of moves) {
    const vertex = getVertex(nextStore, move.vertexId);
    if (vertex === undefined) {
      return rejected(REJECT_REASON.NotFound, `move target ${move.vertexId} not in store`);
    }
    nextStore = setVertex(nextStore, withVertexCoordinate(vertex, move.coordinate));
    touchedVertexIds.add(move.vertexId);
    for (const ref of referencesOf(state, move.vertexId, index)) {
      touchedFeatureIds.add(featureIdOf(ref.container));
    }
  }

  const next = withVertices(state, nextStore);
  const validators = options.validators ?? [];
  const violations = runValidators(next, validators);
  if (violations.length > 0) {
    return rejected(REJECT_REASON.ResultInvalid, resultMessage(violations), {
      result: violations,
    });
  }

  return {
    status: SHARED_VERTEX_OUTCOME.Applied,
    state: next,
    change: {
      touchedVertexIds,
      touchedFeatureIds,
      createdVertexIds: new Set(),
      deletedVertexIds: new Set(),
    },
  };
}

// ---------------------------------------------------------------------------
// §4.6 Unshare command.
// ---------------------------------------------------------------------------
//
// Split off ONE shape reference of a shared vertex into a fresh same-coordinate
// vertex (new id). Remaining references keep the original; once the original is
// cited only once it is a normal vertex by derivation. The newly minted id is
// returned (recorded for redo, never re-minted; 教訓5.20). Coordinate source is
// the original vertex (same coordinate). Result validation is optional here —
// coordinates are unchanged (§4.6.4).

export interface UnshareResult {
  readonly result: SharedVertexResult;
  /** The freshly minted vertex id (only meaningful when applied). */
  readonly newVertexId?: VertexId;
  /** The advanced id-generator state (for the caller to thread forward). */
  readonly idState: IdGeneratorState;
}

export function unshareReference(
  state: SharedVertexState,
  vertexId: VertexId,
  reference: ShapeReference,
  idState: IdGeneratorState,
  now: TimeSource,
  options: ShareOptions = {},
): UnshareResult {
  const original = getVertex(state.vertices, vertexId);
  if (original === undefined) {
    return {
      result: rejected(REJECT_REASON.NotFound, `unshare target ${vertexId} not in store`),
      idState,
    };
  }
  const key = containerKey(reference.container);
  const entry = state.containers.get(key);
  if (entry === undefined || entry.vertexIds[reference.position] !== vertexId) {
    return {
      result: rejected(
        REJECT_REASON.NotFound,
        `reference ${key}#${reference.position} does not cite ${vertexId}`,
      ),
      idState,
    };
  }

  // Mint a new id (skip ids already used as vertex ids).
  const existing = new Set<string>();
  for (const id of state.vertices.byId.keys()) existing.add(id);
  const generated = nextRawId('v', idState, now, existing);
  const newId = asVertexId(generated.value);
  const newVertex = createVertex(newId, original.coordinate);

  let next = withVertices(state, setVertex(state.vertices, newVertex));
  const containers = new Map(next.containers);
  containers.set(key, replaceIdInContainer(entry, reference.position, newId));
  next = withContainers(next, containers);

  // Optional result validation (coordinates unchanged, normally unnecessary).
  const validators = options.validators ?? [];
  const violations = runValidators(next, validators);
  if (violations.length > 0) {
    return {
      result: rejected(REJECT_REASON.ResultInvalid, resultMessage(violations), {
        result: violations,
      }),
      idState, // not advanced on rejection
    };
  }

  return {
    result: {
      status: SHARED_VERTEX_OUTCOME.Applied,
      state: next,
      change: {
        touchedVertexIds: new Set([vertexId, newId]),
        touchedFeatureIds: new Set([featureIdOf(reference.container)]),
        createdVertexIds: new Set([newId]),
        deletedVertexIds: new Set(),
      },
    },
    newVertexId: newId,
    idState: generated.state,
  };
}

// ---------------------------------------------------------------------------
// §4.6.3 Auto-resharing suppression (judged purely; session holds the flag).
// ---------------------------------------------------------------------------
//
// After an unshare, the involved vertex must not immediately re-snap into a
// share until it has once moved beyond the snap distance. The flag itself lives
// in session state (not domain truth); this unit provides the pure predicates:
// "is suppressed" and "should the suppression lift given this distance".

export interface SuppressionEntry {
  readonly vertexId: VertexId;
  readonly suppressed: boolean;
}

/** True iff `vertexId` is currently suppressed within `entries`. */
export function isResharingSuppressed(
  entries: readonly SuppressionEntry[],
  vertexId: VertexId,
): boolean {
  for (const e of entries) {
    if (e.vertexId === vertexId) return e.suppressed;
  }
  return false;
}

/**
 * Should suppression lift? It lifts once the vertex has moved strictly beyond
 * the snap distance (一度スナップ距離外へ離れたら解除). Distance and snap
 * distance are supplied by the caller (this unit does not compute screen-space
 * distance — that is U24's, §2.2).
 */
export function shouldLiftSuppression(
  movedDistance: number,
  snapDistance: number,
): boolean {
  return movedDistance > snapDistance;
}

/** Apply lift logic: return entries with the vertex un-suppressed if it lifts. */
export function liftSuppressionIfMoved(
  entries: readonly SuppressionEntry[],
  vertexId: VertexId,
  movedDistance: number,
  snapDistance: number,
): readonly SuppressionEntry[] {
  if (!shouldLiftSuppression(movedDistance, snapDistance)) return entries;
  return entries.map((e) =>
    e.vertexId === vertexId ? { vertexId: e.vertexId, suppressed: false } : e,
  );
}

// ---------------------------------------------------------------------------
// §4.7 Continuity rules (split / merge / shared-edge cut).
// ---------------------------------------------------------------------------
//
// Split / merge themselves are other units; this unit provides the pure
// transfer functions they call so shared relationships survive re-created
// vertices (FR-95). All are pure remappings over the state's containers.

/** A mapping from an old vertex id to its successor (after split/merge). */
export type VertexRemap = ReadonlyMap<VertexId, VertexId>;

/**
 * Transfer shared relationships across a split/merge: rewrite EVERY container's
 * vertexId list through `remap` (old id -> new id). An id absent from the remap
 * is left as-is. Because sharing is derived from references, repointing the
 * references is exactly transferring the sharing: if two old ids both mapped
 * into the same new id (merge) they become one shared vertex; if an old shared
 * id maps to a new id, all its citations move together and stay shared.
 *
 * Single source of truth (R6): repointing references is not enough — every new
 * id a container now cites MUST resolve to a vertex BODY in the store, or the
 * remap leaves dangling references (getVertex(newId) === undefined), which
 * silently break linked move / coordinate resolution and let derivation report a
 * 'shared' vertex with no coordinate source (開発ガイド §5.31 no dangling refs).
 * So for each distinct new id (newId !== oldId) lacking a body, mint one by
 * carrying the OLD vertex's coordinate forward from the *original* store. The
 * original store is read for carry-forward because old bodies may be pruned
 * below; reading from the post-prune store would lose the source coordinate.
 *
 * Same-container fold collapse (§4.3 / FR-32 participation): a fold may map two
 * ids that are BOTH cited by ONE container onto the same new id — e.g. a ring
 * [v0, v1, v2] under {v1 -> v0} would become [v0, v0, v2]. That is an ILLEGAL
 * state: the container would cite one id twice (a same-ring / same-line-path
 * participation violation, and — when the duplicates are adjacent — a zero-length
 * edge), and derivation would report a "shared" vertex that is really a self-
 * citation within one container. shareVertices REJECTS exactly this merge, so the
 * merge-time transfer must NOT silently produce it (教訓5.6 結果状態で判定 /
 * 不正状態を表現不能に). The geometrically correct outcome of folding co-cited
 * vertices of one ring/path together is to COLLAPSE the now-degenerate repeat:
 * within each container, keep only the FIRST citation of each id (dropping the
 * later duplicate positions). This removes the degenerate self-touch / zero-
 * length edge while preserving the order of the remaining distinct vertices, and
 * keeps every legitimate CROSS-container share intact (two different containers
 * folding onto one id is a real share, never collapsed).
 *
 * Orphaned old vertex bodies (no longer cited and present in `remap`'s domain)
 * are pruned afterwards (削除は参照掃除まで; 教訓5.21).
 */
export function transferSharing(state: SharedVertexState, remap: VertexRemap): SharedVertexState {
  if (remap.size === 0) return state;
  const containers = new Map<string, ContainerEntry>();
  for (const [key, entry] of state.containers) {
    const remapped = entry.vertexIds.map((id) => remap.get(id) ?? id);
    // Collapse a same-container fold: drop any later duplicate citation of an id
    // so no container ends up citing one id more than once (no same-ring /
    // same-line-path self-share, no zero-length edge). Pure (no mutation of the
    // input); first occurrence wins so the remaining vertex order is preserved.
    const ids = dedupeContainerCitations(remapped);
    containers.set(key, { container: entry.container, vertexIds: ids });
  }
  let next = withContainers(state, containers);
  // Read carry-forward source coordinates from the ORIGINAL store, before any
  // pruning below can remove the old bodies (§4.7 / FR-95 同座標頂点を保つ).
  const originalStore = state.vertices;
  let store = next.vertices;
  // 1. Ensure a body exists for every remapped-to id (single source of truth):
  //    carry the old vertex's coordinate onto the new id when the new id has no
  //    body yet. Skip when the new id already has a body (e.g. merge target).
  for (const [oldId, newId] of remap) {
    if (newId === oldId) continue;
    if (getVertex(store, newId) !== undefined) continue;
    const oldVertex = getVertex(originalStore, oldId);
    if (oldVertex === undefined) continue; // nothing to carry forward
    store = setVertex(store, createVertex(newId, oldVertex.coordinate));
  }
  // 2. Prune old bodies that were remapped away and are no longer referenced.
  for (const oldId of remap.keys()) {
    const newId = remap.get(oldId);
    if (newId === oldId) continue;
    if (!isReferenced(next, oldId) && getVertex(store, oldId) !== undefined) {
      store = removeVertex(store, oldId);
    }
  }
  next = withVertices(next, store);
  return next;
}

/**
 * §4.7 shared-edge mid cut. A cut line crosses a shared edge (both endpoints
 * shared, with a corresponding edge on the partner feature) partway along it.
 * Insert a new vertex at the cut point on this feature's edge AND a same-
 * coordinate new vertex on the partner's corresponding edge, then put them in a
 * share. The insertion coordinate is computed by the caller (geometry / ratio
 * position) and passed in; this unit performs the structural insertion + share
 * and runs participation + result validation afterwards.
 */
export interface SharedEdgeCutSpec {
  /** The container + edge (position i -> i+1) on the primary feature. */
  readonly primary: { readonly containerKey: string; readonly edgeStart: number };
  /** The container + edge on the partner feature. */
  readonly partner: { readonly containerKey: string; readonly edgeStart: number };
  /** Quantize-aligned cut-point coordinate (same for both, by FR-95). */
  readonly cutCoordinate: WorldCoordinate;
}

export interface SharedEdgeCutResult {
  readonly result: SharedVertexResult;
  /** The single shared vertex id minted at the cut point (when applied). */
  readonly cutVertexId?: VertexId;
  readonly idState: IdGeneratorState;
}

export function insertSharedEdgeCut(
  state: SharedVertexState,
  spec: SharedEdgeCutSpec,
  idState: IdGeneratorState,
  now: TimeSource,
  options: ShareOptions = {},
): SharedEdgeCutResult {
  const primary = state.containers.get(spec.primary.containerKey);
  const partner = state.containers.get(spec.partner.containerKey);
  if (primary === undefined || partner === undefined) {
    return {
      result: rejected(REJECT_REASON.NotFound, 'shared-edge cut: container not found'),
      idState,
    };
  }

  // Reject a malformed edgeStart that does not name a real edge of its container
  // (不正状態を表現不能に / REJECT_REASON.NotFound). `insertAfter` is `splice`,
  // which silently CLAMPS an out-of-range index and appends — so without this
  // guard an out-of-bounds edgeStart would not error but would insert the cut
  // vertex into the WRONG edge, corrupting the geometry while leaving the
  // reverse index internally consistent (so structural invariants miss it).
  // Valid edges: a closed ring has edges 0..n-1 (the n-1↔0 closing edge is real);
  // an open line has edges 0..n-2. For the same-container case the two cuts are
  // checked against the ORIGINAL length here; the same-ring participation check
  // below still rejects them, so positions never matter in that branch.
  const primaryEdgeError = edgeStartError(primary, spec.primary.edgeStart);
  if (primaryEdgeError !== undefined) {
    return {
      result: rejected(
        REJECT_REASON.NotFound,
        `shared-edge cut: primary ${spec.primary.containerKey} ${primaryEdgeError}`,
      ),
      idState,
    };
  }
  const partnerEdgeError = edgeStartError(partner, spec.partner.edgeStart);
  if (partnerEdgeError !== undefined) {
    return {
      result: rejected(
        REJECT_REASON.NotFound,
        `shared-edge cut: partner ${spec.partner.containerKey} ${partnerEdgeError}`,
      ),
      idState,
    };
  }

  // Mint ONE shared vertex (single id cited by both inserted positions — that is
  // exactly the share by ID reference; §4.1 / FR-95 同座標頂点を共有関係に入れる).
  const existing = new Set<string>();
  for (const id of state.vertices.byId.keys()) existing.add(id);
  const generated = nextRawId('v', idState, now, existing);
  const cutId = asVertexId(generated.value);
  const cutVertex = createVertex(cutId, spec.cutCoordinate);

  const store = setVertex(state.vertices, cutVertex);
  const containers = new Map(state.containers);
  containers.set(
    spec.primary.containerKey,
    insertAfter(primary, spec.primary.edgeStart, cutId),
  );
  // Re-read partner from the working map in case primary === partner container.
  const partnerEntry = containers.get(spec.partner.containerKey) ?? partner;
  containers.set(
    spec.partner.containerKey,
    insertAfter(partnerEntry, spec.partner.edgeStart, cutId),
  );

  let next: SharedVertexState = { vertices: store, containers };

  // The cut vertex is now cited twice (primary + partner) — a share. Validate
  // participation (the two citations must be different containers) and results.
  const refs = referencesOf(next, cutId);
  const participation = checkParticipation(refs);
  if (participation.length > 0) {
    return {
      result: rejected(REJECT_REASON.Participation, participationMessage(participation), {
        participation,
      }),
      idState, // not advanced on rejection
    };
  }

  const validators = options.validators ?? [];
  const violations = runValidators(next, validators);
  if (violations.length > 0) {
    return {
      result: rejected(REJECT_REASON.ResultInvalid, resultMessage(violations), {
        result: violations,
      }),
      idState,
    };
  }

  next = { vertices: store, containers };
  return {
    result: {
      status: SHARED_VERTEX_OUTCOME.Applied,
      state: next,
      change: {
        touchedVertexIds: new Set([cutId]),
        touchedFeatureIds: new Set([
          featureIdOf(primary.container),
          featureIdOf(partner.container),
        ]),
        createdVertexIds: new Set([cutId]),
        deletedVertexIds: new Set(),
      },
    },
    cutVertexId: cutId,
    idState: generated.state,
  };
}

/**
 * Validate that `edgeStart` names a real edge of `entry`'s container, returning
 * an error reason string when it does not (and `undefined` when valid). An edge
 * is identified by its START position. A closed ring of n vertices has edges
 * 0..n-1 (the n-1↔0 closing edge is real); an open line of n vertices has edges
 * 0..n-2. `edgeStart` must additionally be a non-negative integer.
 */
function edgeStartError(entry: ContainerEntry, edgeStart: number): string | undefined {
  if (!Number.isInteger(edgeStart) || edgeStart < 0) {
    return `edgeStart ${edgeStart} is not a non-negative integer`;
  }
  const n = entry.vertexIds.length;
  const closed = entry.container.kind === 'ring';
  const maxEdgeStart = closed ? n - 1 : n - 2;
  if (n < 2 || edgeStart > maxEdgeStart) {
    return `edgeStart ${edgeStart} is out of range (container has ${n} vertices, max edge start ${maxEdgeStart})`;
  }
  return undefined;
}

/** Insert `id` immediately AFTER position `edgeStart` (within the edge). */
function insertAfter(entry: ContainerEntry, edgeStart: number, id: VertexId): ContainerEntry {
  const ids = entry.vertexIds.slice();
  ids.splice(edgeStart + 1, 0, id);
  return { container: entry.container, vertexIds: ids };
}

// ---------------------------------------------------------------------------
// Message helpers (拒否理由を通知用メッセージとテスト戻り値の両方で; §4.4).
// ---------------------------------------------------------------------------

function participationMessage(violations: readonly ParticipationViolation[]): string {
  return `sharing rejected: participation restriction (${violations
    .map((v) => `${v.kind}@${v.containerKey}`)
    .join(', ')})`;
}

function resultMessage(violations: readonly ResultViolation[]): string {
  return `operation rejected: result would be invalid (${violations
    .map((v) => v.kind)
    .join(', ')})`;
}

// ---------------------------------------------------------------------------
// Small re-exports the unit's own equality uses (kept local, not widened).
// ---------------------------------------------------------------------------

export { shapeReferencesEqual, coordinatesEqual, type Vertex };
