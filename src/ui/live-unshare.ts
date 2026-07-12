// FR-33 共有解除 (unshare) — the LIVE launcher that turns a right-click「共有解除」
// intent into ONE undo-unit structural edit over the committed DomainProject,
// WITHOUT re-implementing the unshare op (it drives the domain single-source
// {@link unshareReference}) and WITHOUT re-implementing the write-back store math
// (it materialises each touched feature through the SAME {@link FeatureSnapshot}
// U13 applies for a vertex edit).
//
// WHY THIS FILE EXISTS (教訓 5.7 完了トリガー / 5.29 単一真実源):
// U11 (domain/shared-vertex) has the full unshare logic but NO UI launcher — the
// only reachable path was its unit tests (AUDIT #4 到達ゼロ). vertex-delete.ts is
// the exact sibling for 頂点削除; this is its 共有解除 counterpart. It is a pure PLAN
// builder + a thin run-orchestration over injected ports, so the App composition
// root stays thin and the whole thing is Vitest-testable without env (技術方針 2.5).
//
// UNDO ATOMICITY (design gate — U13 は複数 feature を1提案で受けない):
//   `EditProposal`/`createEditProposal` key on ONE `featureId` + ONE
//   `FeatureSnapshot.feature` (consistency/types.ts), so a multi-vertex unshare that
//   touches SEVERAL features cannot be a single `startProcess`. Verified: U13 does NOT
//   batch features. So — per the gate — the undo-atomicity design is CHANGED: this
//   module applies each touched feature's snapshot through the injected pure
//   `applyProposal` (= U44 `applyEditProposal`) to build the final root, then wraps the
//   baseline→final delta in ONE whole-state-swap {@link Command} recorded as a single
//   composite undo unit (the SAME shape createDeleteFeatureCommandForRoot uses, FR-73 /
//   FR-94). This bypasses U13's spatial/time convergence, which is CORRECT for unshare:
//   the op mints a same-coordinate vertex and rewrites one id reference — coordinates are
//   unchanged (shared-vertex §4.6.4), so no overlap can appear and no temporal validity
//   changes. The common single-owner case touches ONE feature (one snapshot); the
//   multi/unknown-owner case touches several, still ONE undo unit.
//
// WHICH REFERENCE IS DETACHED (selection preservation, 教訓 5.11):
//   For each shared vertex we detach a reference that does NOT belong to the intent's
//   owner (when the owner is known), so the OWNER keeps citing the ORIGINAL vertex id
//   and the new same-coordinate vertex goes to the neighbour. This is what makes the
//   owner's original vertex a SURVIVOR, matching the reresolve-bridge contract
//   (context-menu/consistency.test.ts: unshare (single owner) keeps {owner → original
//   vertices} selected, the new id is `created`). A self-share (a vertex cited twice by
//   ONE feature) has no non-owner reference; we then detach one of its references — the
//   owner still cites the vertex via the OTHER reference, so it survives all the same.

