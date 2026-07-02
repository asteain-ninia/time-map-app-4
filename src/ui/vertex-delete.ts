// FR-87 / FR-88 頂点削除 — the pure PLAN builder that turns a live vertex selection
// into ONE complete-state edit (single undo unit) or a below-threshold feature
// deletion, WITHOUT writing any state. It is the wiring rule the composition root
// (App.tsx) drives through the SAME confirm seam ring-edit / attribute-edit use.
//
// WHY THIS FILE EXISTS (単一真実源 5.29 / testable seam 5.34):
// The 頂点削除 導線 (Delete キー・編集メニュー・FR-96 右クリック「削除」) all dispatch the
// ONE COMMAND_ID.EditDelete command (5.13). When a vertex is selected that command
// must delete the vertex(es) rather than the whole feature. Folding a multi-vertex
// selection into ONE FeatureSnapshot, resolving each leaf vertex's ring against the
// EVOLVING feature, and short-circuiting to a below-threshold feature deletion is a
// non-trivial rule that must be ONE testable place — not inlined in the App effect.
//
// It NEVER re-implements the削除 thresholds: it chains the domain's SINGLE
// {@link deleteVertex} over the evolving in-memory feature (2点未満で線削除 /
// 3点未満でリード削除 U07 / 領土0で面削除 / 点は点情報削除 — all decided by deleteVertex,
// edit-ops.ts). Pure: the caller passes the live root + time + selection.

import { deleteVertex, type FeatureEditResult } from '../domain/editing/index';
import { buildSnapshot, type FeatureSnapshot } from '../domain/editing/index';
import { FEATURE_KIND, type Feature } from '../domain/feature';
import type { FeatureId, RingId, VertexId } from '../domain/ids';
import type { DomainProject } from '../domain/persistence/index';
import type { TimePoint } from '../domain/time/time-point';
import { featureByIdAt } from './live-lookup';
import {
  createEditProposal,
  PROCESS_STATUS,
  type EditProposal,
  type ProcessResult,
  type Resolution,
} from '../domain/consistency/index';
import type { NextTargetPreference } from '../domain/selection/index';

/** The proposal-bound U35 apply-resolutions adapter (matches ApplyResolutions<S>). */
type ApplyResolutionsFn<S> = (resolutions: readonly Resolution[]) => ProcessResult<S>;

/**
 * The live domain context a plan is built against (read fresh — never a stale
 * capture, 教訓 5.6). Mirrors {@link EditSnapshotContext} but this module only reads
 * the root at the anchor time.
 */
export interface VertexDeleteContext {
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
}

/** The vertex selection a delete acts on (= SelectionState.vertexOwner + vertexIds). */
export interface VertexSelection {
  readonly ownerFeatureId: FeatureId;
  readonly vertexIds: ReadonlySet<VertexId>;
}

/**
 * The computed outcome of a vertex-delete request:
 *   - `null` … no-op: no owner/vertices, an aggregate (shapeless FR-35), a stale
 *      target, or every deleteVertex step returned undefined → NO command, NO
 *      ghost history entry (教訓 5.24).
 *   - `delete-feature` … a threshold drop (line<2 / leaf no-territory / point):
 *      the caller delegates to the SINGLE all-anchor delete truth source
 *      (createDeleteFeatureCommandForRoot) — NO: see below. It is a TIME-SLICE
 *      delete through the SAME FeatureSnapshot(deletedFeatureId) confirm path, so
 *      the feature is dropped ONLY at the anchor time (belowThreshold study result).
 *   - `survive` … the feature continues with vertices removed: the caller confirms
 *      the snapshot through the integrity pipeline and records ONE undo unit.
 */
export type VertexDeletePlan =
  | {
      readonly kind: 'survive';
      readonly featureId: FeatureId;
      readonly snapshot: FeatureSnapshot;
    }
  | {
      readonly kind: 'delete-feature';
      readonly featureId: FeatureId;
      readonly snapshot: FeatureSnapshot;
    };

/**
 * The ring that owns `vertexId` on THIS feature instance (for a leaf), scanning the
 * feature's own rings — NOT the live root — so a chained delete that reorganized the
 * ring set resolves against the EVOLVING feature (multiVertex study warning). The
 * FIRST ring citing the vertex, matching the rule {@link deleteLeafVertex} uses. For
 * a point / line the ring is irrelevant (deleteVertex ignores it). Pure.
 */
export function ringIdForVertexInFeature(
  feature: Feature,
  vertexId: VertexId,
): RingId | undefined {
  if (feature.kind !== FEATURE_KIND.Leaf) return undefined;
  for (const ring of feature.shape.rings) {
    if (ring.vertexIds.includes(vertexId)) return ring.id;
  }
  return undefined;
}

