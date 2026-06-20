// U31 deletion — delete-eligibility judgment, ACROSS ALL ANCHORS (FR-41).
//
// FR-41: 面情報の削除は、全時刻を通じてその地物への上位/下位領域参照を持つ他地物が
// 存在しないか、再編が許容される場合にのみ可能とする。
//
// 教訓 5.21 適用: 可否判定は全錨 (全時間軸) を横断し、上位/下位の双方向参照を各錨ごとに
// 列挙する。単一時点・片方向だけの判定をしない (「ある時刻にだけ参照が残る」入力を弾く)。
//
// 教訓 5.26「編集制約はコマンド確定前にも同じサービスで検証する」適用: 「再編許容」は、
// 参照掃除＋連鎖剪定を適用した結果を U08 の不変条件検証 (`validateHierarchy`) に通して
// 判定する。UI のボタン無効化だけでなく、コマンド確定前の最終ゲートでもこの同じ関数を
// 呼ぶ (ショートカット/メニュー/直接呼び出し/undo・redo 経路からの不正削除を塞ぐ)。
//
// 結果は構造化して返す (削除可能 / 拒否 + 拒否理由種別 + 関与地物 ID)。拒否理由は日本語
// 通知文言 (messages.ts) とテスト可能な機械可読フィールド (this kind) の双方で扱える
// (教訓 5.26 / FR-115)。

import type { Feature } from '../feature';
import type { FeatureId } from '../ids';
import { buildForest } from '../hierarchy/forest';
import { validateHierarchy } from '../hierarchy/validate';

import { sweepAndPruneAnchor } from './sweep';
import type { DeletionState } from './state';

export const DELETE_REJECT = {
  /** The target feature is present in no anchor — nothing to delete (教訓 5.24). */
  NotFound: 'not-found',
  /**
   * Sweeping + chain-pruning the target cannot restore the domain invariants in
   * some anchor (再編不能): the post-deletion state still violates U08's checks.
   */
  ReorganizationImpossible: 'reorganization-impossible',
} as const;

export type DeleteRejectKind =
  (typeof DELETE_REJECT)[keyof typeof DELETE_REJECT];

export const DELETE_VERDICT = {
  Allowed: 'allowed',
  Rejected: 'rejected',
} as const;

export type DeleteVerdictKind =
  (typeof DELETE_VERDICT)[keyof typeof DELETE_VERDICT];

/**
 * Structured eligibility verdict. The `Allowed` branch carries no payload; the
 * `Rejected` branch carries the machine-readable reason kind PLUS the involved
 * feature ids, so a caller can build a日本語 message AND a test can assert on the
 * kind/ids without parsing prose (教訓 5.26).
 */
export type DeleteVerdict =
  | { readonly kind: typeof DELETE_VERDICT.Allowed }
  | {
      readonly kind: typeof DELETE_VERDICT.Rejected;
      readonly reason: DeleteRejectKind;
      /** Features implicated in the rejection (the target, violating ids, …). */
      readonly featureIds: readonly FeatureId[];
    };

/** A reference to the target across one anchor: the parents and children that point at it. */
export interface AnchorReferences {
  /** This anchor lists the target as a direct child of these aggregates (下位領域参照元). */
  readonly parentRefs: readonly FeatureId[];
  /** This anchor has these features parented to the target (上位領域参照元 = the target's children). */
  readonly childRefs: readonly FeatureId[];
}

/**
 * Enumerate, for one anchor's feature set, every BIDIRECTIONAL reference to
 * `targetId` (教訓 5.21: both directions, never one-sided):
 *   - childRefs: features whose parentId === target (the target's sub-regions),
 *   - parentRefs: aggregates whose childIds contain target (the target's parents).
 * Both lists are derived from the same forest so the relation is consistent.
 */
export function referencesInAnchor(
  features: readonly Feature[],
  targetId: FeatureId,
): AnchorReferences {
  const forest = buildForest(features);
  const childRefs: FeatureId[] = [];
  for (const id of forest.orderedIds) {
    const f = forest.byId.get(id);
    if (f?.parentId === targetId) childRefs.push(id);
  }
  const parentRefs: FeatureId[] = [];
  for (const id of forest.orderedIds) {
    const f = forest.byId.get(id);
    if (f !== undefined && f.kind === 'aggregate' && f.childIds.includes(targetId)) {
      parentRefs.push(id);
    }
  }
  return { parentRefs, childRefs };
}

/** True iff some other feature references `targetId` in `features` (either direction). */
export function hasReferencesInAnchor(
  features: readonly Feature[],
  targetId: FeatureId,
): boolean {
  const refs = referencesInAnchor(features, targetId);
  // 教訓 5.18: decide on the lengths, not a falsy short-circuit.
  return refs.parentRefs.length > 0 || refs.childRefs.length > 0;
}

/**
 * Judge whether deleting `targetId` is permitted, ACROSS ALL ANCHORS (FR-41).
 *
 * Rules:
 *   1. The target must exist in at least one anchor, else `NotFound` (教訓 5.24
 *      no-op guard surfaced as a verdict).
 *   2. If NO other feature references the target in ANY anchor → Allowed
 *      unconditionally (FR-41 first clause).
 *   3. Otherwise simulate the sweep + chain prune in EVERY anchor and validate the
 *      result with U08 (`validateHierarchy`, vertex store供給). If every anchor's
 *      post-deletion state passes → Allowed (再編許容). If any anchor still
 *      violates an invariant → Rejected(ReorganizationImpossible) with the
 *      violating ids (教訓 5.26: same service used pre-commit).
 *
 * The judgment never looks at a single time slice alone (受け入れ基準 1): "ある時刻
 * にだけ参照が残る" forces step-3 simulation over that anchor too.
 */
export function judgeDeletion(
  state: DeletionState,
  targetId: FeatureId,
): DeleteVerdict {
  // 1. existence across全錨.
  const existsSomewhere = state.anchors.some((a) =>
    a.snapshot.features.some((f) => f.id === targetId),
  );
  if (!existsSomewhere) {
    return { kind: DELETE_VERDICT.Rejected, reason: DELETE_REJECT.NotFound, featureIds: [targetId] };
  }

  // 2. unconditional when no anchor references the target (either direction).
  const referencedSomewhere = state.anchors.some((a) =>
    hasReferencesInAnchor(a.snapshot.features, targetId),
  );
  if (!referencedSomewhere) {
    return { kind: DELETE_VERDICT.Allowed };
  }

  // 3.再編許容: simulate sweep + prune per anchor and validate with U08.
  const targets = new Set<FeatureId>([targetId]);
  const violating: FeatureId[] = [];
  for (const anchor of state.anchors) {
    const swept = sweepAndPruneAnchor(anchor.snapshot.features, targets);
    const validation = validateHierarchy(swept.features, {
      vertexStore: anchor.snapshot.vertices,
    });
    if (!validation.ok) {
      for (const v of validation.violations) {
        for (const id of v.featureIds) violating.push(id);
      }
    }
  }
  if (violating.length > 0) {
    return {
      kind: DELETE_VERDICT.Rejected,
      reason: DELETE_REJECT.ReorganizationImpossible,
      featureIds: [targetId, ...violating],
    };
  }
  return { kind: DELETE_VERDICT.Allowed };
}

/** True iff the verdict permits deletion. */
export function isDeletable(verdict: DeleteVerdict): boolean {
  return verdict.kind === DELETE_VERDICT.Allowed;
}
