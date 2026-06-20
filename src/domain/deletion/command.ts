// U31 deletion — the面情報削除 command (single, indivisible undo unit, FR-73 / FR-94).
//
// 教訓 5.21 / FR-41 適用: execute sweeps削除対象 ID out of 全錨 (双方向・全時間軸) and
// chain-prunes empty aggregates to a fixpoint. 教訓 5.20 適用: undo restores the EXACT
// pre-deletion anchors captured at construction (no ID re-mint on redo). 教訓 5.23
// 適用: execute / undo / redo report the SAME touched set so outer layers notify
// symmetrically. 教訓 5.24 適用: a no-op deletion (target absent everywhere) is built
// as an explicit no-op result so a confirm handler can refuse to push a幽霊 entry.
//
// The command is pure over {@link DeletionState} (U12 contract): same input → same
// outcome, input never mutated (the swept anchors are freshly built; the prior
// anchors are reused unchanged for undo, structural sharing).

import type { Anchor } from '../anchor';
import { createAnchor, createAnchorSnapshot } from '../anchor';
import {
  type Command,
  type CommandOutcome,
  createCommandResult,
  defineCommandKind,
  type CommandResult,
} from '../command/index';
import type { DomainId, FeatureId } from '../ids';

import { sweepAndPruneAnchor } from './sweep';
import { createDeletionState, type DeletionState } from './state';

/** The kind discriminator for the面情報削除 command (教訓 5.19). */
export const DELETE_FEATURE_COMMAND_KIND = defineCommandKind('deletion/delete-feature');

/** Default label for the command (menus / history UI; never used for branching). */
export const DELETE_FEATURE_COMMAND_LABEL = '地物の削除';

/** The pre-computed deletion PLAN: the after-state plus the change-set summary. */
interface DeletionPlan {
  readonly before: readonly Anchor[];
  readonly after: readonly Anchor[];
  readonly result: CommandResult;
}

/**
 * Compute the deletion plan for `targetId` over `state` (pure, deterministic).
 *
 * For each anchor it sweeps + chain-prunes (`sweepAndPruneAnchor`) and rebuilds the
 * anchor with the surviving features (the vertex store is preserved as-is: the
 * shared-vertex DETACH of the deleted face's participation is delegated to U11 and
 * is out of scope here — spec 実装方針「共有頂点の扱い」). The result aggregates:
 *   - deleted: the target PLUS every aggregate that auto-disappeared in any anchor
 *     (連鎖消滅, FR-35) — union across anchors,
 *   - survived: every feature id that still exists after the command (union across
 *     anchors) and was not deleted,
 *   - touched: deleted ∪ edited-survivors (the残存 whose refs were swept) so undo /
 *     redo notify symmetrically (教訓 5.23).
 *
 * `created` is empty (deletion mints nothing).
 */
function planDeletion(state: DeletionState, targetId: FeatureId): DeletionPlan {
  const targets = new Set<FeatureId>([targetId]);

  const after: Anchor[] = [];
  const deleted = new Set<DomainId>();
  const survived = new Set<DomainId>();
  const touched = new Set<DomainId>();

  for (const anchor of state.anchors) {
    const swept = sweepAndPruneAnchor(anchor.snapshot.features, targets);
    after.push(
      createAnchor(
        anchor.id,
        createAnchorSnapshot(swept.features, anchor.snapshot.vertices),
      ),
    );
    for (const id of swept.removedIds) {
      deleted.add(id);
      touched.add(id);
    }
    for (const f of swept.features) {
      survived.add(f.id);
    }
    for (const id of swept.editedIds) {
      touched.add(id);
    }
  }

  // A feature deleted in one anchor but surviving in another is, on balance,
  // surviving overall (it still exists). Keep survived/deleted disjoint by
  // removing survivors from the deleted set — the per-anchor removal is still
  // applied to that anchor's state; the command RESULT reports net lifecycle.
  for (const id of survived) deleted.delete(id);

  const result = createCommandResult({
    deleted,
    survived,
    touched,
  });

  return { before: state.anchors, after, result };
}

/**
 * Build the面情報削除 command for `targetId` (FR-41 / FR-85). The plan is computed
 * once at construction over the CURRENT state so undo can restore the exact prior
 * anchors and redo replays the exact same after-state (教訓 5.20: no re-mint).
 *
 * execute / redo replace the state's anchors with the planned after-anchors; undo
 * restores the captured before-anchors. All three return the SAME touched set
 * (教訓 5.23). The command is the indivisible undo unit for the whole sweep + chain
 * prune (FR-73 / FR-94) — there is no public sub-step.
 */
export function createDeleteFeatureCommand(
  state: DeletionState,
  targetId: FeatureId,
  label: string = DELETE_FEATURE_COMMAND_LABEL,
): Command<DeletionState> {
  const plan = planDeletion(state, targetId);

  const toAfter = (): CommandOutcome<DeletionState> => ({
    state: createDeletionState(plan.after),
    result: plan.result,
  });
  const toBefore = (): CommandOutcome<DeletionState> => ({
    state: createDeletionState(plan.before),
    // undo touches the same elements (教訓 5.23): the same notification set, but
    // the lifecycle inverts (deleted → created back). We report the symmetric
    // touched set; created carries the restored ids so selection re-resolution
    // (教訓 5.11) can treat undo as bringing them back.
    result: createCommandResult({
      created: plan.result.deleted,
      survived: plan.result.survived,
      touched: plan.result.touched,
    }),
  });

  return {
    kind: DELETE_FEATURE_COMMAND_KIND,
    label,
    execute: toAfter,
    undo: toBefore,
    redo: toAfter,
  };
}

/**
 * True iff this deletion would change nothing (target absent from every anchor):
 * a no-op the confirm handler must NOT push (教訓 5.24 no幽霊 undo entry).
 */
export function isNoOpDeletion(state: DeletionState, targetId: FeatureId): boolean {
  return !state.anchors.some((a) =>
    a.snapshot.features.some((f) => f.id === targetId),
  );
}