/**
 * Build the ONE-undo-unit plan for deleting the selected vertices of a single
 * feature (FR-81 guarantees ONE owner). Chains {@link deleteVertex} over the
 * EVOLVING in-memory feature so a multi-vertex selection folds into ONE
 * FeatureSnapshot; a step that drops the feature below threshold short-circuits to a
 * single `deletedFeatureId` snapshot (the remaining deletes are moot). Returns
 * `null` for a no-op (aggregate / stale / all-undefined) so the caller records no
 * ghost history (教訓 5.24). Pure — reads the live root at the anchor time only.
 */
export function buildVertexDeletePlan(
  ctx: VertexDeleteContext,
  selection: VertexSelection,
): VertexDeletePlan | null {
  if (selection.vertexIds.size === 0) return null;
  const root = ctx.getRoot();
  const time = ctx.getTime();
  const feature0 = featureByIdAt(root, time, selection.ownerFeatureId);
  if (feature0 === undefined) return null; // owner absent at this time → no-op.

  // Deterministic order so a redo replays identically: iterate the feature's own
  // vertex-id order, deleting only those actually selected. (A selected id absent
  // from the feature is a stale target → deleteVertex returns undefined → skipped.)
  const orderedTargets = orderedSelectedVertexIds(feature0, selection.vertexIds);
  if (orderedTargets.length === 0) return null; // nothing on this feature is selected.

  let current: Feature = feature0;
  let anyDeleted = false;
  for (const vertexId of orderedTargets) {
    // The ring is resolved against the EVOLVING feature (a chained delete may have
    // reorganized the ring set). exactOptionalPropertyTypes: only set `ringId` when
    // resolved so an undefined never masquerades as a supplied ring (point/line ignore it).
    const ringId = ringIdForVertexInFeature(current, vertexId);
    const result: FeatureEditResult | undefined = deleteVertex(
      ringId === undefined
        ? { feature: current, vertexId }
        : { feature: current, vertexId, ringId },
    );
    if (result === undefined) continue; // stale / aggregate for this step → skip.
    anyDeleted = true;
    if (result.kind === 'delete-feature') {
      // Below threshold: the feature is gone; remaining deletes are moot. This is a
      // TIME-SLICE removal (deletedFeatureId snapshot) — NOT an all-anchor delete —
      // so the feature drops only at the anchor time (belowThreshold study result).
      return {
        kind: 'delete-feature',
        featureId: result.featureId,
        snapshot: buildSnapshot({ vertices: [], deletedFeatureId: result.featureId }),
      };
    }
    current = result.feature; // carry the survived feature forward.
  }

  if (!anyDeleted) return null; // every step was a no-op → no command (教訓 5.24).

  // The feature survived every delete. Build ONE snapshot from the FINAL feature; no
  // vertex bodies move (a delete only removes id references), so `vertices: []`
  // (editSlicePrunes study: the orphaned body is harmless — never drawn / detected).
  // NOTE: every SELECTED vertex was deleted, so none of the originally-selected
  // vertices survive on the final feature — the caller clears the vertex selection
  // (keeping the feature active). makeCommand reports deletion at feature-history
  // level only, so reresolve cannot prune the deleted vertex ids on its own.
  return {
    kind: 'survive',
    featureId: current.id,
    snapshot: buildSnapshot({ feature: current, vertices: [] }),
  };
}

/** The selected vertex ids in the feature's own reference order (deterministic). */
function orderedSelectedVertexIds(
  feature: Feature,
  selected: ReadonlySet<VertexId>,
): VertexId[] {
  const out: VertexId[] = [];
  for (const vertexId of featureVertexOrder(feature)) {
    if (selected.has(vertexId)) out.push(vertexId);
  }
  return out;
}

/** Every vertex id the feature references, in a stable order (point/line/leaf). */
function featureVertexOrder(feature: Feature): VertexId[] {
  switch (feature.kind) {
    case FEATURE_KIND.Point:
      return [feature.vertexId];
    case FEATURE_KIND.Line:
      return feature.vertexIds.slice();
    case FEATURE_KIND.Leaf: {
      const out: VertexId[] = [];
      for (const ring of feature.shape.rings) for (const v of ring.vertexIds) out.push(v);
      return out;
    }
    default:
      return []; // aggregate has no own vertices (FR-35).
  }
}

// --- the EditDelete run orchestration (single funnel, 教訓 5.13) --------------

/** The live selection the EditDelete command reads (= SelectionState subset). */
export interface EditDeleteSelection {
  readonly activeFeature: FeatureId | null;
  readonly vertexOwner: FeatureId | null;
  readonly vertexIds: ReadonlySet<VertexId>;
}

/**
 * The host ports the vertex-delete branch drives (injected so the branch is ONE
 * testable place — the same shape the App composition root supplies). Generic over
 * the domain root `S` so the U13 binding threads the real DomainRoot.
 */