import {
  FEATURE_KIND,
  withLeafShape,
  withLineVertexIds,
  type Feature,
  type LeafFeature,
  type LineFeature,
} from '../domain/feature';
import { createShape, withHoleRingVertexIds, withTerritoryRingVertexIds, RING_KIND, type Ring } from '../domain/ring';
import {
  buildReverseIndex,
  containerKey,
  createSharedVertexState,
  referencesOf,
  unshareReference,
  SHARED_VERTEX_OUTCOME,
  type ShapeReference,
  type SharedVertexState,
} from '../domain/shared-vertex';
import { buildSnapshot, type FeatureSnapshot } from '../domain/editing/index';
import { createEditProposal, type EditProposal } from '../domain/consistency/index';
import {
  createCommandResult,
  type CommandResult,
} from '../domain/command/result';
import {
  createCompositeCommand,
  defineCommandKind,
  type Command,
  type CommandOutcome,
} from '../domain/command/index';
import { FLOW_KIND, bridgeReresolve } from '../domain/context-menu/index';
import type { NextTargetPreference } from '../domain/selection/index';
import {
  createIdGeneratorState,
  type IdGeneratorState,
  type TimeSource,
} from '../domain/id-generator';
import type { FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import type { TimePoint } from '../domain/time/time-point';
import { getVertex, type Vertex } from '../domain/vertex';

import { containersOf } from './map/shared-vertex-derivation';
import { featureByIdAt, featuresAt, verticesAt } from './live-lookup';

/** The right-click「共有解除」payload (= FLOW_KIND.Unshare intent minus the tag). */
export interface UnshareIntent {
  /** The SHARED vertices to detach (≥1) — only the shared subset (contracts §payload). */
  readonly vertexIds: ReadonlySet<VertexId>;
  /** The single owner when the selection resolved to one, else null (multi/unknown). */
  readonly ownerFeatureId: FeatureId | null;
}

/** One touched feature's complete after-state, ready for {@link createEditProposal}. */
export interface UnshareSnapshot {
  readonly featureId: FeatureId;
  readonly snapshot: FeatureSnapshot;
}

/**
 * The pure PLAN for an unshare: per-touched-feature snapshots plus the change sets a
 * whole-state-swap command needs. `null` (no plan) means a no-op — no shared vertex to
 * detach — so the caller records NO command (no幽霊 undo, 教訓 5.24).
 */
export interface UnsharePlan {
  /** One entry per feature whose ring/line lost a shared citation (never the owner). */
  readonly snapshots: readonly UnshareSnapshot[];
  /** The feature ids of {@link snapshots} (the reshaped neighbours). */
  readonly touchedFeatureIds: readonly FeatureId[];
  /** The ORIGINAL detached vertices — they SURVIVE (still cited by the owner). */
  readonly survivedVertexIds: readonly VertexId[];
  /** The freshly minted same-coordinate vertices (one per detached reference). */
  readonly createdVertexIds: readonly VertexId[];
  /** The advanced id-generator state for the caller to thread forward. */
  readonly nextIdState: IdGeneratorState;
}

/** The live domain context a plan is built against (read fresh — never a stale capture). */
export interface UnshareContext {
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** The current id-generator state (threaded through the sequential mints). */
  readonly idState: IdGeneratorState;
  /** A monotonic-ish integer source for the id mints (injected, 教訓 5.15 / 5.37). */
  readonly now: TimeSource;
}

/**
 * Pick the reference to DETACH for a shared vertex: prefer one NOT owned by
 * `ownerFeatureId` so the owner keeps citing the original vertex (selection
 * preservation, see the module note). Falls back to the first reference for a
 * self-share / unknown owner. `refs` has ≥2 entries (the caller filtered to shared).
 */
function pickDetachReference(
  refs: readonly ShapeReference[],
  ownerFeatureId: FeatureId | null,
): ShapeReference {
  if (ownerFeatureId !== null) {
    const foreign = refs.find((r) => r.container.featureId !== ownerFeatureId);
    if (foreign !== undefined) return foreign;
  }
  return refs[0]!; // refs.length >= 2 by construction
}

/** Selected vertex ids in a deterministic order (so a redo replays identically). */
function orderedTargets(
  vertexIds: ReadonlySet<VertexId>,
  index: ReadonlyMap<VertexId, readonly ShapeReference[]>,
): VertexId[] {
  // Iterate the reverse index's key order (deterministic build order) and keep only
  // the ones actually requested — a set has no inherent order, the index does.
  const out: VertexId[] = [];
  for (const vid of index.keys()) {
    if (vertexIds.has(vid)) out.push(vid);
  }
  return out;
}

/**
 * Rebuild a touched feature's complete after-state from the FINAL shared-vertex state:
 * a leaf's rings / a line's path pick up their new id lists from the matching
 * containers; points / aggregates never own a container so are never here. Pure.
 */
function rebuildFeature(feature: Feature, state: SharedVertexState): Feature {
  switch (feature.kind) {
    case FEATURE_KIND.Leaf:
      return rebuildLeaf(feature, state);
    case FEATURE_KIND.Line:
      return rebuildLine(feature, state);
    default:
      // Point / Aggregate own no ShapeContainer — they can never be an unshare target.
      return feature;
  }
}

function rebuildLeaf(feature: LeafFeature, state: SharedVertexState): LeafFeature {
  const rings: Ring[] = feature.shape.rings.map((ring) => {
    const entry = state.containers.get(
      containerKey({ kind: 'ring', featureId: feature.id, ringId: ring.id as RingId }),
    );
    if (entry === undefined) return ring; // untouched ring keeps its exact ids
    return ring.kind === RING_KIND.Territory
      ? withTerritoryRingVertexIds(ring, entry.vertexIds)
      : withHoleRingVertexIds(ring, entry.vertexIds);
  });
  return withLeafShape(feature, createShape(rings));
}

function rebuildLine(feature: LineFeature, state: SharedVertexState): LineFeature {
  const entry = state.containers.get(containerKey({ kind: 'line', featureId: feature.id }));
  return entry === undefined ? feature : withLineVertexIds(feature, entry.vertexIds);
}

/**
 * Build the pure unshare plan (FR-33): detach one reference per shared vertex through
 * the domain {@link unshareReference}, then materialise each touched feature as a
 * {@link FeatureSnapshot}. Returns `null` when nothing in `intent.vertexIds` is
 * actually shared at the current time (no-op / stale). Pure — reads the live root at
 * the anchor time only; never writes state.
 */
export function buildUnsharePlan(ctx: UnshareContext, intent: UnshareIntent): UnsharePlan | null {
  if (intent.vertexIds.size === 0) return null;
  const root = ctx.getRoot();
  const time = ctx.getTime();
  const features = featuresAt(root, time);
  const vertices = verticesAt(root, time);

  const state0 = createSharedVertexState(vertices, containersOf(features));
  const index0 = buildReverseIndex(state0);

  // Choose ONE reference to detach per requested vertex that is actually shared (≥2
  // references). The (container, position) refs stay valid across the sequential
  // unshares below: each unshare rewrites only its own slot (same array length), so a
  // later target's slot is untouched (バグハント3 index-once discipline).
  const detach: { readonly vertexId: VertexId; readonly reference: ShapeReference }[] = [];
  for (const vid of orderedTargets(intent.vertexIds, index0)) {
    const refs = referencesOf(state0, vid, index0);
    if (refs.length < 2) continue; // not shared → skip (dispatch already filtered, defensive)
    detach.push({ vertexId: vid, reference: pickDetachReference(refs, intent.ownerFeatureId) });
  }
  if (detach.length === 0) return null; // nothing shared → no-op (no幽霊, 教訓 5.24)

  // Apply the detaches sequentially, threading the id-generator state forward.
  let state = state0;
  let idState = ctx.idState;
  const survivedVertexIds: VertexId[] = [];
  const createdVertexIds: VertexId[] = [];
  const createdByFeature = new Map<FeatureId, VertexId[]>();
  const touchedFeatureOrder: FeatureId[] = [];
  for (const { vertexId, reference } of detach) {
    const res = unshareReference(state, vertexId, reference, idState, ctx.now);
    if (res.result.status !== SHARED_VERTEX_OUTCOME.Applied || res.newVertexId === undefined) {
      continue; // defensive: coordinates unchanged so a reject is not expected here
    }
    state = res.result.state;
    idState = res.idState;
    survivedVertexIds.push(vertexId);
    createdVertexIds.push(res.newVertexId);
    const fid = reference.container.featureId;
    const list = createdByFeature.get(fid);
    if (list === undefined) {
      createdByFeature.set(fid, [res.newVertexId]);
      touchedFeatureOrder.push(fid);
    } else {
      list.push(res.newVertexId);
    }
  }
  if (createdVertexIds.length === 0) return null;

  // Materialise each touched (neighbour) feature as a complete-state snapshot: its
  // reshaped record + the new same-coordinate vertex bodies its containers now cite.
  const snapshots: UnshareSnapshot[] = [];
  for (const fid of touchedFeatureOrder) {
    const feature0 = featureByIdAt(root, time, fid);
    if (feature0 === undefined) continue; // vanished at this time → skip (absence-not-crash)
    const feature1 = rebuildFeature(feature0, state);
    const newBodies: Vertex[] = [];
    for (const vid of createdByFeature.get(fid) ?? []) {
      const body = getVertex(state.vertices, vid);
      if (body !== undefined) newBodies.push(body);
    }
    snapshots.push({
      featureId: fid,
      snapshot: buildSnapshot({ feature: feature1, vertices: newBodies }),
    });
  }
  if (snapshots.length === 0) return null;

  return {
    snapshots,
    touchedFeatureIds: snapshots.map((s) => s.featureId),
    survivedVertexIds,
    createdVertexIds,
    nextIdState: idState,
  };
}

// --- run orchestration (single undo unit, 教訓 5.6 / 5.11) -------------------

const UNSHARE_COMMIT_KIND = defineCommandKind('u36-unshare-commit');

/** The host ports the unshare run drives (injected — the SAME shape App supplies). */
export interface UnsharePorts {
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** The current app id-generation state (project-wide collision-safe, 教訓 5.37). */
  readonly getIdState: () => IdGeneratorState;
  /** Monotonic integer source for id mints. */
  readonly now: TimeSource;
  /** Apply ONE feature snapshot to the root WITHOUT recording history (= U44 applyEditProposal). */
  readonly applyProposal: (
    root: DomainProject,
    proposal: EditProposal<FeatureSnapshot>,
  ) => DomainProject;
  /** Record the ONE composite command as a single undo unit + re-resolve selection. */
  readonly recordCommit: (
    command: Command<DomainProject>,
    preference: NextTargetPreference,
  ) => void;
  /** Advance the app's id-generation state past the ids this unshare minted (教訓 5.37). */
  readonly onIdStateAdvanced?: (next: IdGeneratorState) => void;
}

/**
 * Build the whole-state-swap command + its lifecycle {@link CommandResult} for an
 * unshare (the SAME shape createDeleteFeatureCommandForRoot uses). `survived` lists the
 * owner (so the reresolve preference's owner is a survivor), the reshaped neighbours,
 * and the ORIGINAL detached vertices; `created` lists the new same-coordinate vertices;
 * nothing is deleted (the original vertices keep ≥1 citation). Undo is symmetric
 * (教訓 5.23): the created ids become deleted, the rest survive.
 */
function buildUnshareCommand(
  baseline: DomainProject,
  finalState: DomainProject,
  plan: UnsharePlan,
  ownerFeatureId: FeatureId | null,
): { readonly command: Command<DomainProject>; readonly result: CommandResult } {
  const survived = new Set<FeatureId | VertexId>([
    ...plan.touchedFeatureIds,
    ...plan.survivedVertexIds,
  ]);
  if (ownerFeatureId !== null) survived.add(ownerFeatureId);
  const created = new Set<VertexId>(plan.createdVertexIds);

  const forward: CommandResult = createCommandResult({ survived, created });
  // Undo: the minted vertices are removed (created → deleted); everything else survives.
  const backward: CommandResult = createCommandResult({
    survived,
    deleted: created,
    touched: forward.touched,
  });

  const swap: Command<DomainProject> = {
    kind: UNSHARE_COMMIT_KIND,
    label: 'unshare',
    execute(state: DomainProject): CommandOutcome<DomainProject> {
      void state;
      return { state: finalState, result: forward };
    },
    undo(state: DomainProject): CommandOutcome<DomainProject> {
      void state;
      return { state: baseline, result: backward };
    },
    redo(state: DomainProject): CommandOutcome<DomainProject> {
      void state;
      return { state: finalState, result: forward };
    },
  };
  // Wrap in a composite so it records as ONE indivisible undo unit (FR-73 / FR-94).
  return { command: createCompositeCommand('unshare', [swap]), result: forward };
}

/**
 * Run FR-33 共有解除 against the live root (the ONE handler the右クリック「共有解除」
 * drives). Builds the pure plan, applies each touched feature's snapshot to assemble
 * the final root, records ONE whole-state-swap undo unit, and re-resolves the selection
 * from the SAME reresolve-bridge the other flows use (教訓 5.6 / 5.11). Returns the
 * forward {@link CommandResult} (for callers/tests), or `null` for a no-op (nothing
 * shared → no command, no幽霊 undo entry, 教訓 5.24).
 */
export function runUnshare(intent: UnshareIntent, ports: UnsharePorts): CommandResult | null {
  const plan = buildUnsharePlan(
    { getRoot: ports.getRoot, getTime: ports.getTime, idState: ports.getIdState(), now: ports.now },
    intent,
  );
  if (plan === null) return null;

  const baseline = ports.getRoot();
  const time = ports.getTime();
  let finalState = baseline;
  for (const { featureId, snapshot } of plan.snapshots) {
    finalState = ports.applyProposal(finalState, createEditProposal(featureId, time, snapshot));
  }

  const { command, result } = buildUnshareCommand(
    baseline,
    finalState,
    plan,
    intent.ownerFeatureId,
  );
  ports.onIdStateAdvanced?.(plan.nextIdState);

  // Re-resolve selection through the SAME bridge the UI-button path uses (受け入れ基準 12).
  const { preference } = bridgeReresolve(
    { kind: FLOW_KIND.Unshare, vertexIds: intent.vertexIds, ownerFeatureId: intent.ownerFeatureId },
    result,
  );
  ports.recordCommit(command, preference);
  return result;
}

/** A fresh id-generator state (used by tests / thin adapters that have no live state). */
export { createIdGeneratorState };