export interface EditDeletePorts<S> {
  readonly getRoot: () => DomainProject;
  readonly getTime: () => TimePoint;
  /** Run the confirm through the SAME U13 pipeline add/knife/move/ring-edit use. */
  readonly startProcess: (proposal: EditProposal<FeatureSnapshot>) => ProcessResult<S>;
  /** Build the U35 apply-resolutions adapter for ONE paused proposal. */
  readonly applyResolutionsFor: (proposal: EditProposal<FeatureSnapshot>) => ApplyResolutionsFn<S>;
  /** Record a Committed result as ONE undo unit with the re-resolution preference. */
  readonly recordCommit: (result: ProcessResult<S>, preference?: NextTargetPreference) => void;
  /**
   * Surface a paused conflict through the SAME modal add/knife use (honest failure).
   * `clearVertexOwner` (survive only) is the vertex-owner whose selection MUST be
   * cleared once the conflict commit lands: the deleted vertex ids cannot be pruned by
   * reresolve (makeCommand reports deletion at feature-history level, so `result.deleted`
   * never lists a vertex id — reresolve.ts:83-88), so the host stashes this owner on the
   * paused conflict and clears it in the SAME order the DIRECT commit does
   * (recordCommit → clearVertexSelection), keeping the feature active. Omitted for a
   * below-threshold delete (no surviving feature — the deleted feature id drops on its own).
   */
  readonly openConflict: (
    result: ProcessResult<S>,
    apply: ApplyResolutionsFn<S>,
    preference?: NextTargetPreference,
    clearVertexOwner?: FeatureId,
  ) => void;
  /** Clear the vertex selection (keep the feature active) — for the all-deleted case. */
  readonly clearVertexSelection: (ownerFeatureId: FeatureId) => void;
  /** The UNCHANGED U31 全錨 feature delete (no vertex selected). */
  readonly deleteFeatureAllAnchors: (featureId: FeatureId) => void;
}

/**
 * Run COMMAND_ID.EditDelete against the LIVE selection (the ONE handler the Delete
 * key / 編集メニュー / FR-96 右クリック「削除」 share, 教訓 5.13):
 *   • a non-empty vertex selection → delete those vertices (FR-88) through the U13
 *     pipeline (survive → ONE undo unit + selection re-resolution; 閾値割れ → a
 *     TIME-SLICE feature deletion; ConflictsPending → the conflict modal; Rejected →
 *     keep selection, no commit — honest, never silent corruption);
 *   • otherwise (only an activeFeature) → the UNCHANGED U31 全錨 delete (FR-79/85).
 * A no-op plan (aggregate / stale / all-undefined) records nothing (no幽霊, 教訓 5.24).
 */
export function runEditDelete<S>(
  selection: EditDeleteSelection,
  ports: EditDeletePorts<S>,
): void {
  // --- FR-88 vertex-delete branch (a vertex is selected) ----------------------
  if (selection.vertexIds.size > 0 && selection.vertexOwner !== null) {
    const plan = buildVertexDeletePlan(
      { getRoot: ports.getRoot, getTime: ports.getTime },
      { ownerFeatureId: selection.vertexOwner, vertexIds: selection.vertexIds },
    );
    if (plan === null) return; // no-op (aggregate / stale / all-undefined): no幽霊.

    const proposal = createEditProposal(plan.featureId, ports.getTime(), plan.snapshot);
    const result = ports.startProcess(proposal);

    if (result.status === PROCESS_STATUS.ConflictsPending) {
      // A surviving delete promotes the feature AND must clear the (all-deleted) vertex
      // selection once the modal commits — the SAME reconciliation the DIRECT survive
      // commit does (recordCommit + clearVertexSelection), because reresolve cannot prune
      // the deleted vertex ids (deletion is reported only at feature-history level). A
      // below-threshold delete has no surviving feature, so no preference and no clear
      // (the deleted feature id drops from selection via reresolve Step-1).
      ports.openConflict(
        result,
        ports.applyResolutionsFor(proposal),
        plan.kind === 'survive' ? { featureId: plan.featureId } : undefined,
        plan.kind === 'survive' ? plan.featureId : undefined,
      );
      return;
    }
    if (result.status !== PROCESS_STATUS.Committed) return; // Rejected: keep selection.

    if (plan.kind === 'delete-feature') {
      // TIME-SLICE deletion: no preference (mirrors ring-edit onRingEditCommitted) —
      // the deleted feature id drops from selection via reresolve Step-1.
      ports.recordCommit(result);
      return;
    }

    // survive: keep the feature ACTIVE (preference.featureId) but the deleted vertex
    // ids must drop from the vertex selection. reresolve reports deletion only at
    // feature-history level (makeCommand), NOT per vertex, so it can neither prune the
    // deleted ids (Step-1) nor is any originally-selected vertex a survivor to promote
    // (Step-2) — we deleted them all. So we clear the vertex selection explicitly,
    // keeping the feature active (withVertexSet drops the owner on an empty set).
    ports.recordCommit(result, { featureId: plan.featureId });
    ports.clearVertexSelection(plan.featureId);
    return;
  }

  // --- UNCHANGED U31 全錨 feature-delete branch (no vertex selection) ----------
  if (selection.activeFeature === null) return;
  ports.deleteFeatureAllAnchors(selection.activeFeature);
}
